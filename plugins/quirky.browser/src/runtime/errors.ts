import type { PluginErrorKind, PluginContext } from '@quirky/protocol'

export type BrowserReason =
  | 'invalid_argument'
  | 'browser_import_invalid_json'
  | 'browser_import_not_array'
  | 'browser_import_empty'
  | 'browser_import_no_valid_cookies'
  | 'browser_no_tab'
  | 'browser_tab_not_found'
  | 'browser_profile_not_found'
  | 'browser_import_not_found'
  | 'browser_stale_ref'
  | 'browser_tab_closed'
  | 'browser_tab_changed'
  | 'browser_timeout'
  | 'browser_eval_error'
  | 'browser_unavailable'
  | 'browser_import_source_unavailable'
  | 'browser_unsafe_replace'
  | 'browser_error'

const KIND_BY_REASON: Record<BrowserReason, PluginErrorKind> = {
  invalid_argument: 'invalid-params',
  browser_import_invalid_json: 'invalid-params',
  browser_import_not_array: 'invalid-params',
  browser_import_empty: 'invalid-params',
  browser_import_no_valid_cookies: 'invalid-params',
  browser_no_tab: 'not-found',
  browser_tab_not_found: 'not-found',
  browser_profile_not_found: 'not-found',
  browser_import_not_found: 'not-found',
  browser_stale_ref: 'conflict',
  browser_tab_closed: 'conflict',
  browser_tab_changed: 'conflict',
  browser_timeout: 'conflict',
  browser_eval_error: 'conflict',
  browser_unavailable: 'conflict',
  browser_import_source_unavailable: 'conflict',
  browser_unsafe_replace: 'conflict',
  browser_error: 'conflict'
}

export class BrowserFault extends Error {
  readonly kind: PluginErrorKind

  constructor(readonly reason: BrowserReason, detail: string) {
    super(`${reason}: ${detail}`)
    this.name = 'BrowserFault'
    this.kind = KIND_BY_REASON[reason]
  }
}

export function fault(reason: BrowserReason, detail: string): BrowserFault {
  return new BrowserFault(reason, detail)
}

export function asPluginError(context: PluginContext, error: unknown): Error {
  if (error instanceof BrowserFault) return context.error(error.kind, redactedMessage(error))
  return context.error('conflict', `browser_error: ${redactedMessage(error)}`)
}

export function redactedMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.replace(/(?:\/[^\s:]+){2,}/g, '[path]').replace(/(?:cookie|password|secret|token)[^\s=]*=[^\s]*/gi, '[redacted]').slice(0, 500)
}
