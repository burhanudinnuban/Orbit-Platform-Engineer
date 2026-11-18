import type { Config } from '../config/env.js'
import { errorMessage } from '../lib/logger.js'
import { httpJson } from './http.js'

interface HealthBody {
  version?: string
  edition?: string
  services?: Record<string, string>
}

/** Health paths, newest first: Floci's own, then its LocalStack-compatible one. */
const HEALTH_PATHS = ['/_floci/health', '/_localstack/health']

/** Floci, the local AWS emulator. Orbit only checks its health; Terraform does the provisioning. */
export class Floci {
  constructor(private readonly config: Config) {}

  /**
   * Healthy only when a health path answers 2xx. Any other HTTP answer (a 404 from
   * another server bound to the same port, say) is reported, not trusted.
   */
  async health(): Promise<string> {
    const base = this.config.cloud.url
    if (!base) throw new Error('ORBIT_CLOUD is not floci')
    const failures: string[] = []
    for (const path of HEALTH_PATHS) {
      try {
        const body = await httpJson<HealthBody>(`${base}${path}`, {
          timeoutMs: 3000,
        })
        const services =
          body && typeof body === 'object' && body.services
            ? Object.keys(body.services).length
            : 0
        const version =
          body && typeof body === 'object' ? body.version : undefined
        return [
          `Floci ${version ?? ''}`.trim(),
          services ? `${services} services` : '',
          base,
        ]
          .filter(Boolean)
          .join(' · ')
      } catch (err) {
        failures.push(errorMessage(err).split('\n')[0]!.slice(0, 120))
      }
    }
    throw new Error(`no Floci at ${base} (${failures.join('; ')})`)
  }
}
