import { parse } from 'yaml'
import { z } from 'zod'
import type { StageType } from '../../types/contract.js'

export const PIPELINE_FILE = '.orbit/pipeline.yaml'
export const SCANNERS = [
  'semgrep',
  'gitleaks',
  'trivy-fs',
  'trivy-image',
] as const
export type Scanner = (typeof SCANNERS)[number]

const stageName = z
  .string()
  .regex(
    /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/,
    'stage names must be lowercase letters, digits and dashes'
  )
  .max(30)

const ScriptStage = z.object({
  name: stageName,
  type: z.literal('script'),
  image: z.string().min(1),
  script: z.array(z.string().min(1)).min(1),
  env: z.record(z.string()).optional(),
  timeoutMinutes: z.number().int().positive().max(120).optional(),
})

const BuildStage = z.object({
  name: stageName,
  type: z.literal('build'),
  dockerfile: z.string().default('Dockerfile'),
  context: z.string().default('.'),
  timeoutMinutes: z.number().int().positive().max(120).optional(),
})

const ScanStage = z.object({
  name: stageName,
  type: z.literal('scan'),
  scanners: z
    .array(z.enum(SCANNERS))
    .min(1)
    .default([...SCANNERS]),
  timeoutMinutes: z.number().int().positive().max(120).optional(),
})

const DeployStage = z.object({
  name: stageName,
  type: z.literal('deploy'),
  environment: z.string().min(1),
  timeoutMinutes: z.number().int().positive().max(60).optional(),
})

const DastStage = z.object({
  name: stageName,
  type: z.literal('dast'),
  environment: z.string().min(1),
  timeoutMinutes: z.number().int().positive().max(60).optional(),
})

const Stage = z.discriminatedUnion('type', [
  ScriptStage,
  BuildStage,
  ScanStage,
  DeployStage,
  DastStage,
])

const PipelineSchema = z.object({
  version: z.literal(1),
  stages: z.array(Stage).min(1).max(20),
})

export type StageSpec = z.infer<typeof Stage>
export type ScriptStageSpec = z.infer<typeof ScriptStage>
export type BuildStageSpec = z.infer<typeof BuildStage>
export type ScanStageSpec = z.infer<typeof ScanStage>
export type DeployStageSpec = z.infer<typeof DeployStage>
export type DastStageSpec = z.infer<typeof DastStage>
export type PipelineSpec = z.infer<typeof PipelineSchema>

export type ParseResult =
  { ok: true; spec: PipelineSpec } | { ok: false; errors: string[] }

/** Parse and validate `.orbit/pipeline.yaml`, including ordering rules between stages. */
export function parsePipeline(
  text: string,
  environments?: string[]
): ParseResult {
  let raw: unknown
  try {
    raw = parse(text)
  } catch (err) {
    return {
      ok: false,
      errors: [
        `invalid YAML: ${err instanceof Error ? err.message : String(err)}`,
      ],
    }
  }
  // Stages without an explicit type are script stages.
  if (
    raw &&
    typeof raw === 'object' &&
    Array.isArray((raw as { stages?: unknown }).stages)
  ) {
    for (const st of (raw as { stages: unknown[] }).stages) {
      if (st && typeof st === 'object' && !('type' in st))
        (st as Record<string, unknown>).type = 'script'
    }
  }
  const parsed = PipelineSchema.safeParse(raw)
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map(
        (i) => `${i.path.length ? i.path.join('.') : 'pipeline'}: ${i.message}`
      ),
    }
  }
  const spec = parsed.data
  const errors: string[] = []
  const seen = new Set<string>()
  let built = false
  const deployed = new Set<string>()
  spec.stages.forEach((stage, i) => {
    const where = `stages.${i} (${stage.name})`
    if (seen.has(stage.name)) errors.push(`${where}: duplicate stage name`)
    seen.add(stage.name)
    switch (stage.type) {
      case 'build':
        if (stage.dockerfile.includes('..') || stage.context.includes('..'))
          errors.push(`${where}: paths must stay inside the repository`)
        built = true
        break
      case 'scan':
        if (stage.scanners.includes('trivy-image') && !built)
          errors.push(`${where}: trivy-image needs an earlier build stage`)
        break
      case 'deploy':
        if (!built) errors.push(`${where}: deploy needs an earlier build stage`)
        if (environments && !environments.includes(stage.environment)) {
          errors.push(
            `${where}: environment "${stage.environment}" is not one of the app's environments (${environments.join(', ')})`
          )
        }
        deployed.add(stage.environment)
        break
      case 'dast':
        if (!deployed.has(stage.environment))
          errors.push(
            `${where}: dast needs an earlier deploy to "${stage.environment}"`
          )
        break
      default:
        break
    }
  })
  return errors.length ? { ok: false, errors } : { ok: true, spec }
}

export function stageType(stage: StageSpec): StageType {
  return stage.type
}

/** Deploy and DAST stages only run on the default branch. */
export function runsOnBranch(
  stage: StageSpec,
  branch: string,
  defaultBranch = 'main'
): boolean {
  return (
    (stage.type !== 'deploy' && stage.type !== 'dast') ||
    branch === defaultBranch
  )
}
