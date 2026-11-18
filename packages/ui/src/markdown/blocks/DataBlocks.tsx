import { Fragment, useContext, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { ChartSourcesContext } from '../runtime'
import type { FenceProps } from '../types'
import { BlockFrame, CodeBlock, CopyButton, fenceTitle } from './CodeBlock'
import { RenderError } from './RenderError'


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
        } else quoted = false
      } else field += char
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
      if (char === '\r' && source[index + 1] === '\n') index += 1
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
  if (quoted) return { error: 'a quoted field is never closed' }
  if (touched || field !== '') {
    row.push(field)
    rows.push(row)
  }
  if (rows.length === 0) return { error: 'it has no rows' }
  return { rows }
}

function parseTable(language: string, code: string): CsvResult {
  return parseDelimited(code, language === 'tsv' ? '\t' : ',')
}

function DataTable({ rows }: { rows: string[][] }) {
  const [header, ...body] = rows
  const width = Math.max(...rows.map((row) => row.length))
  const pad = (row: string[]) => Array.from({ length: width }, (_, index) => row[index] ?? '')
  return (
    <div className="qmd-table-wrapper" data-streamdown="table-wrapper" data-qmd-data="table">
      <div className="qmd-table-scroll">
        <table data-streamdown="table">
          <thead data-streamdown="table-header">
            <tr data-streamdown="table-row">
              {pad(header).map((cell, index) => <th key={index} data-streamdown="table-header-cell">{cell}</th>)}
            </tr>
          </thead>
          <tbody data-streamdown="table-body">
            {body.map((row, rowIndex) => (
              <tr key={rowIndex} data-streamdown="table-row">
                {pad(row).map((cell, index) => <td key={index} data-streamdown="table-cell">{cell}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** Shows the failure note above the fence as an ordinary code block. */
function Unreadable({ language, message, code, meta }: { language: string; message: string; code: string; meta?: string | undefined }) {
  return (
    <>
      <RenderError message={`Couldn't read this ${language} block: ${message}`} />
      <CodeBlock code={code} language={language} meta={meta} isIncomplete={false} />
    </>
  )
}

/** A `csv` or `tsv` fence drawn as the same zebra table GFM tables get. */
export function TableFence({ code, isIncomplete, language, meta }: FenceProps) {
  const parsed = useMemo(() => (isIncomplete ? null : parseTable(language, code)), [code, isIncomplete, language])
  if (!parsed) return <CodeBlock code={code} language={language} meta={meta} isIncomplete />
  if ('error' in parsed) return <Unreadable language={language} message={parsed.error} code={code} meta={meta} />
  return <DataTable rows={parsed.rows} />
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

function JsonScalar({ value }: { value: null | boolean | number | string }) {
  const kind = value === null ? 'null' : typeof value
  return <span className={`qmd-json-${kind}`}>{JSON.stringify(value)}</span>
}

function JsonNode({ name, value, open, last }: { name?: string; value: Json; open?: boolean; last: boolean }) {
  const key: ReactNode = name === undefined ? null : <><span className="qmd-json-key">{JSON.stringify(name)}</span>{': '}</>
  const comma = last ? '' : ','
  const isArray = Array.isArray(value)
  const entries: Array<[string | undefined, Json]> | null =
    value !== null && typeof value === 'object'
      ? isArray ? value.map((item): [string | undefined, Json] => [undefined, item]) : Object.entries(value)
      : null
  if (entries === null || entries.length === 0) {
    return (
      <div className="qmd-json-row">
        {key}
        {entries === null ? <JsonScalar value={value as null | boolean | number | string} /> : <span>{isArray ? '[]' : '{}'}</span>}
        {comma}
      </div>
    )
  }
  return (
    <details className="qmd-json-node" open={open}>
      <summary>
        {key}
        {isArray ? `[ ${plural(entries.length, 'item', 'items')} ]` : `{ ${plural(entries.length, 'key', 'keys')} }`}
      </summary>
      {entries.map(([childName, child], index) => (
        <JsonNode key={index} name={childName} value={child} last={index === entries.length - 1} />
      ))}
    </details>
  )
}

/** A `json` fence as a tree: the top level open, nested objects and arrays folded. */
export function JsonFence({ code, isIncomplete, language, meta }: FenceProps) {
  const parsed = useMemo((): { value: Json } | { error: string } | null => {
    if (isIncomplete) return null
    try {
      return { value: JSON.parse(code) as Json }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }, [code, isIncomplete])
  if (!parsed) return <CodeBlock code={code} language={language} meta={meta} isIncomplete />
  if ('error' in parsed) return <Unreadable language={language} message={parsed.error} code={code} meta={meta} />
  return (
    <BlockFrame label={fenceTitle(meta) ?? 'json'} language="json" actions={<CopyButton code={code} />} state={{ 'data-qmd-data': 'json' }}>
      <div className="qmd-json">
        <JsonNode value={parsed.value} open last />
      </div>
    </BlockFrame>
  )
}

export interface ChartPoint { label: string; value: number }
export interface ChartSpec {
  type: 'bar' | 'line'
  title?: string
  unit?: string
  data?: Array<{ label: string; value: number } | { x: number | string; y: number }>
  from?: string
  x?: string
  y?: string
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/** Validates a `chart` fence body against the documented schema. */
export function parseChartSpec(source: string): ChartSpec | { error: string } {
  let raw: unknown
  try {
    raw = JSON.parse(source)
  } catch (error) {
    return { error: `invalid JSON (${error instanceof Error ? error.message : String(error)})` }
  }
  if (!isRecord(raw)) return { error: 'expected a JSON object' }
  if (raw.type !== 'bar' && raw.type !== 'line') return { error: '"type" must be "bar" or "line"' }
  for (const key of ['title', 'unit', 'from', 'x', 'y'] as const) {
    if (raw[key] !== undefined && typeof raw[key] !== 'string') return { error: `"${key}" must be a string` }
  }
  const hasData = raw.data !== undefined
  const hasFrom = raw.from !== undefined
  if (hasData === hasFrom) return { error: 'exactly one of "data" and "from" is required' }
  const spec: ChartSpec = { type: raw.type }
  if (typeof raw.title === 'string') spec.title = raw.title
  if (typeof raw.unit === 'string') spec.unit = raw.unit
  if (hasFrom) {
    if (typeof raw.x !== 'string' || typeof raw.y !== 'string') return { error: '"from" needs "x" and "y" column names' }
    spec.from = raw.from as string
    spec.x = raw.x
    spec.y = raw.y
    return spec
  }
  if (!Array.isArray(raw.data) || raw.data.length === 0) return { error: '"data" must be a non-empty array' }
  const data: NonNullable<ChartSpec['data']> = []
  for (const [index, entry] of raw.data.entries()) {
    if (!isRecord(entry)) return { error: `data[${index}] must be an object` }
    if (raw.type === 'bar') {
      if (typeof entry.label !== 'string' || !isNumber(entry.value)) return { error: `data[${index}] needs a string "label" and a number "value"` }
      if (entry.value < 0) return { error: 'bar values must be zero or more' }
      data.push({ label: entry.label, value: entry.value })
    } else {
      if ((typeof entry.x !== 'string' && !isNumber(entry.x)) || !isNumber(entry.y)) return { error: `data[${index}] needs an "x" and a number "y"` }
      data.push({ x: entry.x, y: entry.y })
    }
  }
  spec.data = data
  return spec
}

type Resolved = { type: 'bar' | 'line'; title?: string; unit?: string; points: ChartPoint[] }

function resolveChart(spec: ChartSpec, sources: Record<string, { language: string; code: string }>): Resolved | { error: string } {
  const base = { type: spec.type, title: spec.title, unit: spec.unit }
  if (spec.data) {
    return {
      ...base,
      points: spec.data.map((entry) => (
        'label' in entry ? { label: entry.label, value: entry.value } : { label: String(entry.x), value: entry.y }
      ))
    }
  }
  const name = spec.from as string
  const source = Object.hasOwn(sources, name) ? sources[name] : undefined
  if (!source) return { error: `no csv block named ${name}` }
  const table = parseTable(source.language, source.code)
  if ('error' in table) return { error: `${name}: ${table.error}` }
  const [header, ...rows] = table.rows
  const xIndex = header.indexOf(spec.x as string)
  const yIndex = header.indexOf(spec.y as string)
  if (xIndex < 0) return { error: `no column ${spec.x} in ${name}` }
  if (yIndex < 0) return { error: `no column ${spec.y} in ${name}` }
  const points: ChartPoint[] = []
  for (const row of rows) {
    const cell = (row[yIndex] ?? '').trim()
    const value = Number(cell.replace(/,/g, ''))
    if (cell === '' || !Number.isFinite(value)) return { error: `${spec.y} has a value that is not a number: ${cell || 'empty'}` }
    if (spec.type === 'bar' && value < 0) return { error: 'bar values must be zero or more' }
    points.push({ label: row[xIndex] ?? '', value })
  }
  if (points.length === 0) return { error: `${name} has no rows` }
  return { ...base, points }
}

const BAR_ROW = 22
const BAR_HEIGHT = 14
const BAR_MAX = 220
const CHAR_WIDTH = 6.4
const HUES = 5
const formatValue = (value: number, unit?: string) => `${Number.isInteger(value) ? value : Number(value.toFixed(2))}${unit ? ` ${unit}` : ''}`

function BarChart({ points, unit }: { points: ChartPoint[]; unit?: string }) {
  const labelWidth = Math.ceil(Math.min(160, Math.max(...points.map((point) => point.label.length)) * CHAR_WIDTH)) + 12
  const valueWidth = Math.ceil(Math.max(...points.map((point) => formatValue(point.value, unit).length)) * CHAR_WIDTH) + 8
  const max = Math.max(...points.map((point) => point.value), 0) || 1
  const height = points.length * BAR_ROW + 4
  return (
    <svg className="qmd-chart" width={labelWidth + BAR_MAX + valueWidth} height={height} role="img" aria-label="Bar chart">
      {points.map((point, index) => {
        const y = index * BAR_ROW + 2
        const width = Math.max(0, point.value / max) * BAR_MAX
        return (
          <g key={index}>
            <text className="qmd-chart-label" x={0} y={y + BAR_HEIGHT - 3}>{point.label}</text>
            <rect className={`qmd-chart-bar qmd-chart-hue-${index % HUES}`} x={labelWidth} y={y} width={width} height={BAR_HEIGHT} rx={3} />
            <text className="qmd-chart-value" x={labelWidth + width + 6} y={y + BAR_HEIGHT - 3}>{formatValue(point.value, unit)}</text>
          </g>
        )
      })}
    </svg>
  )
}

const LINE_WIDTH = 380
const LINE_HEIGHT = 140
const LINE_LEFT = 44
const LINE_BOTTOM = 22
const LINE_TOP = 10
const LINE_RIGHT = 12

function LineChart({ points, unit }: { points: ChartPoint[]; unit?: string }) {
  const values = points.map((point) => point.value)
  const low = Math.min(...values, 0)
  const high = Math.max(...values) === low ? low + 1 : Math.max(...values)
  const plotWidth = LINE_WIDTH - LINE_LEFT - LINE_RIGHT
  const plotHeight = LINE_HEIGHT - LINE_TOP - LINE_BOTTOM
  const at = (index: number, value: number): [number, number] => [
    LINE_LEFT + (points.length === 1 ? plotWidth / 2 : (index / (points.length - 1)) * plotWidth),
    LINE_TOP + (1 - (value - low) / (high - low)) * plotHeight
  ]
  const path = points.map((point, index) => at(index, point.value).join(',')).join(' ')
  return (
    <svg className="qmd-chart" width={LINE_WIDTH} height={LINE_HEIGHT} role="img" aria-label="Line chart">
      <line className="qmd-chart-axis" x1={LINE_LEFT} y1={LINE_TOP + plotHeight} x2={LINE_WIDTH - LINE_RIGHT} y2={LINE_TOP + plotHeight} />
      <text className="qmd-chart-value" x={LINE_LEFT - 6} y={LINE_TOP + 4} textAnchor="end">{formatValue(high, unit)}</text>
      <text className="qmd-chart-value" x={LINE_LEFT - 6} y={LINE_TOP + plotHeight} textAnchor="end">{formatValue(low)}</text>
      <polyline className="qmd-chart-line" points={path} fill="none" />
      {points.map((point, index) => {
        const [x, y] = at(index, point.value)
        return (
          <Fragment key={index}>
            <circle className="qmd-chart-dot" cx={x} cy={y} r={3} />
            <text className="qmd-chart-label" x={x} y={LINE_HEIGHT - 6} textAnchor="middle">{point.label}</text>
          </Fragment>
        )
      })}
    </svg>
  )
}

/** A `chart` fence drawn as bars or a line from inline data or from a named csv/tsv fence, with a Source toggle. */
export function ChartFence({ code, isIncomplete, language, meta }: FenceProps) {
  const sources = useContext(ChartSourcesContext)
  const [showSource, setShowSource] = useState(false)
  const outcome = useMemo(() => {
    if (isIncomplete) return null
    const spec = parseChartSpec(code)
    return 'error' in spec ? spec : resolveChart(spec, sources)
  }, [code, isIncomplete, sources])
  if (!outcome) return <CodeBlock code={code} language={language} meta={meta} isIncomplete />
  if ('error' in outcome) return <Unreadable language={language} message={outcome.error} code={code} meta={meta} />
  return (
    <BlockFrame
      label={outcome.title ? `chart · ${outcome.title}` : 'chart'}
      language="chart"
      actions={(
        <>
          <button type="button" className="qmd-code-button" aria-pressed={showSource} onClick={() => setShowSource((value) => !value)}>
            {showSource ? 'Chart' : 'Source'}
          </button>
          <CopyButton code={code} />
        </>
      )}
      state={{ 'data-qmd-data': 'chart' }}
    >
      {showSource ? (
        <pre className="qmd-source">{code}</pre>
      ) : (
        <div className="qmd-figure-body">{outcome.type === 'bar' ? <BarChart points={outcome.points} unit={outcome.unit} /> : <LineChart points={outcome.points} unit={outcome.unit} />}</div>
      )}
    </BlockFrame>
  )
}
