import type { FastifyInstance } from 'fastify'
import type { ServerDeps } from '../app/server.js'
import { CreateAppSchema } from '../features/apps/apps.schema.js'
import { appDetail, appSummary } from '../features/apps/apps.views.js'
import { wantsCloud } from '../features/terraform/terraform.cloud.js'
import { HttpProblem } from '../lib/httpProblem.js'
import { errorMessage } from '../lib/logger.js'
import { requireApp } from './routes.helpers.js'

/** Create, read and delete applications, and retry their workflows. */
export function registerAppRoutes(
  app: FastifyInstance,
  deps: ServerDeps
): void {
  const { platform, engine } = deps
  const { store, config } = platform

  app.get('/api/apps', async () =>
    store.listApps().map((a) => appSummary(platform, a))
  )

  app.post('/api/apps', async (req, reply) => {
    const body = CreateAppSchema.parse(req.body)
    const template = platform.templates.get(body.template)
    if (!template)
      throw new HttpProblem(400, `unknown template "${body.template}"`)
    const language = body.language ?? template.language
    if (!template.languages.includes(language))
      throw new HttpProblem(
        400,
        `template "${template.id}" comes in ${template.languages.join(' and ')}, not ${language}`
      )
    const unknownEnvs = body.environments.filter(
      (e) => !config.environments.includes(e)
    )
    if (unknownEnvs.length) {
      throw new HttpProblem(
        400,
        `unknown environment(s): ${unknownEnvs.join(', ')} (allowed: ${config.environments.join(', ')})`
      )
    }
    const existing = store.getApp(body.name)
    if (existing && existing.status !== 'deleted')
      throw new HttpProblem(409, `application ${body.name} already exists`)
    if (wantsCloud(body.options) && config.cloud.provider === 'none') {
      throw new HttpProblem(
        400,
        'cloud resources (object storage, queue) are disabled on this platform (ORBIT_CLOUD=none)'
      )
    }
    if (existing) store.purgeApp(body.name)
    const environments = config.environments.filter((e) =>
      body.environments.includes(e)
    )
    const record = store.insertApp({
      name: body.name,
      team: body.team,
      template: body.template,
      language,
      description: body.description,
      environments,
      options: body.options,
      status: 'provisioning',
    })
    engine.create(record.name, 'provision')
    platform.log.info(
      { app: record.name, team: record.team, environments },
      'application created'
    )
    return reply.status(201).send(appDetail(platform, engine, record))
  })

  app.get<{ Params: { name: string } }>('/api/apps/:name', async (req) =>
    appDetail(platform, engine, requireApp(store, req.params.name))
  )

  app.delete<{ Params: { name: string } }>(
    '/api/apps/:name',
    async (req, reply) => {
      const record = requireApp(store, req.params.name)
      if (record.status === 'deleting' || record.status === 'deleted') {
        throw new HttpProblem(409, `application is already ${record.status}`)
      }
      const running = store
        .listWorkflows(record.name)
        .find((w) => w.status === 'pending' || w.status === 'running')
      if (running)
        throw new HttpProblem(
          409,
          'provisioning is still running; wait for it to finish or fail'
        )
      store.setAppStatus(record.name, 'deleting')
      const wf = engine.create(record.name, 'teardown')
      platform.log.info({ app: record.name }, 'application teardown requested')
      return reply.status(202).send(engine.view(wf))
    }
  )

  app.post<{ Params: { name: string; id: string } }>(
    '/api/apps/:name/workflows/:id/retry',
    async (req) => {
      requireApp(store, req.params.name)
      const wf = store.getWorkflow(req.params.id)
      if (!wf || wf.app !== req.params.name)
        throw new HttpProblem(404, 'workflow not found')
      try {
        return engine.view(engine.retry(wf.id))
      } catch (err) {
        throw new HttpProblem(409, errorMessage(err))
      }
    }
  )
}
