// REST API contract shared by the API server, the CLI and the portal.
// Keep this file free of runtime imports so the portal can `import type` it.

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info'
export type SeverityCounts = Record<Severity, number>
export type SecurityGate = 'critical' | 'high' | 'medium' | 'off'
export type AppSize = 'small' | 'medium' | 'large'
/** floci = local AWS emulator (https://github.com/floci-io/floci), aws = real AWS, none = disabled */
export type CloudProvider = 'floci' | 'aws' | 'none'

export type AppStatus =
  'provisioning' | 'ready' | 'failed' | 'deleting' | 'deleted'
export type WorkflowKind = 'provision' | 'teardown'
export type WorkflowStatus = 'pending' | 'running' | 'succeeded' | 'failed'
export type StepStatus =
  'pending' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'skipped'

export type PipelineStatus =
  'queued' | 'running' | 'succeeded' | 'failed' | 'canceled'
export type StageStatus =
  'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'canceled'
export type StageType = 'script' | 'build' | 'scan' | 'deploy' | 'dast'
export type PipelineTrigger = 'push' | 'manual' | 'initial'

export type SyncStatus =
  'Synced' | 'OutOfSync' | 'Pending' | 'Error' | 'Unknown'
export type HealthStatus =
  'Healthy' | 'Progressing' | 'Degraded' | 'Missing' | 'Unknown'

export type ScanTool = 'semgrep' | 'trivy' | 'gitleaks' | 'zap'
export type FindingCategory = 'sast' | 'sca' | 'secret' | 'image' | 'dast'

export interface AppOptions {
  database: boolean
  /** S3 bucket (Terraform module app-cloud) */
  objectStorage: boolean
  /** SQS queue with a dead-letter queue (Terraform module app-cloud) */
  queue: boolean
  size: AppSize
  securityGate: SecurityGate
}

export interface CreateAppRequest {
  name: string
  team: string
  template: string
  /** One of the template's languages (TemplateInfo.languages); default: its first. */
  language?: string
  description?: string
  environments: string[]
  options: AppOptions
}

export interface AppLinks {
  repository?: string
  /** environment → public URL */
  urls: Record<string, string>
  /** environment → Grafana dashboard URL */
  dashboards: Record<string, string>
}

export interface AppSummary {
  name: string
  team: string
  template: string
  /** Language the app was created in, such as typescript or javascript. */
  language: string
  description: string
  environments: string[]
  status: AppStatus
  createdAt: string
  updatedAt: string
  links: AppLinks
  latestPipeline?: PipelineSummary
  deployments: DeploymentStatus[]
  findings: SeverityCounts
}

/** AWS resources of one environment, provisioned in Floci locally or in real AWS. */
export interface CloudResources {
  provider: CloudProvider
  region: string
  /** Endpoint override the app uses (Floci's in-cluster URL); absent on real AWS. */
  endpoint?: string
  bucket?: string
  queueUrl?: string
  dlqUrl?: string
  /** Secret in the app namespace with AWS_* settings, S3_BUCKET and SQS_QUEUE_URL (loaded with envFrom). */
  secret: string
}

export interface AppDetail extends AppSummary {
  options: AppOptions
  /** environment → cloud resources (only for apps with object storage or a queue) */
  cloud: Record<string, CloudResources>
  workflows: WorkflowView[]
}

export interface WorkflowView {
  id: string
  app: string
  kind: WorkflowKind
  status: WorkflowStatus
  createdAt: string
  updatedAt: string
  error?: string
  steps: StepView[]
}

export interface StepView {
  id: string
  name: string
  title: string
  status: StepStatus
  attempts: number
  startedAt?: string
  finishedAt?: string
  logs: string
  error?: string
}

export interface PipelineSummary {
  id: string
  app: string
  number: number
  commitSha: string
  commitMessage?: string
  branch: string
  trigger: PipelineTrigger
  status: PipelineStatus
  createdAt: string
  startedAt?: string
  finishedAt?: string
}

export interface StageView {
  id: string
  name: string
  type: StageType
  status: StageStatus
  startedAt?: string
  finishedAt?: string
  logs: string
  error?: string
}

export interface PipelineDetail extends PipelineSummary {
  stages: StageView[]
}

export interface ResourceStatus {
  kind: string
  name: string
  namespace?: string
  health: HealthStatus
  syncStatus: SyncStatus
  message?: string
}

export interface DeploymentStatus {
  app: string
  env: string
  namespace: string
  syncStatus: SyncStatus
  health: HealthStatus
  /** gitops repo commit that was applied */
  revision?: string
  image?: string
  message?: string
  lastSyncedAt?: string
  url?: string
  resources: ResourceStatus[]
}

export interface Finding {
  id: string
  app: string
  pipelineId?: string
  tool: ScanTool
  category: FindingCategory
  severity: Severity
  title: string
  description?: string
  ruleId: string
  /** file:line for code findings, URL for DAST, package@version for dependencies */
  location?: string
  fingerprint: string
  createdAt: string
}

/** [unix seconds, value] */
export type Point = [number, number]

export interface AlertView {
  name: string
  state: 'inactive' | 'pending' | 'firing'
  severity: string
  summary?: string
}

export interface MetricsResponse {
  env: string
  available: boolean
  message?: string
  series: {
    requestRate: Point[]
    errorRate: Point[]
    p95LatencyMs: Point[]
    cpuCores: Point[]
    memoryMb: Point[]
  }
  alerts: AlertView[]
}

export interface ComponentHealth {
  name: string
  ok: boolean
  message?: string
}

export interface TemplateInfo {
  id: string
  name: string
  description: string
  /** The default language: languages[0]. */
  language: string
  /** Languages the template comes in, such as typescript and javascript; the first is the default. */
  languages: string[]
}

export interface PlatformInfo {
  version: string
  kubeContext: string
  runtime: PlatformRuntime
  environments: string[]
  templates: TemplateInfo[]
  components: ComponentHealth[]
  links: { git: string; grafana: string; prometheus: string; cloud?: string }
  /** namePrefix: buckets and queues are named <namePrefix>-<app>-<env> */
  cloud: { provider: CloudProvider; region: string; namePrefix: string }
}

/** compose: platform services from docker-compose.yml; kind: Deployments in orbit-system. */
export type PlatformRuntime = 'compose' | 'kind'

/** admin: the caller sent ORBIT_ADMIN_TOKEN; member: anyone else the API lets in. */
export type UserRole = 'admin' | 'member'

export interface SessionInfo {
  role: UserRole
  /** False when the API runs without ORBIT_ADMIN_TOKEN, so nobody can be admin. */
  adminConfigured: boolean
}

// ── Platform versions (admin) ────────────────────────────────────────────────

/** runtime: the cluster and its network; service: tools the platform runs; ci: images of CI and Terraform jobs. */
export type VersionGroup = 'runtime' | 'service' | 'ci'
/** Where the image comes from: the built-in default, .env (ORBIT_IMAGE_*), or an admin's update. */
export type VersionSource = 'default' | 'env' | 'admin'
export type UpdateState =
  'up-to-date' | 'update-available' | 'major-available' | 'unknown'

export interface VersionCandidate {
  version: string
  image: string
  /** A new major version (or, for k3s, more than one Kubernetes minor ahead). */
  major: boolean
}

export interface ComponentVersion {
  id: string
  name: string
  group: VersionGroup
  description: string
  /** The image the platform is configured to run. */
  image: string
  version: string
  /** The image actually running, when Orbit can see it and it differs from image. */
  running?: string
  source: VersionSource
  defaultImage: string
  /** What a rollback returns to. */
  previousImage?: string
  /** Newest version in the registry. */
  latest?: string
  /** Newest version that is safe to take without reading release notes ("Update all" goes here). */
  recommended?: string
  /** Newer versions, newest first. */
  candidates: VersionCandidate[]
  state: UpdateState
  checkedAt?: string
  checkError?: string
  /** False when Orbit cannot change it from where it runs; reason says why. */
  manageable: boolean
  reason?: string
  /** False when going back to an older version is unsupported (data migrations). */
  downgrade: boolean
  note?: string
  /** CI images: whether the image is already on the cluster node. */
  pulled?: boolean
  /** Id of the queued or running update of this component. */
  activeUpdate?: string
}

export type PlatformUpdateKind = 'update' | 'rollback'
export type PlatformUpdateStatus = 'queued' | 'running' | 'succeeded' | 'failed'

export interface PlatformUpdate {
  id: string
  component: string
  componentName: string
  kind: PlatformUpdateKind
  fromImage?: string
  toImage: string
  status: PlatformUpdateStatus
  logs: string
  error?: string
  createdAt: string
  startedAt?: string
  finishedAt?: string
}

export interface VersionsResponse {
  runtime: PlatformRuntime
  /** When the registries were last asked for new versions. */
  checkedAt?: string
  checking: boolean
  components: ComponentVersion[]
  /** Most recent first; logs are trimmed (GET /api/platform/updates/:id has them in full). */
  updates: PlatformUpdate[]
}

export interface UpdateComponentRequest {
  /** A tag from candidates, or any tag of the same repository. */
  version: string
}

export interface ApiError {
  error: string
  details?: unknown
}

/*
 * Endpoints
 *   GET    /api/platform                         → PlatformInfo
 *   GET    /api/apps                             → AppSummary[]
 *   POST   /api/apps            CreateAppRequest → AppDetail (201)
 *   GET    /api/apps/:name                       → AppDetail
 *   DELETE /api/apps/:name                       → WorkflowView (202, teardown workflow)
 *   POST   /api/apps/:name/workflows/:id/retry   → WorkflowView
 *   GET    /api/apps/:name/pipelines             → PipelineSummary[]
 *   POST   /api/apps/:name/pipelines             → PipelineSummary (manual run of main HEAD)
 *   GET    /api/pipelines/:id                    → PipelineDetail
 *   POST   /api/pipelines/:id/cancel             → PipelineSummary
 *   GET    /api/apps/:name/deployments           → DeploymentStatus[]
 *   GET    /api/apps/:name/findings[?pipelineId] → Finding[]
 *   GET    /api/apps/:name/metrics?env=&range=   → MetricsResponse   (range: 15m | 1h | 6h | 24h)
 *   GET    /api/session                          → SessionInfo
 *   GET    /api/platform/versions                → VersionsResponse
 *   POST   /api/platform/versions/check          → VersionsResponse (asks the registries again)
 *   POST   /api/platform/versions/:id/update  UpdateComponentRequest → PlatformUpdate (202, admin)
 *   POST   /api/platform/versions/:id/rollback   → PlatformUpdate (202, admin)
 *   POST   /api/platform/versions/update-all     → PlatformUpdate[] (202, admin: every recommended update)
 *   GET    /api/platform/updates/:id             → PlatformUpdate
 *   POST   /webhooks/gitea                       ← Gitea push webhook
 * Errors use ApiError with 4xx/5xx status codes.
 */
