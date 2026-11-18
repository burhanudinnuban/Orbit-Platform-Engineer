import apiClient from '@/services/http'
import type { DeploymentStatus } from './deployments.types'

const endpoints = {
  list: (app: string) => `/api/apps/${encodeURIComponent(app)}/deployments`,
}

export function fetchDeploymentsApi(app: string): Promise<DeploymentStatus[]> {
  return apiClient.get<DeploymentStatus[]>(endpoints.list(app))
}
