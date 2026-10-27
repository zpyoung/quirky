import { isDeepStrictEqual } from 'node:util'

/**
 * Line edits to Hermes's `config.yaml` that add a plugin to `plugins.enabled` and take it out of
 * `plugins.disabled`. The layouts it edits are a block or a one-line flow list under a block
 * `plugins:` mapping; entries it doesn't own keep their exact text. Every line Quirky adds ends
 * in `ADDED`, and every line it rewrites keeps the original after `ORIGINAL`, so removal restores
 * the file. The input is parsed before editing and the result after, so a file that isn't valid
 * YAML, or a layout the line editor would misread, raises YamlShapeError and is never written.
 */

export class YamlShapeError extends Error {}

const ADDED = ' # quirky-added'
const ORIGINAL_MARK = '# quirky-original: '
const KEY_PATTERN = /^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*|"[^"]*"|'[^']*')\s*:(?:\s|$)/
const KEY_NULL_VALUES = new Set(['~', 'null', 'Null', 'NULL'])
const DEFAULT_INDENT = 2

const keyPattern = (name: string): RegExp => new RegExp(`^(?:${name}|"${name}"|'${name}')\\s*:(\\s|$)`)

const indentOf = (line: string): number => line.length - line.trimStart().length

const isSkippable = (line: string): boolean => line.trim() === '' || line.trim().startsWith('#')

function stripComment(text: string): string {
  let quote = ''
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!
    if (quote) {
      if (char === quote) quote = ''
    } else if (char === '"' || char === "'") quote = char
    else if (char === '#' && (index === 0 || /\s/.test(text[index - 1]!))) return text.slice(0, index).trim()
  }
  return text.trim()
}

/** The string a list item denotes; empty for anything that isn't a string scalar, so it never matches a plugin name. */
function itemName(text: string): string {
  try {
    const value: unknown = Bun.YAML.parse(text)
    return typeof value === 'string' ? value : ''
  } catch {
    return ''
  }
}

/** Splits the inside of a one-line flow list on its top-level commas, leaving every token's text as written. */
function splitFlow(inner: string): string[] {
  const tokens: string[] = []
  let quote = ''
  let depth = 0
  let start = 0
  for (let index = 0; index < inner.length; index++) {
    const char = inner[index]!
    if (quote) {
      if (quote === '"' && char === '\\') index++
      else if (char === quote) quote = ''
    } else if (char === '"' || char === "'") quote = char
    else if (char === '[' || char === '{') depth++
    else if (char === ']' || char === '}') depth--
    else if (char === ',' && depth === 0) {
      tokens.push(inner.slice(start, index).trim())
      start = index + 1
    }
  }
  const last = inner.slice(start).trim()
  if (last !== '' || tokens.length > 0) tokens.push(last)
  return tokens
}

type Mapping = Record<string, unknown>

const isMapping = (value: unknown): value is Mapping => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Parses the document, requiring a single mapping (or nothing); anything else is not a config Quirky can edit. */
function parseDocument(lines: readonly string[]): Mapping | null {
  let document: unknown
  try {
    document = Bun.YAML.parse(lines.join('\n'))
  } catch {
    throw new YamlShapeError('not valid YAML')
  }
  if (document === null) return null
  if (!isMapping(document)) throw new YamlShapeError('top level is not a mapping')
  return document
}

/** The document `before` means once `name` is enabled and no longer disabled; the edit must produce exactly this. */
function withEnabled(before: Mapping | null, name: string): Mapping {
  const root: Mapping = before ? structuredClone(before) : {}
  const plugins: Mapping = isMapping(root.plugins) ? root.plugins : {}
  const enabled = Array.isArray(plugins.enabled) ? plugins.enabled : []
  if (!enabled.includes(name)) enabled.push(name)
  plugins.enabled = enabled
  if (Array.isArray(plugins.disabled)) plugins.disabled = plugins.disabled.filter((item) => item !== name)
  root.plugins = plugins
  return root
}

/** Drops an empty or null `disabled`: dropping the last block item leaves the key null where the model has `[]`. */
function comparable(document: Mapping): Mapping {
  const copy = structuredClone(document)
  if (isMapping(copy.plugins)) {
    const disabled = copy.plugins.disabled
    if (disabled === null || (Array.isArray(disabled) && disabled.length === 0)) delete copy.plugins.disabled
  }
  return copy
}

/** Throws YamlShapeError for a file whose top level isn't a mapping Quirky can read line by line. */
function assertLayout(lines: readonly string[]): void {
  for (const line of lines) {
    if (isSkippable(line)) continue
    if (/^\s*\t/.test(line)) throw new YamlShapeError('tab indentation')
    if (indentOf(line) > 0) continue
    if (/^(---|\.\.\.|%.*)\s*$/.test(line) || /^-(\s|$)/.test(line) || KEY_PATTERN.test(line)) continue
    throw new YamlShapeError(line)
  }
}

const valueAfterColon = (line: string): string => stripComment(line.slice(line.indexOf(':') + 1))

function topLevelPlugins(lines: readonly string[]): number {
  const found = lines.flatMap((line, index) => (keyPattern('plugins').test(line) ? [index] : []))
  if (found.length > 1) throw new YamlShapeError('plugins defined twice')
  return found[0] ?? -1
}

/** The index after the last line belonging to the entry at `key`: the next line indented no deeper, or a same-indent `- ` item when the key is a mapping key. */
function entryEnd(lines: readonly string[], key: number): number {
  const base = indentOf(lines[key]!)
  for (let index = key + 1; index < lines.length; index++) {
    if (isSkippable(lines[index]!)) continue
    const indent = indentOf(lines[index]!)
    if (indent > base || (indent === base && /^\s*-(\s|$)/.test(lines[index]!))) continue
    return index
  }
  return lines.length
}

type NamedList = { names: string[]; tokens: string[]; items: { index: number; name: string }[]; lastLine: number; style: 'block' | 'flow' | 'null' }

function readList(lines: readonly string[], key: number): NamedList {
  const value = valueAfterColon(lines[key]!)
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim()
    const tokens = splitFlow(inner)
    if (tokens.some((token) => token === '' || /^[[{&*!|>]/.test(token))) throw new YamlShapeError(lines[key]!)
    return { names: tokens.map(itemName), tokens, items: [], lastLine: key, style: 'flow' }
  }
  if (value === '' || KEY_NULL_VALUES.has(value)) {
    const items: NamedList['items'] = []
    let lastLine = key
    for (let index = key + 1; index < entryEnd(lines, key); index++) {
      const line = lines[index]!
      if (isSkippable(line)) continue
      const item = /^\s*-\s+(.+)$/.exec(line)
      const name = item ? stripComment(item[1]!) : ''
      if (!item || name === '' || /^[[{&*!|>]/.test(name) || /:(\s|$)/.test(name)) throw new YamlShapeError(line)
      items.push({ index, name: itemName(name) })
      lastLine = index
    }
    return { names: items.map((item) => item.name), tokens: [], items, lastLine, style: value === '' ? 'block' : 'null' }
  }
  throw new YamlShapeError(lines[key]!)
}

type PluginsMap = { header: number; end: number; indent: number; enabled: number; disabled: number }

/** Where `plugins`, `plugins.enabled` and `plugins.disabled` sit; -1 for a key that isn't there. */
function locate(lines: readonly string[], plugins: number): PluginsMap {
  if (valueAfterColon(lines[plugins]!) !== '') throw new YamlShapeError(lines[plugins]!)
  const end = entryEnd(lines, plugins)
  const body = lines.slice(plugins + 1, end).filter((line) => !isSkippable(line))
  const indent = body.length > 0 ? Math.min(...body.map(indentOf)) : DEFAULT_INDENT
  const find = (name: string): number => {
    const found = lines.flatMap((line, index) => (index > plugins && index < end && indentOf(line) === indent && keyPattern(name).test(line.trim()) ? [index] : []))
    if (found.length > 1) throw new YamlShapeError(`${name} defined twice`)
    return found[0] ?? -1
  }
  return { header: plugins, end, indent, enabled: find('enabled'), disabled: find('disabled') }
}

const flow = (tokens: readonly string[]): string => `[${tokens.join(', ')}]`

/** The line up to and including its colon, so a rewritten list keeps the key as the user spelled it. */
const keyPart = (line: string): string => line.slice(0, line.indexOf(':') + 1)

/**
 * Returns the lines with `name` in `plugins.enabled` and out of `plugins.disabled`.
 * Throws YamlShapeError when the input isn't valid YAML or the edit would change anything else.
 */
export function enablePlugin(input: readonly string[], name: string): string[] {
  assertLayout(input)
  const before = parseDocument(input)
  const lines = editLines(input, name)
  const after = parseDocument(lines)
  if (!after || !isDeepStrictEqual(comparable(after), comparable(withEnabled(before, name)))) throw new YamlShapeError('edit would change other content')
  return lines
}

function editLines(input: readonly string[], name: string): string[] {
  const lines = [...input]
  const plugins = topLevelPlugins(lines)
  const created = (indent: number): string[] => [`${' '.repeat(indent)}enabled:${ADDED}`, `${' '.repeat(indent + DEFAULT_INDENT)}- ${name}${ADDED}`]
  if (plugins === -1) return [...lines, `plugins:${ADDED}`, ...created(DEFAULT_INDENT)]
  const empty = valueAfterColon(lines[plugins]!)
  if (empty === '{}' || KEY_NULL_VALUES.has(empty)) {
    const original = lines[plugins]!
    return [...lines.slice(0, plugins), `plugins: ${ORIGINAL_MARK}${original}`, ...created(DEFAULT_INDENT), ...lines.slice(plugins + 1)]
  }
  const map = locate(lines, plugins)
  const pad = ' '.repeat(map.indent)
  let insertAt = -1
  let insert: string[] = []

  if (map.disabled !== -1) {
    const list = readList(lines, map.disabled)
    if (list.names.includes(name)) {
      if (list.style === 'flow') {
        const kept = list.tokens.filter((_, position) => list.names[position] !== name)
        lines[map.disabled] = `${keyPart(lines[map.disabled]!)} ${flow(kept)} ${ORIGINAL_MARK}${lines[map.disabled]}`
      } else {
        for (const item of list.items) if (item.name === name) lines[item.index] = `${ORIGINAL_MARK}${lines[item.index]}`
      }
    }
  }

  if (map.enabled === -1) {
    insertAt = plugins + 1
    insert = created(map.indent)
  } else {
    const list = readList(lines, map.enabled)
    if (!list.names.includes(name)) {
      if (list.style === 'block') {
        insertAt = list.lastLine + 1
        const itemIndent = list.items.length > 0 ? indentOf(lines[list.lastLine]!) : map.indent + DEFAULT_INDENT
        insert = [`${' '.repeat(itemIndent)}- ${name}${ADDED}`]
      } else {
        lines[map.enabled] = `${keyPart(lines[map.enabled]!)} ${flow([...list.tokens, name])} ${ORIGINAL_MARK}${lines[map.enabled]}`
      }
    }
  }
  if (insertAt !== -1) lines.splice(insertAt, 0, ...insert)
  return lines
}

function flowTokens(line: string): string[] | null {
  const value = valueAfterColon(line)
  return value.startsWith('[') && value.endsWith(']') ? splitFlow(value.slice(1, -1).trim()) : null
}

/**
 * The line a rewritten flow list becomes on remove. When the list still reads as Quirky left it,
 * the saved original comes back byte for byte; when the user has edited it since, their entries
 * stay and only `name` is taken out of `enabled`, or put back into `disabled`.
 */
function restoreFlowLine(line: string, original: string, name: string): string {
  const rewritten = flowTokens(line.slice(0, line.indexOf(ORIGINAL_MARK)))
  const saved = flowTokens(original)
  if (!rewritten || !saved) return original
  const wasDisabled = saved.some((token) => itemName(token) === name)
  const expected = wasDisabled ? saved.filter((token) => itemName(token) !== name) : [...saved, name]
  if (rewritten.length === expected.length && rewritten.every((token, position) => token === expected[position])) return original
  const present = rewritten.some((token) => itemName(token) === name)
  const kept = wasDisabled ? (present ? rewritten : [...rewritten, saved.find((token) => itemName(token) === name)!]) : rewritten.filter((token) => itemName(token) !== name)
  return `${keyPart(line)} ${flow(kept)}`
}

/** Undoes `enablePlugin` for `name`: restores rewritten lines and drops added ones, keeping a parent line the user has since put children under. */
export function restoreConfig(input: readonly string[], name: string): string[] {
  const lines = input.map((line) => {
    const at = line.indexOf(ORIGINAL_MARK)
    if (at === -1) return line
    return restoreFlowLine(line, line.slice(at + ORIGINAL_MARK.length), name)
  })
  for (let index = lines.length - 1; index >= 0; index--) {
    if (!lines[index]!.endsWith(ADDED)) continue
    const indent = indentOf(lines[index]!)
    let hasUserChild = false
    for (let next = index + 1; next < lines.length; next++) {
      if (isSkippable(lines[next]!)) continue
      if (indentOf(lines[next]!) <= indent) break
      hasUserChild = true
    }
    if (hasUserChild) lines[index] = lines[index]!.slice(0, -ADDED.length)
    else lines.splice(index, 1)
  }
  return lines
}

/** Whether the plugin is enabled, and whether a disabled list still names it. */
export function readEnablement(input: readonly string[], name: string): { enabled: boolean; disabled: boolean } {
  assertLayout(input)
  parseDocument(input)
  const plugins = topLevelPlugins(input)
  if (plugins === -1) return { enabled: false, disabled: false }
  const value = valueAfterColon(input[plugins]!)
  if (value === '{}' || KEY_NULL_VALUES.has(value)) return { enabled: false, disabled: false }
  const map = locate(input, plugins)
  const has = (key: number): boolean => key !== -1 && readList(input, key).names.includes(name)
  return { enabled: has(map.enabled), disabled: has(map.disabled) }
}
