import type { FastifyInstance } from 'fastify'
import type { ServerDeps } from '../app/server.js'
import { queueBranchHead } from '../features/ci/ci.triggers.js'
import { pipelineDetail, pipelineSummary } from '../features/ci/ci.views.js'
import { HttpProblem } from '../lib/httpProblem.js'
import { nowIso } from '../lib/util.js'
import { requireApp } from './routes.helpers.js'

/** List, start, inspect and cancel pipeline runs. */
export function registerPipelineRoutes(
  app: FastifyInstance,
  deps: ServerDeps
): void {
  const { platform } = deps
  const { store } = platform

  app.get<{ Params: { name: string } }>(
    '/api/apps/:name/pipelines',
    async (req) =>
      store
        .listPipelines(requireApp(store, req.params.name).name)
        .map(pipelineSummary)
  )

  app.post<{ Params: { name: string } }>(
    '/api/apps/:name/pipelines',
    async (req, reply) => {
      const record = requireApp(store, req.params.name)
      if (record.status === 'deleting' || record.status === 'deleted') {
        throw new HttpProblem(409, `application is ${record.status}`)
      }
      if (!record.outputs.repositoryUrl)
        throw new HttpProblem(409, 'the repository has not been created yet')
      const p = await queueBranchHead(platform, record.name, 'main', 'manual')
      return reply.status(201).send(pipelineSummary(p))
    }
  )

  app.get<{ Params: { id: string } }>('/api/pipelines/:id', async (req) => {
    const p = store.getPipeline(req.params.id)
    if (!p) throw new HttpProblem(404, 'pipeline not found')
    return pipelineDetail(platform, p)
  })

  app.post<{ Params: { id: string } }>(
    '/api/pipelines/:id/cancel',
    async (req) => {
      const p = store.getPipeline(req.params.id)
      if (!p) throw new HttpProblem(404, 'pipeline not found')
      if (p.status !== 'queued' && p.status !== 'running')
        throw new HttpProblem(409, `pipeline is already ${p.status}`)
      if (deps.ci) deps.ci.cancel(p.id)
      else if (p.status === 'queued')
        store.updatePipeline(p.id, { status: 'canceled', finishedAt: nowIso() })
      else
        throw new HttpProblem(
          409,
          'the CI engine is not running in this process'
        )
      return pipelineSummary(store.getPipeline(p.id)!)
    }
  )
}
