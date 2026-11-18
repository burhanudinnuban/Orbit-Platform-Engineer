import type { Platform } from '../../app/platform.js'
import type { AppOutputs, AppRecord } from '../../app/store.js'

export interface StepContext {
  platform: Platform
  /** Fresh app record at the start of the step. */
  app: AppRecord
  /** Append a line to the step's log (visible live in the portal). */
  log: (line: string) => void
  /** Append raw text (e.g. streamed job output) to the step's log. */
  write: (text: string) => void
  /** Durable per-step state, kept across retries and waits. */
  state: Record<string, unknown>
  /** Merge values into the app's outputs (links, namespaces...). */
  setOutputs: (outputs: AppOutputs) => void
  attempt: number
}

/** Return `{ waitMs }` to be re-invoked later without consuming an attempt. */
export type StepResult = void | { waitMs: number; message?: string }

export interface StepDefinition {
  name: string
  title: string
  run: (ctx: StepContext) => Promise<StepResult>
  /** Teardown counterpart; steps without it are skipped during teardown. */
  destroy?: (ctx: StepContext) => Promise<StepResult>
  /** Default 3. */
  maxAttempts?: number
  /** Maximum total time spent waiting, default 20 minutes. */
  waitTimeoutMs?: number
}
