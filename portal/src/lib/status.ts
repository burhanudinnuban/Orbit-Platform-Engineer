/** The colour family a status renders in; maps onto the `tone-*` classes. */
export type Tone = 'success' | 'running' | 'failed' | 'pending' | 'warning'

/**
 * Every status the API reports — app, workflow, step, pipeline, stage, Argo
 * sync and health — in one table, so the same word is always the same colour.
 */
const TONES: Record<string, Tone> = {
  // success
  ready: 'success',
  succeeded: 'success',
  Synced: 'success',
  Healthy: 'success',
  // running
  provisioning: 'running',
  running: 'running',
  Progressing: 'running',
  // failed
  failed: 'failed',
  Error: 'failed',
  Degraded: 'failed',
  // warning
  deleting: 'warning',
  OutOfSync: 'warning',
  Missing: 'warning',
  // pending / neutral
  pending: 'pending',
  waiting: 'pending',
  queued: 'pending',
  skipped: 'pending',
  canceled: 'pending',
  deleted: 'pending',
  Pending: 'pending',
  Unknown: 'pending',
}

export function toneFor(status: string | undefined): Tone {
  return (status && TONES[status]) || 'pending'
}

const LABELS: Record<string, string> = {
  OutOfSync: 'Out of sync',
}

export function statusLabel(status: string): string {
  return LABELS[status] ?? status.charAt(0).toUpperCase() + status.slice(1)
}
