import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import * as k8s from '@kubernetes/client-node'
import type {
  DeploymentStatus,
  HealthStatus,
  ResourceStatus,
} from '../../types/contract.js'
import { appUrl } from '../../config/env.js'
import { GitWorkspace } from '../../services/git.js'
import { isNotFound, kubeErrorMessage, type Kube } from '../../services/kube.js'
import { errorMessage } from '../../lib/logger.js'
import type { Platform } from '../../app/platform.js'
import { nowIso, shortSha } from '../../lib/util.js'
import { diffObject } from './gitops.diff.js'
import {
  APPLICATION_FILE,
  readYamlFile,
  VALUES_FILE,
  type ApplicationSpec,
} from './gitops.files.js'
import {
  assessHealth,
  BAD_CONTAINER_REASONS,
  worstHealth,
} from './gitops.health.js'
import {
  APPLICATION_LABEL,
  applicationId,
  MANAGED_BY,
  objectKey,
  PRUNABLE_KINDS,
  renderManifests,
  type ManifestObject,
} from './gitops.render.js'

export const FIELD_MANAGER = 'orbit-gitops'

interface DiscoveredApp {
  app: string
  env: string
  dir: string
}

export interface ControllerStatus {
  lastRunAt?: string
  lastRevision?: string
  lastError?: string
  applications: number
}

/**
 * Orbit's GitOps controller: continuously reconciles the gitops repo into the
 * cluster with server-side apply, detects drift, prunes and reports health.
 */
export class GitOpsController {
  private workspace?: GitWorkspace
  private timer?: NodeJS.Timeout
  private debounce?: NodeJS.Timeout
  private running = false
  private rerun = false
  private stopped = false
  private lastApplied = new Map<string, string>()
  readonly status: ControllerStatus = { applications: 0 }

  constructor(private readonly platform: Platform) {}

  start(): void {
    this.platform.events.on('gitops:sync', ({ reason }) => this.trigger(reason))
    this.trigger('startup')
  }

  stop(): void {
    this.stopped = true
    clearTimeout(this.timer)
    clearTimeout(this.debounce)
  }

  /** Request a reconcile soon (coalesces bursts of requests). */
  trigger(reason: string): void {
    if (this.stopped) return
    clearTimeout(this.debounce)
    this.debounce = setTimeout(() => void this.reconcile(reason), 300)
  }

  private scheduleNext(ms: number): void {
    if (this.stopped) return
    clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.reconcile('interval'), ms)
  }

  async reconcile(reason: string): Promise<void> {
    if (this.running) {
      this.rerun = true
      return
    }
    this.running = true
    let progressing = false
    try {
      do {
        this.rerun = false
        progressing = await this.reconcileOnce()
      } while (this.rerun && !this.stopped)
      this.status.lastError = undefined
    } catch (err) {
      this.status.lastError = errorMessage(err)
      this.platform.log.warn(
        { reason, error: this.status.lastError },
        'gitops reconcile failed'
      )
    } finally {
      this.running = false
      this.status.lastRunAt = nowIso()
      // Poll quickly while rollouts are in progress so CI deploy stages get fast feedback.
      this.scheduleNext(
        progressing ? 3000 : this.platform.config.gitops.intervalSeconds * 1000
      )
    }
  }

  /** One full pass. Returns true when any application is still progressing. */
  private async reconcileOnce(): Promise<boolean> {
    const { config, store, events } = this.platform
    this.workspace ??= new GitWorkspace(
      path.join(config.dataDir, 'git', 'gitops-reader'),
      this.platform.repoAuthUrl(config.gitea.gitopsRepo)
    )
    const revision = await this.workspace.sync()
    this.status.lastRevision = revision
    const kube = this.platform.kube()
    const discovered = await discoverApplications(this.workspace.dir)
    this.status.applications = discovered.length

    let progressing = false
    const seen = new Set<string>()
    for (const found of discovered) {
      seen.add(`${found.app}/${found.env}`)
      let result: DeploymentStatus
      try {
        result = await this.reconcileApplication(kube, found, revision)
      } catch (err) {
        result = {
          app: found.app,
          env: found.env,
          namespace: `${found.app}-${found.env}`,
          syncStatus: 'Error',
          health: 'Unknown',
          revision,
          message: errorMessage(err),
          resources: [],
        }
      }
      if (result.health === 'Progressing') progressing = true
      const previous = store.getDeployment(found.app, found.env)
      store.upsertDeployment(result)
      if (
        !previous ||
        previous.syncStatus !== result.syncStatus ||
        previous.health !== result.health ||
        previous.image !== result.image ||
        previous.message !== result.message
      ) {
        events.emit('deployment:updated', { app: found.app, env: found.env })
        this.platform.log.info(
          {
            app: found.app,
            env: found.env,
            sync: result.syncStatus,
            health: result.health,
            revision: shortSha(revision),
          },
          result.message ?? 'deployment status changed'
        )
      }
    }

    // Applications removed from git: prune everything they owned.
    for (const dep of store.listDeployments()) {
      if (seen.has(`${dep.app}/${dep.env}`)) continue
      const pruned = await this.prune(
        kube,
        dep.app,
        dep.env,
        dep.namespace,
        new Set()
      )
      store.deleteDeployment(dep.app, dep.env)
      this.lastApplied.delete(applicationId(dep.app, dep.env))
      events.emit('deployment:updated', { app: dep.app, env: dep.env })
      this.platform.log.info(
        { app: dep.app, env: dep.env, pruned },
        'application removed from git, resources pruned'
      )
    }
    return progressing
  }

  private async reconcileApplication(
    kube: Kube,
    found: DiscoveredApp,
    revision: string
  ): Promise<DeploymentStatus> {
    const { config } = this.platform
    const spec = await readYamlFile<ApplicationSpec>(
      path.join(found.dir, APPLICATION_FILE)
    )
    const values =
      (await readYamlFile<Record<string, unknown>>(
        path.join(found.dir, VALUES_FILE)
      )) ?? {}
    const namespace = spec?.namespace ?? `${found.app}-${found.env}`
    const policy = spec?.syncPolicy ?? {
      automated: true,
      prune: true,
      selfHeal: true,
    }
    const image =
      typeof values.image === 'string' && values.image
        ? values.image
        : undefined
    const base = {
      app: found.app,
      env: found.env,
      namespace,
      revision,
      image,
      url: appUrl(config, found.app, found.env),
    }

    if (!image) {
      return {
        ...base,
        syncStatus: 'Pending',
        health: 'Unknown',
        message: 'waiting for the first build from CI',
        resources: [],
      }
    }

    try {
      await kube.core.readNamespace({ name: namespace })
    } catch (err) {
      if (isNotFound(err)) {
        return {
          ...base,
          syncStatus: 'Error',
          health: 'Missing',
          message: `namespace ${namespace} does not exist (has Terraform run?)`,
          resources: [],
        }
      }
      throw err
    }

    const files: { name: string; content: string }[] = []
    for (const name of await readdir(found.dir)) {
      if (name === APPLICATION_FILE || name === VALUES_FILE) continue
      if (!name.endsWith('.yaml') && !name.endsWith('.yml')) continue
      files.push({
        name,
        content: await readFile(path.join(found.dir, name), 'utf8'),
      })
    }
    const desired = renderManifests(files, values, {
      app: found.app,
      env: found.env,
      namespace,
    })

    const id = applicationId(found.app, found.env)
    const revisionChanged = this.lastApplied.get(id) !== revision
    const resources: ResourceStatus[] = []
    const errors: string[] = []
    const healed: string[] = []
    let outOfSync = false

    for (const obj of desired) {
      const ref = `${obj.kind}/${obj.metadata.name}`
      let live = await readLive(kube, obj)
      const drift = live ? diffObject(stripForDiff(obj), live) : ['(missing)']
      const shouldApply =
        policy.automated &&
        (drift.length > 0 || revisionChanged) &&
        (policy.selfHeal || revisionChanged || !live)
      if (shouldApply) {
        try {
          live = (await kube.objects.patch(
            obj as k8s.KubernetesObject,
            undefined,
            undefined,
            FIELD_MANAGER,
            true,
            k8s.PatchStrategy.ServerSideApply
          )) as unknown as Record<string, unknown>
          if (drift.length && !revisionChanged)
            healed.push(`${ref} (${drift.slice(0, 3).join(', ')})`)
        } catch (err) {
          errors.push(`${ref}: ${kubeErrorMessage(err)}`)
        }
      } else if (drift.length) {
        outOfSync = true
      }
      const health = assessHealth(live as Parameters<typeof assessHealth>[0])
      if (obj.kind === 'Deployment' && health.health === 'Progressing') {
        const problem = await podProblem(kube, namespace, live)
        if (problem) {
          health.health = 'Degraded'
          health.message = problem
        }
      }
      resources.push({
        kind: obj.kind,
        name: obj.metadata.name,
        namespace,
        health: health.health,
        syncStatus: errors.some((e) => e.startsWith(`${ref}:`))
          ? 'Error'
          : shouldApply || !drift.length
            ? 'Synced'
            : 'OutOfSync',
        message: health.message,
      })
    }

    let pruned = 0
    if (policy.prune && !errors.length) {
      pruned = await this.prune(
        kube,
        found.app,
        found.env,
        namespace,
        new Set(desired.map(objectKey))
      )
    }
    if (!errors.length) this.lastApplied.set(id, revision)

    const health: HealthStatus = worstHealth(resources.map((r) => r.health))
    const notes: string[] = []
    if (errors.length) notes.push(errors.join('; '))
    if (healed.length) notes.push(`self-healed drift: ${healed.join('; ')}`)
    if (pruned) notes.push(`pruned ${pruned} resource(s)`)
    const degraded = resources.find(
      (r) => r.health === 'Degraded' || r.health === 'Progressing'
    )
    if (!notes.length && degraded?.message)
      notes.push(`${degraded.kind}/${degraded.name}: ${degraded.message}`)

    return {
      ...base,
      syncStatus: errors.length ? 'Error' : outOfSync ? 'OutOfSync' : 'Synced',
      health,
      message: notes.join(' · ') || undefined,
      lastSyncedAt: errors.length ? undefined : nowIso(),
      resources,
    }
  }

  /** Delete objects labeled for this application that are no longer desired. */
  private async prune(
    kube: Kube,
    app: string,
    env: string,
    namespace: string,
    keep: Set<string>
  ): Promise<number> {
    const selector = `${APPLICATION_LABEL}=${applicationId(app, env)},app.kubernetes.io/managed-by=${MANAGED_BY}`
    let deleted = 0
    for (const { apiVersion, kind } of PRUNABLE_KINDS) {
      let items: k8s.KubernetesObject[]
      try {
        const list = await kube.objects.list(
          apiVersion,
          kind,
          namespace,
          undefined,
          undefined,
          undefined,
          undefined,
          selector
        )
        items = list.items
      } catch (err) {
        if (isNotFound(err)) continue
        throw err
      }
      for (const item of items) {
        const key = objectKey({
          apiVersion,
          kind,
          metadata: { name: item.metadata!.name!, namespace },
        })
        if (keep.has(key)) continue
        try {
          await kube.objects.delete(
            {
              apiVersion,
              kind,
              metadata: { name: item.metadata!.name!, namespace },
            },
            undefined,
            undefined,
            undefined,
            undefined,
            'Background'
          )
          deleted++
        } catch (err) {
          if (!isNotFound(err)) throw err
        }
      }
    }
    return deleted
  }
}

async function discoverApplications(
  checkout: string
): Promise<DiscoveredApp[]> {
  const appsDir = path.join(checkout, 'apps')
  if (!existsSync(appsDir)) return []
  const found: DiscoveredApp[] = []
  for (const app of await readdir(appsDir, { withFileTypes: true })) {
    if (!app.isDirectory()) continue
    for (const env of await readdir(path.join(appsDir, app.name), {
      withFileTypes: true,
    })) {
      const dir = path.join(appsDir, app.name, env.name)
      if (env.isDirectory() && existsSync(path.join(dir, APPLICATION_FILE))) {
        found.push({ app: app.name, env: env.name, dir })
      }
    }
  }
  return found
}

async function readLive(
  kube: Kube,
  obj: ManifestObject
): Promise<Record<string, unknown> | undefined> {
  try {
    return (await kube.objects.read({
      apiVersion: obj.apiVersion,
      kind: obj.kind,
      metadata: { name: obj.metadata.name, namespace: obj.metadata.namespace },
    })) as unknown as Record<string, unknown>
  } catch (err) {
    if (isNotFound(err)) return undefined
    throw err
  }
}

/** Secrets are write-only for drift purposes (stringData never round-trips). */
function stripForDiff(obj: ManifestObject): ManifestObject {
  if (obj.kind !== 'Secret') return obj
  const {
    stringData: _s,
    data: _d,
    ...rest
  } = obj as ManifestObject & { stringData?: unknown; data?: unknown }
  return rest as ManifestObject
}

/** Find a pod of the Deployment stuck in a state it won't recover from. */
async function podProblem(
  kube: Kube,
  namespace: string,
  live: Record<string, unknown> | undefined
): Promise<string | undefined> {
  const matchLabels = (
    live?.spec as
      { selector?: { matchLabels?: Record<string, string> } } | undefined
  )?.selector?.matchLabels
  if (!matchLabels) return undefined
  const labelSelector = Object.entries(matchLabels)
    .map(([k, v]) => `${k}=${v}`)
    .join(',')
  const pods = await kube.core.listNamespacedPod({ namespace, labelSelector })
  for (const pod of pods.items) {
    for (const st of [
      ...(pod.status?.initContainerStatuses ?? []),
      ...(pod.status?.containerStatuses ?? []),
    ]) {
      const reason = st.state?.waiting?.reason
      if (reason && BAD_CONTAINER_REASONS.has(reason)) {
        const msg = st.state?.waiting?.message
          ? `: ${st.state.waiting.message.slice(0, 200)}`
          : ''
        return `pod ${pod.metadata?.name}: ${reason}${msg}`
      }
    }
  }
  return undefined
}
