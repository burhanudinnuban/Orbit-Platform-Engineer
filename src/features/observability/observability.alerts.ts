import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { stringify } from 'yaml'
import type { Config } from '../../config/env.js'
import { errorMessage } from '../../lib/logger.js'
import { isNotFound, type Kube } from '../../services/kube.js'
import type { Prometheus } from '../../services/prometheus.js'
import { promql } from './observability.queries.js'

export const RULES_CONFIGMAP = 'prometheus-rules'
/** ConfigMap key or file name; app and env are DNS labels, so this is a safe file name. */
export const rulesKey = (app: string, env: string) => `${app}-${env}.rules.yaml`

/** Prometheus alerting rules for one app environment. */
export function buildAlertRules(
  app: string,
  env: string,
  namespace: string
): string {
  const labels = { app, env, namespace }
  return stringify({
    groups: [
      {
        name: `orbit-${app}-${env}`,
        rules: [
          {
            alert: 'OrbitAppDown',
            expr: `(${promql.targetsUp(namespace)} or vector(0)) == 0`,
            for: '5m',
            labels: { ...labels, severity: 'critical' },
            annotations: {
              summary: `${app} (${env}) has no healthy scrape targets`,
            },
          },
          {
            alert: 'OrbitAppHighErrorRate',
            expr: `(${promql.errorRatio(namespace)}) > 0.05`,
            for: '5m',
            labels: { ...labels, severity: 'warning' },
            annotations: { summary: `${app} (${env}) error rate above 5%` },
          },
          {
            alert: 'OrbitAppHighLatency',
            expr: `(${promql.latencyQuantile(namespace, 0.95)}) > 1`,
            for: '10m',
            labels: { ...labels, severity: 'warning' },
            annotations: { summary: `${app} (${env}) p95 latency above 1s` },
          },
        ],
      },
    ],
  })
}

async function updateRules(
  kube: Kube,
  namespace: string,
  mutate: (data: Record<string, string>) => void
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      const cm = await kube.core.readNamespacedConfigMap({
        name: RULES_CONFIGMAP,
        namespace,
      })
      const data = { ...(cm.data ?? {}) }
      mutate(data)
      await kube.core.replaceNamespacedConfigMap({
        name: RULES_CONFIGMAP,
        namespace,
        body: { ...cm, data },
      })
      return
    } catch (err) {
      if (isNotFound(err)) {
        const data: Record<string, string> = {}
        mutate(data)
        await kube.core.createNamespacedConfigMap({
          namespace,
          body: {
            apiVersion: 'v1',
            kind: 'ConfigMap',
            metadata: { name: RULES_CONFIGMAP, namespace },
            data,
          },
        })
        return
      }
      // 409: someone else updated the ConfigMap between read and replace; retry.
      if (attempt >= 5) throw err
    }
  }
}

export function putAlertRules(
  kube: Kube,
  namespace: string,
  key: string,
  rules: string
): Promise<void> {
  return updateRules(kube, namespace, (data) => {
    data[key] = rules
  })
}

export function deleteAlertRules(
  kube: Kube,
  namespace: string,
  key: string
): Promise<void> {
  return updateRules(kube, namespace, (data) => {
    delete data[key]
  })
}

// ── Where the rules live ─────────────────────────────────────────────────────
// Docker Compose: one file per key in config.prometheus.rulesDir, which the
// Prometheus container mounts; Orbit asks Prometheus to reload afterwards.
// kind: a key in ConfigMap prometheus-rules, whose sidecar reloads Prometheus.

export interface AlertRulesDeps {
  config: Config
  kube: () => Kube
  prometheus: Pick<Prometheus, 'reload'>
}

/** Ask Prometheus to reload; a failure only delays the rules until its next start. */
async function reloadNote(prometheus: Pick<Prometheus, 'reload'>) {
  try {
    await prometheus.reload()
    return 'Prometheus reloaded'
  } catch (err) {
    return `Prometheus reload failed (${errorMessage(err)}); it loads the rules on its next start`
  }
}

/** Store the rules for `key` and return a line for the workflow log. */
export async function saveAlertRules(
  deps: AlertRulesDeps,
  key: string,
  rules: string
): Promise<string> {
  const dir = deps.config.prometheus.rulesDir
  if (!dir) {
    await putAlertRules(deps.kube(), deps.config.platformNamespace, key, rules)
    return `ConfigMap ${RULES_CONFIGMAP}/${key}`
  }
  await mkdir(dir, { recursive: true })
  // Write then rename, so Prometheus never reads a half-written file. The
  // temporary name does not match the *.yaml glob in prometheus.yml.
  const file = path.join(dir, key)
  const tmp = path.join(dir, `.${key}.tmp`)
  await writeFile(tmp, rules, 'utf8')
  await rename(tmp, file)
  return `${file}; ${await reloadNote(deps.prometheus)}`
}

/** Remove the rules for `key`; already gone is fine. */
export async function removeAlertRules(
  deps: AlertRulesDeps,
  key: string
): Promise<void> {
  const dir = deps.config.prometheus.rulesDir
  if (!dir) {
    await deleteAlertRules(deps.kube(), deps.config.platformNamespace, key)
    return
  }
  await rm(path.join(dir, key), { force: true })
  await reloadNote(deps.prometheus)
}
