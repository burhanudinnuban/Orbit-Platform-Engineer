import type { PipelineDetail, StageView } from './pipelines.types'

/** Statuses of a run that can still be canceled. */
export const ACTIVE_STATUSES = new Set(['queued', 'running'])

/**
 * The stage to show when the reader hasn't picked one: the running stage,
 * else the failed one, else the last that did anything.
 */
export function defaultStage(p: PipelineDetail): StageView | undefined {
  return (
    p.stages.find((s) => s.status === 'running') ??
    p.stages.find((s) => s.status === 'failed') ??
    [...p.stages]
      .reverse()
      .find((s) => s.status !== 'pending' && s.status !== 'skipped') ??
    p.stages[0]
  )
}
