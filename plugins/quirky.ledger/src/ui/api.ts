import type { UiPluginContext } from '@quirky/protocol'
import type { LedgerRequest, LedgerResponse } from './types'

export async function ledgerRequest(context: UiPluginContext, request: LedgerRequest, confirmed = false): Promise<LedgerResponse> {
  const params: Record<string, unknown> = {
    ...request,
    ...(confirmed ? { yes: true, confirmed: true } : {})
  }
  const raw = await context.call('quirky.ledger/request', params)
  if (typeof raw !== 'object' || raw === null) throw new Error('Ledger returned an invalid response.')
  const value = raw as Record<string, unknown>
  const runtime = value.runtime
  if (value.schemaVersion !== 1 || !('ledger' in value) || typeof runtime !== 'object' || runtime === null || !('runtimeId' in runtime) || typeof runtime.runtimeId !== 'string' || !('profileId' in runtime) || typeof runtime.profileId !== 'string') {
    throw new Error('Ledger returned an incompatible response.')
  }
  if (request.operation === 'list' && !Array.isArray(value.entries)) throw new Error('Ledger list response is missing entries.')
  if (request.operation === 'show' && (typeof value.entry !== 'object' || value.entry === null)) throw new Error('Ledger show response is missing its entry.')
  if (request.operation === 'review' && !Array.isArray(value.candidates)) throw new Error('Ledger review response is missing candidates.')
  if (request.operation === 'catalog' && !Array.isArray(value.ledgers)) throw new Error('Ledger catalog response is missing ledgers.')
  if (request.operation === 'removal-preview' && !Array.isArray(value.removalPreview)) throw new Error('Ledger removal preview response is missing snapshots.')
  if (['file', 'edit', 'state', 'revert'].includes(request.operation) && (typeof value.entry !== 'object' || value.entry === null)) {
    throw new Error(`Ledger ${request.operation} response is missing its entry.`)
  }
  return value as unknown as LedgerResponse
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string') return error.message
  return String(error)
}

export function errorData(error: unknown): Record<string, unknown> {
  if (typeof error !== 'object' || error === null) return {}
  const data = 'data' in error ? error.data : undefined
  return typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {}
}

export function currentRevisionOf(error: unknown): number | null {
  const revision = errorData(error).currentRevision
  return typeof revision === 'number' && Number.isSafeInteger(revision) ? revision : null
}

export function isConflict(error: unknown): boolean {
  return errorData(error).kind === 'conflict' || errorData(error).kind === 'revision-conflict' || currentRevisionOf(error) !== null
}

