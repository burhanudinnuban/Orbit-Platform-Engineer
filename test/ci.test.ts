import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type * as k8s from '@kubernetes/client-node'
import { loadConfig } from '../src/config/env.js'
import type { PipelineRecord, StageRecord } from '../src/app/store.js'
import { scanJob } from '../src/features/ci/ci.pods.js'
import {
  CACHE_DIR,
  scanCacheClaim,
  TRIVY_DB_MAX_AGE_HOURS,
  trivyDbCronJob,
  trivyDbUpdateScript,
} from '../src/features/ci/ci.scanCache.js'
import type { ScanStageSpec } from '../src/features/ci/ci.spec.js'

const config = loadConfig({})

const pipeline: PipelineRecord = {
  id: 'pl_0123456789abcdef',
  app: 'payments',
  number: 7,
  commitSha: 'a'.repeat(40),
  branch: 'main',
  trigger: 'push',
  status: 'running',
  createdAt: '2026-11-17T00:00:00.000Z',
}
const stage: StageRecord = {
  id: 'st_1',
  pipelineId: pipeline.id,
  idx: 2,
  name: 'security',
  type: 'scan',
  status: 'running',
  logs: '',
}

function scan(scanners: ScanStageSpec['scanners']): k8s.V1Job {
  return scanJob(
    { config, pipeline, stage },
    { name: 'security', type: 'scan', scanners }
  )
}

const podSpec = (job: k8s.V1Job) => job.spec!.template.spec!
const container = (job: k8s.V1Job, name: string) => {
  const c = podSpec(job).initContainers!.find((c) => c.name === name)
  assert.ok(c, `container ${name}`)
  return c
}
const script = (c: k8s.V1Container) => c.command!.join(' ')

describe('scan jobs: the shared Trivy DB', () => {
  it('mounts the scan cache claim, not a per-pod emptyDir', () => {
    const job = scan(['gitleaks', 'trivy-fs', 'semgrep', 'trivy-image'])
    const volume = podSpec(job).volumes!.find((v) => v.name === 'scan-cache')
    assert.equal(volume?.persistentVolumeClaim?.claimName, 'orbit-scan-cache')
    assert.equal(volume?.emptyDir, undefined)
    for (const name of ['trivy-fs', 'trivy-image']) {
      assert.ok(
        container(job, name).volumeMounts!.some(
          (m) => m.name === 'scan-cache' && m.mountPath === CACHE_DIR
        ),
        `${name} mounts ${CACHE_DIR}`
      )
    }
  })

  it('scans under the read lock with the DB frozen and no on-disk scan cache', () => {
    const job = scan(['trivy-fs', 'trivy-image'])
    for (const name of ['trivy-fs', 'trivy-image']) {
      const s = script(container(job, name))
      assert.match(
        s,
        new RegExp(`flock -s /cache/\\.lock trivy ${name.slice(6)} `)
      )
      assert.match(
        s,
        /--cache-dir \/cache --skip-db-update --cache-backend memory/
      )
      // The DB is fetched first only when the volume has none.
      assert.match(s, /if \[ ! -s \/cache\/db\/trivy\.db \]; then/)
      assert.match(s, /no report will be produced/)
    }
    assert.match(script(container(job, 'trivy-fs')), /--skip-check-update/)
  })

  it('leaves the volume out when the stage has no Trivy scanner', () => {
    const job = scan(['gitleaks', 'semgrep'])
    assert.deepEqual(
      podSpec(job).volumes!.map((v) => v.name),
      ['workspace']
    )
  })
})

describe('Trivy DB updates', () => {
  it('downloads from mirror.gcr.io by default, with a configurable timeout', () => {
    assert.equal(
      config.ci.trivyDb.repository,
      'mirror.gcr.io/aquasec/trivy-db:2'
    )
    const s = trivyDbUpdateScript(
      loadConfig({ ORBIT_TRIVY_DB_TIMEOUT_MINUTES: '45' }),
      0
    )
    assert.match(s, /--db-repository 'mirror\.gcr\.io\/aquasec\/trivy-db:2'/)
    assert.match(s, /--timeout 45m --cache-dir \/cache\/\.staging/)
  })

  it("uses Trivy's own default repository when the setting is empty", () => {
    const s = trivyDbUpdateScript(
      loadConfig({ ORBIT_TRIVY_DB_REPOSITORY: '' }),
      0
    )
    assert.doesNotMatch(s, /--db-repository/)
  })

  it('serializes downloads and swaps the new DB in under the exclusive lock', () => {
    const s = trivyDbUpdateScript(config, 0)
    assert.match(s, /^\(\n {2}flock -x 9\n/)
    assert.match(s, /\) 9>\/cache\/\.update\.lock$/)
    const swap = s.slice(s.indexOf('flock -x 8'), s.indexOf(') 8>/cache/.lock'))
    assert.match(swap, /mv \/cache\/db \/cache\/db\.old/)
    assert.match(swap, /mv \/cache\/\.staging\/db \/cache\/db/)
    // The download itself happens before, outside the read lock.
    assert.ok(s.indexOf('--download-db-only') < s.indexOf('flock -x 8'))
  })

  it('only checks for any DB in scans, and for its age in the CronJob', () => {
    assert.doesNotMatch(trivyDbUpdateScript(config, 0), /-mmin/)
    assert.match(
      trivyDbUpdateScript(config, 720),
      /find \/cache\/db\/downloaded-at -mmin -720/
    )
  })

  it('runs as a CronJob that never overlaps itself', () => {
    const cron = trivyDbCronJob(config)
    assert.equal(cron.metadata?.namespace, 'orbit-ci')
    assert.equal(cron.spec?.concurrencyPolicy, 'Forbid')
    const pod = cron.spec!.jobTemplate.spec!.template.spec!
    const [c] = pod.containers
    assert.equal(c?.image, config.images.trivy)
    assert.match(
      c!.command!.join(' '),
      new RegExp(`-mmin -${TRIVY_DB_MAX_AGE_HOURS * 60}`)
    )
    assert.equal(
      pod.volumes?.[0]?.persistentVolumeClaim?.claimName,
      scanCacheClaim(config).metadata?.name
    )
    assert.equal(pod.automountServiceAccountToken, false)
  })
})
