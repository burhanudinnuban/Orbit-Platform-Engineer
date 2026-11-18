import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import type * as k8s from '@kubernetes/client-node'
import type { Config } from '../../config/env.js'
import { runJob } from '../../services/jobs.js'
import { isNotFound, upsertConfigMap, type Kube } from '../../services/kube.js'
import { dnsLabel } from '../../lib/util.js'

export type TerraformAction = 'apply' | 'destroy'

/**
 * Root modules under terraform/modules:
 *   app-namespace  Kubernetes namespace, quotas, policies, RBAC, optional Postgres
 *   app-cloud      AWS resources (S3, SQS): Floci locally, real AWS in production
 */
export type TerraformModule = 'app-namespace' | 'app-cloud'

export interface TerraformRun {
  module: TerraformModule
  app: string
  env: string
  action: TerraformAction
  vars: Record<string, string | number | boolean>
  onLog?: (log: string) => void
  signal?: AbortSignal
}

const OUTPUT_MARKER = '::orbit-terraform-outputs::'

/** State lives in Secret tfstate-default-<suffix> in orbit-system, one per module, app and environment. */
export function stateSuffix(
  module: TerraformModule,
  app: string,
  env: string
): string {
  return module === 'app-namespace' ? `${app}-${env}` : `${app}-${env}-cloud`
}

export function backendTf(
  config: Config,
  module: TerraformModule,
  app: string,
  env: string
): string {
  return `terraform {
  backend "kubernetes" {
    secret_suffix     = "${stateSuffix(module, app, env)}"
    namespace         = "${config.terraform.namespace}"
    in_cluster_config = true
  }
}
`
}

/**
 * Base name for the run's ConfigMap and Jobs. Long app and environment names are
 * truncated, so a short hash keeps different module/app/env runs from colliding.
 */
export function runBaseName(
  module: TerraformModule,
  app: string,
  env: string
): string {
  const short = module === 'app-namespace' ? 'ns' : 'cloud'
  const hash = createHash('sha256')
    .update(`${module}/${app}/${env}`)
    .digest('hex')
    .slice(0, 6)
  return `${dnsLabel(`tf-${short}-${app}-${env}`, 33)}-${hash}`
}

export function terraformScript(action: TerraformAction): string {
  return [
    'set -e',
    'cp /module/* /work/',
    'cd /work',
    'terraform version -no-color',
    'terraform init -input=false -no-color',
    ...(action === 'apply'
      ? [
          'terraform plan -input=false -no-color -out=/work/plan.out',
          'terraform apply -input=false -no-color /work/plan.out',
          `echo '${OUTPUT_MARKER}' && terraform output -json -no-color`,
        ]
      : ['terraform destroy -auto-approve -input=false -no-color']),
  ].join('\n')
}

export function parseOutputs(log: string): Record<string, unknown> {
  const idx = log.lastIndexOf(OUTPUT_MARKER)
  if (idx < 0) return {}
  const text = log.slice(idx + OUTPUT_MARKER.length).trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end < start) return {}
  try {
    const raw = JSON.parse(text.slice(start, end + 1)) as Record<
      string,
      { value: unknown }
    >
    return Object.fromEntries(
      Object.entries(raw).map(([k, v]) => [k, v?.value])
    )
  } catch {
    return {}
  }
}

/**
 * Orbit's Terraform runner: bundles a root module into a ConfigMap and runs
 * terraform as a Kubernetes Job (like Terraform Cloud / Atlantis, in-cluster).
 */
export async function runTerraform(
  kube: Kube,
  config: Config,
  run: TerraformRun
): Promise<Record<string, unknown>> {
  const ns = config.terraform.namespace
  const moduleDir = path.join(config.terraform.modulesDir, run.module)
  const files: Record<string, string> = {}
  for (const name of await readdir(moduleDir)) {
    if (name.endsWith('.tf'))
      files[name] = await readFile(path.join(moduleDir, name), 'utf8')
  }
  if (!Object.keys(files).length)
    throw new Error(`no .tf files in ${moduleDir}`)
  files['backend.tf'] = backendTf(config, run.module, run.app, run.env)
  files['terraform.tfvars.json'] = JSON.stringify(run.vars, null, 2)

  const base = runBaseName(run.module, run.app, run.env)
  const configMapName = `${base}-module`
  const labels = {
    'app.kubernetes.io/managed-by': 'orbit',
    'orbit.dev/app': run.app,
    'orbit.dev/env': run.env,
    'orbit.dev/component': 'terraform',
    'orbit.dev/terraform-module': run.module,
  }
  await upsertConfigMap(kube, ns, configMapName, files, labels)

  // Real AWS only: the AWS provider reads AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY
  // (or AWS_ROLE_ARN etc.) from this Secret. Floci needs none; the module sets test keys.
  const envFrom: k8s.V1EnvFromSource[] =
    run.module === 'app-cloud'
      ? [
          {
            secretRef: { name: config.cloud.credentialsSecret, optional: true },
          },
        ]
      : []

  const jobName = dnsLabel(`${base}-${run.action}-${Date.now().toString(36)}`)
  const job: k8s.V1Job = {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name: jobName, namespace: ns, labels },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: 3600,
      template: {
        metadata: { labels },
        spec: {
          restartPolicy: 'Never',
          serviceAccountName: config.terraform.serviceAccount,
          containers: [
            {
              name: 'terraform',
              image: config.images.terraform,
              command: ['/bin/sh', '-c', terraformScript(run.action)],
              env: [
                { name: 'TF_IN_AUTOMATION', value: 'true' },
                { name: 'HOME', value: '/work' },
              ],
              envFrom,
              volumeMounts: [
                { name: 'module', mountPath: '/module' },
                { name: 'work', mountPath: '/work' },
              ],
              // The AWS provider needs noticeably more memory than the Kubernetes one.
              resources: {
                requests: { cpu: '100m', memory: '128Mi' },
                limits: { memory: '1Gi' },
              },
            },
          ],
          volumes: [
            { name: 'module', configMap: { name: configMapName } },
            { name: 'work', emptyDir: {} },
          ],
        },
      },
    },
  }

  const result = await runJob(kube, {
    namespace: ns,
    job,
    onLog: run.onLog,
    timeoutMs: 20 * 60_000,
    signal: run.signal,
  })
  if (!result.succeeded) {
    throw new Error(
      `terraform ${run.action} (${run.module}) failed for ${run.app}/${run.env}: ${result.reason ?? 'see logs'}`
    )
  }

  if (run.action === 'destroy') {
    try {
      await kube.core.deleteNamespacedConfigMap({
        name: configMapName,
        namespace: ns,
      })
    } catch (err) {
      if (!isNotFound(err)) throw err
    }
  }
  return parseOutputs(result.lastContainerLog || result.log)
}
