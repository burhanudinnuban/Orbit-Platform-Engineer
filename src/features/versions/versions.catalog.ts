import type { Platform } from '../../app/platform.js'
import type { CiImage } from '../../config/env.js'
import type { PlatformRuntime, VersionGroup } from '../../types/contract.js'
import type { UpgradePolicy } from './versions.semver.js'

/** vX.Y.Z and X.Y.Z releases: no rc, beta, -rootless, -ubuntu, sha-... */
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/
const V_SEMVER = /^v(\d+)\.(\d+)\.(\d+)$/

/** A Deployment in orbit-system whose container is named like it. */
export interface KubeTarget {
  runtimes: PlatformRuntime[]
  deployment: string
  /** File under bootstrap/manifests that defines it (and its default image). */
  manifest: string
}

export interface ComponentDef extends UpgradePolicy {
  id: string
  name: string
  group: VersionGroup
  description: string
  /** False when the component migrates its data on upgrade and cannot go back. */
  downgrade: boolean
  note?: string
  /** docker-compose.yml services running this image (runtime compose); the first is the main one. */
  compose?: string[]
  kube?: KubeTarget
  /** A CI or Terraform job image, with a command that prints its version (the smoke test of an update). */
  ci?: { key: CiImage; smoke: string[] }
  /** Resolves once the component serves again after an update. */
  probe?: (platform: Platform) => Promise<unknown>
}

const ORBIT_SYSTEM: PlatformRuntime[] = ['kind']

export const COMPONENTS: ComponentDef[] = [
  // ── runtime ───────────────────────────────────────────────────────────────
  {
    id: 'k3s',
    name: 'Kubernetes (k3s)',
    group: 'runtime',
    description: 'The cluster that runs CI jobs, Terraform jobs and the apps',
    tags: /^v(\d+)\.(\d+)\.(\d+)-k3s(\d+)$/,
    minorStep: 1,
    downgrade: false,
    note: 'Restarts the cluster: apps and running pipelines stop for about a minute. Kubernetes upgrades one minor version at a time and cannot be downgraded.',
    compose: ['k3s', 'k3s-setup'],
    probe: async (p) => {
      await p.kube().core.readNamespace({ name: p.config.platformNamespace })
    },
  },
  {
    id: 'dns',
    name: 'CoreDNS (pod DNS)',
    group: 'runtime',
    description:
      'Forwards DNS from pods to Docker, so CI reaches Compose services',
    tags: SEMVER,
    downgrade: true,
    compose: ['dns'],
  },
  {
    id: 'edge-proxy',
    name: 'Traefik (edge proxy)',
    group: 'runtime',
    description: 'Entry point of every *.localtest.me URL',
    tags: V_SEMVER,
    downgrade: true,
    compose: ['traefik'],
    probe: (p) => p.gitea.health(),
  },
  {
    id: 'ingress',
    name: 'Traefik (cluster ingress)',
    group: 'runtime',
    description: 'Routes app URLs to the apps inside the cluster',
    tags: V_SEMVER,
    downgrade: true,
    kube: {
      runtimes: ['compose', 'kind'],
      deployment: 'traefik',
      manifest: '10-traefik.yaml',
    },
  },
  {
    id: 'registry',
    name: 'Container registry',
    group: 'runtime',
    description: 'Stores the images CI builds',
    tags: SEMVER,
    downgrade: true,
    note: 'Registry 3 is a new major version: read its release notes before taking it.',
    compose: ['registry'],
    probe: async (p) => {
      const res = await fetch(`http://${p.config.registry.pull}/v2/`, {
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) throw new Error(`registry answered HTTP ${res.status}`)
    },
  },

  // ── platform services ─────────────────────────────────────────────────────
  {
    id: 'gitea',
    name: 'Gitea',
    group: 'service',
    description: 'Git hosting for app repositories and the gitops repo',
    tags: SEMVER,
    downgrade: false,
    note: 'Gitea migrates its database on upgrade and cannot go back to an older version.',
    compose: ['gitea'],
    kube: {
      runtimes: ORBIT_SYSTEM,
      deployment: 'gitea',
      manifest: '20-gitea.yaml',
    },
    probe: (p) => p.gitea.health(),
  },
  {
    id: 'prometheus',
    name: 'Prometheus',
    group: 'service',
    description: 'Metrics and alert rules of every app',
    tags: V_SEMVER,
    downgrade: true,
    compose: ['prometheus'],
    kube: {
      runtimes: ORBIT_SYSTEM,
      deployment: 'prometheus',
      manifest: '30-prometheus.yaml',
    },
    probe: (p) => p.prometheus.health(),
  },
  {
    id: 'grafana',
    name: 'Grafana',
    group: 'service',
    description: 'Dashboards of every app',
    tags: SEMVER,
    downgrade: false,
    note: 'Grafana migrates its database on upgrade; older versions may not start on it.',
    compose: ['grafana'],
    kube: {
      runtimes: ORBIT_SYSTEM,
      deployment: 'grafana',
      manifest: '40-grafana.yaml',
    },
    probe: (p) => p.grafana.health(),
  },
  {
    id: 'floci',
    name: 'Floci (local AWS)',
    group: 'service',
    description: 'S3 buckets and SQS queues of the apps',
    tags: SEMVER,
    downgrade: true,
    compose: ['floci'],
    kube: {
      runtimes: ORBIT_SYSTEM,
      deployment: 'floci',
      manifest: '35-floci.yaml',
    },
    probe: (p) => p.floci.health(),
  },

  // ── CI and Terraform job images ───────────────────────────────────────────
  {
    id: 'git',
    name: 'Git',
    group: 'ci',
    description: 'Clones app repositories in every pipeline',
    tags: /^v?(\d+)\.(\d+)\.(\d+)$/,
    downgrade: true,
    ci: { key: 'git', smoke: ['git', '--version'] },
  },
  {
    id: 'buildkit',
    name: 'BuildKit',
    group: 'ci',
    description: 'Builds app images from their Dockerfile',
    tags: V_SEMVER,
    downgrade: true,
    ci: {
      key: 'buildkit',
      smoke: [
        'sh',
        '-c',
        'buildctl --version && command -v buildctl-daemonless.sh',
      ],
    },
  },
  {
    id: 'semgrep',
    name: 'Semgrep',
    group: 'ci',
    description: 'Static analysis (SAST) in the security stage',
    tags: SEMVER,
    downgrade: true,
    ci: { key: 'semgrep', smoke: ['semgrep', '--version'] },
  },
  {
    id: 'trivy',
    name: 'Trivy',
    group: 'ci',
    description: 'Dependency and image vulnerability scans',
    tags: SEMVER,
    downgrade: true,
    // A real scan with the flags CI passes (ci.scanCache.ts, ci.pods.ts), minus
    // the vulnerability DB: a release that dropped one of them fails here.
    ci: {
      key: 'trivy',
      smoke: [
        'sh',
        '-c',
        'trivy --version && trivy fs --quiet --exit-code 0 --cache-dir /tmp/trivy --skip-db-update --cache-backend memory --scanners secret,misconfig --skip-check-update --format json --output /tmp/report.json /etc && echo "trivy fs: flags OK"',
      ],
    },
  },
  {
    id: 'gitleaks',
    name: 'Gitleaks',
    group: 'ci',
    description: 'Secret scanning in the security stage',
    tags: V_SEMVER,
    downgrade: true,
    // The command and flags of the security stage (ci.pods.ts), on an empty directory.
    ci: {
      key: 'gitleaks',
      smoke: [
        'sh',
        '-c',
        'gitleaks version && mkdir -p /tmp/src && gitleaks detect --no-git --no-banner --redact --exit-code 0 --source /tmp/src --report-format json --report-path /tmp/report.json && echo "gitleaks detect: flags OK"',
      ],
    },
  },
  {
    id: 'zap',
    name: 'OWASP ZAP',
    group: 'ci',
    description: 'DAST baseline scan of each deployed environment',
    tags: SEMVER,
    downgrade: true,
    note: 'About 1.2 GB: Orbit downloads a new version into the cluster before switching to it.',
    ci: {
      key: 'zap',
      smoke: ['sh', '-c', 'command -v zap-baseline.py && ls /zap | head -3'],
    },
  },
  {
    id: 'busybox',
    name: 'BusyBox',
    group: 'ci',
    description:
      'Helper containers of CI jobs (workspace setup, report output)',
    tags: /^(\d+)\.(\d+)(?:\.(\d+))?$/,
    downgrade: true,
    ci: { key: 'busybox', smoke: ['sh', '-c', 'busybox | head -1'] },
  },
  {
    id: 'terraform',
    name: 'Terraform',
    group: 'ci',
    description:
      'Provisions each app’s namespace, database and cloud resources',
    tags: SEMVER,
    downgrade: true,
    ci: { key: 'terraform', smoke: ['terraform', 'version'] },
  },
]

/** Components that exist on this runtime. */
export function componentsFor(runtime: PlatformRuntime): ComponentDef[] {
  return COMPONENTS.filter(
    (c) =>
      c.ci ||
      (runtime === 'compose' && c.compose) ||
      c.kube?.runtimes.includes(runtime)
  )
}

/** How a component is changed on this runtime. */
export function targetOf(
  c: ComponentDef,
  runtime: PlatformRuntime
): 'ci' | 'compose' | 'kube' {
  if (c.ci) return 'ci'
  if (runtime === 'compose' && c.compose) return 'compose'
  return 'kube'
}

/** "Update all" order: job images first, the cluster itself last. */
export const GROUP_ORDER: VersionGroup[] = ['ci', 'service', 'runtime']
