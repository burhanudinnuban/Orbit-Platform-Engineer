import path from 'node:path'
import { Floci } from '../services/floci.js'
import { Gitea } from '../services/gitea.js'
import { Grafana } from '../services/grafana.js'
import { Prometheus } from '../services/prometheus.js'
import type { Config } from '../config/env.js'
import { Events } from './events.js'
import { authUrl, GitWorkspace } from '../services/git.js'
import { lazyKube, type Kube } from '../services/kube.js'
import type { Logger } from '../lib/logger.js'
import { openStore, type Store } from './store.js'
import { TemplateCatalog } from '../features/templates/templates.catalog.js'

/** Every service a component needs, created once per process. */
export interface Platform {
  config: Config
  log: Logger
  store: Store
  events: Events
  gitea: Gitea
  grafana: Grafana
  prometheus: Prometheus
  /** Local AWS emulator (only meaningful when ORBIT_CLOUD=floci). */
  floci: Floci
  templates: TemplateCatalog
  /** Kubernetes clients for the allowed context; throws a clear error when unavailable. */
  kube: () => Kube
  /** Writable clone of the gitops repo (serialized commits). */
  gitopsWriter: () => GitWorkspace
  /** Authenticated clone URL for a repository on the Git server, as seen from this process. */
  repoAuthUrl: (fullName: string) => string
}

export function createPlatform(
  config: Config,
  log: Logger,
  store?: Store
): Platform {
  const repoAuthUrl = (fullName: string) => {
    if (!config.gitea.token)
      throw new Error('GITEA_TOKEN is not set. Run `npm run bootstrap`.')
    return authUrl(
      config.gitea.url,
      fullName,
      config.gitea.user,
      config.gitea.token
    )
  }
  let writer: GitWorkspace | undefined
  return {
    config,
    log,
    store: store ?? openStore(config.dataDir),
    events: new Events(),
    gitea: new Gitea(config),
    grafana: new Grafana(config),
    prometheus: new Prometheus(config),
    floci: new Floci(config),
    templates: new TemplateCatalog(config.rootDir),
    kube: lazyKube(config),
    repoAuthUrl,
    gitopsWriter: () => {
      writer ??= new GitWorkspace(
        path.join(config.dataDir, 'git', 'gitops-writer'),
        repoAuthUrl(config.gitea.gitopsRepo)
      )
      return writer
    },
  }
}
