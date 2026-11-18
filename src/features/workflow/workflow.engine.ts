import type {
  StepView,
  WorkflowKind,
  WorkflowView,
} from '../../types/contract.js'
import { errorMessage } from '../../lib/logger.js'
import type { Platform } from '../../app/platform.js'
import type { StepRecord, WorkflowRecord } from '../../app/store.js'
import { nowIso } from '../../lib/util.js'
import type { StepContext, StepDefinition } from './workflow.types.js'

const WAIT_STARTED = '__waitStartedAt'

/**
 * Orbit's durable workflow engine (a small Temporal-like saga runner).
 * Workflows are ordered steps persisted in SQLite; each step is idempotent,
 * retried with exponential backoff, may "wait" (poll) and survives restarts.
 */
export class WorkflowEngine {
  private timer?: NodeJS.Timeout
  private inflight = new Set<string>()
  private stopped = false
  private readonly byName: Map<string, StepDefinition>

  constructor(
    private readonly platform: Platform,
    private readonly steps: StepDefinition[],
    private readonly options: { tickMs?: number; backoffBaseMs?: number } = {}
  ) {
    this.byName = new Map(steps.map((s) => [s.name, s]))
  }

  start(): void {
    const recovered = this.platform.store.recoverInterruptedSteps()
    if (recovered)
      this.platform.log.info(
        { recovered },
        'workflow steps resumed after restart'
      )
    this.platform.events.on('workflow:queued', () => void this.tick())
    this.schedule()
  }

  async stop(): Promise<void> {
    this.stopped = true
    clearTimeout(this.timer)
    while (this.inflight.size) await new Promise((r) => setTimeout(r, 100))
  }

  private schedule(): void {
    if (this.stopped) return
    this.timer = setTimeout(() => {
      void this.tick().finally(() => this.schedule())
    }, this.options.tickMs ?? 1000)
  }

  /** Create a workflow for an app. Teardown runs destroy() of each step in reverse order. */
  create(app: string, kind: WorkflowKind): WorkflowRecord {
    const defs =
      kind === 'provision'
        ? this.steps
        : [...this.steps].reverse().filter((s) => s.destroy)
    const wf = this.platform.store.createWorkflow(
      app,
      kind,
      defs.map((d) => ({
        name: d.name,
        title: kind === 'provision' ? d.title : `Remove: ${d.title}`,
      }))
    )
    this.platform.events.emit('workflow:queued', { workflowId: wf.id })
    return wf
  }

  retry(workflowId: string): WorkflowRecord {
    const { store } = this.platform
    const wf = store.getWorkflow(workflowId)
    if (!wf) throw new Error('workflow not found')
    if (wf.status !== 'failed')
      throw new Error(
        `workflow is ${wf.status}, only failed workflows can be retried`
      )
    for (const step of store.listSteps(workflowId)) {
      if (step.status === 'failed') {
        store.updateStep(step.id, {
          status: 'pending',
          attempts: 0,
          error: undefined,
          nextRunAt: undefined,
          finishedAt: undefined,
        })
        store.appendStepLog(step.id, `\n[${nowIso()}] ── retry requested ──\n`)
      }
    }
    store.setWorkflowStatus(workflowId, 'running')
    store.setAppStatus(
      wf.app,
      wf.kind === 'provision' ? 'provisioning' : 'deleting'
    )
    this.platform.events.emit('workflow:queued', { workflowId })
    return store.getWorkflow(workflowId)!
  }

  /** Process every active workflow once (one step each). Exposed for tests. */
  async tick(): Promise<void> {
    const runs: Promise<void>[] = []
    for (const wf of this.platform.store.activeWorkflows()) {
      if (this.inflight.has(wf.id)) continue
      this.inflight.add(wf.id)
      runs.push(
        this.advance(wf)
          .catch((err) =>
            this.platform.log.error(
              { err, workflow: wf.id },
              'workflow engine error'
            )
          )
          .finally(() => this.inflight.delete(wf.id))
      )
    }
    await Promise.all(runs)
  }

  private async advance(wf: WorkflowRecord): Promise<void> {
    const { store } = this.platform
    const steps = store.listSteps(wf.id)
    const next = steps.find(
      (s) => s.status !== 'succeeded' && s.status !== 'skipped'
    )
    if (!next) {
      store.setWorkflowStatus(wf.id, 'succeeded')
      store.setAppStatus(wf.app, wf.kind === 'provision' ? 'ready' : 'deleted')
      this.platform.log.info(
        { app: wf.app, kind: wf.kind },
        'workflow succeeded'
      )
      return
    }
    if (next.status === 'failed') return
    if (next.nextRunAt && Date.parse(next.nextRunAt) > Date.now()) return
    if (wf.status === 'pending') store.setWorkflowStatus(wf.id, 'running')

    const def = this.byName.get(next.name)
    if (!def) {
      this.fail(wf, next, `unknown step "${next.name}"`)
      return
    }
    await this.runStep(wf, next, def)
  }

  private async runStep(
    wf: WorkflowRecord,
    step: StepRecord,
    def: StepDefinition
  ): Promise<void> {
    const { store } = this.platform
    const app = store.getApp(wf.app)
    if (!app) {
      this.fail(wf, step, `app ${wf.app} no longer exists`)
      return
    }
    const resuming = step.status === 'waiting'
    const attempt = resuming ? step.attempts : step.attempts + 1
    const state = { ...step.state }
    store.updateStep(step.id, {
      status: 'running',
      attempts: attempt,
      startedAt: step.startedAt ?? nowIso(),
      nextRunAt: undefined,
    })
    if (!resuming)
      store.appendStepLog(step.id, `[${nowIso()}] attempt ${attempt}\n`)

    const ctx: StepContext = {
      platform: this.platform,
      app,
      attempt,
      state,
      log: (line) => store.appendStepLog(step.id, `[${nowIso()}] ${line}\n`),
      write: (text) => store.appendStepLog(step.id, text),
      setOutputs: (outputs) => {
        store.mergeAppOutputs(app.name, outputs)
      },
    }

    const fn = wf.kind === 'provision' ? def.run : def.destroy
    try {
      const result = fn ? await fn(ctx) : undefined
      if (result && 'waitMs' in result) {
        const startedWaiting = Number(state[WAIT_STARTED] ?? Date.now())
        state[WAIT_STARTED] = startedWaiting
        if (Date.now() - startedWaiting > (def.waitTimeoutMs ?? 20 * 60_000)) {
          throw new Error(
            `gave up waiting: ${result.message ?? 'condition not met'}`
          )
        }
        if (result.message && result.message !== state.__lastWaitMessage) {
          ctx.log(`waiting: ${result.message}`)
          state.__lastWaitMessage = result.message
        }
        store.updateStep(step.id, {
          status: 'waiting',
          state,
          nextRunAt: new Date(Date.now() + result.waitMs).toISOString(),
        })
        return
      }
      delete state[WAIT_STARTED]
      delete state.__lastWaitMessage
      store.updateStep(step.id, {
        status: 'succeeded',
        state,
        finishedAt: nowIso(),
        error: undefined,
      })
      ctx.log('done')
    } catch (err) {
      const message = errorMessage(err)
      ctx.log(`error: ${message}`)
      const maxAttempts = def.maxAttempts ?? 3
      delete state[WAIT_STARTED]
      if (attempt < maxAttempts) {
        const delay = (this.options.backoffBaseMs ?? 5000) * 2 ** (attempt - 1)
        ctx.log(
          `retrying in ${Math.round(delay / 1000)}s (${attempt}/${maxAttempts})`
        )
        store.updateStep(step.id, {
          status: 'pending',
          state,
          error: message,
          nextRunAt: new Date(Date.now() + delay).toISOString(),
        })
      } else {
        store.updateStep(step.id, { state })
        this.fail(wf, step, message)
      }
    }
  }

  private fail(wf: WorkflowRecord, step: StepRecord, message: string): void {
    const { store } = this.platform
    store.updateStep(step.id, {
      status: 'failed',
      error: message,
      finishedAt: nowIso(),
    })
    store.setWorkflowStatus(wf.id, 'failed', `${step.title}: ${message}`)
    store.setAppStatus(wf.app, 'failed')
    this.platform.log.warn(
      { app: wf.app, step: step.name, error: message },
      'workflow failed'
    )
  }

  view(wf: WorkflowRecord): WorkflowView {
    return {
      id: wf.id,
      app: wf.app,
      kind: wf.kind,
      status: wf.status,
      createdAt: wf.createdAt,
      updatedAt: wf.updatedAt,
      error: wf.error,
      steps: this.platform.store.listSteps(wf.id).map((s): StepView => ({
        id: s.id,
        name: s.name,
        title: s.title,
        status: s.status,
        attempts: s.attempts,
        startedAt: s.startedAt,
        finishedAt: s.finishedAt,
        logs: s.logs,
        error: s.error,
      })),
    }
  }
}
