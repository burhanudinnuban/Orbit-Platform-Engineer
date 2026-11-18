import apiClient from '@/services/http'
import type { PlatformInfo } from './platform.types'

const endpoints = {
  platform: '/api/platform',
}

/** Version, environments, templates and the health of every platform component. */
export function fetchPlatformApi(): Promise<PlatformInfo> {
  return apiClient.get<PlatformInfo>(endpoints.platform)
}
