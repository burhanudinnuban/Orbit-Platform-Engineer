import type { HealthStatus } from '../../types/contract.js'

export interface HealthResult {
  health: HealthStatus
  message?: string
}

interface Condition {
  type?: string
  status?: string
  reason?: string
  message?: string
}

type Live = {
  kind?: string
  metadata?: { generation?: number }
  spec?: Record<string, unknown>
  status?: Record<string, unknown>
}

const num = (v: unknown, fallback = 0) => (typeof v === 'number' ? v : fallback)

/** Assess the health of a live Kubernetes object (Argo CD-style health checks). */
export function assessHealth(obj: Live | undefined): HealthResult {
  if (!obj) return { health: 'Missing', message: 'not found in cluster' }
  const status = obj.status ?? {}
  const spec = obj.spec ?? {}
  switch (obj.kind) {
    case 'Deployment': {
      const conditions = (status.conditions as Condition[] | undefined) ?? []
      if (
        conditions.some(
          (c) =>
            c.type === 'Progressing' && c.reason === 'ProgressDeadlineExceeded'
        )
      ) {
        return {
          health: 'Degraded',
          message: 'rollout exceeded its progress deadline',
        }
      }
      if (num(status.observedGeneration) < num(obj.metadata?.generation)) {
        return {
          health: 'Progressing',
          message: 'waiting for the rollout to be observed',
        }
      }
      const desired = num(spec.replicas, 1)
      const updated = num(status.updatedReplicas)
      const available = num(status.availableReplicas)
      const total = num(status.replicas)
      if (updated < desired)
        return {
          health: 'Progressing',
          message: `${updated}/${desired} replicas updated`,
        }
      if (total > updated)
        return {
          health: 'Progressing',
          message: `${total - updated} old replicas terminating`,
        }
      if (available < desired)
        return {
          health: 'Progressing',
          message: `${available}/${desired} replicas available`,
        }
      return {
        health: 'Healthy',
        message: `${available}/${desired} replicas available`,
      }
    }
    case 'StatefulSet': {
      const desired = num(spec.replicas, 1)
      const ready = num(status.readyReplicas)
      if (
        status.updateRevision &&
        status.currentRevision !== status.updateRevision
      ) {
        return { health: 'Progressing', message: 'rolling update in progress' }
      }
      if (ready < desired)
        return {
          health: 'Progressing',
          message: `${ready}/${desired} replicas ready`,
        }
      return {
        health: 'Healthy',
        message: `${ready}/${desired} replicas ready`,
      }
    }
    case 'Pod': {
      const phase = status.phase as string | undefined
      if (phase === 'Running' || phase === 'Succeeded')
        return { health: 'Healthy', message: phase }
      if (phase === 'Failed')
        return { health: 'Degraded', message: 'pod failed' }
      return { health: 'Progressing', message: phase ?? 'pending' }
    }
    case 'PersistentVolumeClaim':
      return status.phase === 'Bound'
        ? { health: 'Healthy' }
        : { health: 'Progressing', message: String(status.phase ?? 'Pending') }
    case 'Service': {
      if (spec.type === 'LoadBalancer') {
        const ingress = (
          status.loadBalancer as { ingress?: unknown[] } | undefined
        )?.ingress
        if (!ingress?.length)
          return { health: 'Progressing', message: 'waiting for load balancer' }
      }
      return { health: 'Healthy' }
    }
    case 'Job': {
      if (num(status.succeeded) > 0)
        return { health: 'Healthy', message: 'completed' }
      if (num(status.failed) > 0)
        return { health: 'Degraded', message: 'job failed' }
      return { health: 'Progressing', message: 'running' }
    }
    case 'HorizontalPodAutoscaler': {
      const conditions = (status.conditions as Condition[] | undefined) ?? []
      const bad = conditions.find(
        (c) => c.type === 'ScalingActive' && c.status === 'False'
      )
      return bad
        ? { health: 'Degraded', message: bad.message }
        : { health: 'Healthy' }
    }
    default:
      return { health: 'Healthy' }
  }
}

const RANK: Record<HealthStatus, number> = {
  Healthy: 0,
  Unknown: 1,
  Progressing: 2,
  Missing: 3,
  Degraded: 4,
}

/** The overall health is the worst health among resources. */
export function worstHealth(values: HealthStatus[]): HealthStatus {
  if (!values.length) return 'Unknown'
  return values.reduce(
    (worst, h) => (RANK[h] > RANK[worst] ? h : worst),
    'Healthy' as HealthStatus
  )
}

/** Container states that mean a rollout will not succeed on its own. */
export const BAD_CONTAINER_REASONS = new Set([
  'CrashLoopBackOff',
  'ImagePullBackOff',
  'ErrImagePull',
  'InvalidImageName',
  'CreateContainerConfigError',
  'CreateContainerError',
  'RunContainerError',
])
