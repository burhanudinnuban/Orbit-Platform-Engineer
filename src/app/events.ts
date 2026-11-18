import { EventEmitter } from 'node:events'

export interface OrbitEvents {
  /** Ask the GitOps controller to reconcile now (optionally just one app). */
  'gitops:sync': { app?: string; reason: string }
  /** A deployment status row changed. */
  'deployment:updated': { app: string; env: string }
  /** A pipeline was queued; wakes the CI scheduler. */
  'ci:queued': { pipelineId: string }
  /** Cancel every queued or running pipeline of an app (teardown). */
  'ci:cancel': { app: string }
  /** A workflow was created or retried; wakes the workflow engine. */
  'workflow:queued': { workflowId: string }
}

export class Events {
  private emitter = new EventEmitter()

  constructor() {
    this.emitter.setMaxListeners(100)
  }

  emit<K extends keyof OrbitEvents>(event: K, payload: OrbitEvents[K]): void {
    this.emitter.emit(event, payload)
  }

  on<K extends keyof OrbitEvents>(
    event: K,
    listener: (payload: OrbitEvents[K]) => void
  ): () => void {
    this.emitter.on(event, listener)
    return () => this.emitter.off(event, listener)
  }
}
