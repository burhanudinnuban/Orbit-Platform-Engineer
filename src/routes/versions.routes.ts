import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { ServerDeps } from '../app/server.js'
import { HttpProblem } from '../lib/httpProblem.js'
import type { SessionInfo } from '../types/contract.js'
import type { VersionManager } from '../features/versions/versions.manager.js'
import { requireAdmin } from './routes.helpers.js'

const UpdateSchema = z.object({ version: z.string().min(1).max(128) })

/** `GET /api/session` and Platform → Versions (changes need the admin token). */
export function registerVersionRoutes(
  app: FastifyInstance,
  deps: ServerDeps
): void {
  const { config } = deps.platform

  app.get('/api/session', async (req): Promise<SessionInfo> => ({
    role: req.role ?? 'member',
    adminConfigured: Boolean(config.adminToken),
  }))

  const versions = (): VersionManager => {
    if (!deps.versions)
      throw new HttpProblem(
        503,
        'version management is not running in this process'
      )
    return deps.versions
  }

  app.get('/api/platform/versions', async () => versions().versions())

  app.post('/api/platform/versions/check', async () => {
    await versions().check()
    return versions().versions()
  })

  app.post('/api/platform/versions/update-all', async (req, reply) => {
    requireAdmin(req, config)
    return reply.status(202).send(await versions().updateAll())
  })

  app.post<{ Params: { id: string } }>(
    '/api/platform/versions/:id/update',
    async (req, reply) => {
      requireAdmin(req, config)
      const { version } = UpdateSchema.parse(req.body)
      return reply
        .status(202)
        .send(await versions().requestUpdate(req.params.id, version.trim()))
    }
  )

  app.post<{ Params: { id: string } }>(
    '/api/platform/versions/:id/rollback',
    async (req, reply) => {
      requireAdmin(req, config)
      return reply.status(202).send(await versions().rollback(req.params.id))
    }
  )

  app.get<{ Params: { id: string } }>(
    '/api/platform/updates/:id',
    async (req) => versions().getUpdate(req.params.id)
  )
}
