/**
 * Line edits to Hermes's `config.yaml` that add a plugin to `plugins.enabled` and take it out of
 * `plugins.disabled`. There is no YAML parser; the layouts it understands are a block or a
 * one-line flow list under a block `plugins:` mapping. Every line Quirky adds ends in `ADDED`,
 * and every line it rewrites keeps the original after `ORIGINAL`, so removal restores the file.
 */

export class YamlShapeError extends Error {}

const ADDED = ' # quirky-added'
const ORIGINAL_MARK = '# quirky-original: '
const KEY_PATTERN = /^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*|"[^"]*"|'[^']*')\s*:(?:\s|$)/
const KEY_NULL_VALUES = new Set(['~', 'null', 'Null', 'NULL'])
const DEFAULT_INDENT = 2

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

function unquote(text: string): string {
  const match = /^(['"])(.*)\1$/.exec(text.trim())
  return match ? match[2]! : text.trim()
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
  const found = lines.flatMap((line, index) => (/^plugins\s*:(\s|$)/.test(line) ? [index] : []))
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

type NamedList = { names: string[]; items: { index: number; name: string }[]; lastLine: number; style: 'block' | 'flow' | 'null' }

function readList(lines: readonly string[], key: number): NamedList {
  const value = valueAfterColon(lines[key]!)
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim()
    const names = inner === '' ? [] : inner.split(',').map(unquote)
    return { names, items: [], lastLine: key, style: 'flow' }
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
      items.push({ index, name: unquote(name) })
      lastLine = index
    }
    return { names: items.map((item) => item.name), items, lastLine, style: value === '' ? 'block' : 'null' }
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
    const found = lines.flatMap((line, index) => (index > plugins && index < end && indentOf(line) === indent && new RegExp(`^${name}\\s*:(\\s|$)`).test(line.trim()) ? [index] : []))
    if (found.length > 1) throw new YamlShapeError(`${name} defined twice`)
    return found[0] ?? -1
  }
  return { header: plugins, end, indent, enabled: find('enabled'), disabled: find('disabled') }
}

const flow = (names: string[]): string => `[${names.join(', ')}]`

/** Returns the lines with `name` in `plugins.enabled` and out of `plugins.disabled`. */
export function enablePlugin(input: readonly string[], name: string): string[] {
  assertLayout(input)
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
        lines[map.disabled] = `${pad}disabled: ${flow(list.names.filter((item) => item !== name))} ${ORIGINAL_MARK}${lines[map.disabled]}`
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
        lines[map.enabled] = `${pad}enabled: ${flow([...list.names, name])} ${ORIGINAL_MARK}${lines[map.enabled]}`
      }
    }
  }
  if (insertAt !== -1) lines.splice(insertAt, 0, ...insert)
  return lines
}

/** Undoes `enablePlugin`: restores rewritten lines and drops added ones, keeping a parent line the user has since put children under. */
export function restoreConfig(input: readonly string[]): string[] {
  const lines = input.map((line) => {
    const at = line.indexOf(ORIGINAL_MARK)
    return at === -1 ? line : line.slice(at + ORIGINAL_MARK.length)
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
  const plugins = topLevelPlugins(input)
  if (plugins === -1) return { enabled: false, disabled: false }
  const value = valueAfterColon(input[plugins]!)
  if (value === '{}' || KEY_NULL_VALUES.has(value)) return { enabled: false, disabled: false }
  const map = locate(input, plugins)
  const has = (key: number): boolean => key !== -1 && readList(input, key).names.includes(name)
  return { enabled: has(map.enabled), disabled: has(map.disabled) }
}
