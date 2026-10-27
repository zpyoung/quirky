import { randomUUID } from 'node:crypto'

export type JsonObject = Record<string, unknown>
export type NotebookCellType = 'code' | 'markdown' | 'raw'
export type NotebookCell = JsonObject & {
  cell_type: NotebookCellType
  metadata: JsonObject
  source: string[]
  id?: string
  outputs?: JsonObject[]
  execution_count?: number | null
}
export type NotebookDocument = JsonObject & {
  cells: NotebookCell[]
  metadata: JsonObject
  nbformat: number
  nbformat_minor: number
}
export type NotebookCellView = Omit<NotebookCell, 'source'> & { source: string }
export type NotebookParse = {
  valid: boolean
  rawSource: string
  error: string | null
  cellCount: number
  language: string
  cells: NotebookCellView[]
  document?: NotebookDocument
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function invalid(message: string): never {
  throw new Error(message)
}

export function sourceText(source: unknown): string {
  if (typeof source === 'string') return source
  if (Array.isArray(source) && source.every((part) => typeof part === 'string')) return source.join('')
  return invalid('cell source must be a string or an array of strings')
}

/** Split at complete newline sequences, retaining the original CRLF/LF/CR bytes in each line. */
export function sourceLines(source: string): string[] {
  if (source.length === 0) return []
  return source.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? []
}

function languageFor(metadata: unknown): string {
  if (!isObject(metadata)) return 'python'
  const info = isObject(metadata.language_info) ? metadata.language_info.name : undefined
  const kernelspec = isObject(metadata.kernelspec) ? metadata.kernelspec.language : undefined
  const value = typeof info === 'string' && info.trim() ? info : typeof kernelspec === 'string' && kernelspec.trim() ? kernelspec : 'python'
  return value.toLowerCase()
}

export function parseNotebookRoot(text: string): NotebookDocument {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return invalid(`notebook JSON is malformed: ${detail}`)
  }
  if (!isObject(parsed)) return invalid('notebook JSON root must be an object')
  if (!Array.isArray(parsed.cells)) return invalid('notebook JSON must contain a cells array')
  if (!isObject(parsed.metadata)) return invalid('notebook metadata must be an object')
  const cells: NotebookCell[] = parsed.cells.map((value, index) => {
    if (!isObject(value)) return invalid(`cell ${index + 1} must be an object`)
    const type = value.cell_type
    if (type !== 'code' && type !== 'markdown' && type !== 'raw') return invalid(`cell ${index + 1} has unsupported type ${String(type)}`)
    if (!isObject(value.metadata)) return invalid(`cell ${index + 1} metadata must be an object`)
    const source = sourceText(value.source ?? [])
    if (type === 'code') {
      const outputs = value.outputs
      if (outputs !== undefined && !Array.isArray(outputs)) return invalid(`cell ${index + 1} outputs must be an array`)
      if (Array.isArray(outputs) && outputs.some((output) => !isObject(output))) return invalid(`cell ${index + 1} contains an invalid output`)
      if (value.execution_count !== undefined && value.execution_count !== null && typeof value.execution_count !== 'number') {
        return invalid(`cell ${index + 1} execution_count must be a number or null`)
      }
    }
    return { ...value, cell_type: type, metadata: value.metadata, source: sourceLines(source) } as NotebookCell
  })
  const nbformat = typeof parsed.nbformat === 'number' && Number.isInteger(parsed.nbformat) ? parsed.nbformat : 4
  const minor = typeof parsed.nbformat_minor === 'number' && Number.isInteger(parsed.nbformat_minor) ? parsed.nbformat_minor : 0
  return { ...parsed, cells, metadata: parsed.metadata, nbformat, nbformat_minor: minor } as NotebookDocument
}

export function parseNotebook(text: string): NotebookParse {
  try {
    const document = parseNotebookRoot(text)
    return {
      valid: true,
      rawSource: text,
      error: null,
      cellCount: document.cells.length,
      language: languageFor(document.metadata),
      cells: document.cells.map((cell) => ({ ...cell, source: cell.source.join('') })),
      document
    }
  } catch (error) {
    return {
      valid: false,
      rawSource: text,
      error: `Unable to render notebook: ${error instanceof Error ? error.message : String(error)}`,
      cellCount: 0,
      language: 'python',
      cells: []
    }
  }
}

export function notebookLanguage(document: NotebookDocument): string {
  return languageFor(document.metadata)
}

export function serializeNotebook(document: NotebookDocument): string {
  return `${JSON.stringify(document, null, 1)}\n`
}

export function makeCell(type: NotebookCellType, language = 'python'): NotebookCell {
  const cell: NotebookCell = {
    cell_type: type,
    id: randomUUID(),
    metadata: {},
    source: []
  }
  if (type === 'code') {
    cell.execution_count = null
    cell.outputs = []
    cell.metadata.vscode = { languageId: language }
  }
  return cell
}

export function ensureExecutableCells(document: NotebookDocument): void {
  for (const cell of document.cells) {
    if (!cell.id) cell.id = randomUUID()
  }
  if (document.nbformat < 4) document.nbformat = 4
  if (document.nbformat_minor < 5) document.nbformat_minor = 5
}
