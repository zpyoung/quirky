import type { EditorServices } from '../types'

export const CSV_PAGED_BYTES = 1024 * 1024
export const CSV_MAX_COLUMNS = 4096
export const CSV_MAX_RECORD_BYTES = 1024 * 1024
export const CSV_PAGE_ROWS = 100
export const CSV_PAGE_BYTES = 1024 * 1024
export const CSV_PAGE_CACHE_COUNT = 64
export const CSV_PAGE_CACHE_BYTES = 8 * 1024 * 1024
export const CSV_PAGE_CACHE_CELLS = 512 * 1024
const BYTE_CHUNK_SIZE = 64 * 1024
const CANDIDATE_DELIMITERS = [',', '\t', ';', '|'] as const

export type CsvTable = {
  rows: string[][]
  delimiter: string
  lineEnding: '\n' | '\r\n' | '\r'
  trailingNewline: boolean
  byteLength: number
}
export type CsvPageRow = { index: number; cells: string[] }
export type CsvPage = { page: number; rows: CsvPageRow[]; offset: number; nextPage: number | null; readOnly: true }
type ReadBytes = (offset: number, length: number) => Promise<{ data: string; eof: boolean; size: number }>
type CacheEntry = { value: CsvPage; bytes: number; cells: number }
export type CsvPager = {
  key: string
  anchors: Map<number, number>
  pages: Map<number, CacheEntry>
  cacheBytes: number
  cacheCells: number
}

function fail(message: string): never {
  throw new Error(message)
}

function isLineBreak(character: string): boolean {
  return character === '\n' || character === '\r'
}

function pushField(row: string[], field: string): void {
  if (row.length >= CSV_MAX_COLUMNS) fail(`CSV column limit exceeded (${CSV_MAX_COLUMNS}).`)
  row.push(field)
}

function appendRow(rows: string[][], row: string[], field: string): void {
  pushField(row, field)
  rows.push(row)
}

function recordByteLength(text: string, start: number, end: number): number {
  return new TextEncoder().encode(text.slice(start, end)).byteLength
}

export function detectDelimiter(text: string, fallback = ','): string {
  const counts = new Map<string, number>(CANDIDATE_DELIMITERS.map((delimiter) => [delimiter, 0]))
  let quoted = false
  const scanLimit = Math.min(text.length, 64 * 1024)
  for (let index = text.charCodeAt(0) === 0xfeff ? 1 : 0; index < scanLimit; index++) {
    const character = text[index]!
    if (character === '"') {
      if (quoted && text[index + 1] === '"') index++
      else quoted = !quoted
    } else if (!quoted && counts.has(character)) counts.set(character, counts.get(character)! + 1)
    else if (!quoted && isLineBreak(character)) break
  }
  let chosen = fallback
  let highest = 0
  for (const [delimiter, count] of counts) {
    if (count > highest) {
      chosen = delimiter
      highest = count
    }
  }
  return chosen
}

export function parseCsv(text: string, delimiter = ','): CsvTable {
  if (delimiter.length !== 1 || delimiter === '"' || isLineBreak(delimiter)) fail('CSV delimiter must be one non-quote character.')
  const rows: string[][] = []
  const row: string[] = []
  let field = ''
  let quoted = false
  let afterQuote = false
  let rowStart = 0
  let lineEnding: CsvTable['lineEnding'] = text.includes('\r\n') ? '\r\n' : text.includes('\r') ? '\r' : '\n'
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  if (input.length === 0) return { rows, delimiter, lineEnding, trailingNewline: false, byteLength: new TextEncoder().encode(text).byteLength }

  for (let index = 0; index < input.length; index++) {
    const character = input[index]!
    if (quoted) {
      if (character === '"') {
        if (input[index + 1] === '"') {
          field += '"'
          index++
        } else {
          quoted = false
          afterQuote = true
        }
      } else field += character
      continue
    }
    if (afterQuote) {
      if (character === delimiter) {
        pushField(row, field)
        field = ''
        afterQuote = false
      } else if (isLineBreak(character)) {
        if (recordByteLength(input, rowStart, index) > CSV_MAX_RECORD_BYTES) fail(`CSV record exceeds ${CSV_MAX_RECORD_BYTES} bytes.`)
        appendRow(rows, row, field)
        field = ''
        afterQuote = false
        if (character === '\r' && input[index + 1] === '\n') index++
        rowStart = index + 1
      } else fail('Invalid character after a closing CSV quote.')
      continue
    }
    if (character === '"') {
      if (field.length !== 0) fail('CSV quote may only begin an empty field.')
      quoted = true
    } else if (character === delimiter) {
      pushField(row, field)
      field = ''
    } else if (isLineBreak(character)) {
      if (recordByteLength(input, rowStart, index) > CSV_MAX_RECORD_BYTES) fail(`CSV record exceeds ${CSV_MAX_RECORD_BYTES} bytes.`)
      appendRow(rows, row, field)
      field = ''
      if (character === '\r' && input[index + 1] === '\n') index++
      rowStart = index + 1
    } else field += character
  }
  if (quoted) fail('CSV contains an unterminated quoted field.')
  const trailingNewline = isLineBreak(input[input.length - 1]!)
  if (rowStart < input.length || row.length > 0 || field.length > 0 || afterQuote) {
    if (recordByteLength(input, rowStart, input.length) > CSV_MAX_RECORD_BYTES) fail(`CSV record exceeds ${CSV_MAX_RECORD_BYTES} bytes.`)
    appendRow(rows, row, field)
  }
  if (rows.some((current) => current.length > CSV_MAX_COLUMNS)) fail(`CSV column limit exceeded (${CSV_MAX_COLUMNS}).`)
  return { rows, delimiter, lineEnding, trailingNewline, byteLength: new TextEncoder().encode(text).byteLength }
}

export function serializeCsv(table: CsvTable): string {
  const output = table.rows.map((row) => row.map((field) => {
    if (field.includes(table.delimiter) || field.includes('"') || field.includes('\r') || field.includes('\n')) {
      return `"${field.replace(/"/g, '""')}"`
    }
    return field
  }).join(table.delimiter)).join(table.lineEnding)
  return output + (table.trailingNewline && table.rows.length ? table.lineEnding : '')
}

function decodeRecord(bytes: Uint8Array, delimiter: string): string[] {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return fail('CSV contains invalid UTF-8.')
  }
  if (new TextEncoder().encode(text).byteLength > CSV_MAX_RECORD_BYTES) fail(`CSV record exceeds ${CSV_MAX_RECORD_BYTES} bytes.`)
  if (text.length === 0) return ['']
  const parsed = parseCsv(text, delimiter)
  if (parsed.rows.length !== 1) fail('CSV record contains an invalid line break.')
  return parsed.rows[0] ?? ['']
}

function newPager(key: string): CsvPager {
  return { key, anchors: new Map([[0, 0]]), pages: new Map(), cacheBytes: 0, cacheCells: 0 }
}

export function createCsvPager(key: string): CsvPager {
  return newPager(key)
}

function evictCache(pager: CsvPager): void {
  while (pager.pages.size > CSV_PAGE_CACHE_COUNT || pager.cacheBytes > CSV_PAGE_CACHE_BYTES || pager.cacheCells > CSV_PAGE_CACHE_CELLS) {
    const oldest = pager.pages.entries().next().value as [number, CacheEntry] | undefined
    if (!oldest) break
    pager.pages.delete(oldest[0])
    pager.cacheBytes -= oldest[1].bytes
    pager.cacheCells -= oldest[1].cells
  }
  while (pager.anchors.size > CSV_PAGE_CACHE_COUNT * 64) {
    const oldestIndex = pager.anchors.keys().next().value as number | undefined
    if (oldestIndex === undefined) break
    if (oldestIndex === 0) {
      const next = pager.anchors.keys().next().value as number | undefined
      if (next === undefined) break
      pager.anchors.delete(next)
    } else pager.anchors.delete(oldestIndex)
  }
}

function cachedPage(pager: CsvPager, pageNumber: number): CsvPage | undefined {
  const cached = pager.pages.get(pageNumber)
  if (!cached) return undefined
  pager.pages.delete(pageNumber)
  pager.pages.set(pageNumber, cached)
  return cached.value
}

function cachePage(pager: CsvPager, pageNumber: number, value: CsvPage, bytes: number): void {
  const cells = value.rows.reduce((count, row) => count + row.cells.length, 0)
  const previous = pager.pages.get(pageNumber)
  if (previous) {
    pager.cacheBytes -= previous.bytes
    pager.cacheCells -= previous.cells
    pager.pages.delete(pageNumber)
  }
  if (bytes > CSV_PAGE_CACHE_BYTES || cells > CSV_PAGE_CACHE_CELLS) return
  pager.pages.set(pageNumber, { value, bytes, cells })
  pager.cacheBytes += bytes
  pager.cacheCells += cells
  evictCache(pager)
}

function nearestAnchor(pager: CsvPager, targetRow: number): { row: number; offset: number } {
  let bestRow = 0
  let bestOffset = 0
  for (const [row, offset] of pager.anchors) {
    if (row <= targetRow && row >= bestRow) {
      bestRow = row
      bestOffset = offset
    }
  }
  return { row: bestRow, offset: bestOffset }
}

export async function readCsvPage(
  readBytes: ReadBytes,
  pager: CsvPager,
  requestedPage: number,
  delimiter: string,
  options: { pageRows?: number; maxPageBytes?: number } = {}
): Promise<CsvPage> {
  if (!Number.isInteger(requestedPage) || requestedPage < 0) fail('CSV page must be a non-negative integer.')
  const pageRows = options.pageRows ?? CSV_PAGE_ROWS
  const maxPageBytes = options.maxPageBytes ?? CSV_PAGE_BYTES
  const targetRow = requestedPage * pageRows
  const anchor = nearestAnchor(pager, targetRow)
  const cached = cachedPage(pager, requestedPage)
  if (cached) return cached

  let offset = anchor.offset
  let fileSize = 0
  let rowIndex = anchor.row
  let recordStart = offset
  let recordLength = 0
  let segmentStart = 0
  let quoteOpen = false
  let quotePending = false
  let skipLf = false
  let chunks: Uint8Array[] = []
  const rows: CsvPageRow[] = []
  let pageStart = offset
  let pageBytes = 0
  let eof = false
  let stopped = false

  const flushSegment = (bytes: Uint8Array, end: number) => {
    if (end > segmentStart) chunks.push(bytes.subarray(segmentStart, end))
  }
  const finishRecord = (nextOffset: number): boolean => {
    const cells = decodeRecord(Buffer.concat(chunks, recordLength), delimiter)
    if (cells.length > CSV_MAX_COLUMNS) fail(`CSV column limit exceeded (${CSV_MAX_COLUMNS}).`)
    if (rowIndex >= targetRow) rows.push({ index: rowIndex, cells })
    rowIndex++
    recordStart = nextOffset
    recordLength = 0
    chunks = []
    if (rowIndex % pageRows === 0) pager.anchors.set(rowIndex, nextOffset)
    if (rowIndex === targetRow) pageStart = nextOffset
    pageBytes = rowIndex > targetRow ? nextOffset - pageStart : 0
    return rows.length >= pageRows || pageBytes >= maxPageBytes
  }

  while (!eof && !stopped) {
    const chunkStart = offset
    const { data, eof: atEnd, size } = await readBytes(chunkStart, BYTE_CHUNK_SIZE)
    const bytes = Buffer.from(data, 'base64')
    fileSize = size
    eof = atEnd || chunkStart + bytes.length >= size
    if (bytes.length === 0) {
      eof = true
      break
    }
    segmentStart = 0
    for (let index = 0; index < bytes.length; index++) {
      const byte = bytes[index]!
      if (skipLf) {
        skipLf = false
        if (byte === 10) {
          segmentStart = index + 1
          continue
        }
      }
      if (quoteOpen) {
        if (quotePending) {
          if (byte === 34) {
            quotePending = false
            continue
          }
          quoteOpen = false
          quotePending = false
        } else if (byte === 34) {
          quotePending = true
          continue
        } else continue
      }
      if (byte === 34) {
        quoteOpen = true
        continue
      }
      if (byte !== 10 && byte !== 13) continue

      flushSegment(bytes, index)
      let lineBreakBytes = 1
      let lineFeedInNextChunk = false
      if (byte === 13) {
        if (bytes[index + 1] === 10) lineBreakBytes = 2
        else if (index + 1 === bytes.length) {
          const next = Buffer.from((await readBytes(chunkStart + index + 1, 1)).data, 'base64')
          if (next[0] === 10) {
            lineBreakBytes = 2
            lineFeedInNextChunk = true
          }
        }
      }
      recordLength += index - segmentStart
      if (recordLength > CSV_MAX_RECORD_BYTES) fail(`CSV record exceeds ${CSV_MAX_RECORD_BYTES} bytes.`)
      const nextOffset = chunkStart + index + lineBreakBytes
      if (finishRecord(nextOffset)) {
        offset = nextOffset
        stopped = true
        break
      }
      if (lineFeedInNextChunk) skipLf = true
      index += lineBreakBytes - 1
      segmentStart = index + 1
    }
    if (stopped) break
    flushSegment(bytes, bytes.length)
    recordLength += bytes.length - segmentStart
    if (recordLength > CSV_MAX_RECORD_BYTES) fail(`CSV record exceeds ${CSV_MAX_RECORD_BYTES} bytes.`)
    offset = chunkStart + bytes.length
  }

  if (eof && !stopped) {
    if (quotePending) {
      quoteOpen = false
      quotePending = false
    }
    if (quoteOpen || recordLength > CSV_MAX_RECORD_BYTES) fail('CSV contains an unterminated quoted field or an over-limit record.')
    if (recordLength > 0 || chunks.length > 0 || rowIndex === 0 && recordStart === 0) {
      const cells = decodeRecord(Buffer.concat(chunks, recordLength), delimiter)
      if (cells.length > CSV_MAX_COLUMNS) fail(`CSV column limit exceeded (${CSV_MAX_COLUMNS}).`)
      if (rowIndex >= targetRow) rows.push({ index: rowIndex, cells })
      rowIndex++
      const nextOffset = recordStart + recordLength
      if (rowIndex % pageRows === 0) pager.anchors.set(rowIndex, nextOffset)
      if (rowIndex === targetRow) pageStart = nextOffset
      pageBytes = rowIndex > targetRow ? nextOffset - pageStart : 0
      recordStart = nextOffset
      offset = nextOffset
    }
  }

  if (rows.length === 0 && requestedPage > 0 && eof) {
    return { page: requestedPage, rows, offset: recordStart, nextPage: null, readOnly: true }
  }
  const hasMore = offset < fileSize
  const page: CsvPage = {
    page: requestedPage,
    rows,
    offset: pageStart,
    nextPage: hasMore ? requestedPage + 1 : null,
    readOnly: true
  }
  const cachedBytes = rows.reduce((sum, row) => sum + row.cells.reduce((rowSum, cell) => rowSum + Buffer.byteLength(cell), 0), 0)
  cachePage(pager, requestedPage, page, cachedBytes)
  evictCache(pager)
  return page
}

export function resetCsvPager(pager: CsvPager, key: string): CsvPager {
  return pager.key === key ? pager : newPager(key)
}

export function createCsvTable(text: string, fallbackDelimiter = ','): CsvTable {
  return parseCsv(text, detectDelimiter(text, fallbackDelimiter))
}

export type CsvViewerHost = Pick<EditorServices, 'readBytes'>
