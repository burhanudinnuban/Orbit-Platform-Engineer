import * as k8s from '@kubernetes/client-node'
import type { Config } from '../config/env.js'

export interface Kube {
  context: string
  kc: k8s.KubeConfig
  core: k8s.CoreV1Api
  apps: k8s.AppsV1Api
  batch: k8s.BatchV1Api
  objects: k8s.KubernetesObjectApi
}

export class KubeContextError extends Error {}

/**
 * Build Kubernetes clients for the configured context.
 * Orbit refuses any context that isn't explicitly allowed, so a developer's
 * production context (e.g. an AKS cluster) can never be used by accident.
 */
export function createKube(config: Config): Kube {
  const kc = new k8s.KubeConfig()
  const inCluster =
    Boolean(process.env.KUBERNETES_SERVICE_HOST) &&
    !process.env.KUBECONFIG &&
    config.kube.context === 'in-cluster'
  if (inCluster) {
    kc.loadFromCluster()
  } else {
    kc.loadFromDefault()
    const wanted = config.kube.context
    if (!config.kube.allowedContexts.includes(wanted)) {
      throw new KubeContextError(
        `Kube context "${wanted}" is not in ORBIT_ALLOWED_KUBE_CONTEXTS (${config.kube.allowedContexts.join(', ')}). Refusing to continue.`
      )
    }
    if (!kc.getContexts().some((c) => c.name === wanted)) {
      throw new KubeContextError(
        `Kube context "${wanted}" was not found in your kubeconfig. Run \`npm run bootstrap\` to create the local cluster.`
      )
    }
    kc.setCurrentContext(wanted)
  }
  return {
    context: inCluster ? 'in-cluster' : config.kube.context,
    kc,
    core: kc.makeApiClient(k8s.CoreV1Api),
    apps: kc.makeApiClient(k8s.AppsV1Api),
    batch: kc.makeApiClient(k8s.BatchV1Api),
    objects: k8s.KubernetesObjectApi.makeApiClient(kc),
  }
}

/** Lazily creates the clients and caches either the clients or the configuration error. */
export function lazyKube(config: Config): () => Kube {
  let cached: Kube | undefined
  return () => {
    if (!cached) cached = createKube(config)
    return cached
  }
}

export function statusCode(err: unknown): number | undefined {
  if (err && typeof err === 'object') {
    const e = err as {
      code?: unknown
      statusCode?: unknown
      response?: { statusCode?: unknown }
    }
    for (const v of [e.code, e.statusCode, e.response?.statusCode]) {
      if (typeof v === 'number') return v
    }
  }
  return undefined
}

export const isNotFound = (err: unknown) => statusCode(err) === 404
export const isConflict = (err: unknown) => statusCode(err) === 409

/** Extract the Kubernetes Status message from an API error when there is one. */
export function kubeErrorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'body' in err) {
    const body = (err as { body?: unknown }).body
    if (typeof body === 'string') {
      try {
        const parsed = JSON.parse(body) as { message?: string }
        if (parsed.message) return parsed.message
      } catch {
        return body.slice(0, 500)
      }
    } else if (body && typeof body === 'object' && 'message' in body) {
      return String((body as { message: unknown }).message)
    }
  }
  return err instanceof Error ? err.message : String(err)
}

/** Server-side apply: creates the object, or updates the fields this field manager owns. */
export async function applyObject<T extends k8s.KubernetesObject>(
  kube: Kube,
  obj: T,
  fieldManager: string
): Promise<T> {
  return (await kube.objects.patch(
    obj,
    undefined,
    undefined,
    fieldManager,
    true,
    k8s.PatchStrategy.ServerSideApply
  )) as T
}

/** Create or replace a Secret with string data. */
export async function upsertSecret(
  kube: Kube,
  namespace: string,
  name: string,
  data: Record<string, string>,
  labels: Record<string, string> = {}
): Promise<void> {
  const body: k8s.V1Secret = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name,
      namespace,
      labels: { 'app.kubernetes.io/managed-by': 'orbit', ...labels },
    },
    type: 'Opaque',
    stringData: data,
  }
  try {
    await kube.core.readNamespacedSecret({ name, namespace })
    await kube.core.replaceNamespacedSecret({ name, namespace, body })
  } catch (err) {
    if (!isNotFound(err)) throw err
    await kube.core.createNamespacedSecret({ namespace, body })
  }
}

/** Create or replace a ConfigMap. */
export async function upsertConfigMap(
  kube: Kube,
  namespace: string,
  name: string,
  data: Record<string, string>,
  labels: Record<string, string> = {}
): Promise<void> {
  const body: k8s.V1ConfigMap = {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name,
      namespace,
      labels: { 'app.kubernetes.io/managed-by': 'orbit', ...labels },
    },
    data,
  }
  try {
    await kube.core.readNamespacedConfigMap({ name, namespace })
    await kube.core.replaceNamespacedConfigMap({ name, namespace, body })
  } catch (err) {
    if (!isNotFound(err)) throw err
    await kube.core.createNamespacedConfigMap({ namespace, body })
  }
}
