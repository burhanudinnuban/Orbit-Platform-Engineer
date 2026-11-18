import apiClient from '@/services/http'
import type { PlatformUpdate, VersionsResponse } from './versions.types'

const seg = encodeURIComponent

const endpoints = {
  versions: '/api/platform/versions',
  check: '/api/platform/versions/check',
  updateAll: '/api/platform/versions/update-all',
  update: (id: string) => `/api/platform/versions/${seg(id)}/update`,
  rollback: (id: string) => `/api/platform/versions/${seg(id)}/rollback`,
  updateRun: (id: string) => `/api/platform/updates/${seg(id)}`,
}

/** Every platform component's version, newer releases and recent updates. */
export function fetchVersionsApi(): Promise<VersionsResponse> {
  return apiClient.get<VersionsResponse>(endpoints.versions)
}

/** Ask the registries for new releases now (otherwise every six hours). */
export function checkVersionsApi(): Promise<VersionsResponse> {
  return apiClient.post<VersionsResponse>(endpoints.check)
}

/** Admin: queue an update of one component to a version (tag). */
export function updateComponentApi(
  id: string,
  version: string
): Promise<PlatformUpdate> {
  return apiClient.post<PlatformUpdate>(endpoints.update(id), { version })
}

/** Admin: queue a return to the version before the last update. */
export function rollbackComponentApi(id: string): Promise<PlatformUpdate> {
  return apiClient.post<PlatformUpdate>(endpoints.rollback(id))
}

/** Admin: queue the recommended update of every component that has one. */
export function updateAllApi(): Promise<PlatformUpdate[]> {
  return apiClient.post<PlatformUpdate[]>(endpoints.updateAll)
}

/** One update with its full log. */
export function fetchPlatformUpdateApi(id: string): Promise<PlatformUpdate> {
  return apiClient.get<PlatformUpdate>(endpoints.updateRun(id))
}
