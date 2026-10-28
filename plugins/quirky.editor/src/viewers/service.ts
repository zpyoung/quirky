import { realpathSync } from 'node:fs'
import { extname, isAbsolute, relative, sep } from 'node:path'
import type { MethodHandler } from '@quirky/protocol'
import type { CsvCopyRange, EditorBuffer, EditorServices, FeatureMethods, ViewerResourceParams } from '../types'
import {
  CSV_MAX_COLUMNS,
  CSV_MAX_RECORD_BYTES,
  CSV_PAGE_CACHE_BYTES,
  CSV_PAGE_CACHE_COUNT,
  CSV_PAGE_CACHE_CELLS,
  CSV_PAGE_ROWS,
  CSV_PAGED_BYTES,
  createCsvPager,
  detectDelimiter,
  parseCsv,
  readCsvPage,
  resetCsvPager,
  serializeCsv,
  type CsvPageRow,
  type CsvPager,
  type CsvTable
} from './csv'

type Action = 'metadata' | 'page' | 'edit' | 'sort' | 'filter' | 'insertRow' | 'deleteRow' | 'insertColumn' | 'deleteColumn' | 'delimiter' | 'copy' | 'paste' | 'save' | 'zoom' | 'find' | 'position' | 'media' | 'release'
type FileResource = { url: string; revoke: () => void }
type ViewerLease = { active: boolean; resource?: FileResource }
type ViewerMemory = {
  pager?: CsvPager
  resourceKeys: Map<string, FileResource>
  leases: Map<string, ViewerLease>
  closed: boolean
}
type MediaParams = Extract<ViewerResourceParams, { action: 'media' }>
type ImageMetadata = { mime: string; width?: number; height?: number; error?: string; previewable: boolean }

const ACTIONS = new Set<Action>([
  'metadata', 'page', 'edit', 'sort', 'filter', 'insertRow', 'deleteRow', 'insertColumn', 'deleteColumn',
  'delimiter', 'copy', 'paste', 'save', 'zoom', 'find', 'position', 'media', 'release'
])
const MAX_FILE_BYTES = 50 * 1024 * 1024
const MAX_FILTER_LENGTH = 8192
const MAX_FIND_MATCHES = 10_000
const IMAGE_MAX_SIDE = 32_768
const IMAGE_MAX_PIXELS = 32 * 1024 * 1024
const AUDIO_TYPES: Record<string, string> = {
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.flac': 'audio/flac', '.opus': 'audio/ogg'
}
const VIDEO_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm'
}
const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.avif': 'image/avif'
}
const CSV_LIMITS = {
  maxColumns: CSV_MAX_COLUMNS,
  maxRecordBytes: CSV_MAX_RECORD_BYTES,
  maxCachedPages: CSV_PAGE_CACHE_COUNT,
  maxCachedBytes: CSV_PAGE_CACHE_BYTES,
  maxCachedCells: CSV_PAGE_CACHE_CELLS,
  pageRows: CSV_PAGE_ROWS
}

function error(host: EditorServices, kind: 'invalid-params' | 'conflict' | 'not-found', message: string): never {
  throw host.context.error(kind, message)
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function stringParam(host: EditorServices, value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) error(host, 'invalid-params', `${label} must be a string`)
  return value
}

function leaseParam(host: EditorServices, value: unknown): string {
  const leaseId = stringParam(host, value, 'leaseId')
  if (leaseId.length > 128) error(host, 'invalid-params', 'leaseId must be at most 128 characters')
  return leaseId
}

function integerParam(host: EditorServices, value: unknown, label: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum) error(host, 'invalid-params', `${label} must be an integer of at least ${minimum}`)
  return value
}

function currentText(buffer: EditorBuffer): string {
  return buffer.draft !== null ? buffer.draft : buffer.content
}

function bufferExtension(buffer: EditorBuffer): string {
  return extname(buffer.relativePath).toLowerCase()
}

function contentType(buffer: EditorBuffer): string | null {
  const extension = bufferExtension(buffer)
  if (buffer.kind === 'image') return IMAGE_TYPES[extension] ?? null
  if (buffer.kind === 'pdf') return 'application/pdf'
  if (buffer.kind === 'audio') return AUDIO_TYPES[extension] ?? null
  if (buffer.kind === 'video') return VIDEO_TYPES[extension] ?? null
  return null
}

function viewerState(buffer: EditorBuffer): Record<string, unknown> {
  return object(buffer.view.viewer)
}

function baseViewerMetadata(buffer: EditorBuffer): Record<string, unknown> {
  return {
    kind: buffer.kind,
    size: buffer.size,
    readOnly: buffer.readOnly,
    changedOnDisk: buffer.external === 'changed',
    error: buffer.error
  }
}

function imageDimensions(bytes: Uint8Array, mime: string): ImageMetadata {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let width: number | undefined
  let height: number | undefined
  if (mime === 'image/png') {
    if (bytes.length < 24 || bytes[0] !== 137 || bytes[1] !== 80 || bytes[2] !== 78 || bytes[3] !== 71 || view.getUint32(8) < 13 || String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR') {
      return { mime, error: 'Malformed PNG image header.', previewable: false }
    }
    width = view.getUint32(16)
    height = view.getUint32(20)
  } else if (mime === 'image/gif') {
    if (bytes.length < 10 || String.fromCharCode(...bytes.subarray(0, 3)) !== 'GIF') return { mime, error: 'Malformed GIF image header.', previewable: false }
    width = view.getUint16(6, true)
    height = view.getUint16(8, true)
  } else if (mime === 'image/bmp') {
    if (bytes.length < 26 || bytes[0] !== 66 || bytes[1] !== 77) return { mime, error: 'Malformed BMP image header.', previewable: false }
    width = Math.abs(view.getInt32(18, true))
    height = Math.abs(view.getInt32(22, true))
  } else if (mime === 'image/webp') {
    if (bytes.length < 30 || String.fromCharCode(...bytes.subarray(0, 4)) !== 'RIFF' || String.fromCharCode(...bytes.subarray(8, 12)) !== 'WEBP') {
      return { mime, error: 'Malformed WebP image header.', previewable: false }
    }
    const chunk = String.fromCharCode(...bytes.subarray(12, 16))
    if (chunk === 'VP8X') {
      width = 1 + bytes[24]! + (bytes[25]! << 8) + (bytes[26]! << 16)
      height = 1 + bytes[27]! + (bytes[28]! << 8) + (bytes[29]! << 16)
    } else if (chunk === 'VP8 ') {
      width = view.getUint16(26, true) & 0x3fff
      height = view.getUint16(28, true) & 0x3fff
    } else if (chunk === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) {
      width = 1 + bytes[21]! + ((bytes[22]! & 0x3f) << 8)
      height = 1 + ((bytes[22]! & 0xc0) >> 6) + (bytes[23]! << 2) + ((bytes[24]! & 0x0f) << 10)
    }
  } else if (mime === 'image/jpeg') {
    const dimensions = jpegDimensions(bytes)
    width = dimensions?.width
    height = dimensions?.height
    if (!dimensions) return { mime, error: 'Malformed JPEG image header.', previewable: false }
  } else if (mime === 'image/x-icon') {
    if (bytes.length < 8 || view.getUint16(0, true) !== 0 || view.getUint16(2, true) !== 1) return { mime, error: 'Malformed icon image header.', previewable: false }
    width = bytes[6] || 256
    height = bytes[7] || 256
  } else if (mime === 'image/avif') {
    const dimensions = avifDimensions(bytes)
    width = dimensions?.width
    height = dimensions?.height
    if (!dimensions) return { mime, error: 'AVIF dimensions could not be read safely.', previewable: false }
  } else if (mime === 'image/svg+xml') {
    const dimensions = svgDimensions(bytes)
    width = dimensions?.width
    height = dimensions?.height
    if (!dimensions) return { mime, error: 'SVG dimensions could not be read safely.', previewable: false }
  }
  if (width === undefined || height === undefined || width <= 0 || height <= 0) return { mime, error: 'Image dimensions could not be read.', previewable: false }
  if (width > IMAGE_MAX_SIDE || height > IMAGE_MAX_SIDE || width * height > IMAGE_MAX_PIXELS) {
    return { mime, width, height, error: `Image preview exceeds the ${IMAGE_MAX_PIXELS.toLocaleString()} decoded-pixel safety limit.`, previewable: false }
  }
  return { mime, width, height, previewable: true }
}

function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  let offset = 2
  while (offset + 4 < bytes.length) {
    if (bytes[offset] !== 0xff) { offset++; continue }
    const marker = bytes[offset + 1]!
    offset += 2
    if (marker === 0xd8 || marker === 0xd9 || marker >= 0xd0 && marker <= 0xd7) continue
    if (offset + 2 > bytes.length) return null
    const length = (bytes[offset]! << 8) | bytes[offset + 1]!
    if (length < 2 || offset + length > bytes.length) return null
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (length < 7) return null
      return { height: (bytes[offset + 3]! << 8) | bytes[offset + 4]!, width: (bytes[offset + 5]! << 8) | bytes[offset + 6]! }
    }
    offset += length
  }
  return null
}
function avifDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  for (let offset = 4; offset + 16 <= bytes.length; offset++) {
    if (bytes[offset] === 0x69 && bytes[offset + 1] === 0x73 && bytes[offset + 2] === 0x70 && bytes[offset + 3] === 0x65) {
      const view = new DataView(bytes.buffer, bytes.byteOffset + offset + 4, bytes.byteLength - offset - 4)
      const width = view.getUint32(4)
      const height = view.getUint32(8)
      return width > 0 && height > 0 ? { width, height } : null
    }
  }
  return null
}
function svgDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  let source: string
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
  if (!/<svg(?:\s|>)/i.test(source)) return null
  const attribute = (name: string): number | undefined => {
    const match = new RegExp(`\\b${name}\\s*=\\s*["']\\s*([\\d.]+)\\s*(?:px)?\\s*["']`, 'i').exec(source)
    const value = match ? Number(match[1]) : Number.NaN
    return Number.isFinite(value) && value > 0 ? value : undefined
  }
  const viewBox = /\bviewBox\s*=\s*["']\s*[-\d.]+[ ,]+[-\d.]+[ ,]+([\d.]+)[ ,]+([\d.]+)/i.exec(source)
  const viewWidth = viewBox ? Number(viewBox[1]) : undefined
  const viewHeight = viewBox ? Number(viewBox[2]) : undefined
  const width = attribute('width') ?? viewWidth
  const height = attribute('height') ?? viewHeight
  return width && height && Number.isFinite(width) && Number.isFinite(height) ? { width, height } : null
}

function imageSourceBytes(host: EditorServices, bufferId: string, size: number): Promise<Uint8Array> {
  const length = Math.min(size, 1024 * 1024)
  return host.readBytes(bufferId, 0, length).then((result) => Buffer.from(result.data, 'base64'))
}

async function imageMetadata(host: EditorServices, buffer: EditorBuffer): Promise<ImageMetadata & { bytes: number; zoom: number }> {
  const mime = IMAGE_TYPES[bufferExtension(buffer)]
  if (!mime) return { mime: 'application/octet-stream', error: 'Unsupported image type.', previewable: false, bytes: buffer.size, zoom: 1 }
  const view = viewerState(buffer)
  if (buffer.size > MAX_FILE_BYTES) return { mime, error: 'File is too large to preview.', previewable: false, bytes: buffer.size, zoom: typeof view.zoom === 'number' ? view.zoom : 1 }
  const bytes = await imageSourceBytes(host, buffer.id, buffer.size)
  return { ...imageDimensions(bytes, mime), bytes: buffer.size, zoom: typeof view.zoom === 'number' ? view.zoom : 1 }
}

function smallCsv(buffer: EditorBuffer, delimiterOverride?: string): CsvTable {
  const text = currentText(buffer)
  const fallback = bufferExtension(buffer) === '.tsv' ? '\t' : ','
  const delimiter = delimiterOverride ?? detectDelimiter(text, fallback)
  return parseCsv(text, delimiter)
}

function pagerFor(memory: ViewerMemory, buffer: EditorBuffer): CsvPager {
  const key = `${buffer.contentRevision}:${buffer.size}:${buffer.baseline ?? 'no-baseline'}`
  memory.pager = memory.pager ? resetCsvPager(memory.pager, key) : createCsvPager(key)
  return memory.pager
}

function filterAndSort(rows: CsvPageRow[], filter: string, sort: { column?: number; order?: string } | null): CsvPageRow[] {
  let filtered = filter ? rows.filter((row) => row.cells.some((cell) => cell.toLocaleLowerCase().includes(filter.toLocaleLowerCase()))) : rows
  if (sort && typeof sort.column === 'number') {
    const column = sort.column
    const factor = sort.order === 'desc' ? -1 : 1
    filtered = [...filtered].sort((left, right) => factor * (left.cells[column] ?? '').localeCompare(right.cells[column] ?? '', undefined, { numeric: true, sensitivity: 'base' }))
  }
  return filtered
}

async function withLock<T>(locks: Map<string, Promise<void>>, key: string, task: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve()
  const gate = Promise.withResolvers<void>()
  const tail = previous.then(() => gate.promise)
  locks.set(key, tail)
  await previous
  try {
    return await task()
  } finally {
    gate.resolve()
    if (locks.get(key) === tail) locks.delete(key)
  }
}

async function mutateSmallCsv(
  host: EditorServices,
  bufferId: string,
  locks: Map<string, Promise<void>>,
  mutate: (table: CsvTable) => void
): Promise<void> {
  await withLock(locks, bufferId, async () => {
    const buffer = host.get(bufferId)
    if (buffer.kind !== 'csv' || buffer.size >= CSV_PAGED_BYTES || buffer.readOnly) error(host, 'conflict', 'Large CSV previews are read-only.')
    const revision = buffer.contentRevision
    const table = smallCsv(buffer)
    mutate(table)
    const serialized = serializeCsv(table)
    const bytes = new TextEncoder().encode(serialized).byteLength
    if (bytes >= CSV_PAGED_BYTES) error(host, 'conflict', 'Table edits must stay below 1 MiB. Use Source for larger changes.')
    await host.draft(bufferId, serialized, revision)
  })
}


function maxColumns(rows: string[][]): number {
  let maximum = 0
  for (const row of rows) maximum = Math.max(maximum, row.length)
  return maximum
}

function ensureRow(rows: string[][], row: number, columns: number): string[] {
  while (rows.length <= row) rows.push(Array.from({ length: columns }, () => ''))
  const cells = rows[row]!
  while (cells.length < columns) cells.push('')
  return cells
}

function csvCopyRows(host: EditorServices, params: Record<string, unknown>, table: CsvTable): string[][] {
  const row = params.row === undefined ? undefined : integerParam(host, params.row, 'row')
  const column = params.column === undefined ? undefined : integerParam(host, params.column, 'column')
  const hasEndRow = params.endRow !== undefined
  const hasEndColumn = params.endColumn !== undefined
  if (hasEndRow !== hasEndColumn) error(host, 'invalid-params', 'copy range requires both endRow and endColumn')
  if (hasEndRow) {
    if (row === undefined || column === undefined) error(host, 'invalid-params', 'copy range requires row and column')
    const range: CsvCopyRange = {
      row,
      column,
      endRow: integerParam(host, params.endRow, 'endRow'),
      endColumn: integerParam(host, params.endColumn, 'endColumn')
    }
    if (range.endRow < range.row || range.endColumn < range.column) error(host, 'invalid-params', 'copy range bounds cannot be reversed')
    const columns = maxColumns(table.rows)
    if (range.endRow >= table.rows.length || range.endColumn >= columns) error(host, 'invalid-params', 'copy range is out of bounds')
    return Array.from({ length: range.endRow - range.row + 1 }, (_, rowOffset) =>
      Array.from({ length: range.endColumn - range.column + 1 }, (_, columnOffset) =>
        table.rows[range.row + rowOffset]?.[range.column + columnOffset] ?? ''
      )
    )
  }
  if (row !== undefined && row >= table.rows.length) error(host, 'invalid-params', 'copy row is out of range')
  if (row !== undefined) {
    const values = table.rows[row]!
    return column === undefined ? [values] : [[values[column] ?? '']]
  }
  if (column !== undefined) return table.rows.map((values) => [values[column] ?? ''])
  return table.rows
}

function serializeTsv(rows: string[][]): string {
  return rows.map((row) => row.map((value) => {
    if (value.length === 0 || value.includes('\t') || value.includes(',') || value.includes(';') || value.includes('|') || value.includes('"') || value.includes('\r') || value.includes('\n')) {
      return `"${value.replace(/"/g, '""')}"`
    }
    return value
  }).join('\t')).join('\n')
}

function csvMetadata(buffer: EditorBuffer): Record<string, unknown> {
  if (buffer.size >= CSV_PAGED_BYTES) return {
    ...baseViewerMetadata(buffer), format: 'csv', paged: true, readOnly: true, rows: null, columns: null,
    delimiter: bufferExtension(buffer) === '.tsv' ? '\t' : ',', limits: CSV_LIMITS,
    message: buffer.external === 'changed' ? 'CSV changed on disk. Reload the file to refresh the preview.' : null
  }
  try {
    const table = smallCsv(buffer)
    return { ...baseViewerMetadata(buffer), format: 'csv', paged: false, readOnly: buffer.readOnly, rows: table.rows.length, columns: maxColumns(table.rows), delimiter: table.delimiter, limits: CSV_LIMITS }
  } catch (cause) {
    return { ...baseViewerMetadata(buffer), format: 'csv', paged: false, readOnly: true, error: cause instanceof Error ? cause.message : String(cause), limits: CSV_LIMITS }
  }
}

async function csvPage(
  host: EditorServices,
  buffer: EditorBuffer,
  memory: ViewerMemory,
  params: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const pageIndex = integerParam(host, params.page ?? 0, 'page')
  if (buffer.external === 'changed') return {
    page: pageIndex, rows: [], readOnly: true, changedOnDisk: true,
    message: 'CSV changed on disk. Reload the file to refresh the preview.'
  }
  const view = viewerState(buffer)
  const filter = typeof view.filter === 'string' ? view.filter : ''
  const sort = view.sort && typeof view.sort === 'object' ? object(view.sort) : null
  if (buffer.size >= CSV_PAGED_BYTES) {
    const pager = pagerFor(memory, buffer)
    try {
      const page = await readCsvPage(async (offset, length) => host.readBytes(buffer.id, offset, length), pager, pageIndex, typeof view.delimiter === 'string' ? view.delimiter : bufferExtension(buffer) === '.tsv' ? '\t' : ',', { pageRows: CSV_PAGE_ROWS })
      const rows = filter ? [
        ...(pageIndex === 0 ? page.rows.filter((row) => row.index === 0) : []),
        ...filterAndSort(page.rows.filter((row) => row.index !== 0), filter, null)
      ] : page.rows
      return { ...page, rows, changedOnDisk: false, limits: CSV_LIMITS }
    } catch (cause) {
      error(host, 'conflict', cause instanceof Error ? cause.message : String(cause))
    }
  }
  const table = smallCsv(buffer, typeof view.delimiter === 'string' ? view.delimiter : undefined)
  let rows: CsvPageRow[] = table.rows.map((cells, index) => ({ index, cells }))
  if (filter) {
    const header = rows.find((row) => row.index === 0)
    const body = filterAndSort(rows.filter((row) => row.index !== 0), filter, null)
    rows = header ? [header, ...body] : body
  }
  if (sort && typeof sort.column === 'number') {
    const header = rows.find((row) => row.index === 0)
    const body = filterAndSort(rows.filter((row) => row.index !== 0), '', sort)
    rows = header ? [header, ...body] : body
  }
  const pageRows = typeof params.count === 'number' ? Math.min(CSV_PAGE_ROWS, Math.max(1, Math.trunc(params.count))) : CSV_PAGE_ROWS
  const start = pageIndex * pageRows
  return {
    page: pageIndex,
    rows: rows.slice(start, start + pageRows),
    readOnly: buffer.readOnly,
    changedOnDisk: false,
    totalRows: rows.length,
    nextPage: start + pageRows < rows.length ? pageIndex + 1 : null,
    delimiter: table.delimiter
  }
}

function ensureResourceAcquisition(host: EditorServices, memory: ViewerMemory, leaseId?: string, lease?: ViewerLease): void {
  if (memory.closed || (leaseId !== undefined && (!lease?.active || memory.leases.get(leaseId) !== lease))) {
    error(host, 'conflict', 'Viewer resource acquisition is no longer active.')
  }
}

async function createResource(
  host: EditorServices,
  buffer: EditorBuffer,
  memory: ViewerMemory,
  params: MediaParams,
  lease?: ViewerLease
): Promise<Record<string, unknown>> {
  const leaseId = params.leaseId
  ensureResourceAcquisition(host, memory, leaseId, lease)
  if (buffer.size > MAX_FILE_BYTES) error(host, 'conflict', 'File is too large to preview.')
  const mime = contentType(buffer)
  if (!mime) error(host, 'invalid-params', 'This file type has no safe streaming viewer.')
  if (buffer.kind === 'image') {
    const metadata = await imageMetadata(host, buffer)
    ensureResourceAcquisition(host, memory, leaseId, lease)
    if (!metadata.previewable) error(host, 'conflict', metadata.error ?? 'Image preview is not safe.')
  }
  if (buffer.external === 'changed') return { changedOnDisk: true, error: 'File changed on disk. Reload before previewing.', size: buffer.size }
  const key = `${mime}:${buffer.path}:${buffer.contentRevision}:${buffer.baseline ?? 'none'}`
  if (lease === undefined) {
    const known = memory.resourceKeys.get(key)
    if (known) return { url: known.url, contentType: mime, size: buffer.size, acceptsRanges: true }
  }
  const path = await host.path(buffer.worktreeId, buffer.relativePath)
  ensureResourceAcquisition(host, memory, leaseId, lease)
  const root = realpathSync(buffer.root)
  const canonical = realpathSync(path)
  const relativePath = relative(root, canonical)
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) error(host, 'conflict', 'Viewer path is no longer inside its worktree.')
  ensureResourceAcquisition(host, memory, leaseId, lease)
  const created = await host.context.createFileResource({ path: canonical, contentType: mime, disposition: 'inline' })
  if (memory.closed || (leaseId !== undefined && (!lease?.active || memory.leases.get(leaseId) !== lease))) {
    created.revoke()
    error(host, 'conflict', 'Viewer resource acquisition is no longer active.')
  }
  let resource = created
  if (lease) lease.resource = resource
  else {
    const known = memory.resourceKeys.get(key)
    if (known) {
      resource.revoke()
      resource = known
    } else memory.resourceKeys.set(key, resource)
  }
  return {
    url: resource.url,
    contentType: mime,
    size: buffer.size,
    acceptsRanges: true,
    ...(leaseId === undefined ? {} : { leaseId })
  }
}

function imageKind(buffer: EditorBuffer, metadata: ImageMetadata & { bytes: number; zoom: number }): Record<string, unknown> {
  return { ...baseViewerMetadata(buffer), kind: 'image', ...metadata }
}

function getMetadata(host: EditorServices, buffer: EditorBuffer): Record<string, unknown> | Promise<Record<string, unknown>> {
  if (buffer.size > MAX_FILE_BYTES) return { ...baseViewerMetadata(buffer), kind: buffer.kind, displayable: false, reason: 'too-large', message: 'File is too large to preview.' }
  if (buffer.kind === 'csv') return csvMetadata(buffer)
  if (buffer.kind === 'image') return imageMetadata(host, buffer).then((metadata) => imageKind(buffer, metadata))
  if (buffer.kind === 'pdf' || buffer.kind === 'audio' || buffer.kind === 'video') {
    const view = viewerState(buffer)
    return { ...baseViewerMetadata(buffer), kind: buffer.kind, contentType: contentType(buffer), zoom: typeof view.zoom === 'number' ? view.zoom : buffer.kind === 'pdf' ? 'page-width' : 1, page: typeof view.page === 'number' ? view.page : 1, offset: typeof view.offset === 'number' ? view.offset : 0, seekable: true }
  }
  if (buffer.kind === 'mermaid') return { ...baseViewerMetadata(buffer), kind: 'mermaid', sourceAvailable: true, sourceLength: currentText(buffer).length }
  if (buffer.kind === 'binary') return { ...baseViewerMetadata(buffer), kind: 'binary', displayable: false, reason: 'binary', message: 'Binary file — cannot display.' }
  return { ...baseViewerMetadata(buffer), displayable: false, reason: 'unsupported' }
}

export function createViewerMethods(host: EditorServices): FeatureMethods {
  const memories = new Map<string, ViewerMemory>()
  const mutationLocks = new Map<string, Promise<void>>()
  let disposed = false

  const closeMemory = (bufferId: string, memory: ViewerMemory): void => {
    if (memory.closed) return
    memory.closed = true
    if (memories.get(bufferId) === memory) memories.delete(bufferId)
    for (const resource of memory.resourceKeys.values()) resource.revoke()
    memory.resourceKeys.clear()
    for (const lease of memory.leases.values()) {
      lease.active = false
      lease.resource?.revoke()
      lease.resource = undefined
    }
    memory.leases.clear()
  }

  const memoryFor = (bufferId: string): ViewerMemory => {
    let memory = memories.get(bufferId)
    if (!memory) {
      memory = { resourceKeys: new Map(), leases: new Map(), closed: false }
      memories.set(bufferId, memory)
    }
    return memory
  }

  const updateViewer = async (bufferId: string, patch: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const buffer = host.get(bufferId)
    const current = viewerState(buffer)
    const viewer = { ...current, ...patch }
    await host.updateView(bufferId, { viewer })
    return viewer
  }

  const onClose = host.onClose((bufferId) => {
    const memory = memories.get(bufferId)
    if (memory) closeMemory(bufferId, memory)
  })

  const releaseLease = (request: Extract<ViewerResourceParams, { action: 'release' }>): { released: boolean } => {
    const memory = memories.get(request.bufferId)
    const lease = memory?.leases.get(request.leaseId)
    if (!memory || !lease) return { released: false }
    memory.leases.delete(request.leaseId)
    lease.active = false
    lease.resource?.revoke()
    lease.resource = undefined
    return { released: true }
  }

  const mutate = async (bufferId: string, action: Action, params: Record<string, unknown>): Promise<unknown> => {
    if (action === 'release') {
      const request: Extract<ViewerResourceParams, { action: 'release' }> = {
        bufferId,
        action: 'release',
        leaseId: leaseParam(host, params.leaseId)
      }
      return releaseLease(request)
    }
    if (action === 'save') return host.save(bufferId, 'user')
    if (action === 'metadata') {
      const buffer = host.get(bufferId)
      return await getMetadata(host, buffer)
    }
    if (action === 'page') {
      const buffer = host.get(bufferId)
      if (buffer.kind === 'csv') return csvPage(host, buffer, memoryFor(bufferId), params)
      if (buffer.kind === 'pdf') {
        const page = integerParam(host, params.page ?? viewerState(buffer).page ?? 1, 'page', 1)
        const position = await updateViewer(bufferId, { page })
        return { page, position, contentType: 'application/pdf', readOnly: true }
      }
      if (buffer.kind === 'image') return imageMetadata(host, buffer)
      error(host, 'invalid-params', `page is not supported for ${buffer.kind} files`)
    }
    if (action === 'edit' || action === 'insertRow' || action === 'deleteRow' || action === 'insertColumn' || action === 'deleteColumn' || action === 'delimiter' || action === 'paste') {
      const buffer = host.get(bufferId)
      if (buffer.kind !== 'csv') error(host, 'invalid-params', `${action} requires a CSV or TSV file`)
      await mutateSmallCsv(host, bufferId, mutationLocks, (table) => {
        if (action === 'edit') {
          const row = integerParam(host, params.row, 'row')
          const column = integerParam(host, params.column, 'column')
          if (row >= table.rows.length || column >= table.rows[row]!.length) error(host, 'invalid-params', 'CSV cell is out of range')
          table.rows[row]![column] = stringParam(host, params.value, 'value', true)
        } else if (action === 'insertRow') {
          const index = typeof params.index === 'number' ? integerParam(host, params.index, 'index') : table.rows.length
          const count = typeof params.count === 'number' ? Math.min(1000, integerParam(host, params.count, 'count', 1)) : 1
          if (index > table.rows.length) error(host, 'invalid-params', 'row insertion index is out of range')
          const width = Math.max(1, maxColumns(table.rows))
          if (count * width > CSV_PAGED_BYTES) error(host, 'invalid-params', 'Requested CSV row insertion exceeds the 1 MiB table limit.')
          table.rows.splice(index, 0, ...Array.from({ length: count }, () => Array.from({ length: width }, () => '')))
        } else if (action === 'deleteRow') {
          const index = integerParam(host, params.row ?? params.index, 'row')
          if (index >= table.rows.length) error(host, 'invalid-params', 'row index is out of range')
          table.rows.splice(index, 1)
        } else if (action === 'insertColumn') {
          if (table.rows.length === 0) table.rows.push([])
          const index = integerParam(host, params.index, 'index')
          const width = Math.max(1, maxColumns(table.rows))
          if (index > width || width >= CSV_MAX_COLUMNS) error(host, 'invalid-params', 'column insertion index or column count is out of range')
          for (let rowIndex = 0; rowIndex < table.rows.length; rowIndex++) {
            const row = ensureRow(table.rows, rowIndex, width)
            row.splice(index, 0, rowIndex === 0 ? typeof params.value === 'string' ? params.value : '' : '')
          }
        } else if (action === 'deleteColumn') {
          const index = integerParam(host, params.index, 'index')
          const width = Math.max(1, maxColumns(table.rows))
          if (width <= 1 || index >= width) error(host, 'invalid-params', 'column cannot be removed')
          for (const row of table.rows) row.splice(index, 1)
        } else if (action === 'delimiter') {
          const delimiter = stringParam(host, params.delimiter, 'delimiter')
          if (delimiter.length !== 1 || delimiter === '"' || delimiter === '\n' || delimiter === '\r') error(host, 'invalid-params', 'delimiter must be one non-quote character')
          table.delimiter = delimiter
        } else if (action === 'paste') {
          const startRow = integerParam(host, params.row, 'row')
          const startColumn = integerParam(host, params.column, 'column')
          const text = stringParam(host, params.text, 'text', true)
          if (new TextEncoder().encode(text).byteLength >= CSV_PAGED_BYTES) error(host, 'invalid-params', 'Pasted CSV data must stay below 1 MiB.')
          const clipboardDelimiter = text.includes('\t') ? '\t' : detectDelimiter(text, table.delimiter)
          const pasted = parseCsv(text, clipboardDelimiter).rows
          if (startRow + pasted.length > CSV_PAGED_BYTES || startColumn + maxColumns(pasted) > CSV_MAX_COLUMNS) error(host, 'invalid-params', 'Pasted CSV range exceeds table limits.')
          for (let rowOffset = 0; rowOffset < pasted.length; rowOffset++) {
            const values = pasted[rowOffset]!
            const row = ensureRow(table.rows, startRow + rowOffset, startColumn + values.length)
            for (let columnOffset = 0; columnOffset < values.length; columnOffset++) row[startColumn + columnOffset] = values[columnOffset]!
          }
        }
      })
      return getMetadata(host, host.get(bufferId))
    }
    if (action === 'sort' || action === 'filter') {
      const buffer = host.get(bufferId)
      if (buffer.kind !== 'csv') error(host, 'invalid-params', `${action} requires a CSV or TSV file`)
      if (action === 'filter') {
        const query = stringParam(host, params.query ?? '', 'query', true)
        if (query.length > MAX_FILTER_LENGTH) error(host, 'invalid-params', 'CSV filter is too long.')
        const view = await updateViewer(bufferId, { filter: query })
        return { filter: query, paged: buffer.size >= CSV_PAGED_BYTES, readOnly: buffer.size >= CSV_PAGED_BYTES || buffer.readOnly, view }
      }
      if (buffer.size >= CSV_PAGED_BYTES) error(host, 'conflict', 'Large CSV previews are read-only and cannot be globally sorted.')
      const column = integerParam(host, params.column ?? params.index, 'column')
      const order = params.order === 'desc' ? 'desc' : params.order === 'asc' ? 'asc' : null
      if (!order) error(host, 'invalid-params', 'order must be asc or desc')
      const table = smallCsv(buffer)
      if (column >= Math.max(1, maxColumns(table.rows))) error(host, 'invalid-params', 'sort column is out of range')
      return updateViewer(bufferId, { sort: { column, order } })
    }
    if (action === 'copy') {
      const buffer = host.get(bufferId)
      if (buffer.kind !== 'csv' || buffer.size >= CSV_PAGED_BYTES) error(host, 'conflict', 'Copy is available only for small editable CSV tables.')
      const table = smallCsv(buffer)
      const rows = csvCopyRows(host, params, table)
      const text = serializeTsv(rows)
      return { text, rows: rows.length }
    }
    if (action === 'zoom') {
      const buffer = host.get(bufferId)
      const scale = params.scale
      if (typeof scale !== 'number' || !Number.isFinite(scale)) error(host, 'invalid-params', 'scale must be a finite number')
      const minimum = buffer.kind === 'pdf' ? 0.25 : 0.25
      const maximum = buffer.kind === 'pdf' ? 5 : 8
      const zoom = Math.max(minimum, Math.min(maximum, scale))
      const view = await updateViewer(bufferId, { zoom })
      return { zoom, minimum, maximum, view }
    }
    if (action === 'find') {
      const buffer = host.get(bufferId)
      const query = stringParam(host, params.query ?? '', 'query', true)
      if (query.length > MAX_FILTER_LENGTH) error(host, 'invalid-params', 'Viewer search is too long.')
      const view = await updateViewer(bufferId, { query })
      if (buffer.kind !== 'csv' || buffer.size >= CSV_PAGED_BYTES || !query) return { query, matches: [], view }
      const table = smallCsv(buffer)
      const matches: { row: number; column: number }[] = []
      for (let row = 0; row < table.rows.length && matches.length < MAX_FIND_MATCHES; row++) {
        for (let column = 0; column < table.rows[row]!.length && matches.length < MAX_FIND_MATCHES; column++) {
          if (table.rows[row]![column]!.toLocaleLowerCase().includes(query.toLocaleLowerCase())) matches.push({ row, column })
        }
      }
      return { query, matches, truncated: matches.length === MAX_FIND_MATCHES, view }
    }
    if (action === 'position') {
      const patch: Record<string, unknown> = {}
      if (params.page !== undefined) patch.page = integerParam(host, params.page, 'page', 1)
      if (params.offset !== undefined) patch.offset = integerParam(host, params.offset, 'offset')
      if (Object.keys(patch).length === 0) error(host, 'invalid-params', 'position needs page or offset')
      return { position: await updateViewer(bufferId, patch) }
    }
    if (action === 'media') {
      const leaseId = params.leaseId === undefined ? undefined : leaseParam(host, params.leaseId)
      const request: MediaParams = { bufferId, action: 'media', ...(leaseId === undefined ? {} : { leaseId }) }
      const buffer = host.get(bufferId)
      const memory = memoryFor(bufferId)
      if (leaseId === undefined) return createResource(host, buffer, memory, request)
      if (memory.leases.has(leaseId)) error(host, 'invalid-params', 'leaseId is already active')
      const lease: ViewerLease = { active: true }
      memory.leases.set(leaseId, lease)
      try {
        const result = await createResource(host, buffer, memory, request, lease)
        if (memory.closed || !lease.active || memory.leases.get(leaseId) !== lease) {
          if (lease.resource) {
            lease.resource.revoke()
            lease.resource = undefined
          }
          error(host, 'conflict', 'Viewer resource acquisition is no longer active.')
        }
        if (typeof result.url !== 'string') {
          memory.leases.delete(leaseId)
          lease.active = false
        }
        return result
      } catch (cause) {
        if (memory.leases.get(leaseId) === lease) memory.leases.delete(leaseId)
        lease.active = false
        if (lease.resource) {
          lease.resource.revoke()
          lease.resource = undefined
        }
        throw cause
      }
    }
    return undefined
  }

  const handler: MethodHandler = async (params) => {
    if (disposed) error(host, 'conflict', 'Viewer service is disposed.')
    const action = params.action
    if (typeof action !== 'string' || !ACTIONS.has(action as Action)) error(host, 'invalid-params', 'unknown viewer action')
    const bufferId = stringParam(host, params.bufferId, 'bufferId')
    return mutate(bufferId, action as Action, params)
  }

  return {
    methods: { viewer: handler },
    async dispose() {
      if (disposed) return
      disposed = true
      onClose()
      for (const [bufferId, memory] of memories) closeMemory(bufferId, memory)
    }
  }
}
