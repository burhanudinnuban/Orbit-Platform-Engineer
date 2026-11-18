import type { FastifyInstance } from 'fastify'
import type { ServerDeps } from '../app/server.js'
import { deploymentsFor } from '../features/apps/apps.views.js'
import { requireApp } from './routes.helpers.js'

/** Deployment status per environment, as the GitOps controller last saw it. */
export function registerDeploymentRoutes(
  app: FastifyInstance,
  deps: ServerDeps
): void {
  const { platform } = deps

  app.get<{ Params: { name: string } }>(
    '/api/apps/:name/deployments',
    async (req) =>
      deploymentsFor(platform, requireApp(platform.store, req.params.name))
  )
}
