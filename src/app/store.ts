import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import type {
  AppOptions,
  AppStatus,
  CloudResources,
  DeploymentStatus,
  Finding,
  PipelineStatus,
  PipelineTrigger,
  PlatformUpdateKind,
  PlatformUpdateStatus,
  ResourceStatus,
  SeverityCounts,
  StageStatus,
  StageType,
  StepStatus,
  WorkflowKind,
  WorkflowStatus,
} from '../types/contract.js'
import { newId, nowIso } from '../lib/util.js'

// node:sqlite prints an ExperimentalWarning when loaded. Load it lazily, after
// filtering that single warning, so logs stay clean.
const originalEmitWarning = process.emitWarning
process.emitWarning = function (warning: string | Error, ...rest: unknown[]) {
  if (
    String(warning instanceof Error ? warning.message : warning).includes(
      'SQLite'
    )
  )
    return
  return (originalEmitWarning as (...a: unknown[]) => void).call(
    process,
    warning,
    ...rest
  )
} as typeof process.emitWarning
const require = createRequire(import.meta.url)
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite')
type Database = InstanceType<typeof DatabaseSync>
type SqlValue = string | number | null

const DEFAULT_OPTIONS: AppOptions = {
  database: false,
  objectStorage: false,
  queue: false,
  size: 'small',
  securityGate: 'high',
}

export interface AppOutputs {
  repositoryUrl?: string
  webhookId?: number
  namespaces?: Record<string, string>
  urls?: Record<string, string>
  dashboards?: Record<string, string>
  /** environment → AWS resources (Floci locally) */
  cloud?: Record<string, CloudResources>
}

export interface AppRecord {
  name: string
  team: string
  template: string
  /** One of the template's languages (typescript, javascript, python...). */
  language: string
  description: string
  environments: string[]
  options: AppOptions
  status: AppStatus
  outputs: AppOutputs
  createdAt: string
  updatedAt: string
}

export interface WorkflowRecord {
  id: string
  app: string
  kind: WorkflowKind
  status: WorkflowStatus
  error?: string
  createdAt: string
  updatedAt: string
}

export interface StepRecord {
  id: string
  workflowId: string
  idx: number
  name: string
  title: string
  status: StepStatus
  attempts: number
  nextRunAt?: string
  startedAt?: string
  finishedAt?: string
  logs: string
  error?: string
  state: Record<string, unknown>
}

export interface PipelineRecord {
  id: string
  app: string
  number: number
  commitSha: string
  commitMessage?: string
  branch: string
  trigger: PipelineTrigger
  status: PipelineStatus
  error?: string
  createdAt: string
  startedAt?: string
  finishedAt?: string
}

export interface StageRecord {
  id: string
  pipelineId: string
  idx: number
  name: string
  type: StageType
  status: StageStatus
  jobName?: string
  logs: string
  error?: string
  startedAt?: string
  finishedAt?: string
}

export type NewFinding = Omit<
  Finding,
  'id' | 'app' | 'pipelineId' | 'createdAt'
>

const SCHEMA = `
CREATE TABLE IF NOT EXISTS apps (
  name TEXT PRIMARY KEY,
  team TEXT NOT NULL,
  template TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  environments TEXT NOT NULL,
  options TEXT NOT NULL,
  status TEXT NOT NULL,
  outputs TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  app TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS workflows_app ON workflows(app);
CREATE TABLE IF NOT EXISTS workflow_steps (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  name TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_run_at TEXT,
  started_at TEXT,
  finished_at TEXT,
  logs TEXT NOT NULL DEFAULT '',
  error TEXT,
  state TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS steps_workflow ON workflow_steps(workflow_id, idx);
CREATE TABLE IF NOT EXISTS pipelines (
  id TEXT PRIMARY KEY,
  app TEXT NOT NULL,
  number INTEGER NOT NULL,
  commit_sha TEXT NOT NULL,
  commit_message TEXT,
  branch TEXT NOT NULL,
  trigger TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  UNIQUE (app, number)
);
CREATE TABLE IF NOT EXISTS stages (
  id TEXT PRIMARY KEY,
  pipeline_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  job_name TEXT,
  logs TEXT NOT NULL DEFAULT '',
  error TEXT,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS stages_pipeline ON stages(pipeline_id, idx);
CREATE TABLE IF NOT EXISTS deployments (
  app TEXT NOT NULL,
  env TEXT NOT NULL,
  namespace TEXT NOT NULL,
  sync_status TEXT NOT NULL,
  health TEXT NOT NULL,
  revision TEXT,
  image TEXT,
  message TEXT,
  url TEXT,
  resources TEXT NOT NULL DEFAULT '[]',
  last_synced_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (app, env)
);
CREATE TABLE IF NOT EXISTS findings (
  id TEXT PRIMARY KEY,
  app TEXT NOT NULL,
  pipeline_id TEXT,
  report TEXT NOT NULL,
  tool TEXT NOT NULL,
  category TEXT NOT NULL,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  rule_id TEXT NOT NULL,
  location TEXT,
  fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS findings_app ON findings(app, report, pipeline_id);
CREATE TABLE IF NOT EXISTS scan_reports (
  app TEXT NOT NULL,
  report TEXT NOT NULL,
  pipeline_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (app, report)
);
CREATE TABLE IF NOT EXISTS branch_heads (
  app TEXT NOT NULL,
  branch TEXT NOT NULL,
  sha TEXT NOT NULL,
  PRIMARY KEY (app, branch)
);
CREATE TABLE IF NOT EXISTS platform_versions (
  component TEXT PRIMARY KEY,
  image TEXT NOT NULL,
  previous_image TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS platform_updates (
  id TEXT PRIMARY KEY,
  component TEXT NOT NULL,
  kind TEXT NOT NULL,
  from_image TEXT,
  to_image TEXT NOT NULL,
  status TEXT NOT NULL,
  logs TEXT NOT NULL DEFAULT '',
  error TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
`

/**
 * Columns added after the first release, as [table, column, definition,
 * backfill]. SQLite has no ADD COLUMN IF NOT EXISTS, so each is checked first.
 */
const COLUMNS: [string, string, string, string?][] = [
  [
    'apps',
    'language',
    "TEXT NOT NULL DEFAULT ''",
    // The only templates before languages existed: node-service (JavaScript) and python-service.
    "UPDATE apps SET language = CASE template WHEN 'python-service' THEN 'python' ELSE 'javascript' END WHERE language = ''",
  ],
]

type Row = Record<string, unknown>
const s = (v: unknown) =>
  v === null || v === undefined ? undefined : String(v)
const json = <T>(v: unknown, fallback: T): T => {
  if (typeof v !== 'string' || !v) return fallback
  try {
    return JSON.parse(v) as T
  } catch {
    return fallback
  }
}
const n = (v: string | number | undefined | null): SqlValue =>
  v === undefined ? null : v

export class Store {
  readonly db: Database

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true })
    this.db = new DatabaseSync(file)
    this.db.exec(
      'PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;'
    )
    this.db.exec(SCHEMA)
    for (const [table, column, definition, backfill] of COLUMNS) {
      const columns = this.all(`PRAGMA table_info(${table})`)
      if (columns.some((c) => c.name === column)) continue
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
      if (backfill) this.db.exec(backfill)
    }
  }

  close(): void {
    this.db.close()
  }

  private run(sql: string, ...params: SqlValue[]): void {
    this.db.prepare(sql).run(...params)
  }
  private get(sql: string, ...params: SqlValue[]): Row | undefined {
    return this.db.prepare(sql).get(...params) as Row | undefined
  }
  private all(sql: string, ...params: SqlValue[]): Row[] {
    return this.db.prepare(sql).all(...params) as Row[]
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  // ── apps ──────────────────────────────────────────────────────────────────

  private toApp(r: Row): AppRecord {
    return {
      name: String(r.name),
      team: String(r.team),
      template: String(r.template),
      language: String(r.language ?? ''),
      description: String(r.description ?? ''),
      environments: json<string[]>(r.environments, []),
      // Spread over defaults so records written before a new option existed still read cleanly.
      options: {
        ...DEFAULT_OPTIONS,
        ...json<Partial<AppOptions>>(r.options, {}),
      },
      status: String(r.status) as AppStatus,
      outputs: json<AppOutputs>(r.outputs, {}),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    }
  }

  insertApp(
    app: Omit<AppRecord, 'createdAt' | 'updatedAt' | 'outputs'>
  ): AppRecord {
    const now = nowIso()
    this.run(
      `INSERT INTO apps (name, team, template, language, description, environments, options, status, outputs, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?)`,
      app.name,
      app.team,
      app.template,
      app.language,
      app.description,
      JSON.stringify(app.environments),
      JSON.stringify(app.options),
      app.status,
      now,
      now
    )
    return this.getApp(app.name)!
  }

  getApp(name: string): AppRecord | undefined {
    const r = this.get('SELECT * FROM apps WHERE name = ?', name)
    return r ? this.toApp(r) : undefined
  }

  listApps(includeDeleted = false): AppRecord[] {
    const rows = includeDeleted
      ? this.all('SELECT * FROM apps ORDER BY created_at DESC')
      : this.all(
          "SELECT * FROM apps WHERE status != 'deleted' ORDER BY created_at DESC"
        )
    return rows.map((r) => this.toApp(r))
  }

  setAppStatus(name: string, status: AppStatus): void {
    this.run(
      'UPDATE apps SET status = ?, updated_at = ? WHERE name = ?',
      status,
      nowIso(),
      name
    )
  }

  mergeAppOutputs(name: string, patch: AppOutputs): AppOutputs {
    const app = this.getApp(name)
    if (!app) throw new Error(`app ${name} not found`)
    const merged: AppOutputs = { ...app.outputs }
    for (const [k, v] of Object.entries(patch) as [
      keyof AppOutputs,
      unknown,
    ][]) {
      const prev = merged[k]
      if (v && typeof v === 'object' && prev && typeof prev === 'object') {
        ;(merged as Record<string, unknown>)[k] = {
          ...(prev as object),
          ...(v as object),
        }
      } else {
        ;(merged as Record<string, unknown>)[k] = v
      }
    }
    this.run(
      'UPDATE apps SET outputs = ?, updated_at = ? WHERE name = ?',
      JSON.stringify(merged),
      nowIso(),
      name
    )
    return merged
  }

  /** Remove every trace of an app (used before re-creating a deleted app with the same name). */
  purgeApp(name: string): void {
    this.transaction(() => {
      for (const wf of this.all(
        'SELECT id FROM workflows WHERE app = ?',
        name
      )) {
        this.run(
          'DELETE FROM workflow_steps WHERE workflow_id = ?',
          String(wf.id)
        )
      }
      for (const p of this.all(
        'SELECT id FROM pipelines WHERE app = ?',
        name
      )) {
        this.run('DELETE FROM stages WHERE pipeline_id = ?', String(p.id))
      }
      for (const table of [
        'workflows',
        'pipelines',
        'deployments',
        'findings',
        'scan_reports',
        'branch_heads',
      ]) {
        this.run(`DELETE FROM ${table} WHERE app = ?`, name)
      }
      this.run('DELETE FROM apps WHERE name = ?', name)
    })
  }

  // ── workflows ─────────────────────────────────────────────────────────────

  private toWorkflow(r: Row): WorkflowRecord {
    return {
      id: String(r.id),
      app: String(r.app),
      kind: String(r.kind) as WorkflowKind,
      status: String(r.status) as WorkflowStatus,
      error: s(r.error),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    }
  }

  private toStep(r: Row): StepRecord {
    return {
      id: String(r.id),
      workflowId: String(r.workflow_id),
      idx: Number(r.idx),
      name: String(r.name),
      title: String(r.title),
      status: String(r.status) as StepStatus,
      attempts: Number(r.attempts),
      nextRunAt: s(r.next_run_at),
      startedAt: s(r.started_at),
      finishedAt: s(r.finished_at),
      logs: String(r.logs ?? ''),
      error: s(r.error),
      state: json<Record<string, unknown>>(r.state, {}),
    }
  }

  createWorkflow(
    app: string,
    kind: WorkflowKind,
    steps: { name: string; title: string }[]
  ): WorkflowRecord {
    const id = newId('wf')
    const now = nowIso()
    this.transaction(() => {
      this.run(
        'INSERT INTO workflows (id, app, kind, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        id,
        app,
        kind,
        'pending',
        now,
        now
      )
      steps.forEach((step, idx) => {
        this.run(
          `INSERT INTO workflow_steps (id, workflow_id, idx, name, title, status) VALUES (?, ?, ?, ?, ?, 'pending')`,
          newId('step'),
          id,
          idx,
          step.name,
          step.title
        )
      })
    })
    return this.getWorkflow(id)!
  }

  getWorkflow(id: string): WorkflowRecord | undefined {
    const r = this.get('SELECT * FROM workflows WHERE id = ?', id)
    return r ? this.toWorkflow(r) : undefined
  }

  listWorkflows(app: string): WorkflowRecord[] {
    return this.all(
      'SELECT * FROM workflows WHERE app = ? ORDER BY created_at DESC',
      app
    ).map((r) => this.toWorkflow(r))
  }

  activeWorkflows(): WorkflowRecord[] {
    return this.all(
      "SELECT * FROM workflows WHERE status IN ('pending', 'running') ORDER BY created_at"
    ).map((r) => this.toWorkflow(r))
  }

  setWorkflowStatus(id: string, status: WorkflowStatus, error?: string): void {
    this.run(
      'UPDATE workflows SET status = ?, error = ?, updated_at = ? WHERE id = ?',
      status,
      n(error),
      nowIso(),
      id
    )
  }

  listSteps(workflowId: string): StepRecord[] {
    return this.all(
      'SELECT * FROM workflow_steps WHERE workflow_id = ? ORDER BY idx',
      workflowId
    ).map((r) => this.toStep(r))
  }

  getStep(id: string): StepRecord | undefined {
    const r = this.get('SELECT * FROM workflow_steps WHERE id = ?', id)
    return r ? this.toStep(r) : undefined
  }

  updateStep(
    id: string,
    patch: Partial<
      Pick<
        StepRecord,
        | 'status'
        | 'attempts'
        | 'nextRunAt'
        | 'startedAt'
        | 'finishedAt'
        | 'error'
        | 'state'
      >
    >
  ): void {
    const sets: string[] = []
    const values: SqlValue[] = []
    const map: Record<string, string> = {
      status: 'status',
      attempts: 'attempts',
      nextRunAt: 'next_run_at',
      startedAt: 'started_at',
      finishedAt: 'finished_at',
      error: 'error',
      state: 'state',
    }
    for (const [key, column] of Object.entries(map)) {
      if (!(key in patch)) continue
      const value = (patch as Record<string, unknown>)[key]
      sets.push(`${column} = ?`)
      values.push(
        key === 'state'
          ? JSON.stringify(value ?? {})
          : ((value as SqlValue | undefined) ?? null)
      )
    }
    if (!sets.length) return
    this.run(
      `UPDATE workflow_steps SET ${sets.join(', ')} WHERE id = ?`,
      ...values,
      id
    )
  }

  appendStepLog(id: string, text: string): void {
    this.run(
      'UPDATE workflow_steps SET logs = logs || ? WHERE id = ?',
      text,
      id
    )
  }

  /** Steps left 'running' by a crash become 'pending' again; every step is idempotent. */
  recoverInterruptedSteps(): number {
    const rows = this.all(
      "SELECT id FROM workflow_steps WHERE status = 'running'"
    )
    this.run(
      "UPDATE workflow_steps SET status = 'pending', next_run_at = NULL WHERE status = 'running'"
    )
    return rows.length
  }

  // ── pipelines ─────────────────────────────────────────────────────────────

  private toPipeline(r: Row): PipelineRecord {
    return {
      id: String(r.id),
      app: String(r.app),
      number: Number(r.number),
      commitSha: String(r.commit_sha),
      commitMessage: s(r.commit_message),
      branch: String(r.branch),
      trigger: String(r.trigger) as PipelineTrigger,
      status: String(r.status) as PipelineStatus,
      error: s(r.error),
      createdAt: String(r.created_at),
      startedAt: s(r.started_at),
      finishedAt: s(r.finished_at),
    }
  }

  private toStage(r: Row): StageRecord {
    return {
      id: String(r.id),
      pipelineId: String(r.pipeline_id),
      idx: Number(r.idx),
      name: String(r.name),
      type: String(r.type) as StageType,
      status: String(r.status) as StageStatus,
      jobName: s(r.job_name),
      logs: String(r.logs ?? ''),
      error: s(r.error),
      startedAt: s(r.started_at),
      finishedAt: s(r.finished_at),
    }
  }

  createPipeline(p: {
    app: string
    commitSha: string
    commitMessage?: string
    branch: string
    trigger: PipelineTrigger
  }): PipelineRecord {
    const id = newId('pl')
    this.transaction(() => {
      const row = this.get(
        'SELECT COALESCE(MAX(number), 0) + 1 AS next FROM pipelines WHERE app = ?',
        p.app
      )
      this.run(
        `INSERT INTO pipelines (id, app, number, commit_sha, commit_message, branch, trigger, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
        id,
        p.app,
        Number(row?.next ?? 1),
        p.commitSha,
        n(p.commitMessage),
        p.branch,
        p.trigger,
        nowIso()
      )
    })
    return this.getPipeline(id)!
  }

  getPipeline(id: string): PipelineRecord | undefined {
    const r = this.get('SELECT * FROM pipelines WHERE id = ?', id)
    return r ? this.toPipeline(r) : undefined
  }

  findPipelineByCommit(
    app: string,
    sha: string,
    branch: string
  ): PipelineRecord | undefined {
    const r = this.get(
      'SELECT * FROM pipelines WHERE app = ? AND commit_sha = ? AND branch = ? ORDER BY number DESC LIMIT 1',
      app,
      sha,
      branch
    )
    return r ? this.toPipeline(r) : undefined
  }

  listPipelines(app: string, limit = 50): PipelineRecord[] {
    return this.all(
      'SELECT * FROM pipelines WHERE app = ? ORDER BY number DESC LIMIT ?',
      app,
      limit
    ).map((r) => this.toPipeline(r))
  }

  latestPipeline(app: string): PipelineRecord | undefined {
    const r = this.get(
      'SELECT * FROM pipelines WHERE app = ? ORDER BY number DESC LIMIT 1',
      app
    )
    return r ? this.toPipeline(r) : undefined
  }

  queuedPipelines(): PipelineRecord[] {
    return this.all(
      "SELECT * FROM pipelines WHERE status = 'queued' ORDER BY created_at"
    ).map((r) => this.toPipeline(r))
  }

  activePipelines(app?: string): PipelineRecord[] {
    const rows = app
      ? this.all(
          "SELECT * FROM pipelines WHERE app = ? AND status IN ('queued', 'running')",
          app
        )
      : this.all(
          "SELECT * FROM pipelines WHERE status IN ('queued', 'running')"
        )
    return rows.map((r) => this.toPipeline(r))
  }

  updatePipeline(
    id: string,
    patch: Partial<
      Pick<PipelineRecord, 'status' | 'error' | 'startedAt' | 'finishedAt'>
    >
  ): void {
    const map = {
      status: 'status',
      error: 'error',
      startedAt: 'started_at',
      finishedAt: 'finished_at',
    } as const
    const sets: string[] = []
    const values: SqlValue[] = []
    for (const [key, column] of Object.entries(map)) {
      if (!(key in patch)) continue
      sets.push(`${column} = ?`)
      values.push(
        ((patch as Record<string, unknown>)[key] as SqlValue | undefined) ??
          null
      )
    }
    if (sets.length)
      this.run(
        `UPDATE pipelines SET ${sets.join(', ')} WHERE id = ?`,
        ...values,
        id
      )
  }

  createStages(
    pipelineId: string,
    stages: { name: string; type: StageType }[]
  ): StageRecord[] {
    this.transaction(() => {
      this.run('DELETE FROM stages WHERE pipeline_id = ?', pipelineId)
      stages.forEach((st, idx) => {
        this.run(
          `INSERT INTO stages (id, pipeline_id, idx, name, type, status) VALUES (?, ?, ?, ?, ?, 'pending')`,
          newId('stg'),
          pipelineId,
          idx,
          st.name,
          st.type
        )
      })
    })
    return this.listStages(pipelineId)
  }

  listStages(pipelineId: string): StageRecord[] {
    return this.all(
      'SELECT * FROM stages WHERE pipeline_id = ? ORDER BY idx',
      pipelineId
    ).map((r) => this.toStage(r))
  }

  updateStage(
    id: string,
    patch: Partial<
      Pick<
        StageRecord,
        'status' | 'jobName' | 'logs' | 'error' | 'startedAt' | 'finishedAt'
      >
    >
  ): void {
    const map = {
      status: 'status',
      jobName: 'job_name',
      logs: 'logs',
      error: 'error',
      startedAt: 'started_at',
      finishedAt: 'finished_at',
    } as const
    const sets: string[] = []
    const values: SqlValue[] = []
    for (const [key, column] of Object.entries(map)) {
      if (!(key in patch)) continue
      sets.push(`${column} = ?`)
      values.push(
        ((patch as Record<string, unknown>)[key] as SqlValue | undefined) ??
          null
      )
    }
    if (sets.length)
      this.run(
        `UPDATE stages SET ${sets.join(', ')} WHERE id = ?`,
        ...values,
        id
      )
  }

  /** Pipelines/stages left running by a crash are marked failed; their jobs are orphaned. */
  recoverInterruptedPipelines(): number {
    const rows = this.all("SELECT id FROM pipelines WHERE status = 'running'")
    const now = nowIso()
    for (const r of rows) {
      const id = String(r.id)
      this.run(
        "UPDATE stages SET status = 'failed', error = 'interrupted by platform restart', finished_at = ? WHERE pipeline_id = ? AND status = 'running'",
        now,
        id
      )
      this.run(
        "UPDATE stages SET status = 'skipped' WHERE pipeline_id = ? AND status = 'pending'",
        id
      )
      this.run(
        "UPDATE pipelines SET status = 'failed', error = 'interrupted by platform restart', finished_at = ? WHERE id = ?",
        now,
        id
      )
    }
    return rows.length
  }

  getBranchHead(app: string, branch: string): string | undefined {
    return s(
      this.get(
        'SELECT sha FROM branch_heads WHERE app = ? AND branch = ?',
        app,
        branch
      )?.sha
    )
  }

  setBranchHead(app: string, branch: string, sha: string): void {
    this.run(
      'INSERT INTO branch_heads (app, branch, sha) VALUES (?, ?, ?) ON CONFLICT (app, branch) DO UPDATE SET sha = excluded.sha',
      app,
      branch,
      sha
    )
  }

  // ── deployments ───────────────────────────────────────────────────────────

  upsertDeployment(d: DeploymentStatus): void {
    this.run(
      `INSERT INTO deployments (app, env, namespace, sync_status, health, revision, image, message, url, resources, last_synced_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (app, env) DO UPDATE SET
         namespace = excluded.namespace, sync_status = excluded.sync_status, health = excluded.health,
         revision = excluded.revision, image = excluded.image, message = excluded.message, url = excluded.url,
         resources = excluded.resources, last_synced_at = COALESCE(excluded.last_synced_at, deployments.last_synced_at),
         updated_at = excluded.updated_at`,
      d.app,
      d.env,
      d.namespace,
      d.syncStatus,
      d.health,
      n(d.revision),
      n(d.image),
      n(d.message),
      n(d.url),
      JSON.stringify(d.resources),
      n(d.lastSyncedAt),
      nowIso()
    )
  }

  listDeployments(app?: string): DeploymentStatus[] {
    const rows = app
      ? this.all('SELECT * FROM deployments WHERE app = ? ORDER BY env', app)
      : this.all('SELECT * FROM deployments ORDER BY app, env')
    return rows.map((r) => ({
      app: String(r.app),
      env: String(r.env),
      namespace: String(r.namespace),
      syncStatus: String(r.sync_status) as DeploymentStatus['syncStatus'],
      health: String(r.health) as DeploymentStatus['health'],
      revision: s(r.revision),
      image: s(r.image),
      message: s(r.message),
      url: s(r.url),
      resources: json<ResourceStatus[]>(r.resources, []),
      lastSyncedAt: s(r.last_synced_at),
    }))
  }

  getDeployment(app: string, env: string): DeploymentStatus | undefined {
    return this.listDeployments(app).find((d) => d.env === env)
  }

  deleteDeployment(app: string, env: string): void {
    this.run('DELETE FROM deployments WHERE app = ? AND env = ?', app, env)
  }

  // ── findings ──────────────────────────────────────────────────────────────

  /** Replace the findings of one report (e.g. 'semgrep') for an app with the results of a pipeline. */
  replaceFindings(
    app: string,
    pipelineId: string,
    report: string,
    findings: NewFinding[]
  ): void {
    const now = nowIso()
    this.transaction(() => {
      this.run(
        'DELETE FROM findings WHERE app = ? AND report = ? AND pipeline_id = ?',
        app,
        report,
        pipelineId
      )
      for (const f of findings) {
        this.run(
          `INSERT INTO findings (id, app, pipeline_id, report, tool, category, severity, title, description, rule_id, location, fingerprint, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          newId('fnd'),
          app,
          pipelineId,
          report,
          f.tool,
          f.category,
          f.severity,
          f.title,
          n(f.description),
          f.ruleId,
          n(f.location),
          f.fingerprint,
          now
        )
      }
      this.run(
        `INSERT INTO scan_reports (app, report, pipeline_id, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (app, report) DO UPDATE SET pipeline_id = excluded.pipeline_id, created_at = excluded.created_at`,
        app,
        report,
        pipelineId,
        now
      )
    })
  }

  private toFinding(r: Row): Finding {
    return {
      id: String(r.id),
      app: String(r.app),
      pipelineId: s(r.pipeline_id),
      tool: String(r.tool) as Finding['tool'],
      category: String(r.category) as Finding['category'],
      severity: String(r.severity) as Finding['severity'],
      title: String(r.title),
      description: s(r.description),
      ruleId: String(r.rule_id),
      location: s(r.location),
      fingerprint: String(r.fingerprint),
      createdAt: String(r.created_at),
    }
  }

  /** Current findings: for each report, the findings from the latest pipeline that produced it. */
  currentFindings(app: string): Finding[] {
    return this.all(
      `SELECT f.* FROM findings f
       JOIN scan_reports r ON r.app = f.app AND r.report = f.report AND r.pipeline_id = f.pipeline_id
       WHERE f.app = ?
       ORDER BY CASE f.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END, f.title`,
      app
    ).map((r) => this.toFinding(r))
  }

  pipelineFindings(app: string, pipelineId: string): Finding[] {
    return this.all(
      'SELECT * FROM findings WHERE app = ? AND pipeline_id = ? ORDER BY severity, title',
      app,
      pipelineId
    ).map((r) => this.toFinding(r))
  }

  findingCounts(app: string): SeverityCounts {
    const counts: SeverityCounts = {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      info: 0,
    }
    for (const f of this.currentFindings(app)) counts[f.severity] += 1
    return counts
  }

  // ── platform versions ─────────────────────────────────────────────────────

  /** Images admins chose (Platform → Versions), by component id. */
  versionOverrides(): Map<string, VersionOverride> {
    return new Map(
      this.all('SELECT * FROM platform_versions').map((r) => [
        String(r.component),
        {
          component: String(r.component),
          image: String(r.image),
          previousImage: s(r.previous_image),
          updatedAt: String(r.updated_at),
        },
      ])
    )
  }

  setVersionOverride(
    component: string,
    image: string,
    previousImage?: string
  ): void {
    this.run(
      `INSERT INTO platform_versions (component, image, previous_image, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(component) DO UPDATE SET image = excluded.image, previous_image = excluded.previous_image, updated_at = excluded.updated_at`,
      component,
      image,
      n(previousImage),
      nowIso()
    )
  }

  private toPlatformUpdate(r: Row): PlatformUpdateRecord {
    return {
      id: String(r.id),
      component: String(r.component),
      kind: String(r.kind) as PlatformUpdateKind,
      fromImage: s(r.from_image),
      toImage: String(r.to_image),
      status: String(r.status) as PlatformUpdateStatus,
      logs: String(r.logs ?? ''),
      error: s(r.error),
      createdAt: String(r.created_at),
      startedAt: s(r.started_at),
      finishedAt: s(r.finished_at),
    }
  }

  createPlatformUpdate(u: {
    component: string
    kind: PlatformUpdateKind
    fromImage?: string
    toImage: string
  }): PlatformUpdateRecord {
    const id = newId('up')
    this.run(
      `INSERT INTO platform_updates (id, component, kind, from_image, to_image, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'queued', ?)`,
      id,
      u.component,
      u.kind,
      n(u.fromImage),
      u.toImage,
      nowIso()
    )
    return this.getPlatformUpdate(id)!
  }

  getPlatformUpdate(id: string): PlatformUpdateRecord | undefined {
    const r = this.get('SELECT * FROM platform_updates WHERE id = ?', id)
    return r ? this.toPlatformUpdate(r) : undefined
  }

  listPlatformUpdates(limit = 20): PlatformUpdateRecord[] {
    return this.all(
      'SELECT * FROM platform_updates ORDER BY created_at DESC LIMIT ?',
      limit
    ).map((r) => this.toPlatformUpdate(r))
  }

  setPlatformUpdateStatus(
    id: string,
    status: PlatformUpdateStatus,
    error?: string
  ): void {
    const now = nowIso()
    this.run(
      `UPDATE platform_updates SET status = ?, error = ?,
         started_at = CASE WHEN ? = 'running' THEN ? ELSE started_at END,
         finished_at = CASE WHEN ? IN ('succeeded', 'failed') THEN ? ELSE finished_at END
       WHERE id = ?`,
      status,
      n(error),
      status,
      now,
      status,
      now,
      id
    )
  }

  appendPlatformUpdateLog(id: string, text: string): void {
    this.run(
      'UPDATE platform_updates SET logs = logs || ? WHERE id = ?',
      text,
      id
    )
  }

  /** Updates left queued or running by a restart fail: Orbit does not resume them half-way. */
  recoverInterruptedPlatformUpdates(): number {
    const rows = this.all(
      "SELECT id FROM platform_updates WHERE status IN ('queued', 'running')"
    )
    for (const r of rows)
      this.setPlatformUpdateStatus(
        String(r.id),
        'failed',
        'interrupted by platform restart'
      )
    return rows.length
  }
}

export interface VersionOverride {
  component: string
  image: string
  previousImage?: string
  updatedAt: string
}

export interface PlatformUpdateRecord {
  id: string
  component: string
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

export function openStore(dataDir: string): Store {
  return new Store(path.join(dataDir, 'orbit.db'))
}
