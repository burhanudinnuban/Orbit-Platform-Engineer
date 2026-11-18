import type { FastifyRequest } from 'fastify'
import type { AppRecord, Store } from '../app/store.js'
import type { Config } from '../config/env.js'
import { HttpProblem } from '../lib/httpProblem.js'

/** The app named in the URL, or a 404. */
export function requireApp(store: Store, name: string): AppRecord {
  const record = store.getApp(name)
  if (!record) throw new HttpProblem(404, `application ${name} not found`)
  return record
}

/** A 403 unless the caller sent ORBIT_ADMIN_TOKEN (the server's onRequest hook sets req.role). */
export function requireAdmin(req: FastifyRequest, config: Config): void {
  if (req.role === 'admin') return
  throw new HttpProblem(
    403,
    config.adminToken
      ? 'only platform admins can do this: save the admin token on the Platform page'
      : 'no platform admin is configured: set ORBIT_ADMIN_TOKEN in .env (npm run bootstrap generates one) and restart Orbit'
  )
}
