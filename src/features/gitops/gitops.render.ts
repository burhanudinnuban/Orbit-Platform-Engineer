import { parseAllDocuments } from 'yaml'

export interface ManifestObject {
  apiVersion: string
  kind: string
  metadata: {
    name: string
    namespace?: string
    labels?: Record<string, string>
    annotations?: Record<string, string>
    [key: string]: unknown
  }
  [key: string]: unknown
}

export interface RenderTarget {
  app: string
  env: string
  namespace: string
}

export const MANAGED_BY = 'orbit-gitops'
export const APPLICATION_LABEL = 'orbit.dev/application'
export const applicationId = (app: string, env: string) => `${app}-${env}`

/** Kinds an app may not create from its gitops directory (cluster-scoped or privileged). */
const FORBIDDEN_KINDS = new Set([
  'Namespace',
  'ClusterRole',
  'ClusterRoleBinding',
  'CustomResourceDefinition',
  'PersistentVolume',
  'StorageClass',
  'IngressClass',
  'MutatingWebhookConfiguration',
  'ValidatingWebhookConfiguration',
  'PriorityClass',
  'ResourceQuota',
  'LimitRange',
  'NetworkPolicy',
])

/** Kinds the controller lists when pruning objects that were removed from git. */
export const PRUNABLE_KINDS: { apiVersion: string; kind: string }[] = [
  { apiVersion: 'apps/v1', kind: 'Deployment' },
  { apiVersion: 'apps/v1', kind: 'StatefulSet' },
  { apiVersion: 'v1', kind: 'Service' },
  { apiVersion: 'v1', kind: 'ConfigMap' },
  { apiVersion: 'v1', kind: 'Secret' },
  { apiVersion: 'networking.k8s.io/v1', kind: 'Ingress' },
  { apiVersion: 'autoscaling/v2', kind: 'HorizontalPodAutoscaler' },
  { apiVersion: 'policy/v1', kind: 'PodDisruptionBudget' },
  { apiVersion: 'batch/v1', kind: 'CronJob' },
]

/** Replace `${key}` placeholders. Unknown keys are reported, never silently emptied. */
export function substitute(
  text: string,
  values: Record<string, unknown>
): { text: string; missing: string[] } {
  const missing = new Set<string>()
  const out = text.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
    (match, key: string) => {
      const v = values[key]
      if (v === undefined || v === null) {
        missing.add(key)
        return match
      }
      return String(v)
    }
  )
  return { text: out, missing: [...missing] }
}

export const objectKey = (o: {
  apiVersion: string
  kind: string
  metadata: { name: string; namespace?: string }
}) =>
  `${o.apiVersion}/${o.kind}/${o.metadata.namespace ?? ''}/${o.metadata.name}`

/**
 * Render the manifests of one application: substitute values, parse every
 * YAML document, enforce the destination namespace and inject ownership labels.
 */
export function renderManifests(
  files: { name: string; content: string }[],
  values: Record<string, unknown>,
  target: RenderTarget
): ManifestObject[] {
  const objects: ManifestObject[] = []
  const seen = new Set<string>()
  for (const file of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
    const { text, missing } = substitute(file.content, values)
    if (missing.length)
      throw new Error(
        `${file.name}: no value for ${missing.map((m) => `\${${m}}`).join(', ')} in values.yaml`
      )
    const docs = parseAllDocuments(text)
    for (const [i, doc] of (Array.isArray(docs) ? docs : [docs]).entries()) {
      if (doc.errors.length)
        throw new Error(
          `${file.name} (document ${i + 1}): ${doc.errors[0]!.message}`
        )
      const obj = doc.toJS() as ManifestObject | null
      if (obj === null || obj === undefined) continue
      if (
        typeof obj !== 'object' ||
        !obj.apiVersion ||
        !obj.kind ||
        !obj.metadata?.name
      ) {
        throw new Error(
          `${file.name} (document ${i + 1}): apiVersion, kind and metadata.name are required`
        )
      }
      if (FORBIDDEN_KINDS.has(obj.kind)) {
        throw new Error(
          `${file.name}: kind ${obj.kind} is managed by the platform and can't be deployed by an app`
        )
      }
      if (
        obj.metadata.namespace &&
        obj.metadata.namespace !== target.namespace
      ) {
        throw new Error(
          `${file.name}: ${obj.kind}/${obj.metadata.name} targets namespace "${obj.metadata.namespace}", only "${target.namespace}" is allowed`
        )
      }
      obj.metadata.namespace = target.namespace
      obj.metadata.labels = {
        ...(obj.metadata.labels ?? {}),
        'app.kubernetes.io/managed-by': MANAGED_BY,
        [APPLICATION_LABEL]: applicationId(target.app, target.env),
        'orbit.dev/app': target.app,
        'orbit.dev/env': target.env,
      }
      const key = objectKey(obj)
      if (seen.has(key))
        throw new Error(
          `${file.name}: ${obj.kind}/${obj.metadata.name} is defined twice`
        )
      seen.add(key)
      objects.push(obj)
    }
  }
  return objects
}
