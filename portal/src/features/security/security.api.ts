import apiClient from '@/services/http'
import type { Finding } from './security.types'

const seg = encodeURIComponent

const endpoints = {
  findings: (app: string, pipelineId?: string) =>
    `/api/apps/${seg(app)}/findings${pipelineId ? `?pipelineId=${seg(pipelineId)}` : ''}`,
}

/** The app's current findings, or those of one pipeline run. */
export function fetchFindingsApi(
  app: string,
  pipelineId?: string
): Promise<Finding[]> {
  return apiClient.get<Finding[]>(endpoints.findings(app, pipelineId))
}
