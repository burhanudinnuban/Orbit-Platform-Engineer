import type * as k8s from '@kubernetes/client-node'
import type { Kube } from './kube.js'
import { isNotFound, kubeErrorMessage } from './kube.js'
import { redact } from './git.js'
import { sleep, tailLog } from '../lib/util.js'

export interface JobRunOptions {
  namespace: string
  job: k8s.V1Job
  /** Called with the full (redacted) log so far, whenever it changes. */
  onLog?: (log: string) => void
  /** Run time allowed, not counting time spent waiting for images (see pullAllowanceMs). */
  timeoutMs?: number
  /** Waiting for image pulls beyond this counts towards timeoutMs. */
  pullAllowanceMs?: number
  pollMs?: number
  signal?: AbortSignal
}

export interface JobRunResult {
  succeeded: boolean
  log: string
  /** Log of the last container in the pod spec only (report dumps live there). */
  lastContainerLog: string
  reason?: string
}

const FATAL_GRACE_MS = 90_000
/** A first pull of a large tool image (ZAP is 1.2 GB) on a slow network. */
const PULL_ALLOWANCE_MS = 60 * 60_000
const FATAL_WAITING_REASONS = new Set([
  'ErrImagePull',
  'ImagePullBackOff',
  'InvalidImageName',
  'CreateContainerConfigError',
  'CreateContainerError',
])

function containerOrder(pod: k8s.V1Pod): string[] {
  return [
    ...(pod.spec?.initContainers ?? []),
    ...(pod.spec?.containers ?? []),
  ].map((c) => c.name)
}

function containerStatuses(pod: k8s.V1Pod): Map<string, k8s.V1ContainerStatus> {
  const map = new Map<string, k8s.V1ContainerStatus>()
  for (const st of [
    ...(pod.status?.initContainerStatuses ?? []),
    ...(pod.status?.containerStatuses ?? []),
  ]) {
    map.set(st.name, st)
  }
  return map
}

/**
 * The image of the container the pod is starting, while none runs: the
 * kubelet is pulling it (or, briefly, creating the container). Undefined once
 * a container runs, and before the pod is scheduled.
 */
export function startingImage(pod: k8s.V1Pod): string | undefined {
  const statuses = containerStatuses(pod)
  if ([...statuses.values()].some((s) => s.state?.running)) return undefined
  const inits = pod.spec?.initContainers ?? []
  const pending =
    inits.find((c) => !statuses.get(c.name)?.state?.terminated) ??
    (pod.spec?.containers ?? []).find(
      (c) => !statuses.get(c.name)?.state?.terminated
    )
  if (!pending) return undefined
  const reason = statuses.get(pending.name)?.state?.waiting?.reason
  return reason === 'ContainerCreating' || reason === 'PodInitializing'
    ? pending.image
    : undefined
}

const minutes = (ms: number) => `${Math.round(ms / 60_000)}m`

/** Detect a pod that can never make progress (bad image, missing secret...). */
function fatalPodReason(pod: k8s.V1Pod): string | undefined {
  for (const st of containerStatuses(pod).values()) {
    const waiting = st.state?.waiting
    if (waiting?.reason && FATAL_WAITING_REASONS.has(waiting.reason)) {
      return `container "${st.name}": ${waiting.reason}${waiting.message ? ` — ${waiting.message}` : ''}`
    }
  }
  const unschedulable = pod.status?.conditions?.find(
    (c) => c.type === 'PodScheduled' && c.status === 'False'
  )
  if (
    unschedulable?.reason === 'Unschedulable' &&
    unschedulable.message?.includes('Insufficient')
  ) {
    return `pod unschedulable: ${unschedulable.message}`
  }
  return undefined
}

async function readLogs(
  kube: Kube,
  pod: k8s.V1Pod,
  namespace: string
): Promise<{ log: string; last: string }> {
  const statuses = containerStatuses(pod)
  const parts: string[] = []
  let last = ''
  const order = containerOrder(pod)
  for (const name of order) {
    const st = statuses.get(name)
    if (!st || (!st.state?.running && !st.state?.terminated)) continue
    let text: string
    try {
      text = String(
        await kube.core.readNamespacedPodLog({
          name: pod.metadata!.name!,
          namespace,
          container: name,
        })
      )
    } catch (err) {
      text = `(logs unavailable: ${kubeErrorMessage(err)})`
    }
    const exit = st.state?.terminated
      ? ` (exit ${st.state.terminated.exitCode})`
      : ' (running)'
    parts.push(`── ${name}${exit} ──\n${text.trimEnd()}`)
    if (name === order[order.length - 1]) last = text
  }
  return { log: redact(tailLog(parts.join('\n\n'))), last }
}

/**
 * Run a Kubernetes Job to completion (backoffLimit must be 0), streaming the
 * combined logs of all its containers. The job is deleted when the signal aborts.
 */
export async function runJob(
  kube: Kube,
  opts: JobRunOptions
): Promise<JobRunResult> {
  const { namespace, job } = opts
  const name = job.metadata!.name!
  const timeoutMs = opts.timeoutMs ?? 30 * 60_000
  const pullAllowanceMs = opts.pullAllowanceMs ?? PULL_ALLOWANCE_MS
  const pollMs = opts.pollMs ?? 2_000
  await kube.batch.createNamespacedJob({ namespace, body: job })

  const started = Date.now()
  // Time spent waiting for an image, which (up to pullAllowanceMs) does not
  // count towards the timeout: a first pull says nothing about the stage.
  let pullingMs = 0
  let lastLog = ''
  let lastContainerLog = ''
  let fatalSince: number | undefined
  const emit = (log: string) => {
    if (log !== lastLog) {
      lastLog = log
      opts.onLog?.(log)
    }
  }

  try {
    for (;;) {
      if (opts.signal?.aborted) throw new Error('canceled')
      const excused = Math.min(pullingMs, pullAllowanceMs)
      if (Date.now() - started - excused > timeoutMs) {
        return {
          succeeded: false,
          log: lastLog,
          lastContainerLog,
          reason:
            `timed out after ${minutes(timeoutMs)}` +
            (excused >= 60_000
              ? ` (plus ${minutes(excused)} waiting for images)`
              : ''),
        }
      }
      const tick = Date.now()
      let pulling: string | undefined
      const current = await kube.batch.readNamespacedJob({ name, namespace })
      const pods = await kube.core.listNamespacedPod({
        namespace,
        labelSelector: `job-name=${name}`,
      })
      const pod = pods.items.sort(
        (a, b) =>
          Date.parse(String(b.metadata?.creationTimestamp ?? 0)) -
          Date.parse(String(a.metadata?.creationTimestamp ?? 0))
      )[0]
      if (pod) {
        const logs = await readLogs(kube, pod, namespace)
        lastContainerLog = logs.last
        pulling = startingImage(pod)
        emit(
          pulling
            ? `${logs.log}${logs.log ? '\n\n' : ''}── waiting for image ${pulling} (${Math.round(pullingMs / 1000)}s so far, not counted towards the stage timeout) ──`
            : logs.log
        )
        // The kubelet retries image pulls and config errors, so give them a grace period before failing.
        const fatal = fatalPodReason(pod)
        if (!fatal) fatalSince = undefined
        else if (fatalSince === undefined) fatalSince = Date.now()
        else if (Date.now() - fatalSince > FATAL_GRACE_MS) {
          return {
            succeeded: false,
            log: lastLog,
            lastContainerLog,
            reason: fatal,
          }
        }
      }
      const status = current.status
      if ((status?.succeeded ?? 0) > 0)
        return { succeeded: true, log: lastLog, lastContainerLog }
      if (
        (status?.failed ?? 0) > 0 ||
        status?.conditions?.some(
          (c) => c.type === 'Failed' && c.status === 'True'
        )
      ) {
        const cond = status?.conditions?.find((c) => c.type === 'Failed')
        return {
          succeeded: false,
          log: lastLog,
          lastContainerLog,
          reason: cond?.message ?? 'job failed',
        }
      }
      await sleep(pollMs, opts.signal)
      if (pulling) pullingMs += Date.now() - tick
    }
  } catch (err) {
    if (opts.signal?.aborted) {
      await deleteJob(kube, namespace, name)
      return {
        succeeded: false,
        log: lastLog,
        lastContainerLog,
        reason: 'canceled',
      }
    }
    throw err
  }
}

export async function deleteJob(
  kube: Kube,
  namespace: string,
  name: string
): Promise<void> {
  try {
    await kube.batch.deleteNamespacedJob({
      name,
      namespace,
      propagationPolicy: 'Background',
    })
  } catch (err) {
    if (!isNotFound(err)) throw err
  }
}
