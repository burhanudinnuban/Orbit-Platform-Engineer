import path from 'node:path'
import type * as k8s from '@kubernetes/client-node'
import { appNamespace, imageRef, type Config } from '../../config/env.js'
import type { PipelineRecord, StageRecord } from '../../app/store.js'
import { dnsLabel, shellQuote } from '../../lib/util.js'
import { reportDumpScript } from '../security/security.reports.js'
import type { ReportTool } from '../security/security.types.js'
import {
  scanCacheMount,
  scanCacheVolume,
  TRIVY_SCAN_FLAGS,
  trivyDbEnsureScript,
  withDbReadLock,
} from './ci.scanCache.js'
import type {
  BuildStageSpec,
  DastStageSpec,
  ScanStageSpec,
  Scanner,
  ScriptStageSpec,
} from './ci.spec.js'

export const WORKSPACE = '/workspace'
export const REPORT_DIR = `${WORKSPACE}/.orbit-reports`

export interface JobInput {
  config: Config
  pipeline: PipelineRecord
  stage: StageRecord
}

export function jobName(pipeline: PipelineRecord, stage: StageRecord): string {
  const suffix = pipeline.id.slice(-5).toLowerCase()
  return (
    dnsLabel(`ci-${pipeline.app}-${pipeline.number}-${stage.name}`, 56) +
    `-${suffix}`
  )
}

function labels(input: JobInput): Record<string, string> {
  return {
    'app.kubernetes.io/managed-by': 'orbit',
    'orbit.dev/component': 'ci',
    'orbit.dev/app': input.pipeline.app,
    'orbit.dev/pipeline': input.pipeline.id,
    'orbit.dev/stage': input.stage.name,
  }
}

const workspaceMount: k8s.V1VolumeMount = {
  name: 'workspace',
  mountPath: WORKSPACE,
}

function ciEnv(input: JobInput): k8s.V1EnvVar[] {
  return [
    { name: 'CI', value: 'true' },
    { name: 'ORBIT_APP', value: input.pipeline.app },
    { name: 'ORBIT_COMMIT_SHA', value: input.pipeline.commitSha },
    { name: 'ORBIT_BRANCH', value: input.pipeline.branch },
    { name: 'ORBIT_PIPELINE_ID', value: input.pipeline.id },
  ]
}

/** Init container that checks out the pipeline's commit into /workspace (credentials come from a Secret). */
export function cloneContainer(input: JobInput): k8s.V1Container {
  const { config, pipeline } = input
  const internal = new URL(config.gitea.internalUrl)
  const repoPath = `${internal.pathname.replace(/\/+$/, '')}/${config.gitea.appsOrg}/${pipeline.app}.git`
  const authed = `${internal.protocol}//\${GIT_USERNAME}:\${GIT_TOKEN}@${internal.host}${repoPath}`
  const plain = `${internal.protocol}//${internal.host}${repoPath}`
  const script = [
    'set -eu',
    `git clone --quiet "${authed}" ${WORKSPACE}`,
    `cd ${WORKSPACE}`,
    `git checkout --quiet ${shellQuote(pipeline.commitSha)}`,
    `git remote set-url origin ${shellQuote(plain)}`,
    `mkdir -p ${REPORT_DIR} && chmod 0777 ${REPORT_DIR}`,
    'echo "checked out $(git rev-parse --short HEAD): $(git log -1 --pretty=%s)"',
  ].join('\n')
  return {
    name: 'clone',
    image: config.images.git,
    command: ['/bin/sh', '-c', script],
    env: [
      {
        name: 'GIT_USERNAME',
        valueFrom: {
          secretKeyRef: { name: config.ci.credentialsSecret, key: 'username' },
        },
      },
      {
        name: 'GIT_TOKEN',
        valueFrom: {
          secretKeyRef: { name: config.ci.credentialsSecret, key: 'token' },
        },
      },
      { name: 'GIT_TERMINAL_PROMPT', value: '0' },
    ],
    volumeMounts: [workspaceMount],
    resources: { requests: { cpu: '50m', memory: '64Mi' } },
  }
}

function job(
  input: JobInput,
  spec: {
    initContainers: k8s.V1Container[]
    containers: k8s.V1Container[]
    volumes?: k8s.V1Volume[]
  }
): k8s.V1Job {
  const l = labels(input)
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name: jobName(input.pipeline, input.stage),
      namespace: input.config.ci.namespace,
      labels: l,
    },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: 3600,
      template: {
        metadata: { labels: l },
        spec: {
          restartPolicy: 'Never',
          serviceAccountName: input.config.ci.serviceAccount,
          automountServiceAccountToken: false,
          initContainers: spec.initContainers,
          containers: spec.containers,
          volumes: [
            { name: 'workspace', emptyDir: {} },
            ...(spec.volumes ?? []),
          ],
        },
      },
    },
  }
}

/** A user-defined script stage: the commands run in order with `set -e`, each echoed first. */
export function scriptJob(input: JobInput, stage: ScriptStageSpec): k8s.V1Job {
  const script = [
    'set -e',
    ...stage.script.flatMap((cmd) => [
      `printf '%s\\n' ${shellQuote(`$ ${cmd}`)}`,
      cmd,
    ]),
  ].join('\n')
  return job(input, {
    initContainers: [cloneContainer(input)],
    containers: [
      {
        name: 'run',
        image: stage.image,
        command: ['/bin/sh', '-c', script],
        workingDir: WORKSPACE,
        env: [
          ...ciEnv(input),
          ...Object.entries(stage.env ?? {}).map(([name, value]) => ({
            name,
            value,
          })),
        ],
        volumeMounts: [workspaceMount],
        resources: {
          requests: { cpu: '250m', memory: '256Mi' },
          limits: { memory: '2Gi' },
        },
      },
    ],
  })
}

/** Image build with BuildKit (daemonless), pushed to the local registry. */
export function buildJob(input: JobInput, stage: BuildStageSpec): k8s.V1Job {
  const { config, pipeline } = input
  const dockerfile = path.posix.normalize(stage.dockerfile)
  const destination = imageRef(
    config.registry.push,
    pipeline.app,
    pipeline.commitSha
  )
  return job(input, {
    initContainers: [cloneContainer(input)],
    containers: [
      {
        name: 'build',
        image: config.images.buildkit,
        command: ['buildctl-daemonless.sh'],
        args: [
          'build',
          '--progress=plain',
          '--frontend=dockerfile.v0',
          `--local=context=${path.posix.join(WORKSPACE, stage.context)}`,
          `--local=dockerfile=${path.posix.join(WORKSPACE, path.posix.dirname(dockerfile))}`,
          `--opt=filename=${path.posix.basename(dockerfile)}`,
          `--opt=label:org.opencontainers.image.revision=${pipeline.commitSha}`,
          `--output=type=image,name=${destination},push=true,registry.insecure=true`,
        ],
        securityContext: { privileged: true },
        volumeMounts: [
          workspaceMount,
          { name: 'buildkit', mountPath: '/var/lib/buildkit' },
        ],
        resources: {
          requests: { cpu: '500m', memory: '512Mi' },
          limits: { memory: '4Gi' },
        },
      },
    ],
    volumes: [{ name: 'buildkit', emptyDir: {} }],
  })
}

const tolerant = (tool: string, cmd: string) =>
  `${cmd} || echo "${tool} exited with code $? (no report will be produced)"`

export const isTrivy = (s: Scanner) => s === 'trivy-fs' || s === 'trivy-image'

/** A Trivy scan against the shared DB (ci.scanCache.ts), fetching the DB first on a new cluster. */
const trivyScript = (config: Config, tool: string, cmd: string) =>
  [trivyDbEnsureScript(config), tolerant(tool, withDbReadLock(cmd))].join('\n')

function scannerContainer(input: JobInput, scanner: Scanner): k8s.V1Container {
  const { config, pipeline } = input
  const asRoot = { runAsUser: 0 }
  switch (scanner) {
    case 'gitleaks':
      return {
        name: 'gitleaks',
        image: config.images.gitleaks,
        command: [
          '/bin/sh',
          '-c',
          tolerant(
            'gitleaks',
            `gitleaks detect --no-git --no-banner --redact --exit-code 0 --source ${WORKSPACE} --report-format json --report-path ${REPORT_DIR}/gitleaks.json`
          ),
        ],
        securityContext: asRoot,
        volumeMounts: [workspaceMount],
      }
    case 'trivy-fs':
      return {
        name: 'trivy-fs',
        image: config.images.trivy,
        command: [
          '/bin/sh',
          '-c',
          // --skip-check-update: misconfig checks built into Trivy, no download.
          trivyScript(
            config,
            'trivy fs',
            `trivy fs --quiet --exit-code 0 ${TRIVY_SCAN_FLAGS} --scanners vuln,secret,misconfig --skip-check-update --skip-dirs ${REPORT_DIR} --skip-dirs ${WORKSPACE}/.git --format json --output ${REPORT_DIR}/trivy-fs.json ${WORKSPACE}`
          ),
        ],
        securityContext: asRoot,
        volumeMounts: [workspaceMount, scanCacheMount],
      }
    case 'semgrep':
      return {
        name: 'semgrep',
        image: config.images.semgrep,
        command: [
          '/bin/sh',
          '-c',
          tolerant(
            'semgrep',
            `semgrep scan --config p/default --metrics=off --disable-version-check --quiet --exclude .orbit-reports --json --output ${REPORT_DIR}/semgrep.json ${WORKSPACE}`
          ),
        ],
        env: [{ name: 'SEMGREP_SEND_METRICS', value: 'off' }],
        securityContext: asRoot,
        volumeMounts: [workspaceMount],
        resources: {
          requests: { cpu: '250m', memory: '512Mi' },
          limits: { memory: '2Gi' },
        },
      }
    case 'trivy-image':
      return {
        name: 'trivy-image',
        image: config.images.trivy,
        command: [
          '/bin/sh',
          '-c',
          trivyScript(
            config,
            'trivy image',
            `trivy image --quiet --exit-code 0 ${TRIVY_SCAN_FLAGS} --insecure --format json --output ${REPORT_DIR}/trivy-image.json ${imageRef(config.registry.push, pipeline.app, pipeline.commitSha)}`
          ),
        ],
        env: [{ name: 'TRIVY_INSECURE', value: 'true' }],
        securityContext: asRoot,
        volumeMounts: [workspaceMount, scanCacheMount],
      }
  }
}

function dumpContainer(input: JobInput, tools: ReportTool[]): k8s.V1Container {
  return {
    name: 'report',
    image: input.config.images.busybox,
    command: ['/bin/sh', '-c', reportDumpScript(tools, REPORT_DIR)],
    volumeMounts: [workspaceMount],
    resources: { requests: { cpu: '10m', memory: '16Mi' } },
  }
}

/** Each scanner runs as an init container (sequentially); the last container prints every report. */
export function scanJob(input: JobInput, stage: ScanStageSpec): k8s.V1Job {
  // gitleaks first: later reports may quote source lines and would otherwise be flagged as leaks.
  const order: Scanner[] = ['gitleaks', 'trivy-fs', 'semgrep', 'trivy-image']
  const scanners = order.filter((s) => stage.scanners.includes(s))
  return job(input, {
    initContainers: [
      cloneContainer(input),
      ...scanners.map((s) => scannerContainer(input, s)),
    ],
    containers: [dumpContainer(input, scanners)],
    volumes: scanners.some(isTrivy) ? [scanCacheVolume(input.config)] : [],
  })
}

export function dastTarget(app: string, env: string): string {
  return `http://${app}.${appNamespace(app, env)}.svc.cluster.local`
}

/** OWASP ZAP baseline scan against the in-cluster service of the deployed environment. */
export function dastJob(input: JobInput, stage: DastStageSpec): k8s.V1Job {
  const target = dastTarget(input.pipeline.app, stage.environment)
  const zap = [
    `zap-baseline.py -t ${shellQuote(target)} -J zap.json -I -m 2 -T 5`,
    'rc=$?',
    `cp /zap/wrk/zap.json ${REPORT_DIR}/zap.json 2>/dev/null || echo "zap produced no report (exit $rc)"`,
    'exit 0',
  ].join('\n')
  return job(input, {
    initContainers: [
      {
        name: 'prepare',
        image: input.config.images.busybox,
        command: [
          '/bin/sh',
          '-c',
          `mkdir -p ${REPORT_DIR} && chmod 0777 ${REPORT_DIR}`,
        ],
        volumeMounts: [workspaceMount],
      },
      {
        name: 'zap',
        image: input.config.images.zap,
        command: ['/bin/sh', '-c', zap],
        volumeMounts: [
          workspaceMount,
          { name: 'zap-wrk', mountPath: '/zap/wrk' },
        ],
        resources: {
          requests: { cpu: '250m', memory: '512Mi' },
          limits: { memory: '2Gi' },
        },
      },
    ],
    containers: [dumpContainer(input, ['zap'])],
    volumes: [{ name: 'zap-wrk', emptyDir: {} }],
  })
}
