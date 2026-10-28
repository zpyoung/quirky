import type { KernelWorkerObservation } from './contracts'

export function isCoordinatorSeatLostError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || Array.isArray(error)) return false
  if ('code' in error && error.code === 'consumer_fenced') return true
  if ('data' in error && typeof error.data === 'object' && error.data !== null &&
    !Array.isArray(error.data) && 'reason' in error.data && error.data.reason === 'consumer_fenced') return true
  return 'message' in error && typeof error.message === 'string' && error.message.startsWith('consumer_fenced:')
}

export function workerObservationsFromRun(value: unknown, runId: string): KernelWorkerObservation[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || !('run' in value) ||
    typeof value.run !== 'object' || value.run === null || Array.isArray(value.run) ||
    !('id' in value.run) || value.run.id !== runId) {
    throw new Error('the orchestration run could not be verified')
  }
  if (!('workers' in value) || !Array.isArray(value.workers) ||
    !('questions' in value) || !Array.isArray(value.questions)) {
    throw new Error('the orchestration run returned malformed worker observations')
  }

  const seen = new Set<string>()
  const workers: unknown[] = value.workers
  return workers.map((value, index) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value) ||
      !('dispatchId' in value) || typeof value.dispatchId !== 'string' || value.dispatchId.length === 0) {
      throw new Error(`the orchestration run returned a malformed worker observation at index ${index}`)
    }
    if (seen.has(value.dispatchId)) {
      throw new Error(`the orchestration run returned duplicate worker observation ${value.dispatchId}`)
    }
    if (!('sessionId' in value) || (value.sessionId !== null && typeof value.sessionId !== 'string')) {
      throw new Error(`worker observation ${value.dispatchId} has an invalid session identity`)
    }
    if (!('processIncarnation' in value) ||
      (value.processIncarnation !== null && typeof value.processIncarnation !== 'string')) {
      throw new Error(`worker observation ${value.dispatchId} has an invalid process incarnation`)
    }
    if (!('state' in value) || (value.state !== 'live' && value.state !== 'exited' && value.state !== 'unverifiable')) {
      throw new Error(`worker observation ${value.dispatchId} has an invalid state`)
    }
    if (!('assignmentActive' in value) || typeof value.assignmentActive !== 'boolean') {
      throw new Error(`worker observation ${value.dispatchId} has invalid assignment activity`)
    }
    if (value.state === 'live' &&
      (typeof value.sessionId !== 'string' || value.sessionId.length === 0 ||
        typeof value.processIncarnation !== 'string' || value.processIncarnation.length === 0)) {
      throw new Error(`live worker observation ${value.dispatchId} has no complete process identity`)
    }
    if (!('lastContactAtMs' in value) ||
      (value.lastContactAtMs !== null && (typeof value.lastContactAtMs !== 'number' || !Number.isFinite(value.lastContactAtMs)))) {
      throw new Error(`worker observation ${value.dispatchId} has an invalid contact time`)
    }
    const state = value.state === 'live' && value.lastContactAtMs === null ? 'unverifiable' : value.state
    seen.add(value.dispatchId)
    return {
      dispatchId: value.dispatchId,
      sessionId: value.sessionId,
      processIncarnation: value.processIncarnation,
      state,
      assignmentActive: value.assignmentActive,
      lastContactAtMs: value.lastContactAtMs
    }
  })
}
