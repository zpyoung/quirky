import type { AgentType } from '../../../../shared/agent-status-types'
import type { SessionOptionValue } from '../../../../shared/native-chat-session-options'
import {
  cloneNativeChatSessionOptionRecord,
  createNativeChatSessionOptionRecord,
  type NativeChatSessionOptionRecord,
  type TrackedNativeChatSessionOption
} from '../../../../shared/native-chat-session-option-state'
import { setBoundedScopeCacheEntry } from './bounded-scope-cache'

const sessionOptionCache = new Map<string, NativeChatSessionOptionRecord>()
// The values last taken from an agent report, per scope. Claude paints its model
// descriptor once and repaints it only on resize, so re-reading the same frame is
// not new evidence — and a frame painted before a `/effort` cannot have observed it.
const appliedReportByScope = new Map<string, string>()

function reportFingerprint(values: Record<string, SessionOptionValue>): string {
  return JSON.stringify(Object.entries(values).sort(([left], [right]) => left.localeCompare(right)))
}

/** Forgets the scope's last report, so the next one seeds the record it belongs to. */
export function clearNativeChatSessionOptionReport(scopeKey: string): void {
  appliedReportByScope.delete(scopeKey)
}

/**
 * Whether this report is new evidence for `scopeKey`, marking it applied when it is.
 * Only a report that *changes* may be folded into the record: replaying an identical
 * one would revert every pick the user has dispatched since it was painted.
 */
export function markNativeChatSessionOptionReport(
  scopeKey: string,
  values: Record<string, SessionOptionValue>
): boolean {
  const fingerprint = reportFingerprint(values)
  if (appliedReportByScope.get(scopeKey) === fingerprint) {
    return false
  }
  setBoundedScopeCacheEntry(appliedReportByScope, scopeKey, fingerprint)
  return true
}

export function readNativeChatSessionOptionCache(
  scopeKey: string,
  fallbackScopeKey?: string
): NativeChatSessionOptionRecord | null {
  const record = sessionOptionCache.get(scopeKey) ?? sessionOptionCache.get(fallbackScopeKey ?? '')
  return record ? cloneNativeChatSessionOptionRecord(record) : null
}

export function writeNativeChatSessionOptionCache(
  scopeKey: string,
  record: NativeChatSessionOptionRecord
): void {
  setBoundedScopeCacheEntry(
    sessionOptionCache,
    scopeKey,
    cloneNativeChatSessionOptionRecord(record)
  )
}

export function seedNativeChatAppliedSessionOptions(
  scopeKey: string,
  agent: AgentType,
  values: Record<string, SessionOptionValue> | null | undefined
): void {
  const modelId = typeof values?.model === 'string' ? values.model : null
  if (!modelId) {
    return
  }
  const record = createNativeChatSessionOptionRecord(agent)
  record.model = { value: modelId, source: 'applied' }
  const modelValues: Record<string, TrackedNativeChatSessionOption> = {}
  for (const [id, value] of Object.entries(values ?? {})) {
    if (id !== 'model') {
      modelValues[id] = { value, source: 'applied' }
    }
  }
  record.valuesByModel[modelId] = modelValues
  writeNativeChatSessionOptionCache(scopeKey, record)
}

export function clearNativeChatSessionOptionCacheForTests(): void {
  sessionOptionCache.clear()
  appliedReportByScope.clear()
}
