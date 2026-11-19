/**
 * The view catalog: the only components an agent can draw, the checks every spec passes before it
 * is stored, and the guide text `quirky view --help` prints. Specs are data; nothing here renders.
 */

import { loadsImages } from './mermaid-guard'
import { CATALOG_TYPES, FORMAT_PATTERNS, textAnswerError } from './contract'
import type {
  CatalogType,
  PatchOp,
  Refused,
  RefusedAttempt,
  StoredViewRecord,
  ViewAction,
  ViewChangeKind,
  ViewChangedEvent,
  ViewMountInput,
  ViewNode,
  ViewPlacement,
  ViewRecord,
  ViewSpec,
  ViewSpecValidationResult,
  ViewSurface,
  ViewValidationError
} from './contract'

export { CATALOG_TYPES, FORMAT_PATTERNS, textAnswerError }
export type {
  CatalogType,
  PatchOp,
  Refused,
  RefusedAttempt,
  StoredViewRecord,
  ViewAction,
  ViewChangeKind,
  ViewChangedEvent,
  ViewMountInput,
  ViewNode,
  ViewPlacement,
  ViewRecord,
  ViewSpec,
  ViewSpecValidationResult,
  ViewSurface,
  ViewValidationError
}

export const MAX_NODES = 500
export const MAX_DEPTH = 12
export const MAX_SPEC_BYTES = 256 * 1024
export const MAX_TABLE_ROWS = 500
export const MAX_CHART_POINTS = 500
export const MAX_TITLE_LENGTH = 120
const MAX_TABLE_COLUMNS = 20
const MAX_LIST_ITEMS = 200
const MAX_COLUMNS = 4
const MAX_OPTIONS = 12
const MAX_ID_LENGTH = 40
const MAX_DIAGRAM_BYTES = 20 * 1024
const MAX_HTML_BYTES = 128 * 1024
const MAX_CODE_BYTES = 64 * 1024
const MIN_HTML_HEIGHT = 120
const MAX_HTML_HEIGHT = 1200
const MAX_MATRIX_COLUMNS = 12
const MIN_SKETCH_SIDE = 40
const MAX_SKETCH_SIDE = 4000
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] as const
const LOCAL_PREVIEW_HOSTS = ['localhost', '127.0.0.1'] as const
const FILE_STATUSES = ['added', 'modified', 'deleted', 'renamed', 'touched'] as const
const SKETCH_SHAPES = ['box', 'ellipse', 'line', 'arrow', 'text'] as const

/** The shape of an action name: a button's `action` and a field's `id`. */
export const ACTION_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/

const TONES = ['neutral', 'good', 'warn', 'bad'] as const
const CALLOUT_TONES = ['info', 'good', 'warn', 'bad'] as const
const STATUS_STATES = ['ok', 'warn', 'bad', 'pending'] as const
const STEP_STATES = ['done', 'active', 'pending', 'failed'] as const
const BUTTON_VARIANTS = ['primary', 'ghost'] as const
const FIELD_TYPES = ['select', 'multiselect', 'text', 'number', 'confirm'] as const
const RESERVED_IDS = new Set(['__proto__', 'constructor', 'prototype'])
const ID_HINT = `lowercase letters, digits and dashes, 1 to ${MAX_ID_LENGTH} characters`

type Check = { errors: ViewValidationError[]; fieldIds: Set<string>; ids: Set<string>; nodes: number; nodeLimitHit: boolean }

type Field =
  | { kind: 'string'; required?: boolean; max?: number; bytes?: boolean; markdown?: boolean; pattern?: RegExp; hint?: string; ident?: boolean }
  | { kind: 'enum'; values: readonly string[]; required?: boolean }
  | { kind: 'number'; required?: boolean; min?: number; max?: number }
  | { kind: 'boolean'; required?: boolean }
  | { kind: 'text-or-number'; required?: boolean }
  | { kind: 'strings'; min: number; max: number; optional?: boolean }
  | { kind: 'list'; of: Shape; min: number; max: number; what: string }
  | { kind: 'matrix'; max: number }
  | { kind: 'question' }

type Shape = Record<string, Field>

type Component = {
  summary: string
  container?: 'any' | 'columns'
  shape: Shape
  example: ViewNode
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

const CREDENTIAL_TRIGGER = '(pass(word|phrase)?|secret\\s?key|secret|token|api\\s?key|credential|private\\s?key)'
const CREDENTIAL_PATTERN = new RegExp(`\\b${CREDENTIAL_TRIGGER}\\b`, 'i')
const CREDENTIAL_SUBSTRING_PATTERN = new RegExp(CREDENTIAL_TRIGGER, 'i')

// a capital run against a lowercase run (`DBpassword`) has no marker for where the trailing word
// starts, so both splits are checked
function credentialCandidates(value: string): string[] {
  const withoutSeparators = value.replace(/[_-]+/g, ' ')
  const finishSplit = (candidate: string): string =>
    candidate
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/([A-Za-z])(\d)/g, '$1 $2')
      .replace(/(\d)([A-Za-z])/g, '$1 $2')
  return [
    finishSplit(withoutSeparators.replace(/([A-Z]+)(?=[A-Z][a-z])/g, '$1 ')),
    finishSplit(withoutSeparators.replace(/([A-Z]+)([a-z])/g, '$1 $2'))
  ]
}

function mentionsCredential(value: string): boolean {
  return credentialCandidates(value).some((normalized) => {
    if (CREDENTIAL_PATTERN.test(normalized)) return true
    // an unbroken capital run (MYSECRET) has no internal boundary for \b
    return normalized.split(' ').some((word) => /^[A-Z0-9]+$/.test(word) && CREDENTIAL_SUBSTRING_PATTERN.test(word))
  })
}

const MAX_PATTERN_LENGTH = 200
const MAX_PATTERN_TEST_LENGTH = 200
const MAX_PATTERN_QUANTIFIERS = 3

type CountedQuantifier = { length: number; variable: boolean }

/** Reads a `{n}`, `{n,}` or `{n,m}` quantifier at `index`; anything else is a literal brace. */
function readCountedQuantifier(pattern: string, index: number): CountedQuantifier | undefined {
  const match = /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(index, index + 24))
  if (!match) return undefined
  const [text, min, comma, max] = match
  const variable = comma !== undefined && (max === '' || Number(max) > Number(min))
  return { length: text.length, variable }
}

type UnsafePatternShape = 'nested-repetition' | 'repeated-alternation' | 'too-many-quantifiers'

/**
 * Names the first regex shape that can backtrack badly, since a synchronous regex can't be
 * interrupted once matching starts: a repeated group whose body has a variable quantifier
 * (`(a+)+`), a repeated group with alternatives (`(a|ab)+`), and more than
 * `MAX_PATTERN_QUANTIFIERS` variable quantifiers. With none of those, matching a 200-character
 * input stays polynomial of low degree. A `?` after a group does not count as repeating it.
 */
function findUnsafePatternShape(pattern: string): UnsafePatternShape | undefined {
  const groupHasQuantifier: boolean[] = []
  const groupHasAlternation: boolean[] = []
  let inClass = false
  let quantifierCount = 0
  const markQuantifier = (): void => {
    quantifierCount++
    if (groupHasQuantifier.length > 0) groupHasQuantifier[groupHasQuantifier.length - 1] = true
  }
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]
    if (char === '\\') {
      // each backreference lets the matcher revisit earlier captures, so it spends quantifier budget
      if (!inClass && /[1-9k]/.test(pattern[i + 1] ?? '')) markQuantifier()
      i++
      continue
    }
    if (inClass) {
      if (char === ']') inClass = false
      continue
    }
    if (char === '[') {
      inClass = true
    } else if (char === '(') {
      groupHasQuantifier.push(false)
      groupHasAlternation.push(false)
      if (pattern[i + 1] === '?') i++
    } else if (char === '|') {
      if (groupHasAlternation.length > 0) groupHasAlternation[groupHasAlternation.length - 1] = true
    } else if (char === ')') {
      const bodyHadQuantifier = groupHasQuantifier.pop() ?? false
      const bodyHadAlternation = groupHasAlternation.pop() ?? false
      const next = pattern[i + 1]
      const repeats = next === '+' || next === '*' || readCountedQuantifier(pattern, i + 1) !== undefined
      if (repeats && bodyHadQuantifier) return 'nested-repetition'
      if (repeats && bodyHadAlternation) return 'repeated-alternation'
      if (groupHasQuantifier.length > 0 && bodyHadQuantifier) {
        groupHasQuantifier[groupHasQuantifier.length - 1] = true
      }
      if (groupHasAlternation.length > 0 && bodyHadAlternation) {
        groupHasAlternation[groupHasAlternation.length - 1] = true
      }
    } else if (char === '+' || char === '*' || char === '?') {
      markQuantifier()
      if (pattern[i + 1] === '?') i++
    } else if (char === '{') {
      const counted = readCountedQuantifier(pattern, i)
      if (counted) {
        if (counted.variable) markQuantifier()
        i += counted.length - 1
        if (pattern[i + 1] === '?') i++
      }
    }
  }
  return quantifierCount > MAX_PATTERN_QUANTIFIERS ? 'too-many-quantifiers' : undefined
}

const UNSAFE_PATTERN_MESSAGES: Record<UnsafePatternShape, string> = {
  'nested-repetition': 'pattern must not nest repetition (e.g. (a+)+); it can hang the regex engine',
  'repeated-alternation':
    'pattern must not repeat a group with alternatives (e.g. (a|ab)+); it can hang the regex engine',
  'too-many-quantifiers': `pattern must have at most ${MAX_PATTERN_QUANTIFIERS} variable quantifiers; it can hang the regex engine`
}

/** The text field question with id `name` in the spec, if there is one. */
export function findTextQuestion(node: ViewNode, name: string): Record<string, unknown> | undefined {
  const question = node.type === 'field' ? node.props?.question : undefined
  if (typeof question === 'object' && question !== null) {
    const found = question as Record<string, unknown>
    if (found.id === name && (found.type === 'text' || found.type === undefined)) return found
  }
  for (const child of node.children ?? []) {
    const hit = findTextQuestion(child, name)
    if (hit) return hit
  }
  return undefined
}

const FENCED_CODE = /^(\s{0,3})(?=(?:`{3}|~{3})[^\n]*\n)(`{3,}|~{3,})[^\n]*\n[\s\S]*?(\n\s{0,3}\2[`~]*\s*(?=\n|$)|$)/gm

/**
 * Removes inline code spans in one pass, pairing each backtick run with the next run at least as
 * long (CommonMark's rule); a regex for this backtracks quadratically on long runs of backticks.
 */
function stripInlineCode(text: string): string {
  let out = ''
  let copied = 0
  let at = 0
  for (;;) {
    const start = text.indexOf('`', at)
    if (start < 0) break
    let end = start
    while (text[end] === '`') end++
    const length = end - start
    const next = text.indexOf('`', end)
    let nextLength = 0
    if (next >= 0) {
      while (text[next + nextLength] === '`') nextLength++
    }
    if (next >= 0 && nextLength >= length) {
      out += text.slice(copied, start)
      copied = at = next + length
    } else if (length >= 2) {
      const half = length >> 1
      out += text.slice(copied, start)
      copied = at = start + 2 * half
    } else {
      at = end
    }
  }
  return out + text.slice(copied)
}

function stripMarkdownCode(text: string): string {
  return stripInlineCode(text.replace(FENCED_CODE, ''))
}

const isSpace = (char: string | undefined): boolean => char !== undefined && /\s/.test(char)
const isLineTerminator = (char: string | undefined): boolean => char === '\n' || char === '\r' || char === '\u2028' || char === '\u2029'

/** Finds the first `]` at or after a position; callers move forward only, so a hit is reused. */
function closingBracketFinder(source: string): (from: number) => number {
  let found = -2
  return (from) => {
    if (found === -1 || found >= from) return found
    found = source.indexOf(']', from)
    return found
  }
}

/** `[text](destination` and `![text](destination` found without backtracking. */
function inlineLinks(source: string): { destination: string; image: boolean }[] {
  const found: { destination: string; image: boolean }[] = []
  const closeFrom = closingBracketFinder(source)
  let resume = 0
  for (let open = source.indexOf('[', resume); open >= 0; open = source.indexOf('[', Math.max(open + 1, resume))) {
    const close = closeFrom(open + 1)
    if (close < 0) break
    if (source[close + 1] !== '(') continue
    let cursor = close + 2
    while (isSpace(source[cursor])) cursor++
    if (source[cursor] === '<') cursor++
    const from = cursor
    while (cursor < source.length && source[cursor] !== ')' && source[cursor] !== '>' && !isSpace(source[cursor])) cursor++
    found.push({ destination: source.slice(from, cursor), image: open > resume && source[open - 1] === '!' })
    resume = cursor
  }
  return found
}

/** `[label]: destination` reference definitions: up to three spaces of indent, at a line start. */
function referenceDefinitions(source: string): { destination: string; image: boolean }[] {
  const found: { destination: string; image: boolean }[] = []
  const closeFrom = closingBracketFinder(source)
  const lineStartAtOrAfter = (from: number): number => {
    if (from === 0) return 0
    for (let index = from - 1; index < source.length; index++) if (isLineTerminator(source[index])) return index + 1
    return source.length + 1
  }
  let lineStart = 0
  while (lineStart <= source.length) {
    let open = lineStart
    while (open - lineStart < 3 && isSpace(source[open])) open++
    let next = lineStartAtOrAfter(lineStart + 1)
    if (source[open] === '[') {
      const close = closeFrom(open + 1)
      if (close < 0) break
      if (close > open + 1 && source[close + 1] === ':') {
        let cursor = close + 2
        while (isSpace(source[cursor])) cursor++
        if (cursor < source.length) {
          const labelled = source[cursor] === '<' && cursor + 1 < source.length && !isSpace(source[cursor + 1])
          const from = labelled ? cursor + 1 : cursor
          cursor = from
          while (cursor < source.length && !isSpace(source[cursor])) cursor++
          found.push({ destination: source.slice(from, cursor), image: false })
          next = lineStartAtOrAfter(cursor)
        }
      }
    }
    lineStart = next
  }
  return found
}

/** Every link or image destination in `text` that is not an absolute http(s) URL. */
function unsafeMarkdownLinks(text: string): { destination: string; image: boolean }[] {
  const source = stripMarkdownCode(text)
  const found = inlineLinks(source)
  found.push(...referenceDefinitions(source))
  for (const match of source.matchAll(/<([a-zA-Z][a-zA-Z0-9+.-]*:[^\s<>]*)>/g)) found.push({ destination: match[1], image: false })
  return found.filter(({ destination, image }) => image || !/^https?:\/\/\S/i.test(destination))
}

function shorten(text: string): string {
  return text.length > 40 ? `${text.slice(0, 40)}...` : text
}

function checkMarkdown(text: string, path: string, errors: ViewValidationError[]): void {
  for (const { destination, image } of unsafeMarkdownLinks(text)) {
    errors.push({
      path,
      message: image
        ? 'markdown images are not allowed; a view never loads remote content'
        : `markdown link '${shorten(destination)}' must be an absolute http(s) URL`
    })
  }
}

function levenshtein(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0]
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const above = row[j]
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1))
      diagonal = above
    }
  }
  return row[b.length]
}

/** The catalog types nearest to `name`, closest first; empty when nothing is plausibly meant. */
export function nearestTypes(name: string, limit = 3): CatalogType[] {
  const lower = name.toLowerCase()
  return CATALOG_TYPES.map((type) => ({
    type,
    distance: lower.includes(type) || type.includes(lower) ? 0 : levenshtein(lower, type)
  }))
    .filter(({ type, distance }) => distance <= Math.max(2, Math.floor(type.length / 3)))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit)
    .map(({ type }) => type)
}

function isRequired(field: Field): boolean {
  if (field.kind === 'strings') return field.optional !== true
  return field.kind === 'list' || field.kind === 'matrix' || field.kind === 'question' || field.required === true
}

function describeField(field: Field): string {
  switch (field.kind) {
    case 'string':
      return field.ident ? 'string (an id)' : 'string'
    case 'enum':
      return field.values.join('|')
    case 'number':
      return field.min !== undefined && field.max !== undefined ? `number (${field.min} to ${field.max})` : 'number'
    case 'boolean':
      return 'boolean'
    case 'text-or-number':
      return 'string|number'
    case 'strings':
      return 'string[]'
    case 'matrix':
      return 'string[][]'
    case 'question':
      return 'ask question object (see field)'
    case 'list':
      return `{${describeShape(field.of)}}[]`
  }
}

function describeShape(shape: Shape): string {
  return Object.entries(shape)
    .map(([name, field]) => {
      return `${name}${isRequired(field) ? '' : '?'}: ${describeField(field)}`
    })
    .join(', ')
}

const ID_FIELD: Field = { kind: 'string', ident: true, pattern: ACTION_NAME_PATTERN, hint: ID_HINT }
const CAPTION_FIELD: Field = { kind: 'string', max: 200 }
const TONE_FIELD: Field = { kind: 'enum', values: TONES }

const ITEM_STATE_SHAPE = (states: readonly string[], text: string): Shape => ({
  [text]: { kind: 'string', required: true },
  state: { kind: 'enum', values: states, required: true }
})

export const COMPONENTS: Record<CatalogType, Component> = {
  stack: {
    summary: 'Vertical container; children render top to bottom.',
    container: 'any',
    shape: {},
    example: { type: 'stack', children: [{ type: 'markdown', props: { text: 'Hello' } }] }
  },
  columns: {
    summary: `Side-by-side container; each child is one column, at most ${MAX_COLUMNS}.`,
    container: 'columns',
    shape: {},
    example: {
      type: 'columns',
      children: [
        { type: 'stat', props: { label: 'Passed', value: '120' } },
        { type: 'stat', props: { label: 'Failed', value: '2', tone: 'bad' } }
      ]
    }
  },
  section: {
    summary: 'Titled container.',
    container: 'any',
    shape: { title: { kind: 'string', required: true, max: 120 } },
    example: { type: 'section', props: { title: 'Details' }, children: [{ type: 'markdown', props: { text: 'Notes' } }] }
  },
  markdown: {
    summary: 'Formatted text. Links must be absolute http(s) URLs and ask the user before opening; images and raw HTML are dropped. Math written as $x^2$ or $$x^2$$ is typeset.',
    shape: { text: { kind: 'string', required: true, markdown: true } },
    example: { type: 'markdown', props: { text: 'See the [docs](https://example.com/docs) for **details**.' } }
  },
  kv: {
    summary: 'Key and value rows.',
    shape: { items: { kind: 'list', of: { key: { kind: 'string', required: true }, value: { kind: 'string', required: true } }, min: 1, max: MAX_LIST_ITEMS, what: 'items' } },
    example: { type: 'kv', props: { items: [{ key: 'Branch', value: 'main' }, { key: 'Commit', value: 'a1b2c3d' }] } }
  },
  table: {
    summary: `Header row plus data rows; every row has one cell per column, at most ${MAX_TABLE_ROWS} rows.`,
    shape: { columns: { kind: 'strings', min: 1, max: MAX_TABLE_COLUMNS }, rows: { kind: 'matrix', max: MAX_TABLE_ROWS } },
    example: { type: 'table', props: { columns: ['Package', 'Size'], rows: [['zxcvbn', '14 KB'], ['date-fns-tz', '21 KB']] } }
  },
  stat: {
    summary: 'One headline number with a label.',
    shape: {
      label: { kind: 'string', required: true, max: 80 },
      value: { kind: 'string', required: true, max: 80 },
      delta: { kind: 'string', max: 80 },
      tone: { kind: 'enum', values: TONES }
    },
    example: { type: 'stat', props: { label: 'Total (gzip)', value: '412 KB', delta: '+38 KB', tone: 'bad' } }
  },
  'status-list': {
    summary: 'Rows with a status dot.',
    shape: {
      items: {
        kind: 'list',
        of: { label: { kind: 'string', required: true }, state: { kind: 'enum', values: STATUS_STATES, required: true }, detail: { kind: 'string' } },
        min: 1,
        max: MAX_LIST_ITEMS,
        what: 'items'
      }
    },
    example: { type: 'status-list', props: { items: [{ label: 'Build', state: 'ok' }, { label: 'Lint', state: 'warn', detail: '3 warnings' }] } }
  },
  steps: {
    summary: 'A checklist of steps with progress.',
    shape: { items: { kind: 'list', of: ITEM_STATE_SHAPE(STEP_STATES, 'text'), min: 1, max: MAX_LIST_ITEMS, what: 'items' } },
    example: { type: 'steps', props: { items: [{ text: 'Reproduce', state: 'done' }, { text: 'Fix', state: 'active' }, { text: 'Ship', state: 'pending' }] } }
  },
  code: {
    summary: 'A code block shown as text.',
    shape: { text: { kind: 'string', required: true }, language: { kind: 'string', max: 40 } },
    example: { type: 'code', props: { text: 'const answer = 42', language: 'ts' } }
  },
  'file-diff': {
    summary: 'A changed file with its unified diff text.',
    shape: { path: { kind: 'string', required: true, max: 400 }, diff: { kind: 'string', required: true } },
    example: { type: 'file-diff', props: { path: 'src/a.ts', diff: '@@ -1 +1 @@\n-old\n+new' } }
  },
  'bar-chart': {
    summary: `Horizontal bars, one per series entry, at most ${MAX_CHART_POINTS}. Values are plain numbers.`,
    shape: {
      series: { kind: 'list', of: { label: { kind: 'string', required: true }, value: { kind: 'number', required: true } }, min: 1, max: MAX_CHART_POINTS, what: 'series entries' },
      unit: { kind: 'string', max: 16 }
    },
    example: { type: 'bar-chart', props: { series: [{ label: '/settings', value: 96 }, { label: '/login', value: 18 }], unit: 'KB' } }
  },
  'line-chart': {
    summary: `A line through points, at most ${MAX_CHART_POINTS}. x is a label or number, y a number.`,
    shape: {
      points: { kind: 'list', of: { x: { kind: 'text-or-number', required: true }, y: { kind: 'number', required: true } }, min: 1, max: MAX_CHART_POINTS, what: 'points' },
      unit: { kind: 'string', max: 16 }
    },
    example: { type: 'line-chart', props: { points: [{ x: 'Mon', y: 3 }, { x: 'Tue', y: 5 }, { x: 'Wed', y: 4 }], unit: 'ms' } }
  },
  callout: {
    summary: 'A highlighted note.',
    shape: { tone: { kind: 'enum', values: CALLOUT_TONES, required: true }, text: { kind: 'string', required: true } },
    example: { type: 'callout', props: { tone: 'warn', text: 'The cache is cold; the first run is slow.' } }
  },
  button: {
    summary: 'Sends an action to the agent when clicked. If the agent is blocked in `quirky view wait`, the action is that command\'s result; otherwise it arrives as a message.',
    shape: {
      label: { kind: 'string', required: true, max: 80 },
      action: { kind: 'string', required: true, pattern: ACTION_NAME_PATTERN, hint: 'lowercase letters, digits and dashes, 1 to 40 characters' },
      variant: { kind: 'enum', values: BUTTON_VARIANTS }
    },
    example: { type: 'button', props: { label: 'Lazy-load zxcvbn', action: 'lazy-load-zxcvbn', variant: 'primary' } }
  },
  field: {
    summary:
      'Asks the user one question inline. The answer is sent as an action named after the question id, with data {value}. `question` is one ask question: type select|multiselect (options: {value, label, description?}[], at most 12; default), text (multiline?, pattern? (a regular expression, at most 200 characters, at most 3 variable quantifiers, no nested repetition), format?: email|url, default), number (integer?, min?, max?, default) or confirm (default). Also header?, required?. The id follows the button action pattern and is unique in the spec. Credential-shaped ids or text are refused.',
    shape: { question: { kind: 'question' } },
    example: {
      type: 'field',
      props: {
        question: {
          id: 'next-step',
          type: 'select',
          question: 'Which fix first?',
          options: [{ value: 'lazy', label: 'Lazy-load' }, { value: 'intl', label: 'Use Intl' }]
        }
      }
    }
  }
,
  diagram: {
    summary:
      'A Mermaid diagram (flowchart, sequence, class, state and the rest), drawn by Quirky. Node labels are plain text, and a source that could load an image or other remote content (img: shapes, <img>, url()) is refused. Quirky does not parse the source here: a diagram that fails to draw is reported back to you as a message, so fix it with `quirky view update` or `patch`.',
    shape: { source: { kind: 'string', required: true, max: MAX_DIAGRAM_BYTES, bytes: true }, caption: CAPTION_FIELD },
    example: { type: 'diagram', props: { source: 'flowchart LR\n  client[Client app] --> daemon[Daemon]', caption: 'Request path' } }
  },
  image: {
    summary: 'A picture from the worktree. `path` is relative to the worktree root, never starts with / or contains .., and ends in png, jpg, jpeg, gif, webp or svg. `alt` describes it.',
    shape: { path: { kind: 'string', required: true, max: 400 }, alt: { kind: 'string', required: true, max: 200 }, caption: CAPTION_FIELD },
    example: { type: 'image', props: { path: 'docs/shots/login.png', alt: 'The login screen', caption: 'Before the change' } }
  },
  html: {
    summary: `A small page or prototype in a sandboxed frame with no network. It may carry inline CSS and, when \`interactive\` is true, inline scripts. Nothing may load from http:, https: or // (src, href, action, srcset, poster or CSS url()); inline images as data: URLs. An element with a data-point attribute can be pointed at; add data-point-label for its name. height is in pixels (${MIN_HTML_HEIGHT} to ${MAX_HTML_HEIGHT}).`,
    shape: {
      html: { kind: 'string', required: true, max: MAX_HTML_BYTES, bytes: true },
      interactive: { kind: 'boolean', required: true },
      height: { kind: 'number', min: MIN_HTML_HEIGHT, max: MAX_HTML_HEIGHT }
    },
    example: { type: 'html', props: { html: '<button data-point="save" data-point-label="Save">Save</button>', interactive: true, height: 160 } }
  },
  'live-preview': {
    summary: 'A running local app shown in a browser view. `url` must be http:// on localhost, 127.0.0.1 or a *.quirky.localhost host.',
    shape: { url: { kind: 'string', required: true, max: 2048 }, caption: CAPTION_FIELD },
    example: { type: 'live-preview', props: { url: 'http://localhost:5173/', caption: 'The dev server' } }
  },
  timeline: {
    summary: 'Items on a time axis, at most 100. `start` and `end` are plain labels or dates; items keep the order given.',
    shape: {
      items: {
        kind: 'list',
        of: { id: ID_FIELD, label: { kind: 'string', required: true, max: 120 }, start: { kind: 'string', required: true, max: 40 }, end: { kind: 'string', max: 40 }, tone: TONE_FIELD },
        min: 1,
        max: 100,
        what: 'items'
      }
    },
    example: { type: 'timeline', props: { items: [{ id: 'design', label: 'Design', start: '2026-11-02', end: '2026-11-06', tone: 'good' }, { label: 'Launch', start: '2026-11-23' }] } }
  },
  board: {
    summary: 'Columns of cards, like a kanban board: at most 8 columns of at most 50 cards.',
    shape: {
      columns: {
        kind: 'list',
        of: {
          title: { kind: 'string', required: true, max: 80 },
          cards: {
            kind: 'list',
            of: { id: ID_FIELD, title: { kind: 'string', required: true, max: 120 }, detail: { kind: 'string', max: 400 }, tone: TONE_FIELD },
            min: 0,
            max: 50,
            what: 'cards'
          }
        },
        min: 1,
        max: 8,
        what: 'columns'
      }
    },
    example: { type: 'board', props: { columns: [{ title: 'To do', cards: [{ id: 'docs', title: 'Write docs' }] }, { title: 'Done', cards: [] }] } }
  },
  matrix: {
    summary: `A grid of short cells: rows by named columns, at most ${MAX_MATRIX_COLUMNS} columns and 50 rows. Every row has one cell per column. \`highlight\` lists column names whose cell in that row stands out.`,
    shape: {
      columns: { kind: 'strings', min: 1, max: MAX_MATRIX_COLUMNS },
      rows: {
        kind: 'list',
        of: { label: { kind: 'string', required: true, max: 120 }, cells: { kind: 'strings', min: 1, max: MAX_MATRIX_COLUMNS }, highlight: { kind: 'strings', min: 0, max: MAX_MATRIX_COLUMNS, optional: true } },
        min: 1,
        max: 50,
        what: 'rows'
      }
    },
    example: { type: 'matrix', props: { columns: ['Claude', 'Codex'], rows: [{ label: 'Patch', cells: ['yes', 'no'], highlight: ['Codex'] }] } }
  },
  'annotated-code': {
    summary: 'Code with notes attached to lines. `lines` is a 1-based line "4" or a range "3-7" inside the code; at most 50 notes.',
    shape: {
      language: { kind: 'string', required: true, max: 40 },
      code: { kind: 'string', required: true, max: MAX_CODE_BYTES, bytes: true },
      notes: { kind: 'list', of: { lines: { kind: 'string', required: true, max: 20 }, note: { kind: 'string', required: true, max: 400 } }, min: 0, max: 50, what: 'notes' }
    },
    example: { type: 'annotated-code', props: { language: 'ts', code: 'const a = 1\nconst b = a + 1\n', notes: [{ lines: '2', note: 'Uses a.' }] } }
  },
  'file-map': {
    summary: 'Paths with what happened to each, at most 300. status is added, modified, deleted, renamed or touched.',
    shape: {
      entries: {
        kind: 'list',
        of: { path: { kind: 'string', required: true, max: 400 }, status: { kind: 'enum', values: FILE_STATUSES, required: true }, note: { kind: 'string', max: 200 } },
        min: 1,
        max: 300,
        what: 'entries'
      }
    },
    example: { type: 'file-map', props: { entries: [{ path: 'src/a.ts', status: 'modified', note: 'new check' }, { path: 'src/b.ts', status: 'added' }] } }
  },
  plot: {
    summary: 'An x/y plot of up to 8 series, each with 2 to 500 numeric points.',
    shape: {
      xLabel: { kind: 'string', max: 80 },
      yLabel: { kind: 'string', max: 80 },
      series: {
        kind: 'list',
        of: { label: { kind: 'string', required: true, max: 80 }, points: { kind: 'list', of: { x: { kind: 'number', required: true }, y: { kind: 'number', required: true } }, min: 2, max: MAX_CHART_POINTS, what: 'points' } },
        min: 1,
        max: 8,
        what: 'series'
      }
    },
    example: { type: 'plot', props: { xLabel: 'Request', yLabel: 'ms', series: [{ label: 'p50', points: [{ x: 1, y: 12 }, { x: 2, y: 14 }] }] } }
  },
  sketch: {
    summary: `A rough hand-drawn diagram on a width by height canvas (${MIN_SKETCH_SIDE} to ${MAX_SKETCH_SIDE}), at most 200 shapes. box and ellipse use x, y, w and h; line and arrow run from x, y to x2, y2; text puts its label at x, y.`,
    shape: {
      width: { kind: 'number', required: true, min: MIN_SKETCH_SIDE, max: MAX_SKETCH_SIDE },
      height: { kind: 'number', required: true, min: MIN_SKETCH_SIDE, max: MAX_SKETCH_SIDE },
      shapes: {
        kind: 'list',
        of: {
          id: ID_FIELD,
          kind: { kind: 'enum', values: SKETCH_SHAPES, required: true },
          x: { kind: 'number', required: true },
          y: { kind: 'number', required: true },
          w: { kind: 'number' },
          h: { kind: 'number' },
          x2: { kind: 'number' },
          y2: { kind: 'number' },
          label: { kind: 'string', max: 200 }
        },
        min: 1,
        max: 200,
        what: 'shapes'
      }
    },
    example: {
      type: 'sketch',
      props: { width: 200, height: 100, shapes: [{ id: 'frame', kind: 'box', x: 10, y: 10, w: 80, h: 40, label: 'Daemon' }, { kind: 'arrow', x: 90, y: 30, x2: 150, y2: 30 }] }
    }
  }
}

function addError(check: Check, path: string, message: string): void {
  check.errors.push({ path, message })
}

function checkKeys(raw: Record<string, unknown>, allowed: readonly string[], path: string, check: Check): void {
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) addError(check, path ? `${path}.${key}` : key, `unknown field '${key}'; allowed: ${allowed.join(', ') || 'none'}`)
  }
}

/** The UTF-8 size of `text` in bytes; a lone surrogate counts as the 3 bytes of U+FFFD. */
function utf8Length(text: string): number {
  let bytes = 0
  for (let at = 0; at < text.length; at++) {
    const code = text.charCodeAt(at)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && at + 1 < text.length && (text.charCodeAt(at + 1) & 0xfc00) === 0xdc00) {
      bytes += 4
      at++
    } else bytes += 3
  }
  return bytes
}

function readString(raw: unknown, field: Extract<Field, { kind: 'string' }>, path: string, check: Check): string | undefined {
  if (typeof raw !== 'string') {
    addError(check, path, 'must be a string')
    return undefined
  }
  if (field.required && raw.length === 0) addError(check, path, 'must not be empty')
  if (field.max !== undefined && (field.bytes ? utf8Length(raw) : raw.length) > field.max) addError(check, path, `must be at most ${field.max} ${field.bytes ? 'bytes' : 'characters'}`)
  if (field.pattern && !field.pattern.test(raw)) addError(check, path, `must be ${field.hint ?? `in the form ${field.pattern}`}`)
  if (field.markdown) checkMarkdown(raw, path, check.errors)
  if (field.ident && ACTION_NAME_PATTERN.test(raw)) {
    if (check.ids.has(raw)) addError(check, path, `duplicate id '${raw}'`)
    check.ids.add(raw)
  }
  return raw
}

function readShape(raw: Record<string, unknown>, shape: Shape, path: string, check: Check): Record<string, unknown> {
  checkKeys(raw, Object.keys(shape), path, check)
  const out: Record<string, unknown> = {}
  for (const [name, field] of Object.entries(shape)) {
    const value = Object.hasOwn(raw, name) ? raw[name] : undefined
    const fieldPath = path ? `${path}.${name}` : name
    if (value === undefined) {
      if (isRequired(field)) addError(check, fieldPath, 'is required')
      continue
    }
    const read = readField(value, field, fieldPath, check)
    if (read !== undefined) out[name] = read
  }
  return out
}

function readField(value: unknown, field: Field, path: string, check: Check): unknown {
  switch (field.kind) {
    case 'string':
      return readString(value, field, path, check)
    case 'enum':
      if (typeof value === 'string' && field.values.includes(value)) return value
      addError(check, path, `must be one of ${field.values.join(' | ')}`)
      return undefined
    case 'number':
      if (!isFiniteNumber(value)) return void addError(check, path, 'must be a finite number')
      if ((field.min !== undefined && value < field.min) || (field.max !== undefined && value > field.max)) {
        addError(check, path, `must be between ${field.min ?? '-Infinity'} and ${field.max ?? 'Infinity'}`)
      }
      return value
    case 'boolean':
      if (typeof value === 'boolean') return value
      addError(check, path, 'must be a boolean')
      return undefined
    case 'text-or-number':
      if (isFiniteNumber(value) || typeof value === 'string') return value
      addError(check, path, 'must be a string or a finite number')
      return undefined
    case 'strings': {
      if (!Array.isArray(value)) return void addError(check, path, 'must be an array of strings')
      if (value.length < field.min) addError(check, path, `needs at least ${field.min} entry`)
      if (value.length > field.max) return void addError(check, path, `at most ${field.max} entries allowed`)
      value.forEach((entry, index) => {
        if (typeof entry !== 'string') addError(check, `${path}[${index}]`, 'must be a string')
      })
      return value
    }
    case 'matrix': {
      if (!Array.isArray(value)) return void addError(check, path, 'must be an array of rows')
      if (value.length > field.max) return void addError(check, path, `at most ${field.max} rows allowed`)
      value.forEach((row, index) => {
        if (!Array.isArray(row)) return addError(check, `${path}[${index}]`, 'must be an array of strings')
        row.forEach((cell, cellIndex) => {
          if (typeof cell !== 'string') addError(check, `${path}[${index}][${cellIndex}]`, 'must be a string')
        })
      })
      return value
    }
    case 'list': {
      if (!Array.isArray(value)) return void addError(check, path, 'must be an array')
      if (value.length < field.min) addError(check, path, `needs at least ${field.min} entry`)
      if (value.length > field.max) return void addError(check, path, `at most ${field.max} ${field.what} allowed`)
      return value.map((entry, index) => {
        const entryPath = `${path}[${index}]`
        if (!isPlainObject(entry)) {
          addError(check, entryPath, 'must be an object')
          return {}
        }
        return readShape(entry, field.of, entryPath, check)
      })
    }
    case 'question':
      return readQuestion(value, path, check)
  }
}

function readQuestion(raw: unknown, path: string, check: Check): Record<string, unknown> | undefined {
  if (!isPlainObject(raw)) return void addError(check, path, 'must be an ask question object')
  if ('masked' in raw || 'sensitive' in raw) {
    addError(check, path, 'masked/sensitive input is not permitted; collect credentials out of band')
  }
  checkKeys(raw, ['id', 'type', 'question', 'header', 'required', 'options', 'default', 'multiline', 'pattern', 'format', 'integer', 'min', 'max'], path, check)
  const out: Record<string, unknown> = {}

  const id = raw.id
  if (typeof id !== 'string' || !ACTION_NAME_PATTERN.test(id)) {
    addError(check, `${path}.id`, 'id is required: lowercase letters, digits and dashes, 1 to 40 characters')
  } else {
    if (check.fieldIds.has(id)) addError(check, `${path}.id`, `duplicate field id '${id}'`)
    check.fieldIds.add(id)
    if (RESERVED_IDS.has(id)) addError(check, `${path}.id`, 'id must not be __proto__, constructor or prototype')
    if (mentionsCredential(id)) addError(check, `${path}.id`, 'credential-shaped id is not permitted')
    out.id = id
  }

  if (typeof raw.question !== 'string' || raw.question.length === 0) {
    addError(check, `${path}.question`, 'question text is required')
  } else {
    if (mentionsCredential(raw.question)) addError(check, `${path}.question`, 'credential-shaped question text is not permitted')
    out.question = raw.question
  }
  for (const key of ['header'] as const) {
    if (raw[key] === undefined) continue
    if (typeof raw[key] === 'string') out[key] = raw[key]
    else addError(check, `${path}.${key}`, `${key} must be a string`)
  }
  if (raw.required !== undefined) {
    if (typeof raw.required === 'boolean') out.required = raw.required
    else addError(check, `${path}.required`, 'required must be a boolean')
  }

  const type = raw.type
  if (typeof type !== 'string' || !(FIELD_TYPES as readonly string[]).includes(type)) {
    addError(check, `${path}.type`, `type must be one of ${FIELD_TYPES.join(' | ')}`)
    return out
  }
  out.type = type
  if (type === 'select' || type === 'multiselect') readOptionsQuestion(raw, type, out, path, check)
  else if (type === 'text') readTextQuestion(raw, out, path, check)
  else if (type === 'number') readNumberQuestion(raw, out, path, check)
  else if (raw.default !== undefined) {
    if (typeof raw.default === 'boolean') out.default = raw.default
    else addError(check, `${path}.default`, 'default must be a boolean')
  }
  const stray = { select: ['multiline', 'pattern', 'format', 'integer', 'min', 'max'], multiselect: ['multiline', 'pattern', 'format', 'integer', 'min', 'max'], text: ['options', 'integer', 'min', 'max'], number: ['options', 'multiline', 'pattern', 'format'], confirm: ['options', 'multiline', 'pattern', 'format', 'integer', 'min', 'max'] }[type] ?? []
  for (const key of stray) if (raw[key] !== undefined) addError(check, `${path}.${key}`, `${key} does not apply to ${type}`)
  return out
}

function readOptionsQuestion(raw: Record<string, unknown>, type: 'select' | 'multiselect', out: Record<string, unknown>, path: string, check: Check): void {
  const values = new Set<string>()
  if (!Array.isArray(raw.options) || raw.options.length === 0) {
    addError(check, `${path}.options`, 'options must be a non-empty array')
  } else if (raw.options.length > MAX_OPTIONS) {
    addError(check, `${path}.options`, `at most ${MAX_OPTIONS} options allowed`)
  } else {
    out.options = raw.options.map((option, index) => {
      const optionPath = `${path}.options[${index}]`
      if (!isPlainObject(option)) {
        addError(check, optionPath, 'option must be an object')
        return {}
      }
      checkKeys(option, ['value', 'label', 'description'], optionPath, check)
      const read: Record<string, unknown> = {}
      if (typeof option.value !== 'string' || option.value.length === 0) addError(check, `${optionPath}.value`, 'option value is required')
      else {
        if (mentionsCredential(option.value)) addError(check, `${optionPath}.value`, 'credential-shaped option value is not permitted')
        values.add(option.value)
        read.value = option.value
      }
      if (typeof option.label !== 'string' || option.label.length === 0) addError(check, `${optionPath}.label`, 'option label is required')
      else read.label = option.label
      if (option.description !== undefined) {
        if (typeof option.description === 'string') read.description = option.description
        else addError(check, `${optionPath}.description`, 'description must be a string')
      }
      return read
    })
  }
  const value = raw.default
  if (value === undefined) return
  const valid =
    type === 'select'
      ? typeof value === 'string' && values.has(value)
      : Array.isArray(value) && value.every((entry) => typeof entry === 'string' && values.has(entry))
  if (valid) out.default = value
  else addError(check, `${path}.default`, type === 'select' ? 'default must match one option value' : 'default must be an array of option values')
}

function readTextQuestion(raw: Record<string, unknown>, out: Record<string, unknown>, path: string, check: Check): void {
  if (raw.multiline !== undefined) {
    if (typeof raw.multiline === 'boolean') out.multiline = raw.multiline
    else addError(check, `${path}.multiline`, 'multiline must be a boolean')
  }
  let patternRegex: RegExp | undefined
  if (raw.pattern !== undefined) {
    const unsafe = typeof raw.pattern === 'string' && raw.pattern.length <= MAX_PATTERN_LENGTH ? findUnsafePatternShape(raw.pattern) : undefined
    if (typeof raw.pattern !== 'string') addError(check, `${path}.pattern`, 'pattern must be a string')
    else if (raw.pattern.length > MAX_PATTERN_LENGTH) addError(check, `${path}.pattern`, `pattern must be at most ${MAX_PATTERN_LENGTH} characters`)
    else if (unsafe) addError(check, `${path}.pattern`, UNSAFE_PATTERN_MESSAGES[unsafe])
    else {
      try {
        patternRegex = new RegExp(raw.pattern)
        out.pattern = raw.pattern
      } catch {
        addError(check, `${path}.pattern`, 'pattern must be a valid regular expression')
      }
    }
  }
  const format = raw.format
  if (format !== undefined) {
    if (format === 'email' || format === 'url') out.format = format
    else addError(check, `${path}.format`, "format must be 'email' or 'url'")
  }
  if (raw.default === undefined) return
  if (typeof raw.default !== 'string') return addError(check, `${path}.default`, 'default must be a string')
  if (patternRegex) {
    if (raw.default.length > MAX_PATTERN_TEST_LENGTH) addError(check, `${path}.default`, `default must be at most ${MAX_PATTERN_TEST_LENGTH} characters when pattern is set`)
    else if (!patternRegex.test(raw.default)) addError(check, `${path}.default`, 'default does not match pattern')
  }
  if ((format === 'email' || format === 'url') && !FORMAT_PATTERNS[format].test(raw.default)) {
    addError(check, `${path}.default`, `default is not a valid ${format}`)
  }
  out.default = raw.default
}

function readNumberQuestion(raw: Record<string, unknown>, out: Record<string, unknown>, path: string, check: Check): void {
  if (raw.integer !== undefined) {
    if (typeof raw.integer === 'boolean') out.integer = raw.integer
    else addError(check, `${path}.integer`, 'integer must be a boolean')
  }
  for (const key of ['min', 'max'] as const) {
    if (raw[key] === undefined) continue
    if (isFiniteNumber(raw[key])) out[key] = raw[key]
    else addError(check, `${path}.${key}`, `${key} must be a number`)
  }
  const { min, max } = out as { min?: number; max?: number }
  if (min !== undefined && max !== undefined && min > max) addError(check, `${path}.min`, 'min must not exceed max')
  const value = raw.default
  if (value === undefined) return
  if (!isFiniteNumber(value)) return addError(check, `${path}.default`, 'default must be a number')
  const problem =
    (raw.integer === true && !Number.isInteger(value) && 'default must be an integer') ||
    (min !== undefined && value < min && 'default is below min') ||
    (max !== undefined && value > max && 'default is above max')
  if (problem) addError(check, `${path}.default`, problem)
  else out.default = value
}

type NodeCheck = (props: Record<string, unknown>, path: string, check: Check) => void

const SCHEME = /^[a-z][a-z0-9+.-]*:/i
const IMAGE_EXTENSION = new RegExp(`\\.(${IMAGE_EXTENSIONS.join('|')})$`, 'i')
const REMOTE_URL = /^(?:https?:|\/\/)/i
const URL_ATTRIBUTE = /\b(?:src|href|action|srcset|poster|formaction|data|xlink:href|ping)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]*))/gi
const NAMED_ENTITIES: Record<string, string> = { colon: ':', sol: '/', tab: '', newline: '' }

function decodeEntities(text: string): string {
  const fromCode = (code: number): string => (Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '')
  return text
    .replace(/&#x([0-9a-f]{1,6});?/gi, (_match, hex: string) => fromCode(Number.parseInt(hex, 16)))
    .replace(/&#(\d{1,7});?/g, (_match, digits: string) => fromCode(Number(digits)))
    .replace(/&(colon|sol|tab|newline);/gi, (_match, name: string) => NAMED_ENTITIES[name.toLowerCase()])
}

function isRemoteAttribute(name: string, value: string): boolean {
  const decoded = decodeEntities(value)
  // srcset lists several urls; every other attribute holds one, and browsers ignore control characters and spaces inside its scheme
  if (name.toLowerCase() === 'srcset') return decoded.split(/[\s,]+/).some((candidate) => REMOTE_URL.test(candidate))
  return REMOTE_URL.test(decoded.replace(/[\u0000- ]+/g, ''))
}

const CSS_ESCAPE = /\\(?:([0-9a-f]{1,6})(?:\r\n|[ \t\n\r\f])?|(\r\n|[\n\r\f])|([^\n\r\f]))/gi

/** The text with CSS escapes resolved the way a stylesheet reads them: `\68 ttps` is `https`. */
function decodeCssEscapes(text: string): string {
  return text.replace(CSS_ESCAPE, (_match, hex: string | undefined, _newline: string | undefined, literal: string | undefined) => {
    if (hex !== undefined) {
      const code = Number.parseInt(hex, 16)
      return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? '\ufffd' : String.fromCodePoint(code)
    }
    return literal ?? ''
  })
}

function stripCssComments(text: string): string {
  let out = ''
  let from = 0
  for (let open = text.indexOf('/*'); open >= 0; open = text.indexOf('/*', from)) {
    out += text.slice(from, open) + ' '
    const close = text.indexOf('*/', open + 2)
    if (close < 0) return out
    from = close + 2
  }
  return out + text.slice(from)
}

function startsRemoteCss(lower: string, from: number): boolean {
  let at = from
  while (at < lower.length && /[\s"']/.test(lower[at])) at++
  return lower.startsWith('http:', at) || lower.startsWith('https:', at) || lower.startsWith('//', at)
}

function scansRemoteCss(lower: string): boolean {
  for (let at = lower.indexOf('url'); at >= 0; at = lower.indexOf('url', at + 3)) {
    let open = at + 3
    while (open < lower.length && /\s/.test(lower[open])) open++
    if (lower[open] === '(' && startsRemoteCss(lower, open + 1)) return true
  }
  for (let at = lower.indexOf('@import'); at >= 0; at = lower.indexOf('@import', at + 7)) {
    if (startsRemoteCss(lower, at + 7)) return true
  }
  return false
}

/**
 * True for a CSS `url(` or `@import` that points at http:, https: or //, also when the text is
 * spelled with CSS escapes or comments; scans without regex backtracking.
 */
function loadsRemoteCss(text: string): boolean {
  const decoded = decodeCssEscapes(text)
  return [text, decoded, stripCssComments(decoded)].some((variant) => scansRemoteCss(variant.toLowerCase()))
}

function loadsRemoteHtml(html: string): boolean {
  for (const match of html.matchAll(URL_ATTRIBUTE)) {
    const name = match[0].slice(0, match[0].indexOf('=')).trim()
    if (isRemoteAttribute(name, match[1] ?? match[2] ?? match[3] ?? '')) return true
  }
  return loadsRemoteCss(decodeEntities(html))
}

function isLocalPreviewUrl(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' || url.username !== '' || url.password !== '') return false
  const suffix = '.quirky.localhost'
  return (LOCAL_PREVIEW_HOSTS as readonly string[]).includes(url.hostname) || (url.hostname.endsWith(suffix) && url.hostname.length > suffix.length)
}

const NODE_CHECKS: Partial<Record<CatalogType, NodeCheck>> = {
  table(props, path, check) {
    const { columns, rows } = props
    if (!Array.isArray(columns) || !Array.isArray(rows)) return
    rows.forEach((row, index) => {
      if (Array.isArray(row) && row.length !== columns.length) {
        addError(check, `${path}.props.rows[${index}]`, `row has ${row.length} cells; the table has ${columns.length} columns`)
      }
    })
  },
  diagram(props, path, check) {
    if (typeof props.source === 'string' && loadsImages(props.source)) {
      addError(check, `${path}.props.source`, 'diagram source must not load images or remote content (img: shapes, <img>, url() and similar are refused)')
    }
  },
  image(props, path, check) {
    const value = props.path
    if (typeof value !== 'string') return
    const at = `${path}.props.path`
    if (value.startsWith('/') || value.startsWith('\\') || SCHEME.test(value)) addError(check, at, 'image path must be relative to the worktree')
    else if (value.split(/[\\/]/).includes('..')) addError(check, at, "image path must not contain '..' segments")
    else if (!IMAGE_EXTENSION.test(value)) addError(check, at, `image path must end in ${IMAGE_EXTENSIONS.slice(0, -1).join(', ')} or ${IMAGE_EXTENSIONS.at(-1)}`)
  },
  html(props, path, check) {
    if (typeof props.html === 'string' && loadsRemoteHtml(props.html)) {
      addError(check, `${path}.props.html`, 'remote content is not allowed in html; inline it as data:')
    }
  },
  'live-preview'(props, path, check) {
    if (typeof props.url === 'string' && !isLocalPreviewUrl(props.url)) {
      addError(check, `${path}.props.url`, 'url must be http:// on localhost, 127.0.0.1 or *.quirky.localhost')
    }
  },
  matrix(props, path, check) {
    const { columns, rows } = props
    if (!Array.isArray(columns) || !Array.isArray(rows)) return
    rows.forEach((row: Record<string, unknown>, index) => {
      const cells = row.cells
      if (Array.isArray(cells) && cells.length !== columns.length) {
        addError(check, `${path}.props.rows[${index}].cells`, `row has ${cells.length} cells; the matrix has ${columns.length} columns`)
      }
      if (!Array.isArray(row.highlight)) return
      row.highlight.forEach((name, at) => {
        if (typeof name === 'string' && !columns.includes(name)) addError(check, `${path}.props.rows[${index}].highlight[${at}]`, `'${shorten(name)}' is not a column name`)
      })
    })
  },
  'annotated-code'(props, path, check) {
    const { code, notes } = props
    if (typeof code !== 'string' || !Array.isArray(notes)) return
    const total = code.split('\n').length - (code.endsWith('\n') ? 1 : 0)
    notes.forEach((note: Record<string, unknown>, index) => {
      if (typeof note.lines !== 'string') return
      const at = `${path}.props.notes[${index}].lines`
      const match = /^(\d{1,6})(?:-(\d{1,6}))?$/.exec(note.lines)
      if (!match) return addError(check, at, 'lines must be a line number like "4" or a range like "3-7"')
      const first = Number(match[1])
      const last = match[2] === undefined ? first : Number(match[2])
      if (first < 1 || last < first || last > total) addError(check, at, `lines must fall within the code's ${total} lines`)
    })
  }
}

function readNode(raw: unknown, path: string, depth: number, check: Check): ViewNode | undefined {
  if (!isPlainObject(raw)) return void addError(check, path, 'node must be an object')
  checkKeys(raw, ['type', 'id', 'props', 'children'], path, check)
  const type = raw.type
  if (typeof type !== 'string') return void addError(check, `${path}.type`, 'type is required and must be a string')
  if (!Object.hasOwn(COMPONENTS, type)) {
    const near = nearestTypes(type)
    addError(
      check,
      `${path}.type`,
      near.length > 0
        ? `unknown type '${shorten(type)}'; did you mean ${near.join(', ')}?`
        : `unknown type '${shorten(type)}'; the catalog has ${CATALOG_TYPES.join(', ')}`
    )
    return undefined
  }
  if (check.nodeLimitHit) return undefined
  if (++check.nodes > MAX_NODES) {
    check.nodeLimitHit = true
    addError(check, path, `at most ${MAX_NODES} nodes allowed`)
    return undefined
  }
  if (depth > MAX_DEPTH) {
    addError(check, path, `nesting must be at most ${MAX_DEPTH} levels deep`)
    return undefined
  }
  const component = COMPONENTS[type as CatalogType]
  const node: ViewNode = { type: type as CatalogType }
  if (raw.id !== undefined && typeof readString(raw.id, ID_FIELD as Extract<Field, { kind: 'string' }>, `${path}.id`, check) === 'string' && ACTION_NAME_PATTERN.test(raw.id as string)) {
    node.id = raw.id as string
  }

  const rawProps = raw.props
  if (rawProps !== undefined && !isPlainObject(rawProps)) addError(check, `${path}.props`, 'props must be an object')
  const props = readShape(isPlainObject(rawProps) ? rawProps : {}, component.shape, `${path}.props`, check)
  if (Object.keys(props).length > 0) node.props = props
  NODE_CHECKS[type as CatalogType]?.(props, path, check)

  const rawChildren = raw.children
  if (rawChildren === undefined) return node
  if (!Array.isArray(rawChildren)) return void addError(check, `${path}.children`, 'children must be an array')
  if (component.container === undefined) {
    if (rawChildren.length > 0) addError(check, `${path}.children`, `${type} cannot have children`)
    return node
  }
  if (component.container === 'columns' && rawChildren.length > MAX_COLUMNS) {
    addError(check, `${path}.children`, `columns allows at most ${MAX_COLUMNS} children`)
    return node
  }
  const children: ViewNode[] = []
  rawChildren.forEach((child, index) => {
    const read = readNode(child, `${path}.children[${index}]`, depth + 1, check)
    if (read) children.push(read)
  })
  if (children.length > 0) node.children = children
  return node
}

function encodedSize(raw: unknown): number | 'unserializable' {
  try {
    return new TextEncoder().encode(JSON.stringify(raw)).length
  } catch {
    return 'unserializable'
  }
}

/**
 * Checks an untrusted spec against the catalog and the limits. Pure and never throws: every
 * refusal is a path and message, and all of them are collected. On success `spec` is canonical,
 * holding only known fields.
 */
export function validateViewSpec(raw: unknown): ViewSpecValidationResult {
  try {
    if (!isPlainObject(raw)) return { ok: false, errors: [{ path: '', message: 'view spec must be an object' }] }
    const size = encodedSize(raw)
    if (size === 'unserializable') return { ok: false, errors: [{ path: '', message: 'view spec must be plain JSON' }] }
    if (size > MAX_SPEC_BYTES) {
      return { ok: false, errors: [{ path: '', message: `view spec is ${size} bytes; at most ${MAX_SPEC_BYTES} bytes allowed` }] }
    }
    const check: Check = { errors: [], fieldIds: new Set(), ids: new Set(), nodes: 0, nodeLimitHit: false }
    checkKeys(raw, ['title', 'root'], '', check)
    let title = ''
    if (typeof raw.title !== 'string' || raw.title.trim() === '') addError(check, 'title', 'title is required and must be a non-empty string')
    else if (raw.title.length > MAX_TITLE_LENGTH) addError(check, 'title', `title must be at most ${MAX_TITLE_LENGTH} characters`)
    else title = raw.title
    const root = raw.root === undefined ? (addError(check, 'root', 'root is required'), undefined) : readNode(raw.root, 'root', 1, check)
    if (check.errors.length > 0 || root === undefined) return { ok: false, errors: check.errors }
    return { ok: true, spec: { title, root } }
  } catch (error) {
    return { ok: false, errors: [{ path: '', message: `view spec could not be checked: ${error instanceof Error ? error.message : String(error)}` }] }
  }
}

/** One line for a refusal: `<path>: <message>` per error, joined with `; `. */
export function formatViewErrors(errors: readonly ViewValidationError[]): string {
  return errors.map((error) => (error.path ? `${error.path}: ${error.message}` : error.message)).join('; ')
}

/** The agent-facing guide: the spec envelope, the limits, and every component with its props and one example. */
export function catalogGuide(): string {
  const lines = [
    'View spec',
    '  {"title": string, "root": node}; a node is {"type": <component>, "id"?: string, "props": {...}, "children": [node, ...]}.',
    `  An id is ${ID_HINT}, and unique in the spec, timeline items, board cards and sketch shapes included. A user points at an element by its id and a new version highlights what changed by it, so keep ids the same when you update.`,
    '  Props are strings, except numbers in charts, plots, sketches and fields and booleans in fields and html. There are no style, class, event or URL props.',
    `  Limits: at most ${MAX_NODES} nodes, ${MAX_DEPTH} levels deep, ${MAX_SPEC_BYTES / 1024} KiB encoded, ${MAX_TABLE_ROWS} table rows, ${MAX_CHART_POINTS} chart points.`,
    '  An invalid spec is refused whole: nothing renders and the errors print as `path: message; ...` with exit code 2.',
    '',
    'Components'
  ]
  for (const type of CATALOG_TYPES) {
    const component = COMPONENTS[type]
    const props = describeShape(component.shape)
    lines.push('', `  ${type}: ${component.summary}`, `    props: ${props || 'none'}`)
    if (component.container) lines.push(`    children: ${component.container === 'columns' ? `up to ${MAX_COLUMNS} nodes` : 'any nodes'}`)
    lines.push(`    example: ${JSON.stringify(component.example)}`)
  }
  return lines.join('\n')
}
