import apiClient from '@/services/http'
import type { SessionInfo } from './auth.types'

const endpoints = {
  session: '/api/session',
}

/** Who the saved token makes this browser: admin or member. */
export function fetchSessionApi(): Promise<SessionInfo> {
  return apiClient.get<SessionInfo>(endpoints.session)
}
