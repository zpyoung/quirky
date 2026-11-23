/** Shared view shapes and text-answer checks used by both the renderer and daemon catalog. */
export const CATALOG_TYPES = [
  'stack',
  'columns',
  'section',
  'markdown',
  'kv',
  'table',
  'stat',
  'status-list',
  'steps',
  'code',
  'file-diff',
  'bar-chart',
  'line-chart',
  'callout',
  'button',
  'field',
  'diagram',
  'image',
  'html',
  'live-preview',
  'timeline',
  'board',
  'matrix',
  'annotated-code',
  'file-map',
  'plot',
  'sketch'
] as const

export type CatalogType = (typeof CATALOG_TYPES)[number]

/** `id` is the stable key for pointing at a node. */
export type ViewNode = { type: CatalogType; id?: string; props?: Record<string, unknown>; children?: ViewNode[] }

export type ViewSpec = { title: string; label?: string; root: ViewNode }

export type ViewPlacement = 'inline' | 'pane'

/** The attempt that was refused: `render` is a version the window could not draw, the rest are daemon-side checks. */
export type RefusedAttempt = 'open' | 'update' | 'patch' | 'render'

/**
 * The newest refusal of a view. `version` is the version that failed to render, or null when the
 * attempt never became a version (a refused update or patch). `at` is epoch milliseconds.
 */
export type Refused = { attempt: RefusedAttempt; version: number | null; errors: string[]; source: string; at: number }

export type ViewRecord = {
  viewId: string
  sessionId: string
  title: string
  /** The short tab name of the current spec, when it has one. */
  label?: string
  spec: ViewSpec
  placement: ViewPlacement
  movedByUser: boolean
  /** Always `latestVersion - 1`. */
  updates: number
  createdAt: string
  updatedAt: string
  closed: boolean
  /** The mark that the visual's work is over; any new version clears it. The daemon always sets it; optional so older readers and fakes still type-check. */
  done?: boolean
  /** The version `spec` belongs to. The daemon always sets it; optional so older readers and fakes still type-check. */
  version?: number
  latestVersion?: number
  refused?: Refused | null
}

/** A record as the daemon returns it, with every version field present. */
export type StoredViewRecord = ViewRecord & { done: boolean; version: number; latestVersion: number; refused: Refused | null }

export type ViewChangeKind = 'open' | 'update' | 'patch' | 'close' | 'done' | 'reopen' | 'move' | 'refused' | 'render-failed'

/** The `quirky.view/changed` event; `version` and `placement` are the view's after the change. */
export type ViewChangedEvent = { sessionId: string; viewId: string; version: number; kind: ViewChangeKind; placement: ViewPlacement }

/** An RFC 6902 operation, limited to add, replace and remove. Paths are JSON Pointers into the spec. */
export type PatchOp = { op: 'add' | 'replace' | 'remove'; path: string; value?: unknown }

export type ViewSurface = 'inline' | 'panel' | 'thumbnail' | 'expanded' | 'window'

/** The input of `view:quirky.view/render`. With no `version` the card follows the latest one. */
export type ViewMountInput = {
  viewId: string
  version?: number
  surface?: ViewSurface
  drawing?: boolean
  focused?: boolean
}

export type ViewAction = { name: string; viewId: string; source: string; at: string; data?: Record<string, unknown> }

export type ViewValidationError = { path: string; message: string }

export type ViewSpecValidationResult =
  | { ok: true; spec: ViewSpec }
  | { ok: false; errors: ViewValidationError[] }

export const FORMAT_PATTERNS: Record<'email' | 'url', RegExp> = {
  email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  url: /^[a-z][a-z0-9+.-]*:\/\/\S+$/i
}

const MAX_PATTERN_TEST_LENGTH = 200

/** The reason `raw` breaks the text question's pattern or format, else undefined. */
export function textAnswerError(question: { pattern?: unknown; format?: unknown }, raw: string): string | undefined {
  if (typeof question.pattern === 'string') {
    if (raw.length > MAX_PATTERN_TEST_LENGTH) return `must be at most ${MAX_PATTERN_TEST_LENGTH} characters`
    let regex: RegExp
    try {
      regex = new RegExp(question.pattern)
    } catch {
      return 'does not match the required pattern'
    }
    if (!regex.test(raw)) return 'does not match the required pattern'
  }
  if ((question.format === 'email' || question.format === 'url') && !FORMAT_PATTERNS[question.format].test(raw)) return `is not a valid ${question.format}`
  return undefined
}
