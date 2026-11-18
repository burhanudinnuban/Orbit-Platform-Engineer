import type { FastifyInstance } from 'fastify'
import type { ServerDeps } from '../app/server.js'
import { errorMessage } from '../lib/logger.js'
import { withTimeout } from '../lib/util.js'
import type { ComponentHealth, PlatformInfo } from '../types/contract.js'

/** `GET /api/platform`: version, environments, templates and the health of every component. */
export function registerPlatformRoutes(
  app: FastifyInstance,
  deps: ServerDeps
): void {
  const { platform } = deps
  const { store, config } = platform

  /*
   * Cached for ten seconds: the portal polls this from every open tab, and each
   * answer probes Kubernetes, Gitea, Grafana, Prometheus and the cloud.
   */
  let healthCache: { at: number; components: ComponentHealth[] } | undefined

  const check = async (
    name: string,
    fn: () => Promise<string | undefined>
  ): Promise<ComponentHealth> => {
    try {
      const message = await withTimeout(fn(), 4000, name)
      return { name, ok: true, message }
    } catch (err) {
      return { name, ok: false, message: errorMessage(err) }
    }
  }

  const componentHealth = async (): Promise<ComponentHealth[]> => {
    if (healthCache && Date.now() - healthCache.at < 10_000)
      return healthCache.components
    const enabled = (c: string) => config.components.has(c)
    const components = await Promise.all([
      check('Kubernetes', async () => {
        const kube = platform.kube()
        await kube.core.readNamespace({ name: config.platformNamespace })
        return `context ${kube.context}`
      }),
      check(
        'Git server (Gitea)',
        async () => `Gitea ${await platform.gitea.health()}`
      ),
      check(
        'Grafana',
        async () => `Grafana ${await platform.grafana.health()}`
      ),
      check('Prometheus', () => platform.prometheus.health()),
      config.cloud.provider === 'floci'
        ? check('Cloud (Floci, local AWS)', () => platform.floci.health())
        : check('Cloud', async () =>
            config.cloud.provider === 'aws'
              ? `AWS ${config.cloud.region}`
              : 'disabled (ORBIT_CLOUD=none)'
          ),
      check('Workflow engine', async () => {
        if (!enabled('worker'))
          throw new Error('not running in this process (ORBIT_COMPONENTS)')
        return `${store.activeWorkflows().length} active workflow(s)`
      }),
      check('CI engine', async () => {
        if (!deps.ci)
          throw new Error('not running in this process (ORBIT_COMPONENTS)')
        return `${deps.ci.activeCount} running, ${store.queuedPipelines().length} queued`
      }),
      check('GitOps controller', async () => {
        const g = deps.gitops
        if (!g)
          throw new Error('not running in this process (ORBIT_COMPONENTS)')
        if (g.status.lastError) throw new Error(g.status.lastError)
        return `${g.status.applications} application(s), last sync ${g.status.lastRunAt ?? 'pending'}`
      }),
    ])
    healthCache = { at: Date.now(), components }
    return components
  }

  app.get('/api/platform', async (): Promise<PlatformInfo> => {
    let kubeContext = config.kube.context
    try {
      kubeContext = platform.kube().context
    } catch {
      // reported in components
    }
    return {
      version: config.version,
      kubeContext,
      runtime: config.runtime,
      environments: config.environments,
      templates: platform.templates
        .list()
        .map(({ id, name, description, language, languages }) => ({
          id,
          name,
          description,
          language,
          languages,
        })),
      components: await componentHealth(),
      links: {
        git: config.gitea.url,
        grafana: config.grafana.url,
        prometheus: config.prometheus.url,
        cloud: config.cloud.url || undefined,
      },
      cloud: {
        provider: config.cloud.provider,
        region: config.cloud.region,
        namePrefix: config.cloud.namePrefix,
      },
    }
  })
}
