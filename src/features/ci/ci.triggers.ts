import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Platform } from '../../app/platform.js'
import type { PipelineRecord } from '../../app/store.js'

const ZERO_SHA = /^0+$/

export function signPayload(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('hex')
}

/** Gitea signs webhook bodies with HMAC-SHA256 (hex) in the X-Gitea-Signature header. */
export function verifySignature(
  secret: string,
  body: string,
  signature: string | undefined
): boolean {
  if (!secret || !signature) return false
  const expected = Buffer.from(signPayload(secret, body), 'utf8')
  const given = Buffer.from(signature.replace(/^sha256=/, '').trim(), 'utf8')
  return expected.length === given.length && timingSafeEqual(expected, given)
}

export interface PushPayload {
  ref?: string
  after?: string
  repository?: {
    full_name?: string
    name?: string
    owner?: { login?: string; username?: string }
  }
  head_commit?: { id?: string; message?: string } | null
}

export type PushResult = { queued: PipelineRecord } | { ignored: string }

/** Queue a pipeline for the current HEAD of a branch (manual runs from the portal or CLI). */
export async function queueBranchHead(
  platform: Platform,
  app: string,
  branch = 'main',
  trigger: 'manual' | 'push' = 'manual'
): Promise<PipelineRecord> {
  const { gitea, config, store, events } = platform
  const head = await gitea.getBranch(config.gitea.appsOrg, app, branch)
  if (!head)
    throw new Error(
      `branch ${branch} not found in ${config.gitea.appsOrg}/${app}`
    )
  if (branch === 'main') store.setBranchHead(app, branch, head.commit.id)
  const pipeline = store.createPipeline({
    app,
    commitSha: head.commit.id,
    commitMessage: head.commit.message.split('\n')[0],
    branch,
    trigger,
  })
  events.emit('ci:queued', { pipelineId: pipeline.id })
  return pipeline
}

/** Turn a push webhook into a queued pipeline. */
export function handlePush(
  platform: Platform,
  payload: PushPayload
): PushResult {
  const { store, config, events } = platform
  const ref = payload.ref ?? ''
  if (!ref.startsWith('refs/heads/'))
    return { ignored: `not a branch push (${ref || 'no ref'})` }
  const branch = ref.slice('refs/heads/'.length)
  const sha = payload.after ?? ''
  if (!sha || ZERO_SHA.test(sha)) return { ignored: 'branch deleted' }

  const fullName = payload.repository?.full_name ?? ''
  const [owner, name] = fullName.split('/')
  if (owner !== config.gitea.appsOrg || !name)
    return { ignored: `repository ${fullName} is not an Orbit app` }
  const app = store.getApp(name)
  if (!app) return { ignored: `no Orbit app named ${name}` }
  if (app.status !== 'ready') return { ignored: `app ${name} is ${app.status}` }
  if (store.findPipelineByCommit(name, sha, branch))
    return { ignored: 'a pipeline for this commit already exists' }

  if (branch === 'main') store.setBranchHead(name, branch, sha)
  const queued = store.createPipeline({
    app: name,
    commitSha: sha,
    commitMessage: payload.head_commit?.message?.split('\n')[0],
    branch,
    trigger: 'push',
  })
  events.emit('ci:queued', { pipelineId: queued.id })
  return { queued }
}
