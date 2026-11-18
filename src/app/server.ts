import { timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import path from 'node:path'
import fastifyStatic from '@fastify/static'
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { CiEngine } from '../features/ci/ci.engine.js'
import type { GitOpsController } from '../features/gitops/gitops.controller.js'
import type { VersionManager } from '../features/versions/versions.manager.js'
import type { WorkflowEngine } from '../features/workflow/workflow.engine.js'
import { HttpProblem } from '../lib/httpProblem.js'
import { errorMessage } from '../lib/logger.js'
import { registerAppRoutes } from '../routes/apps.routes.js'
import { registerDeploymentRoutes } from '../routes/deployments.routes.js'
import { registerObservabilityRoutes } from '../routes/observability.routes.js'
import { registerPipelineRoutes } from '../routes/pipelines.routes.js'
import { registerPlatformRoutes } from '../routes/platform.routes.js'
import { registerSecurityRoutes } from '../routes/security.routes.js'
import { registerVersionRoutes } from '../routes/versions.routes.js'
import { registerWebhookRoutes } from '../routes/webhooks.routes.js'
import type { UserRole } from '../types/contract.js'
import type { Platform } from './platform.js'

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: string
    /** Set for every /api/ request by the auth hook. */
    role?: UserRole
  }
}

export interface ServerDeps {
  platform: Platform
  engine: WorkflowEngine
  ci?: CiEngine
  gitops?: GitOpsController
  versions?: VersionManager
}

const sameSecret = (given: string, expected: string) => {
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * The Fastify instance: body parsing, errors, API-token auth, every route
 * module under src/routes, and the portal's production build when present.
 */
export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const { platform } = deps
  const { config } = platform
  const app = Fastify({
    loggerInstance: platform.log as FastifyBaseLogger,
    disableRequestLogging: true,
    bodyLimit: 5 * 1024 * 1024,
  })

  // Keep the raw body (webhook signatures) and accept empty JSON bodies.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (req, body, done) => {
      const text = typeof body === 'string' ? body : body.toString('utf8')
      req.rawBody = text
      if (!text.trim()) return done(null, {})
      try {
        done(null, JSON.parse(text))
      } catch {
        done(new HttpProblem(400, 'request body is not valid JSON'), undefined)
      }
    }
  )

  app.setErrorHandler((err: unknown, _req, reply) => {
    if (err instanceof z.ZodError) {
      return reply.status(400).send({
        error: 'validation failed',
        details: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      })
    }
    if (err instanceof HttpProblem)
      return reply
        .status(err.statusCode)
        .send({ error: err.message, details: err.details })
    const status =
      typeof (err as { statusCode?: unknown }).statusCode === 'number'
        ? (err as { statusCode: number }).statusCode
        : 500
    if (status >= 500) platform.log.error({ err }, 'request failed')
    return reply.status(status).send({ error: errorMessage(err) })
  })

  // The admin token makes a caller admin and also passes the API-token check;
  // without ORBIT_API_TOKEN everyone else is a member.
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return
    const given = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
    if (config.adminToken && given && sameSecret(given, config.adminToken)) {
      req.role = 'admin'
      return
    }
    if (config.apiToken && !sameSecret(given, config.apiToken))
      return reply.status(401).send({ error: 'missing or invalid API token' })
    req.role = 'member'
  })

  registerPlatformRoutes(app, deps)
  registerAppRoutes(app, deps)
  registerPipelineRoutes(app, deps)
  registerDeploymentRoutes(app, deps)
  registerSecurityRoutes(app, deps)
  registerObservabilityRoutes(app, deps)
  registerWebhookRoutes(app, deps)
  registerVersionRoutes(app, deps)

  app.get('/healthz', async () => ({ ok: true }))

  // ── portal (production build) ─────────────────────────────────────────────
  const portalDist = path.join(config.rootDir, 'portal', 'dist')
  if (existsSync(path.join(portalDist, 'index.html'))) {
    await app.register(fastifyStatic, { root: portalDist, wildcard: false })
    app.setNotFoundHandler((req, reply) => {
      if (
        req.method === 'GET' &&
        !req.url.startsWith('/api/') &&
        !req.url.startsWith('/webhooks/')
      ) {
        return reply.sendFile('index.html')
      }
      return reply
        .status(404)
        .send({ error: `route ${req.method} ${req.url} not found` })
    })
  } else {
    app.setNotFoundHandler((req, reply) =>
      reply
        .status(404)
        .send({ error: `route ${req.method} ${req.url} not found` })
    )
  }

  return app
}
