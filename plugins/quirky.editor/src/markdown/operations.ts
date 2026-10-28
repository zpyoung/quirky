export type MarkdownFormat =
  | 'body' | 'heading1' | 'heading2' | 'heading3' | 'heading4' | 'heading5'
  | 'bold' | 'italic' | 'strike' | 'inlineCode' | 'bulletList' | 'orderedList' | 'taskList'
  | 'quote' | 'link' | 'image' | 'codeBlock' | 'divider' | 'table' | 'details'
  | 'collapsibleHeading' | 'mermaid' | 'inlineMath' | 'blockMath' | 'emoji' | 'documentLink'
  | 'tableRowAbove' | 'tableRowBelow' | 'tableRowDelete' | 'tableColumnLeft' | 'tableColumnRight' | 'tableColumnDelete' | 'tableDelete'
  | 'codeLanguage' | 'indentCode' | 'outdentCode' | 'copyCode'

export type MarkdownSelection = { from: number; to: number }

type InsertInput = { format: MarkdownFormat; text?: string; target?: string; language?: string; selection?: MarkdownSelection }
type FormatOptions = { target?: string; language?: string; text?: string }
type TableRegion = { lines: string[]; firstLine: number; endLine: number; selectedLine: number; selectedColumn: number }

const INLINE_WRAPPERS: Partial<Record<MarkdownFormat, [string, string]>> = {
  bold: ['**', '**'],
  italic: ['*', '*'],
  strike: ['~~', '~~'],
  inlineCode: ['`', '`']
}
const TABLE_ACTIONS = new Set<MarkdownFormat>([
  'tableRowAbove', 'tableRowBelow', 'tableRowDelete', 'tableColumnLeft', 'tableColumnRight', 'tableColumnDelete', 'tableDelete'
])
const CODE_ACTIONS = new Set<MarkdownFormat>(['codeLanguage', 'indentCode', 'outdentCode'])

function selectionRange(source: string, selection?: MarkdownSelection): MarkdownSelection {
  if (selection === undefined) return { from: source.length, to: source.length }
  if (!Number.isInteger(selection.from) || !Number.isInteger(selection.to) || selection.from < 0 || selection.to < selection.from || selection.to > source.length) {
    throw new RangeError('Markdown selection is outside the current document.')
  }
  return selection
}

function escapeLinkTarget(target: string): string {
  return `<${target.replace(/[<>\r\n]/g, (char) => encodeURIComponent(char))}>`
}

export function isSafeMarkdownLink(target: string): boolean {
  const value = target.trim()
  if (value === '' || value.startsWith('//')) return false
  if (value.startsWith('#')) return true
  if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) return !value.startsWith('/') && !value.includes('\\')
  return /^(?:https?:|mailto:|tel:)/i.test(value)
}

function escapeHtmlText(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character]!)
}

function extensionlessDocumentTarget(target: string): string {
  const anchor = target.indexOf('#')
  const path = anchor < 0 ? target : target.slice(0, anchor)
  const suffix = anchor < 0 ? '' : target.slice(anchor)
  return `${path.replace(/\.(?:md|markdown|mdx)$/i, '')}${suffix}`
}

function blockText(format: MarkdownFormat, text: string, input: InsertInput): string {
  if (/^heading[1-5]$/.test(format)) {
    const level = Number(format.at(-1))
    return `${'#'.repeat(level)} ${text || `Heading ${level}`}`
  }
  if (format === 'body') return text || 'Text'
  if (format === 'bulletList') return text.split('\n').map((line) => `- ${line}`).join('\n')
  if (format === 'orderedList') return text.split('\n').map((line, index) => `${index + 1}. ${line}`).join('\n')
  if (format === 'taskList') return text.split('\n').map((line) => `- [ ] ${line}`).join('\n')
  if (format === 'quote') return text.split('\n').map((line) => `> ${line}`).join('\n')
  if (format === 'codeBlock') {
    const language = input.language ?? input.target ?? ''
    if (!/^[a-zA-Z0-9_+-]{0,32}$/.test(language)) throw new TypeError('Code language must contain only letters, digits, underscore, plus or hyphen.')
    const body = text.replace(/\n+$/, '')
    return `\`\`\`${language}\n${body || 'code'}\n\`\`\``
  }
  if (format === 'divider') return '---'
  if (format === 'table') return '| Column 1 | Column 2 | Column 3 |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |'
  if (format === 'details' || format === 'collapsibleHeading') {
    const headingLevel = format === 'collapsibleHeading'
      ? /^heading([1-5])$/.exec(input.language ?? '')?.[1]
      : undefined
    if (format === 'collapsibleHeading' && headingLevel === undefined) {
      throw new TypeError('collapsibleHeading language must be heading1 through heading5.')
    }
    const summary = input.text ?? (format === 'collapsibleHeading' ? 'Collapsible heading' : 'Toggle Text')
    const summaryText = escapeHtmlText(summary)
    const summaryMarkup = headingLevel === undefined
      ? summaryText
      : `<h${headingLevel}>${summaryText}</h${headingLevel}>`
    const safeBody = escapeHtmlText(text || 'Content')
    return `<details><summary>${summaryMarkup}</summary>\n\n${safeBody}\n\n</details>`
  }
  if (format === 'mermaid') return `\`\`\`mermaid\ngraph TD\n  A[Start] --> B[End]\n\`\`\``
  if (format === 'inlineMath') return `$${text || 'x^2'}$`
  if (format === 'blockMath') return `$$\n${text || 'x^2'}\n$$`
  if (format === 'emoji') return text || '🙂'
  if (format === 'documentLink') {
    const target = typeof input.target === 'string' ? extensionlessDocumentTarget(input.target.trim()) : ''
    if (target === '' || /[\r\n\[\]|]/.test(target)) throw new TypeError('Document links need a non-empty target without brackets or newlines.')
    const label = text
    if (/[\r\n\[\]|]/.test(label)) throw new TypeError('Document-link labels cannot contain brackets, pipes or newlines.')
    const labelSuffix = label === '' ? '' : `|${label}`
    return `[[${target}${labelSuffix}]]`
  }
  if (format === 'link') {
    const target = input.target?.trim()
    if (!target || !isSafeMarkdownLink(target)) throw new TypeError('Link target must use https, http, mailto, tel, a document path or an anchor.')
    return `[${text || target}](${escapeLinkTarget(target)})`
  }
  if (format === 'image') {
    const target = input.target?.trim()
    if (!target || !isSafeMarkdownLink(target)) throw new TypeError('Image target must be an authorized relative path or a safe https URL.')
    return `![${text}](${escapeLinkTarget(target)})`
  }
  const wrapper = INLINE_WRAPPERS[format]
  if (wrapper) return `${wrapper[0]}${text || (format === 'inlineCode' ? 'code' : 'text')}${wrapper[1]}`
  throw new TypeError(`Unsupported Markdown format ${format}.`)
}

function replaceBlockSelection(source: string, selection: MarkdownSelection, transform: (lines: string[]) => string[]): string {
  const fromLine = source.lastIndexOf('\n', Math.max(0, selection.from - 1)) + 1
  const endAt = source.indexOf('\n', selection.to)
  const toLine = endAt === -1 ? source.length : endAt
  const selected = source.slice(fromLine, toLine)
  return source.slice(0, fromLine) + transform(selected.split('\n')).join('\n') + source.slice(toLine)
}

function splitTableCells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  const cells: string[] = []
  let cell = ''
  let escaped = false
  for (const character of trimmed) {
    if (character === '|' && !escaped) {
      cells.push(cell.trim())
      cell = ''
      continue
    }
    cell += character
    escaped = character === '\\' && !escaped
    if (character !== '\\') escaped = false
  }
  cells.push(cell.trim())
  return cells
}

function isTableRow(line: string): boolean {
  return /^\s*\|.*\|\s*$/.test(line)
}

function isTableDivider(line: string): boolean {
  const cells = splitTableCells(line)
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell))
}

function tableRegion(source: string, selection: MarkdownSelection): TableRegion {
  const lines = source.split('\n')
  let selectedLine = source.slice(0, selection.from).split('\n').length - 1
  if (selectedLine >= lines.length) selectedLine = lines.length - 1
  if (selectedLine < 0 || !isTableRow(lines[selectedLine] ?? '')) throw new RangeError('Table action needs a selection inside a Markdown table.')
  let firstLine = selectedLine
  let endLine = selectedLine + 1
  while (firstLine > 0 && isTableRow(lines[firstLine - 1] ?? '')) firstLine -= 1
  while (endLine < lines.length && isTableRow(lines[endLine] ?? '')) endLine += 1
  const regionLines = lines.slice(firstLine, endLine)
  if (regionLines.length < 2 || !isTableDivider(regionLines[1] ?? '')) throw new RangeError('Selected Markdown table has no valid header divider.')
  const selectedColumn = Math.max(0, Math.min(splitTableCells(lines[selectedLine] ?? '').length - 1, splitTableCells((lines[selectedLine] ?? '').slice(0, Math.max(0, selection.from - source.lastIndexOf('\n', selection.from - 1) - 1))).length - 1))
  return { lines: regionLines, firstLine, endLine, selectedLine: selectedLine - firstLine, selectedColumn }
}

function renderTableRow(cells: string[]): string {
  return `| ${cells.join(' | ')} |`
}

function tableOperation(source: string, selection: MarkdownSelection, format: MarkdownFormat): string {
  const region = tableRegion(source, selection)
  const rows = region.lines.map(splitTableCells)
  const columnCount = rows[0]!.length
  const selectedRow = region.selectedLine
  if (format === 'tableDelete') {
    const lines = source.split('\n')
    const starts = [0]
    for (let i = 0; i < source.length; i += 1) if (source.charCodeAt(i) === 10) starts.push(i + 1)
    const from = starts[region.firstLine] ?? source.length
    const to = region.endLine < starts.length ? starts[region.endLine]! : source.length
    return source.slice(0, from) + source.slice(to)
  }
  if (format === 'tableRowAbove' || format === 'tableRowBelow' || format === 'tableRowDelete') {
    if (format === 'tableRowDelete' && selectedRow < 2) throw new RangeError('The Markdown table header row cannot be deleted.')
    if (format === 'tableRowAbove' && selectedRow < 2) throw new RangeError('Insert a row below the table header instead.')
    if (format === 'tableRowDelete') rows.splice(selectedRow, 1)
    else {
      const insertion = format === 'tableRowAbove' ? selectedRow : Math.max(selectedRow + 1, 2)
      rows.splice(insertion, 0, Array.from({ length: columnCount }, () => ''))
    }
  } else if (format === 'tableColumnLeft' || format === 'tableColumnRight' || format === 'tableColumnDelete') {
    if (format === 'tableColumnDelete' && columnCount <= 1) throw new RangeError('A Markdown table must retain at least one column.')
    const insertion = format === 'tableColumnLeft' ? region.selectedColumn : region.selectedColumn + 1
    for (let row = 0; row < rows.length; row += 1) {
      if (format === 'tableColumnDelete') rows[row]!.splice(region.selectedColumn, 1)
      else rows[row]!.splice(insertion, 0, row === 1 ? '---' : '')
    }
  } else {
    throw new TypeError(`Unsupported table operation ${format}.`)
  }
  const allLines = source.split('\n')
  allLines.splice(region.firstLine, region.endLine - region.firstLine, ...rows.map(renderTableRow))
  return allLines.join('\n')
}

function codeBlockLanguage(source: string, selection: MarkdownSelection, language: string): string {
  if (!/^[a-zA-Z0-9_+-]{0,32}$/.test(language)) throw new TypeError('Code language must contain only letters, digits, underscore, plus or hyphen.')
  const lines = source.split('\n')
  const selectedLine = source.slice(0, selection.from).split('\n').length - 1
  let openLine = -1
  let fence = ''
  for (let index = selectedLine; index >= 0; index -= 1) {
    const opener = /^ {0,3}(`{3,}|~{3,})[^\r\n]*$/.exec(lines[index] ?? '')
    if (opener) {
      openLine = index
      fence = opener[1]!
      break
    }
  }
  if (openLine < 0) throw new RangeError('Code language can be set only inside a fenced code block.')
  let closeLine = -1
  for (let index = selectedLine; index < lines.length; index += 1) {
    if (index === openLine) continue
    if (new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`).test(lines[index] ?? '')) {
      closeLine = index
      break
    }
  }
  if (closeLine < 0) throw new RangeError('Code block has no closing fence.')
  if (selectedLine <= openLine || selectedLine >= closeLine) throw new RangeError('Select inside the code block before changing its language.')
  const opener = lines[openLine] ?? ''
  const indentation = /^\s*/.exec(opener)?.[0] ?? ''
  const marker = fence[0].repeat(fence.length)
  lines[openLine] = `${indentation}${marker}${language}`
  return lines.join('\n')
}

function codeSelection(source: string, selection: MarkdownSelection, indent: boolean): string {
  const lineStart = source.lastIndexOf('\n', Math.max(0, selection.from - 1)) + 1
  const endAt = source.indexOf('\n', selection.to)
  const lineEnd = endAt < 0 ? source.length : endAt
  const selected = source.slice(lineStart, lineEnd)
  const lines = selected.split('\n').map((line) => indent ? `  ${line}` : line.replace(/^(?: {1,2}|\t)/, ''))
  return source.slice(0, lineStart) + lines.join('\n') + source.slice(lineEnd)
}

export function extractSelectedCode(source: string, selection?: MarkdownSelection): string {
  const range = selectionRange(source, selection)
  const lineStart = source.lastIndexOf('\n', Math.max(0, range.from - 1)) + 1
  const openAt = source.lastIndexOf('```', range.from)
  const openEnd = openAt < 0 ? -1 : source.indexOf('\n', openAt)
  const closeAt = source.indexOf('\n```', range.to)
  if (openAt < lineStart && openEnd >= 0 && closeAt >= 0) return source.slice(openEnd + 1, closeAt)
  return source.slice(range.from, range.to)
}

export function formatMarkdownSelection(
  source: string,
  format: MarkdownFormat,
  selection?: MarkdownSelection,
  options: FormatOptions = {}
): string {
  const range = selectionRange(source, selection)
  if (TABLE_ACTIONS.has(format)) return tableOperation(source, range, format)
  if (format === 'codeLanguage') return codeBlockLanguage(source, range, options.language ?? options.target ?? '')
  if (format === 'indentCode') return codeSelection(source, range, true)
  if (format === 'outdentCode') return codeSelection(source, range, false)
  if (format === 'copyCode') return source
  const inline = INLINE_WRAPPERS[format]
  if (inline) {
    const selected = source.slice(range.from, range.to)
    if (selected === '') throw new TypeError(`${format} formatting requires a non-empty selection.`)
    return source.slice(0, range.from) + inline[0] + selected + inline[1] + source.slice(range.to)
  }
  if (format === 'link' || format === 'image' || format === 'documentLink') {
    const selected = source.slice(range.from, range.to)
    return source.slice(0, range.from) + blockText(format, selected, { format, text: selected, target: options.target }) + source.slice(range.to)
  }
  if (format === 'body') {
    return replaceBlockSelection(source, range, (lines) => lines.map((line) => line.replace(/^ {0,3}#{1,5}\s+/, '').replace(/^>\s?/, '').replace(/^(?:[-+*]|\d+[.)])\s+/, '')))
  }
  if (/^heading[1-5]$/.test(format) || ['bulletList', 'orderedList', 'taskList', 'quote'].includes(format)) {
    return replaceBlockSelection(source, range, (lines) => {
      const plain = lines.map((line) => line.replace(/^ {0,3}#{1,5}\s+/, '').replace(/^>\s?/, '').replace(/^(?:[-+*]|\d+[.)])\s+/, ''))
      return plain.map((line) => blockText(format, line, { format, target: options.target, language: options.language, text: options.text }))
    })
  }
  if (format === 'codeBlock' || format === 'divider' || format === 'table' || format === 'details' || format === 'collapsibleHeading' || format === 'mermaid' || format === 'inlineMath' || format === 'blockMath' || format === 'emoji') {
    const selected = source.slice(range.from, range.to)
    const formatted = blockText(format, selected, { format, target: options.target, language: options.language, text: options.text })
    return source.slice(0, range.from) + formatted + source.slice(range.to)
  }
  throw new TypeError(`Unsupported Markdown format ${format}.`)
}

export function insertMarkdown(source: string, input: InsertInput): string {
  const range = selectionRange(source, input.selection)
  const selected = source.slice(range.from, range.to)
  const value = blockText(input.format, input.text ?? selected, input)
  const prefix = source.slice(0, range.from)
  const suffix = source.slice(range.to)
  const block = ['body', 'heading1', 'heading2', 'heading3', 'heading4', 'heading5', 'bulletList', 'orderedList', 'taskList', 'quote', 'codeBlock', 'divider', 'table', 'details', 'collapsibleHeading', 'mermaid', 'blockMath'].includes(input.format)
  const before = block && prefix !== '' && !/\n\n$/.test(prefix) ? `${prefix.replace(/\n*$/, '')}\n\n` : prefix
  const after = block && suffix !== '' && !/^\n\n/.test(suffix) ? `\n\n${suffix.replace(/^\n*/, '')}` : suffix
  return before + value + after
}
