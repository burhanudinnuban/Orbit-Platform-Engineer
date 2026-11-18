import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parse } from 'yaml'
import { loadConfig } from '../src/config/env.js'
import {
  buildAlertRules,
  removeAlertRules,
  rulesKey,
  saveAlertRules,
  type AlertRulesDeps,
} from '../src/features/observability/observability.alerts.js'
import type { Kube } from '../src/services/kube.js'

const dirs: string[] = []
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

/** Rules in a temporary directory, with a Prometheus stub that counts reloads. */
function fileDeps(reload: () => Promise<void> = async () => {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'orbit-rules-'))
  dirs.push(dir)
  let reloads = 0
  const deps: AlertRulesDeps = {
    config: loadConfig({ PROMETHEUS_RULES_DIR: dir }),
    kube: () => {
      throw new Error('file mode must not touch Kubernetes')
    },
    prometheus: {
      reload: async () => {
        reloads++
        await reload()
      },
    },
  }
  return { dir, deps, reloads: () => reloads }
}

describe('alert rules configuration', () => {
  it('defaults to files under .orbit-data, resolved against the repository', () => {
    const config = loadConfig({})
    assert.ok(path.isAbsolute(config.prometheus.rulesDir))
    assert.ok(
      config.prometheus.rulesDir.endsWith(
        path.join('.orbit-data', 'prometheus-rules')
      )
    )
  })

  it('uses the ConfigMap when PROMETHEUS_RULES_DIR is empty (kind)', () => {
    assert.equal(
      loadConfig({ PROMETHEUS_RULES_DIR: '' }).prometheus.rulesDir,
      ''
    )
  })
})

describe('alert rules as files (Docker Compose)', () => {
  const key = rulesKey('payments', 'dev')
  const rules = buildAlertRules('payments', 'dev', 'payments-dev')

  it('writes one file per app environment and reloads Prometheus', async () => {
    const { dir, deps, reloads } = fileDeps()
    const note = await saveAlertRules(deps, key, rules)
    const file = path.join(dir, 'payments-dev.rules.yaml')
    assert.equal(readFileSync(file, 'utf8'), rules)
    assert.equal(reloads(), 1)
    assert.match(note, /Prometheus reloaded$/)
    // Only the final file is left; the temporary one was renamed.
    assert.deepEqual(readdirSync(dir), ['payments-dev.rules.yaml'])
    const parsed = parse(readFileSync(file, 'utf8')) as {
      groups: { name: string; rules: { alert: string }[] }[]
    }
    assert.equal(parsed.groups[0]?.name, 'orbit-payments-dev')
    assert.deepEqual(
      parsed.groups[0]?.rules.map((r) => r.alert),
      ['OrbitAppDown', 'OrbitAppHighErrorRate', 'OrbitAppHighLatency']
    )
  })

  it('replaces an existing file', async () => {
    const { dir, deps } = fileDeps()
    await saveAlertRules(deps, key, 'groups: []\n')
    await saveAlertRules(deps, key, rules)
    assert.equal(readFileSync(path.join(dir, key), 'utf8'), rules)
  })

  it('keeps the file when Prometheus cannot be reached', async () => {
    const { dir, deps } = fileDeps(async () => {
      throw new Error('prometheus unreachable')
    })
    const note = await saveAlertRules(deps, key, rules)
    assert.ok(existsSync(path.join(dir, key)))
    assert.match(note, /reload failed \(prometheus unreachable\)/)
  })

  it('creates the directory when it is missing', async () => {
    const { dir } = fileDeps()
    const nested = path.join(dir, 'not', 'yet')
    const deps: AlertRulesDeps = {
      config: loadConfig({ PROMETHEUS_RULES_DIR: nested }),
      kube: () => ({}) as Kube,
      prometheus: { reload: async () => {} },
    }
    await saveAlertRules(deps, key, rules)
    assert.ok(existsSync(path.join(nested, key)))
  })

  it('removes the file and reloads; removing twice is fine', async () => {
    const { dir, deps, reloads } = fileDeps()
    await saveAlertRules(deps, key, rules)
    await removeAlertRules(deps, key)
    await removeAlertRules(deps, key)
    assert.ok(!existsSync(path.join(dir, key)))
    assert.equal(reloads(), 3)
  })
})
