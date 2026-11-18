import { buildServer } from './app/server.js'
import { CiEngine } from './features/ci/ci.engine.js'
import { loadConfig, loadDotEnv } from './config/env.js'
import { createLogger, errorMessage } from './lib/logger.js'
import { createPlatform } from './app/platform.js'
import { GitOpsController } from './features/gitops/gitops.controller.js'
import { VersionManager } from './features/versions/versions.manager.js'
import { applyImageOverrides } from './features/versions/versions.overrides.js'
import { WorkflowEngine } from './features/workflow/workflow.engine.js'
import { GOLDEN_PATH } from './features/workflow/workflow.goldenPath.js'

loadDotEnv()
const config = loadConfig()
const log = createLogger(config.logLevel)
const platform = createPlatform(config, log)

try {
  const kube = platform.kube()
  log.info({ context: kube.context }, 'kubernetes context verified')
} catch (err) {
  log.warn(errorMessage(err))
}
if (!config.gitea.token)
  log.warn(
    'GITEA_TOKEN is not set — run `npm run bootstrap` first. Provisioning will fail until then.'
  )

const engine = new WorkflowEngine(platform, GOLDEN_PATH)
const ci = config.components.has('ci') ? new CiEngine(platform) : undefined
const gitops = config.components.has('gitops')
  ? new GitOpsController(platform)
  : undefined

// Admin-chosen CI images apply in every process; updates run where the API does.
applyImageOverrides(config, platform.store)
const versions = config.components.has('api')
  ? new VersionManager(platform)
  : undefined

if (config.components.has('worker')) engine.start()
ci?.start()
gitops?.start()
versions?.start()

const server = config.components.has('api')
  ? await buildServer({ platform, engine, ci, gitops, versions })
  : undefined
if (server) {
  await server.listen({ port: config.port, host: config.host })
  log.info(
    `Orbit API listening on http://${config.host}:${config.port} · portal ${config.portalUrl}`
  )
}
log.info(
  { components: [...config.components] },
  `Orbit ${config.version} started`
)

let shuttingDown = false
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  log.info({ signal }, 'shutting down')
  versions?.stop()
  gitops?.stop()
  await ci?.stop()
  await server?.close()
  await engine.stop()
  platform.store.close()
  process.exit(0)
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
