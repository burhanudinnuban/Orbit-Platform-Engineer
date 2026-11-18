import type {
  PipelineDetail,
  PipelineSummary,
  StageView,
} from '../../types/contract.js'
import type { Platform } from '../../app/platform.js'
import type { PipelineRecord } from '../../app/store.js'

/** A pipeline row as the API, CLI and portal list it. */
export function pipelineSummary(p: PipelineRecord): PipelineSummary {
  return {
    id: p.id,
    app: p.app,
    number: p.number,
    commitSha: p.commitSha,
    commitMessage: p.commitMessage,
    branch: p.branch,
    trigger: p.trigger,
    status: p.status,
    createdAt: p.createdAt,
    startedAt: p.startedAt,
    finishedAt: p.finishedAt,
  }
}

/** A pipeline with its stages and their logs. */
export function pipelineDetail(
  platform: Platform,
  p: PipelineRecord
): PipelineDetail {
  const stages: StageView[] = platform.store.listStages(p.id).map((s) => ({
    id: s.id,
    name: s.name,
    type: s.type,
    status: s.status,
    startedAt: s.startedAt,
    finishedAt: s.finishedAt,
    logs: s.logs,
    error: s.error,
  }))
  return { ...pipelineSummary(p), stages }
}
