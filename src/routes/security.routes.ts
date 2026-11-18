import type { FastifyInstance } from 'fastify'
import type { ServerDeps } from '../app/server.js'
import { requireApp } from './routes.helpers.js'

/** Security findings: the app's current set, or one pipeline run's. */
export function registerSecurityRoutes(
  app: FastifyInstance,
  deps: ServerDeps
): void {
  const { store } = deps.platform

  app.get<{ Params: { name: string }; Querystring: { pipelineId?: string } }>(
    '/api/apps/:name/findings',
    async (req) => {
      const record = requireApp(store, req.params.name)
      return req.query.pipelineId
        ? store.pipelineFindings(record.name, req.query.pipelineId)
        : store.currentFindings(record.name)
    }
  )
}
