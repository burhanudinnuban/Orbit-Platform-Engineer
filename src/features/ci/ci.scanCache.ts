import type * as k8s from '@kubernetes/client-node'
import type { Config } from '../../config/env.js'
import { shellQuote } from '../../lib/util.js'
import { applyObject, type Kube } from '../../services/kube.js'

/*
 * Trivy's vulnerability DB lives in one PersistentVolumeClaim that every scan
 * mounts, instead of each pipeline downloading it again (about 135 MB, which
 * took 2.5 minutes from mirror.gcr.io and 5.5 from ghcr.io on a slow office
 * network). CronJob trivy-db keeps it fresh in the background; a scan only
 * downloads it itself when the volume has none yet.
 *
 * Every CI pod runs on the same node, so flock on the volume coordinates them:
 *   .lock         scans hold it shared while Trivy reads the DB; swapping a
 *                 new DB in takes it exclusively, for two renames
 *   .update.lock  one download at a time, across the CronJob and pipelines
 */

export const CACHE_DIR = '/cache'
const DB_DIR = `${CACHE_DIR}/db`
const STAMP = `${DB_DIR}/downloaded-at`
const STAGING_DIR = `${CACHE_DIR}/.staging`
const READ_LOCK = `${CACHE_DIR}/.lock`
const UPDATE_LOCK = `${CACHE_DIR}/.update.lock`

export const TRIVY_DB_CRONJOB = 'trivy-db'
/** The CronJob looks every 6 hours and downloads a DB older than this. */
export const TRIVY_DB_MAX_AGE_HOURS = 12
const SCHEDULE = '17 */6 * * *'
const FIELD_MANAGER = 'orbit-ci'
const VOLUME = 'scan-cache'

const LABELS = {
  'app.kubernetes.io/managed-by': 'orbit',
  'orbit.dev/component': 'trivy-db',
}

/** Flags for every scan: the shared DB, never updated mid-pipeline, and no on-disk scan cache. */
export const TRIVY_SCAN_FLAGS = `--cache-dir ${CACHE_DIR} --skip-db-update --cache-backend memory`

export const scanCacheMount: k8s.V1VolumeMount = {
  name: VOLUME,
  mountPath: CACHE_DIR,
}

export const scanCacheVolume = (config: Config): k8s.V1Volume => ({
  name: VOLUME,
  persistentVolumeClaim: { claimName: config.ci.scanCacheClaim },
})

/** Run a command while holding the DB read lock, so the DB is never swapped mid-scan. */
export const withDbReadLock = (cmd: string) => `flock -s ${READ_LOCK} ${cmd}`

/**
 * POSIX sh (busybox) that downloads the DB into a staging directory and swaps
 * it in, unless the volume already has a usable one. With maxAgeMinutes 0 any
 * DB will do (scans); otherwise a DB older than that is replaced (CronJob).
 * Exits non-zero when the download fails.
 */
export function trivyDbUpdateScript(
  config: Config,
  maxAgeMinutes: number
): string {
  const { repository, timeoutMinutes } = config.ci.trivyDb
  const usable =
    maxAgeMinutes > 0
      ? `[ -s ${DB_DIR}/trivy.db ] && [ -n "$(find ${STAMP} -mmin -${maxAgeMinutes} 2>/dev/null)" ]`
      : `[ -s ${DB_DIR}/trivy.db ]`
  const download = [
    'trivy image --download-db-only --no-progress',
    `--timeout ${timeoutMinutes}m --cache-dir ${STAGING_DIR}`,
    ...(repository ? [`--db-repository ${shellQuote(repository)}`] : []),
  ].join(' ')
  const from = repository ? ` from ${repository}` : ''
  return [
    '(',
    '  flock -x 9',
    `  if ${usable}; then echo "trivy DB: up to date (downloaded $(cat ${STAMP} 2>/dev/null))"; exit 0; fi`,
    `  echo ${shellQuote(`trivy DB: downloading${from} (timeout ${timeoutMinutes}m)`)}`,
    `  rm -rf ${STAGING_DIR}`,
    `  ${download} || exit 1`,
    `  date -u '+%Y-%m-%d %H:%M UTC' > ${STAGING_DIR}/db/downloaded-at || exit 1`,
    '  (',
    '    flock -x 8',
    `    rm -rf ${DB_DIR}.old`,
    `    if [ -d ${DB_DIR} ]; then mv ${DB_DIR} ${DB_DIR}.old; fi`,
    `    mv ${STAGING_DIR}/db ${DB_DIR}`,
    `  ) 8>${READ_LOCK} || exit 1`,
    `  rm -rf ${STAGING_DIR} ${DB_DIR}.old`,
    '  echo "trivy DB: updated"',
    `) 9>${UPDATE_LOCK}`,
  ].join('\n')
}

/**
 * Shell run before a scan: when the volume has no DB yet, download it (or wait
 * for the download already running), then say how old the DB is. A failed
 * download is left to the scan, which then produces no report.
 */
export function trivyDbEnsureScript(config: Config): string {
  return [
    `if [ ! -s ${DB_DIR}/trivy.db ]; then`,
    trivyDbUpdateScript(config, 0),
    'fi',
    `echo "trivy DB: downloaded $(cat ${STAMP} 2>/dev/null || echo never)"`,
  ].join('\n')
}

export function scanCacheClaim(config: Config): k8s.V1PersistentVolumeClaim {
  return {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: {
      name: config.ci.scanCacheClaim,
      namespace: config.ci.namespace,
      labels: LABELS,
    },
    spec: {
      accessModes: ['ReadWriteOnce'],
      // The DB is ~1 GB unpacked, twice that while a new one is swapped in.
      resources: { requests: { storage: '5Gi' } },
    },
  }
}

export function trivyDbCronJob(config: Config): k8s.V1CronJob {
  const meta = { labels: LABELS }
  return {
    apiVersion: 'batch/v1',
    kind: 'CronJob',
    metadata: {
      name: TRIVY_DB_CRONJOB,
      namespace: config.ci.namespace,
      ...meta,
    },
    spec: {
      schedule: SCHEDULE,
      concurrencyPolicy: 'Forbid',
      successfulJobsHistoryLimit: 1,
      failedJobsHistoryLimit: 1,
      jobTemplate: {
        metadata: meta,
        spec: {
          backoffLimit: 0,
          // Room for the download plus a wait behind a pipeline's download.
          activeDeadlineSeconds: (config.ci.trivyDb.timeoutMinutes + 10) * 60,
          template: {
            metadata: meta,
            spec: {
              restartPolicy: 'Never',
              serviceAccountName: config.ci.serviceAccount,
              automountServiceAccountToken: false,
              containers: [
                {
                  name: 'trivy-db',
                  image: config.images.trivy,
                  command: [
                    '/bin/sh',
                    '-c',
                    trivyDbUpdateScript(config, TRIVY_DB_MAX_AGE_HOURS * 60),
                  ],
                  securityContext: { runAsUser: 0 },
                  volumeMounts: [scanCacheMount],
                  resources: {
                    requests: { cpu: '50m', memory: '128Mi' },
                    limits: { memory: '1Gi' },
                  },
                },
              ],
              volumes: [scanCacheVolume(config)],
            },
          },
        },
      },
    },
  }
}

/**
 * Create or update the DB volume and its refresh CronJob. When the CronJob has
 * not succeeded recently (a new cluster, or one that was switched off) and no
 * run is in progress, start one now, so the first pipeline finds a DB.
 * Returns true when it started a run.
 */
export async function ensureScanCache(
  kube: Kube,
  config: Config
): Promise<boolean> {
  const namespace = config.ci.namespace
  await applyObject(kube, scanCacheClaim(config), FIELD_MANAGER)
  const desired = trivyDbCronJob(config)
  const cron = await applyObject(kube, desired, FIELD_MANAGER)
  const last = cron.status?.lastSuccessfulTime
  const age = last ? Date.now() - new Date(last).getTime() : Infinity
  if (age < TRIVY_DB_MAX_AGE_HOURS * 3_600_000) return false
  const jobs = await kube.batch.listNamespacedJob({
    namespace,
    labelSelector: `orbit.dev/component=${LABELS['orbit.dev/component']}`,
  })
  if (jobs.items.some((j) => !j.status?.succeeded && !j.status?.failed))
    return false
  await kube.batch.createNamespacedJob({
    namespace,
    body: {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: {
        name: `${TRIVY_DB_CRONJOB}-${Date.now().toString(36)}`,
        namespace,
        labels: LABELS,
        // Owned like a scheduled run: the CronJob records its success and prunes
        // it (and logs an UnexpectedJob warning, since it did not create it).
        ownerReferences: [
          {
            apiVersion: 'batch/v1',
            kind: 'CronJob',
            name: TRIVY_DB_CRONJOB,
            uid: cron.metadata!.uid!,
            controller: true,
          },
        ],
      },
      spec: desired.spec!.jobTemplate.spec,
    },
  })
  return true
}
