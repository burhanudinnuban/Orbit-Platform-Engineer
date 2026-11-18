import apiClient from '@/services/http'
import type { PipelineDetail, PipelineSummary } from './pipelines.types'

const seg = encodeURIComponent

const endpoints = {
  list: (app: string) => `/api/apps/${seg(app)}/pipelines`,
  pipeline: (id: string) => `/api/pipelines/${seg(id)}`,
  cancel: (id: string) => `/api/pipelines/${seg(id)}/cancel`,
}

export function fetchPipelinesApi(app: string): Promise<PipelineSummary[]> {
  return apiClient.get<PipelineSummary[]>(endpoints.list(app))
}

/** Queues a run of the head of `main`. */
export function runPipelineApi(app: string): Promise<PipelineSummary> {
  return apiClient.post<PipelineSummary>(endpoints.list(app))
}

export function fetchPipelineApi(id: string): Promise<PipelineDetail> {
  return apiClient.get<PipelineDetail>(endpoints.pipeline(id))
}

export function cancelPipelineApi(id: string): Promise<PipelineSummary> {
  return apiClient.post<PipelineSummary>(endpoints.cancel(id))
}
