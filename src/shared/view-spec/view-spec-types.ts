/**
 * Shapes and limits of the JSON view spec that `quirky view` sends and chat renders. Specs are
 * data; nothing here renders or validates (see view-spec-validation.ts).
 */

export const VIEW_NODE_TYPES = [
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

export type ViewNodeType = (typeof VIEW_NODE_TYPES)[number]

export function isViewNodeType(value: unknown): value is ViewNodeType {
  return typeof value === 'string' && VIEW_NODE_TYPES.some((type) => type === value)
}

/** `id` is the stable key for pointing at a node. */
export type ViewNode = {
  type: ViewNodeType
  id?: string
  props?: Record<string, unknown>
  children?: ViewNode[]
}

export type ViewSpec = { title: string; root: ViewNode }

export type ViewValidationError = { path: string; message: string }

export type ViewTone = 'neutral' | 'good' | 'warn' | 'bad'

export type DiagramProps = { source: string; caption?: string }
export type ImageProps = { path: string; alt: string; caption?: string }
export type HtmlProps = { html: string; interactive: boolean; height?: number }
export type LivePreviewProps = { url: string; caption?: string }
export type TimelineProps = {
  items: { id?: string; label: string; start: string; end?: string; tone?: ViewTone }[]
}
export type BoardProps = {
  columns: {
    title: string
    cards: { id?: string; title: string; detail?: string; tone?: ViewTone }[]
  }[]
}
export type MatrixProps = {
  columns: string[]
  rows: { label: string; cells: string[]; highlight?: string[] }[]
}
export type AnnotatedCodeProps = {
  language: string
  code: string
  notes: { lines: string; note: string }[]
}
export type FileMapProps = {
  entries: {
    path: string
    status: 'added' | 'modified' | 'deleted' | 'renamed' | 'touched'
    note?: string
  }[]
}
export type PlotProps = {
  xLabel?: string
  yLabel?: string
  series: { label: string; points: { x: number; y: number }[] }[]
}
export type SketchProps = {
  width: number
  height: number
  shapes: {
    id?: string
    kind: 'box' | 'ellipse' | 'line' | 'arrow' | 'text'
    x: number
    y: number
    w?: number
    h?: number
    x2?: number
    y2?: number
    label?: string
  }[]
}
export type MarkdownProps = { text: string }
export type KvProps = { items: { key: string; value: string }[] }
export type TableProps = { columns: string[]; rows: string[][] }
export type StatProps = { label: string; value: string; delta?: string; tone?: ViewTone }
export type StatusListProps = {
  items: { label: string; state: 'ok' | 'warn' | 'bad' | 'pending'; detail?: string }[]
}
export type StepsProps = {
  items: { text: string; state: 'done' | 'active' | 'pending' | 'failed' }[]
}
export type CodeProps = { text: string; language?: string }
export type FileDiffProps = { path: string; diff: string }
export type BarChartProps = { series: { label: string; value: number }[]; unit?: string }
export type LineChartProps = { points: { x: string | number; y: number }[]; unit?: string }
export type CalloutProps = { tone: 'info' | 'good' | 'warn' | 'bad'; text: string }
export type ButtonProps = { label: string; action: string; variant?: 'primary' | 'ghost' }
export type SectionProps = { title: string }

export type ViewFieldOption = { value: string; label: string; description?: string }

/** One inline question; the answer reaches the agent as an action named after `id`. */
export type ViewFieldQuestion = {
  id: string
  type: 'select' | 'multiselect' | 'text' | 'number' | 'confirm'
  question: string
  header?: string
  required?: boolean
  options?: ViewFieldOption[]
  default?: string | string[] | number | boolean
  multiline?: boolean
  pattern?: string
  format?: 'email' | 'url'
  integer?: boolean
  min?: number
  max?: number
}
export type FieldProps = { question: ViewFieldQuestion }

export type ViewNodePropsByType = {
  stack: undefined
  columns: undefined
  section: SectionProps
  markdown: MarkdownProps
  kv: KvProps
  table: TableProps
  stat: StatProps
  'status-list': StatusListProps
  steps: StepsProps
  code: CodeProps
  'file-diff': FileDiffProps
  'bar-chart': BarChartProps
  'line-chart': LineChartProps
  callout: CalloutProps
  button: ButtonProps
  field: FieldProps
  diagram: DiagramProps
  image: ImageProps
  html: HtmlProps
  'live-preview': LivePreviewProps
  timeline: TimelineProps
  board: BoardProps
  matrix: MatrixProps
  'annotated-code': AnnotatedCodeProps
  'file-map': FileMapProps
  plot: PlotProps
  sketch: SketchProps
}

/** A node narrowed to one kind, for renderers that switch on `type`. */
export type ViewNodeOf<T extends ViewNodeType> = {
  type: T
  id?: string
  props?: ViewNodePropsByType[T]
  children?: ViewNode[]
}

/** An RFC 6902 operation limited to add, replace and remove. Paths are JSON Pointers into the spec. */
export type ViewPatchOp = { op: 'add' | 'replace' | 'remove'; path: string; value?: unknown }

/** Operations applied in order, all or nothing, to a spec. */
export type ViewPatch = { ops: ViewPatchOp[] }

export const MAX_NODES = 500
export const MAX_DEPTH = 12
export const MAX_SPEC_BYTES = 256 * 1024
export const MAX_TABLE_ROWS = 500
export const MAX_CHART_POINTS = 500
export const MAX_TITLE_LENGTH = 120
export const MAX_PATCH_OPS = 200
export const MAX_HTML_BYTES = 128 * 1024
export const MAX_DIAGRAM_BYTES = 20 * 1024
export const MAX_CODE_BYTES = 64 * 1024
export const MAX_TABLE_COLUMNS = 20
export const MAX_LIST_ITEMS = 200
export const MAX_COLUMNS = 4
export const MAX_OPTIONS = 12
export const MAX_ID_LENGTH = 40
export const MIN_HTML_HEIGHT = 120
export const MAX_HTML_HEIGHT = 1200
export const MAX_MATRIX_COLUMNS = 12
export const MIN_SKETCH_SIDE = 40
export const MAX_SKETCH_SIDE = 4000

/** The shape of an action name and of node ids: a button's `action`, a field's `id`, a node `id`. */
export const ACTION_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/

export const FORMAT_PATTERNS: Record<'email' | 'url', RegExp> = {
  email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  url: /^[a-z][a-z0-9+.-]*:\/\/\S+$/i
}
