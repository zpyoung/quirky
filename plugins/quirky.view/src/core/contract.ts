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
  'field'
] as const

export type CatalogType = (typeof CATALOG_TYPES)[number]

export type ViewNode = { type: CatalogType; props?: Record<string, unknown>; children?: ViewNode[] }

export type ViewSpec = { title: string; root: ViewNode }

export type ViewPlacement = 'inline' | 'pane'

export type ViewRecord = {
  viewId: string
  sessionId: string
  title: string
  spec: ViewSpec
  placement: ViewPlacement
  movedByUser: boolean
  updates: number
  createdAt: string
  updatedAt: string
  closed: boolean
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
