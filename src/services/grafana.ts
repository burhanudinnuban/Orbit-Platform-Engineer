import type { Config } from '../config/env.js'
import { basicAuth, httpJson } from './http.js'

export class Grafana {
  constructor(private readonly config: Config) {}

  private headers(): Record<string, string> {
    if (!this.config.grafana.password)
      throw new Error('GRAFANA_PASSWORD is not set. Run `npm run bootstrap`.')
    return {
      authorization: basicAuth(
        this.config.grafana.user,
        this.config.grafana.password
      ),
    }
  }

  private url(path: string): string {
    return `${this.config.grafana.url}${path}`
  }

  async health(): Promise<string> {
    const h = await httpJson<{ version?: string; database?: string }>(
      this.url('/api/health'),
      { timeoutMs: 3000 }
    )
    if (!this.config.grafana.password)
      throw new Error('Grafana reachable, but GRAFANA_PASSWORD is not set')
    return h?.version ?? 'unknown'
  }

  async ensureFolder(uid: string, title: string): Promise<void> {
    const existing = await httpJson(this.url(`/api/folders/${uid}`), {
      headers: this.headers(),
      allow404: true,
    })
    if (existing) return
    await httpJson(this.url('/api/folders'), {
      method: 'POST',
      headers: this.headers(),
      body: { uid, title },
    })
  }

  async upsertDashboard(
    dashboard: Record<string, unknown>,
    folderUid: string
  ): Promise<{ url: string }> {
    const res = await httpJson<{ url: string }>(
      this.url('/api/dashboards/db'),
      {
        method: 'POST',
        headers: this.headers(),
        body: {
          dashboard,
          folderUid,
          overwrite: true,
          message: 'Managed by Orbit',
        },
      }
    )
    return { url: `${this.config.grafana.url}${res?.url ?? ''}` }
  }

  async deleteDashboard(uid: string): Promise<void> {
    await httpJson(this.url(`/api/dashboards/uid/${uid}`), {
      method: 'DELETE',
      headers: this.headers(),
      allow404: true,
    })
  }
}
