import apiClient from '@/services/http'
import type {
  AppDetail,
  AppSummary,
  CreateAppRequest,
  WorkflowView,
} from './apps.types'

const seg = encodeURIComponent

const endpoints = {
  list: '/api/apps',
  app: (name: string) => `/api/apps/${seg(name)}`,
  retry: (name: string, workflowId: string) =>
    `/api/apps/${seg(name)}/workflows/${seg(workflowId)}/retry`,
}

export function fetchAppsApi(): Promise<AppSummary[]> {
  return apiClient.get<AppSummary[]>(endpoints.list)
}

/** Creates the app and starts its provisioning workflow. */
export function createAppApi(req: CreateAppRequest): Promise<AppDetail> {
  return apiClient.post<AppDetail>(endpoints.list, req)
}

export function fetchAppApi(name: string): Promise<AppDetail> {
  return apiClient.get<AppDetail>(endpoints.app(name))
}

/** Starts the teardown workflow; the app is gone once it succeeds. */
export function deleteAppApi(name: string): Promise<WorkflowView> {
  return apiClient.delete<WorkflowView>(endpoints.app(name))
}

/** Re-runs a failed workflow from the step that failed. */
export function retryWorkflowApi(
  name: string,
  workflowId: string
): Promise<WorkflowView> {
  return apiClient.post<WorkflowView>(endpoints.retry(name, workflowId))
}
