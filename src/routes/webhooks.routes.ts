import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ServerDeps } from '../app/server.js'
import {
  handlePush,
  verifySignature,
  type PushPayload,
} from '../features/ci/ci.triggers.js'

/**
 * `POST /webhooks/gitea`: a push queues a pipeline.
 *
 * Outside `/api/`, so the API token hook does not apply; the HMAC signature
 * over the raw body (kept by the server's JSON parser) is the authentication.
 */
export function registerWebhookRoutes(
  app: FastifyInstance,
  deps: ServerDeps
): void {
  const { platform } = deps
  const { config } = platform

  app.post(
    '/webhooks/gitea',
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!config.webhookSecret)
        return reply
          .status(403)
          .send({ error: 'ORBIT_WEBHOOK_SECRET is not configured' })
      const signature = req.headers['x-gitea-signature']
      if (
        !verifySignature(
          config.webhookSecret,
          req.rawBody ?? '',
          Array.isArray(signature) ? signature[0] : signature
        )
      ) {
        return reply.status(401).send({ error: 'invalid webhook signature' })
      }
      const event = req.headers['x-gitea-event']
      if (event !== 'push')
        return reply.status(200).send({ ignored: `event ${String(event)}` })
      const result = handlePush(platform, req.body as PushPayload)
      if ('queued' in result) {
        platform.log.info(
          { app: result.queued.app, pipeline: result.queued.number },
          'pipeline queued by webhook'
        )
        return reply.status(202).send({ queued: result.queued.id })
      }
      return reply.status(200).send(result)
    }
  )
}
