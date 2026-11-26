import { translate } from '@/i18n/i18n'

type CsvResult = { rows: string[][] } | { error: string }

/** Reads RFC-4180 delimited text: quoted fields may hold the delimiter, newlines and doubled quotes. */
function parseDelimited(source: string, delimiter: string): CsvResult {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let touched = false
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"'
          index += 1
        } else {
          quoted = false
        }
      } else {
        field += char
      }
      continue
    }
    if (char === '"' && field === '') {
      quoted = true
      touched = true
    } else if (char === delimiter) {
      row.push(field)
      field = ''
      touched = true
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[index + 1] === '\n') {
        index += 1
      }
      if (touched || field !== '') {
        row.push(field)
        rows.push(row)
      }
      row = []
      field = ''
      touched = false
    } else {
      field += char
      touched = true
    }
  }
  if (quoted) {
    return {
      error: translate(
        'components.chat.markdown.csvQuoteUnclosed',
        'a quoted field is never closed'
      )
    }
  }
  if (touched || field !== '') {
    row.push(field)
    rows.push(row)
  }
  if (rows.length === 0) {
    return { error: translate('components.chat.markdown.csvNoRows', 'it has no rows') }
  }
  return { rows }
}

export function parseTable(language: string, code: string): CsvResult {
  return parseDelimited(code, language === 'tsv' ? '\t' : ',')
}

/** `x` is set only for a point whose x was given as a number, which a line chart places on a linear scale. */
export type ChartPoint = {
  label: string
  value: number
  x?: number
}
export type ChartSpec = {
  type: 'bar' | 'line'
  title?: string
  unit?: string
  data?: ({ label: string; value: number } | { x: number | string; y: number })[]
  from?: string
  x?: string
  y?: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

/** Validates a `chart` fence body against the documented schema. */
export function parseChartSpec(source: string): ChartSpec | { error: string } {
  let raw: unknown
  try {
    raw = JSON.parse(source)
  } catch (error) {
    return {
      error: translate('components.chat.markdown.chartInvalidJson', 'invalid JSON ({{reason}})', {
        reason: error instanceof Error ? error.message : String(error)
      })
    }
  }
  if (!isRecord(raw)) {
    return {
      error: translate('components.chat.markdown.chartExpectedObject', 'expected a JSON object')
    }
  }
  if (raw.type !== 'bar' && raw.type !== 'line') {
    return {
      error: translate(
        'components.chat.markdown.chartTypeInvalid',
        '"type" must be "bar" or "line"'
      )
    }
  }
  for (const key of ['title', 'unit', 'from', 'x', 'y'] as const) {
    if (raw[key] !== undefined && typeof raw[key] !== 'string') {
      return {
        error: translate(
          'components.chat.markdown.chartKeyNotString',
          '"{{key}}" must be a string',
          {
            key
          }
        )
      }
    }
  }
  const hasData = raw.data !== undefined
  const hasFrom = raw.from !== undefined
  if (hasData === hasFrom) {
    return {
      error: translate(
        'components.chat.markdown.chartDataOrFrom',
        'exactly one of "data" and "from" is required'
      )
    }
  }
  const spec: ChartSpec = { type: raw.type }
  if (typeof raw.title === 'string') {
    spec.title = raw.title
  }
  if (typeof raw.unit === 'string') {
    spec.unit = raw.unit
  }
  if (typeof raw.from === 'string') {
    if (typeof raw.x !== 'string' || typeof raw.y !== 'string') {
      return {
        error: translate(
          'components.chat.markdown.chartFromNeedsColumns',
          '"from" needs "x" and "y" column names'
        )
      }
    }
    spec.from = raw.from
    spec.x = raw.x
    spec.y = raw.y
    return spec
  }
  if (!Array.isArray(raw.data) || raw.data.length === 0) {
    return {
      error: translate(
        'components.chat.markdown.chartDataEmpty',
        '"data" must be a non-empty array'
      )
    }
  }
  const data: NonNullable<ChartSpec['data']> = []
  for (const [index, entry] of raw.data.entries()) {
    if (!isRecord(entry)) {
      return {
        error: translate(
          'components.chat.markdown.chartEntryNotObject',
          'data[{{index}}] must be an object',
          {
            index
          }
        )
      }
    }
    if (raw.type === 'bar') {
      if (typeof entry.label !== 'string' || !isNumber(entry.value)) {
        return {
          error: translate(
            'components.chat.markdown.chartBarEntryInvalid',
            'data[{{index}}] needs a string "label" and a number "value"',
            { index }
          )
        }
      }
      if (entry.value < 0) {
        return {
          error: translate(
            'components.chat.markdown.chartBarNegative',
            'bar values must be zero or more'
          )
        }
      }
      data.push({ label: entry.label, value: entry.value })
    } else {
      if ((typeof entry.x !== 'string' && !isNumber(entry.x)) || !isNumber(entry.y)) {
        return {
          error: translate(
            'components.chat.markdown.chartLineEntryInvalid',
            'data[{{index}}] needs an "x" and a number "y"',
            { index }
          )
        }
      }
      data.push({ x: entry.x, y: entry.y })
    }
  }
  spec.data = data
  return spec
}

export type Resolved = { type: 'bar' | 'line'; title?: string; unit?: string; points: ChartPoint[] }

export function resolveChart(
  spec: ChartSpec,
  sources: Record<string, { language: string; code: string }>
): Resolved | { error: string } {
  const base = { type: spec.type, title: spec.title, unit: spec.unit }
  if (spec.data) {
    return {
      ...base,
      points: spec.data.map((entry) =>
        'label' in entry
          ? { label: entry.label, value: entry.value }
          : {
              label: String(entry.x),
              value: entry.y,
              ...(typeof entry.x === 'number' ? { x: entry.x } : {})
            }
      )
    }
  }
  const { from: name, x: xColumn, y: yColumn } = spec
  if (name === undefined || xColumn === undefined || yColumn === undefined) {
    return {
      error: translate(
        'components.chat.markdown.chartFromNeedsColumns',
        '"from" needs "x" and "y" column names'
      )
    }
  }
  const source = Object.hasOwn(sources, name) ? sources[name] : undefined
  if (!source) {
    return {
      error: translate('components.chat.markdown.chartNoCsvBlock', 'no csv block named {{name}}', {
        name
      })
    }
  }
  const table = parseTable(source.language, source.code)
  if ('error' in table) {
    return { error: `${name}: ${table.error}` }
  }
  const [header, ...rows] = table.rows
  const xIndex = header.indexOf(xColumn)
  const yIndex = header.indexOf(yColumn)
  if (xIndex === -1) {
    return {
      error: translate(
        'components.chat.markdown.chartNoColumnX',
        'no column {{column}} in {{name}}',
        {
          column: xColumn,
          name
        }
      )
    }
  }
  if (yIndex === -1) {
    return {
      error: translate(
        'components.chat.markdown.chartNoColumnY',
        'no column {{column}} in {{name}}',
        {
          column: yColumn,
          name
        }
      )
    }
  }
  const points: ChartPoint[] = []
  for (const row of rows) {
    const cell = (row[yIndex] ?? '').trim()
    const value = Number(cell.replace(/,/g, ''))
    if (cell === '' || !Number.isFinite(value)) {
      return {
        error: translate(
          'components.chat.markdown.chartValueNotNumber',
          '{{column}} has a value that is not a number: {{value}}',
          { column: yColumn, value: cell || 'empty' }
        )
      }
    }
    if (spec.type === 'bar' && value < 0) {
      return {
        error: translate(
          'components.chat.markdown.chartSourceBarNegative',
          'bar values must be zero or more'
        )
      }
    }
    points.push({ label: row[xIndex] ?? '', value })
  }
  if (points.length === 0) {
    return {
      error: translate('components.chat.markdown.chartSourceNoRows', '{{name}} has no rows', {
        name
      })
    }
  }
  return { ...base, points }
}
