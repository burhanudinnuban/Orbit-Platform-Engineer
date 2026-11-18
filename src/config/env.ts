import { existsSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import type { CloudProvider, PlatformRuntime } from '../types/contract.js'

export const ROOT_DIR = path.resolve(import.meta.dirname, '..', '..')
export const VERSION = '0.1.0'

const list = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .transform((s) =>
      s
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)
    )

const str = (fallback: string) => z.string().default(fallback)
const num = (fallback: number) => z.coerce.number().default(fallback)

const EnvSchema = z.object({
  ORBIT_PORT: num(4000),
  ORBIT_HOST: str('127.0.0.1'),
  ORBIT_PUBLIC_URL: str('http://localhost:4000'),
  ORBIT_PORTAL_URL: str('http://localhost:5173'),
  ORBIT_WEBHOOK_URL: str('http://host.docker.internal:4000/webhooks/gitea'),
  ORBIT_WEBHOOK_SECRET: str(''),
  ORBIT_DATA_DIR: str('.orbit-data'),
  // Defaults are the Docker Compose runtime (docker-compose.yml);
  // bootstrap/up.mjs writes the kind values to .env instead.
  ORBIT_KUBE_CONTEXT: str('orbit-compose'),
  ORBIT_ALLOWED_KUBE_CONTEXTS: list('orbit-compose'),
  ORBIT_COMPONENTS: list('api,worker,ci,gitops'),
  ORBIT_ENVIRONMENTS: list('dev,staging'),
  ORBIT_BASE_DOMAIN: str('localtest.me'),
  ORBIT_INGRESS_PORT: num(8080),
  ORBIT_API_TOKEN: str(''),
  // Bearer token of platform admins (Platform → Versions). Empty: nobody is admin.
  ORBIT_ADMIN_TOKEN: str(''),
  // Where the platform services run: compose (docker-compose.yml) or kind
  // (Deployments in orbit-system). Empty: compose for context orbit-compose.
  ORBIT_RUNTIME: z.enum(['', 'compose', 'kind']).default(''),
  ORBIT_LOG_LEVEL: str('info'),
  ORBIT_CI_POLL_SECONDS: num(30),
  ORBIT_CI_CONCURRENCY: num(2),
  ORBIT_GITOPS_INTERVAL_SECONDS: num(15),
  GITEA_URL: str('http://git.localtest.me:8080'),
  GITEA_INTERNAL_URL: str('http://gitea:3000'),
  GITEA_USER: str('orbit-admin'),
  GITEA_TOKEN: str(''),
  GITEA_APPS_ORG: str('apps'),
  GITEA_GITOPS_REPO: str('platform/gitops'),
  GRAFANA_URL: str('http://grafana.localtest.me:8080'),
  GRAFANA_USER: str('admin'),
  GRAFANA_PASSWORD: str(''),
  PROMETHEUS_URL: str('http://prometheus.localtest.me:8080'),
  // Alert rules: files in this directory, which Prometheus mounts (Docker Compose),
  // or ConfigMap prometheus-rules in orbit-system when empty (kind).
  PROMETHEUS_RULES_DIR: str('.orbit-data/prometheus-rules'),
  // Cloud resources for apps (S3, SQS): floci = local AWS emulator (Floci),
  // aws = real AWS (credentials in Secret orbit-aws-credentials), none = disabled.
  ORBIT_CLOUD: z.enum(['floci', 'aws', 'none']).default('floci'),
  ORBIT_AWS_REGION: str('us-east-1'),
  ORBIT_CLOUD_NAME_PREFIX: str('orbit'),
  FLOCI_URL: str('http://aws.localtest.me:8080'),
  FLOCI_INTERNAL_URL: str('http://floci:4566'),
  REGISTRY_PUSH: str('registry:5000'),
  REGISTRY_PULL: str('localhost:5001'),
  ORBIT_IMAGE_GIT: str('alpine/git:2.45.2'),
  ORBIT_IMAGE_BUILDKIT: str('moby/buildkit:v0.16.0'),
  ORBIT_IMAGE_SEMGREP: str('semgrep/semgrep:1.85.0'),
  ORBIT_IMAGE_TRIVY: str('aquasec/trivy:0.55.0'),
  // Trivy's vulnerability DB, downloaded into a volume that every scan shares.
  ORBIT_TRIVY_DB_REPOSITORY: str('mirror.gcr.io/aquasec/trivy-db:2'),
  ORBIT_TRIVY_DB_TIMEOUT_MINUTES: num(20),
  ORBIT_IMAGE_GITLEAKS: str('zricethezav/gitleaks:v8.18.4'),
  // Docker Hub's copy of ghcr.io/zaproxy/zaproxy: 1.2 GB, which ghcr.io serves
  // much more slowly (about 45 minutes against 4 on a slow office network).
  ORBIT_IMAGE_ZAP: str('zaproxy/zap-stable:2.17.0'),
  ORBIT_IMAGE_BUSYBOX: str('busybox:1.36'),
  ORBIT_IMAGE_TERRAFORM: str('hashicorp/terraform:1.9.5'),
})

export interface Config {
  version: string
  rootDir: string
  dataDir: string
  port: number
  host: string
  publicUrl: string
  portalUrl: string
  webhookUrl: string
  webhookSecret: string
  apiToken: string
  /** Bearer token that makes a caller a platform admin; empty means nobody is. */
  adminToken: string
  /** compose: platform services are docker-compose.yml services; kind: Deployments in orbit-system. */
  runtime: PlatformRuntime
  logLevel: string
  components: Set<string>
  environments: string[]
  baseDomain: string
  ingressPort: number
  platformNamespace: string
  kube: { context: string; allowedContexts: string[] }
  gitea: {
    url: string
    internalUrl: string
    user: string
    token: string
    appsOrg: string
    gitopsRepo: string
  }
  grafana: { url: string; user: string; password: string }
  prometheus: {
    url: string
    /** Absolute directory for alert rule files; empty means ConfigMap prometheus-rules. */
    rulesDir: string
  }
  cloud: {
    provider: CloudProvider
    region: string
    /** Bucket and queue name prefix (bucket names are global on real AWS). */
    namePrefix: string
    /** Floci as reached from this process (through Traefik); empty unless provider is floci. */
    url: string
    /** Floci as reached from pods; empty unless provider is floci. */
    internalUrl: string
    /** Secret in orbit-system with AWS credentials for Terraform (real AWS only). */
    credentialsSecret: string
  }
  registry: { push: string; pull: string }
  ci: {
    namespace: string
    pollSeconds: number
    concurrency: number
    credentialsSecret: string
    serviceAccount: string
    /** PersistentVolumeClaim in the CI namespace that holds Trivy's vulnerability DB. */
    scanCacheClaim: string
    trivyDb: {
      /** OCI repository of the DB; empty means Trivy's built-in default. */
      repository: string
      timeoutMinutes: number
    }
  }
  gitops: { intervalSeconds: number }
  terraform: { namespace: string; serviceAccount: string; modulesDir: string }
  /**
   * Tool images of CI and Terraform jobs. Platform → Versions overrides them
   * at runtime (features/versions), so read them when a job is created.
   */
  images: Record<CiImage, string>
}

export const CI_IMAGES = [
  'git',
  'buildkit',
  'semgrep',
  'trivy',
  'gitleaks',
  'zap',
  'busybox',
  'terraform',
] as const
export type CiImage = (typeof CI_IMAGES)[number]

/** The built-in image of each tool, before .env (ORBIT_IMAGE_*) or an admin changes it. */
export const DEFAULT_CI_IMAGES = Object.fromEntries(
  CI_IMAGES.map((key) => [
    key,
    EnvSchema.shape[ciImageEnv(key)].parse(undefined),
  ])
) as Record<CiImage, string>

export function ciImageEnv(key: CiImage) {
  return `ORBIT_IMAGE_${key.toUpperCase()}` as `ORBIT_IMAGE_${Uppercase<CiImage>}`
}

/**
 * A secret that grants access, or '' when it is a .env.example placeholder
 * (change-me...) or too short to be one the bootstrap generated.
 */
export function usableSecret(value: string): string {
  const v = value.trim()
  return v.length >= 16 && !v.startsWith('change-me') ? v : ''
}

export function loadDotEnv(file = path.join(ROOT_DIR, '.env')): void {
  if (existsSync(file)) process.loadEnvFile(file)
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ')
    throw new Error(`Invalid configuration: ${issues}`)
  }
  const e = parsed.data
  const trim = (u: string) => u.replace(/\/+$/, '')
  return {
    version: VERSION,
    rootDir: ROOT_DIR,
    dataDir: path.resolve(ROOT_DIR, e.ORBIT_DATA_DIR),
    port: e.ORBIT_PORT,
    host: e.ORBIT_HOST,
    publicUrl: trim(e.ORBIT_PUBLIC_URL),
    portalUrl: trim(e.ORBIT_PORTAL_URL),
    webhookUrl: e.ORBIT_WEBHOOK_URL,
    webhookSecret: e.ORBIT_WEBHOOK_SECRET,
    apiToken: e.ORBIT_API_TOKEN,
    adminToken: usableSecret(e.ORBIT_ADMIN_TOKEN),
    runtime:
      e.ORBIT_RUNTIME ||
      (e.ORBIT_KUBE_CONTEXT === 'orbit-compose' ? 'compose' : 'kind'),
    logLevel: e.ORBIT_LOG_LEVEL,
    components: new Set(e.ORBIT_COMPONENTS),
    environments: e.ORBIT_ENVIRONMENTS,
    baseDomain: e.ORBIT_BASE_DOMAIN,
    ingressPort: e.ORBIT_INGRESS_PORT,
    platformNamespace: 'orbit-system',
    kube: {
      context: e.ORBIT_KUBE_CONTEXT,
      allowedContexts: e.ORBIT_ALLOWED_KUBE_CONTEXTS,
    },
    gitea: {
      url: trim(e.GITEA_URL),
      internalUrl: trim(e.GITEA_INTERNAL_URL),
      user: e.GITEA_USER,
      token: e.GITEA_TOKEN,
      appsOrg: e.GITEA_APPS_ORG,
      gitopsRepo: e.GITEA_GITOPS_REPO,
    },
    grafana: {
      url: trim(e.GRAFANA_URL),
      user: e.GRAFANA_USER,
      password: e.GRAFANA_PASSWORD,
    },
    prometheus: {
      url: trim(e.PROMETHEUS_URL),
      rulesDir: e.PROMETHEUS_RULES_DIR.trim()
        ? path.resolve(ROOT_DIR, e.PROMETHEUS_RULES_DIR.trim())
        : '',
    },
    cloud: {
      provider: e.ORBIT_CLOUD,
      region: e.ORBIT_AWS_REGION,
      namePrefix: e.ORBIT_CLOUD_NAME_PREFIX,
      url: e.ORBIT_CLOUD === 'floci' ? trim(e.FLOCI_URL) : '',
      internalUrl: e.ORBIT_CLOUD === 'floci' ? trim(e.FLOCI_INTERNAL_URL) : '',
      credentialsSecret: 'orbit-aws-credentials',
    },
    registry: { push: e.REGISTRY_PUSH, pull: e.REGISTRY_PULL },
    ci: {
      namespace: 'orbit-ci',
      pollSeconds: e.ORBIT_CI_POLL_SECONDS,
      concurrency: Math.max(1, e.ORBIT_CI_CONCURRENCY),
      credentialsSecret: 'orbit-git-credentials',
      serviceAccount: 'orbit-ci-runner',
      scanCacheClaim: 'orbit-scan-cache',
      trivyDb: {
        repository: e.ORBIT_TRIVY_DB_REPOSITORY.trim(),
        timeoutMinutes: Math.max(1, e.ORBIT_TRIVY_DB_TIMEOUT_MINUTES),
      },
    },
    gitops: { intervalSeconds: Math.max(5, e.ORBIT_GITOPS_INTERVAL_SECONDS) },
    terraform: {
      namespace: 'orbit-system',
      serviceAccount: 'orbit-terraform',
      modulesDir: path.join(ROOT_DIR, 'terraform', 'modules'),
    },
    images: Object.fromEntries(
      CI_IMAGES.map((key) => [key, e[ciImageEnv(key)]])
    ) as Record<CiImage, string>,
  }
}

// ── Naming conventions (docs/architecture.md) ────────────────────────────────

export const appNamespace = (app: string, env: string) => `${app}-${env}`
export const appHost = (config: Config, app: string, env: string) =>
  `${app}-${env}.${config.baseDomain}`
export const appUrl = (config: Config, app: string, env: string) => {
  const port = config.ingressPort === 80 ? '' : `:${config.ingressPort}`
  return `http://${appHost(config, app, env)}${port}`
}
export const dashboardUid = (app: string, env: string) => `orbit-${app}-${env}`
export const dashboardUrl = (config: Config, app: string, env: string) =>
  `${config.grafana.url}/d/${dashboardUid(app, env)}`
export const imageRef = (registry: string, app: string, sha: string) =>
  `${registry}/${app}:${sha}`
export const gitopsAppDir = (app: string, env: string) => `apps/${app}/${env}`

export const APP_SIZES = {
  small: {
    cpuQuota: '1',
    memoryQuota: '1Gi',
    cpuRequest: '100m',
    memoryRequest: '128Mi',
    cpuLimit: '500m',
    memoryLimit: '256Mi',
    replicas: 1,
  },
  medium: {
    cpuQuota: '2',
    memoryQuota: '4Gi',
    cpuRequest: '250m',
    memoryRequest: '256Mi',
    cpuLimit: '1',
    memoryLimit: '512Mi',
    replicas: 2,
  },
  large: {
    cpuQuota: '4',
    memoryQuota: '8Gi',
    cpuRequest: '500m',
    memoryRequest: '512Mi',
    cpuLimit: '2',
    memoryLimit: '1Gi',
    replicas: 3,
  },
} as const
