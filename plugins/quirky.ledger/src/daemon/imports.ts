import { realpathSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import type { LedgerLocation, LedgerType, ImportRecord, ImportSkip } from '../types'

function safeSourcePath(root: string, file: string): string | null {
  const realRoot = realpathSync.native(root)
  const realFile = realpathSync.native(file)
  const rel = relative(realRoot, realFile)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith(sep)) ? realFile : null
}

async function readSource(root: string, file: string): Promise<string> {
  const safe = safeSourcePath(root, file)
  if (!safe) throw Object.assign(new Error('source path resolves outside the workspace root'), { code: 'EOUTSIDE' })
  return await readFile(safe, 'utf8')
}

type Source = { file: string; type: LedgerType }
const SOURCES: Source[] = [
  { file: 'BUGS.md', type: 'bug' },
  { file: 'DEFERRED.md', type: 'deferred' },
  { file: 'TEST_BACKLOG.md', type: 'test-gap' },
  { file: 'proposals.md', type: 'proposal' }
]
const LEGACY_ID = /^\[?([A-Za-z][A-Za-z0-9_-]*-\d+)\]?(?:\s*[:–—-]\s*|\s+)?(.*)$/

function keyOf(label: string): string {
  const normalized = label
    .replace(/\*\*/g, '')
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  const aliases: Record<string, string> = {
    id: 'legacy_id',
    issue: 'legacy_id',
    issue_id: 'legacy_id',
    bug_id: 'legacy_id',
    legacy: 'legacy_id',
    file_path: 'file',
    filename: 'file',
    location: 'file',
    source_file: 'file',
    file_under_test_path: 'file_under_test',
    test_file: 'file_under_test',
    why: 'why_deferred',
    reason: 'reason_skipped',
    status: 'status'
  }
  return aliases[normalized] ?? normalized
}

function cleanValue(value: string): string {
  return value.trim().replace(/^`(.*)`$/, '$1').replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1')
}

function splitTableRow(line: string): string[] | null {
  const trimmed = line.trim()
  if (!trimmed.includes('|')) return null
  const cells = trimmed.replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cleanValue(cell.replace(/\\\|/g, '|')))
  return cells.length > 1 ? cells : null
}

function tableRecords(lines: string[], type: LedgerType, sourcePath: string, sourceBase: LedgerLocation['base']): { records: ImportRecord[]; skipped: ImportSkip[] } {
  const records: ImportRecord[] = []
  const skipped: ImportSkip[] = []
  for (let index = 0; index < lines.length - 1; index += 1) {
    const headers = splitTableRow(lines[index]!)
    const divider = splitTableRow(lines[index + 1]!)
    if (!headers || !divider || !divider.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s/g, '')))) continue
    const keys = headers.map(keyOf)
    index += 1
    while (index + 1 < lines.length) {
      const cells = splitTableRow(lines[index + 1]!)
      if (!cells) break
      index += 1
      if (cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s/g, '')))) continue
      const content: Record<string, unknown> = {}
      for (const [cellIndex, key] of keys.entries()) {
        const value = cells[cellIndex]
        if (value !== undefined && value !== '') content[key] = value
      }
      const id = extractLegacyId(content.legacy_id) ?? extractLegacyId(content.title)?.id
      const legacyId = id?.id
      if (!legacyId) {
        skipped.push({ sourcePath, reason: 'missing-legacy-id' })
        continue
      }
      if (id?.title && typeof content.title === 'string' && content.title === content.legacy_id) content.title = id.title
      else if (typeof content.title === 'string') content.title = stripId(content.title)
      delete content.legacy_id
      records.push({ type, content, sourcePath, sourceBase, legacyId })
    }
  }
  return { records, skipped }
}

function extractLegacyId(value: unknown): { id: string; title: string } | null {
  if (typeof value !== 'string') return null
  const match = value.trim().match(LEGACY_ID)
  return match ? { id: match[1]!, title: match[2]!.trim() } : null
}

function stripId(value: string): string {
  const extracted = extractLegacyId(value)
  return extracted ? extracted.title : value.trim()
}

function parseLabels(lines: string[]): Record<string, unknown> {
  const content: Record<string, unknown> = {}
  let current: string | null = null
  for (const raw of lines) {
    const label = raw.match(/^\s*(?:[-*+]\s*)?(?:\*\*([^*]+?)\*\*\s*:?|([^:]+))\s*:\s*(.*)$/)
    if (label) {
      current = keyOf(label[1] ?? label[2] ?? '')
      const value = cleanValue(label[3] ?? '')
      content[current] = value
      continue
    }
    if (current && raw.trim()) content[current] = `${String(content[current] ?? '')}\n${raw.trim()}`.trim()
  }
  return content
}

function headingRecords(text: string, type: LedgerType, sourcePath: string, sourceBase: LedgerLocation['base']): { records: ImportRecord[]; skipped: ImportSkip[] } {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const headings = lines.map((line, index) => ({ match: line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/), index })).filter((item) => item.match !== null)
  const records: ImportRecord[] = []
  const skipped: ImportSkip[] = []
  for (let h = 0; h < headings.length; h += 1) {
    const item = headings[h]!
    const heading = item.match![2]!.trim()
    const level = item.match![1]!.length
    const end = headings.slice(h + 1).find((next) => next.match![1]!.length <= level)?.index ?? lines.length
    const content = parseLabels(lines.slice(item.index + 1, end))
    const explicit = extractLegacyId(heading)
    const fromField = extractLegacyId(content.legacy_id)
    const titleField = extractLegacyId(content.title)
    const legacyId = explicit?.id ?? fromField?.id ?? titleField?.id
    if (!legacyId) {
      if (Object.keys(content).length) skipped.push({ sourcePath, reason: 'missing-legacy-id' })
      continue
    }
    const title = explicit?.title || (titleField?.id ? titleField.title : typeof content.title === 'string' ? content.title : '')
    if (title) content.title = title
    else delete content.title
    delete content.legacy_id
    records.push({ type, content, sourcePath, sourceBase, legacyId })
  }
  return { records, skipped }
}

function frontmatter(text: string): { values: Record<string, unknown>; body: string } {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  if (lines[0]?.trim() !== '---') return { values: {}, body: text }
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  if (end < 0) return { values: {}, body: text }
  const values: Record<string, unknown> = {}
  for (const line of lines.slice(1, end)) {
    const match = line.match(/^\s*([A-Za-z0-9_-]+)\s*:\s*(.*?)\s*$/)
    if (match) values[keyOf(match[1]!)] = cleanValue(match[2]!)
  }
  return { values, body: lines.slice(end + 1).join('\n') }
}

function adrRecord(text: string, sourcePath: string, sourceBase: LedgerLocation['base']): { record?: ImportRecord; skipped?: ImportSkip } {
  const { values, body } = frontmatter(text)
  const headings = body.replace(/\r\n/g, '\n').split('\n').map((line, index) => ({ line, index, match: line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/) })).filter((item) => item.match !== null)
  const first = headings[0]
  const heading = first?.match?.[2]?.trim() ?? ''
  const id = extractLegacyId(heading) ?? extractLegacyId(values.legacy_id)
  const titleFromHeading = id?.title
  const content: Record<string, unknown> = { ...values }
  if (titleFromHeading && !content.title) content.title = titleFromHeading
  for (let h = 1; h < headings.length; h += 1) {
    const item = headings[h]!
    const section = keyOf(item.match![2]!)
    const level = item.match![1]!.length
    const end = headings.slice(h + 1).find((next) => next.match![1]!.length <= level)?.index ?? body.split(/\r?\n/).length
    const value = body.replace(/\r\n/g, '\n').split('\n').slice(item.index + 1, end).join('\n').trim()
    if (value) content[section] = value
  }
  if (!id?.id) return { skipped: { sourcePath, reason: 'missing-legacy-id' } }
  if (typeof content.status === 'string') content.status = content.status.toLowerCase()
  delete content.legacy_id
  return { record: { type: 'decision', content, sourcePath, sourceBase, legacyId: id.id } }
}

function normalizeEnumFields(type: LedgerType, content: Record<string, unknown>): void {
  const field = type === 'bug' ? 'severity' : type === 'deferred' ? 'priority' : type === 'decision' ? 'status' : null
  if (field && typeof content[field] === 'string') content[field] = (content[field] as string).toLowerCase()
}

/** Reads legacy documents without mutating them or opening ledger storage. */
export async function readLegacyImports(root: string, base: LedgerLocation['base']): Promise<{ records: ImportRecord[]; skipped: ImportSkip[] }> {
  const records: ImportRecord[] = []
  const skipped: ImportSkip[] = []
  const paths = SOURCES.map(({ file, type }) => ({ file, type }))
  let adrFiles: string[] = []
  const adrRoot = join(root, 'docs', 'adr')
  try {
    const safeAdrRoot = safeSourcePath(root, adrRoot)
    if (safeAdrRoot === null) skipped.push({ sourcePath: 'docs/adr', reason: 'outside-root' })
    else {
      adrFiles = (await readdir(safeAdrRoot, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
        .map((entry) => join(adrRoot, entry.name))
        .sort()
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') skipped.push({ sourcePath: 'docs/adr', reason: `read-error:${error instanceof Error ? error.message : String(error)}` })
  }
  for (const file of adrFiles) paths.push({ file, type: 'decision' })

  for (const item of paths) {
    const sourcePath = relative(root, item.file).split(sep).join('/')
    let text: string
    try {
      text = await readSource(root, item.file)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') skipped.push({ sourcePath, reason: code === 'EOUTSIDE' ? 'outside-root' : `read-error:${error instanceof Error ? error.message : String(error)}` })
      continue
    }
    if (item.type === 'decision' && sourcePath.startsWith('docs/adr/')) {
      const parsed = adrRecord(text, sourcePath, base)
      if (parsed.record) {
        normalizeEnumFields(parsed.record.type, parsed.record.content)
        records.push(parsed.record)
      }
      if (parsed.skipped) skipped.push(parsed.skipped)
      continue
    }
    const lines = text.replace(/\r\n/g, '\n').split('\n')
    const tables = tableRecords(lines, item.type, sourcePath, base)
    const headings = headingRecords(text, item.type, sourcePath, base)
    for (const record of [...tables.records, ...headings.records]) {
      normalizeEnumFields(record.type, record.content)
      records.push(record)
    }
    skipped.push(...tables.skipped, ...headings.skipped)
  }

  const identity = (record: ImportRecord) => JSON.stringify([record.sourceBase.kind, record.sourceBase.id, record.sourceBase.host ?? null, record.sourcePath, record.legacyId])
  const counts = new Map<string, number>()
  for (const record of records) counts.set(identity(record), (counts.get(identity(record)) ?? 0) + 1)
  const duplicateIds = new Set([...counts].filter(([, count]) => count > 1).map(([key]) => key))
  for (const record of records) if (duplicateIds.has(identity(record))) skipped.push({ anchor: identity(record), sourcePath: record.sourcePath, reason: 'duplicate-anchor' })
  return { records: records.filter((record) => !duplicateIds.has(identity(record))), skipped }
}
