import { translate } from '@/i18n/i18n'
import { Fragment, useContext, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { ChartSourcesContext } from '../runtime'
import type { FenceProps } from '../types'
import { BlockFrame, CodeBlock, CopyButton, fenceTitle } from './CodeBlock'
import { RenderError } from './RenderError'
import { parseChartSpec, parseTable, resolveChart } from './chart-data-parsing'
import type { ChartPoint } from './chart-data-parsing'
import { positionKeyed } from '../../position-keyed'

export { parseChartSpec }
export type { ChartPoint, ChartSpec } from './chart-data-parsing'

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
              {positionKeyed(pad(header)).map(({ key, item: cell }) => (
                <th key={key} data-streamdown="table-header-cell">
                  {cell}
                </th>
              ))}
            </tr>
          </thead>
          <tbody data-streamdown="table-body">
            {positionKeyed(body).map(({ key: rowKey, item: row }) => (
              <tr key={rowKey} data-streamdown="table-row">
                {positionKeyed(pad(row)).map(({ key, item: cell }) => (
                  <td key={key} data-streamdown="table-cell">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** Shows the failure note above the fence as an ordinary code block. */
function Unreadable({
  language,
  message,
  code,
  meta
}: {
  language: string
  message: string
  code: string
  meta?: string | undefined
}) {
  return (
    <>
      <RenderError
        message={translate(
          'components.chat.markdown.unreadableBlock',
          "Couldn't read this {{language}} block: {{message}}",
          { language, message }
        )}
      />
      <CodeBlock code={code} language={language} meta={meta} isIncomplete={false} />
    </>
  )
}

/** A `csv` or `tsv` fence drawn as the same zebra table GFM tables get. */
export function TableFence({ code, isIncomplete, language, meta }: FenceProps) {
  const parsed = useMemo(
    () => (isIncomplete ? null : parseTable(language, code)),
    [code, isIncomplete, language]
  )
  if (!parsed) {
    return <CodeBlock code={code} language={language} meta={meta} isIncomplete />
  }
  if ('error' in parsed) {
    return <Unreadable language={language} message={parsed.error} code={code} meta={meta} />
  }
  return <DataTable rows={parsed.rows} />
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

function JsonScalar({ value }: { value: null | boolean | number | string }) {
  const kind = value === null ? 'null' : typeof value
  return <span className={`qmd-json-${kind}`}>{JSON.stringify(value)}</span>
}

function JsonNode({
  name,
  value,
  open,
  last
}: {
  name?: string
  value: Json
  open?: boolean
  last: boolean
}) {
  const key: ReactNode =
    name === undefined ? null : (
      <>
        <span className="qmd-json-key">{JSON.stringify(name)}</span>
        {': '}
      </>
    )
  const comma = last ? '' : ','
  if (value === null || typeof value !== 'object') {
    return (
      <div className="qmd-json-row">
        {key}
        <JsonScalar value={value} />
        {comma}
      </div>
    )
  }
  const isArray = Array.isArray(value)
  const entries: [string | undefined, Json][] = isArray
    ? value.map((item): [string | undefined, Json] => [undefined, item])
    : Object.entries(value)
  if (entries.length === 0) {
    return (
      <div className="qmd-json-row">
        {key}
        <span>{isArray ? '[]' : '{}'}</span>
        {comma}
      </div>
    )
  }
  return (
    <details className="qmd-json-node" open={open}>
      <summary>
        {key}
        {isArray
          ? `[ ${plural(entries.length, 'item', 'items')} ]`
          : `{ ${plural(entries.length, 'key', 'keys')} }`}
      </summary>
      {positionKeyed(entries).map(({ key, item: [childName, child] }, index) => (
        <JsonNode key={key} name={childName} value={child} last={index === entries.length - 1} />
      ))}
    </details>
  )
}

/** A `json` fence as a tree: the top level open, nested objects and arrays folded. */
export function JsonFence({ code, isIncomplete, language, meta }: FenceProps) {
  const parsed = useMemo((): { value: Json } | { error: string } | null => {
    if (isIncomplete) {
      return null
    }
    try {
      const value: Json = JSON.parse(code)
      return { value }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }, [code, isIncomplete])
  if (!parsed) {
    return <CodeBlock code={code} language={language} meta={meta} isIncomplete />
  }
  if ('error' in parsed) {
    return <Unreadable language={language} message={parsed.error} code={code} meta={meta} />
  }
  return (
    <BlockFrame
      label={fenceTitle(meta) ?? 'json'}
      language="json"
      actions={<CopyButton code={code} />}
      state={{ 'data-qmd-data': 'json' }}
    >
      <div className="qmd-json">
        <JsonNode value={parsed.value} open last />
      </div>
    </BlockFrame>
  )
}

const BAR_ROW = 22
const BAR_HEIGHT = 14
const BAR_MAX = 220
const CHAR_WIDTH = 6.4
const HUES = 5
const formatValue = (value: number, unit?: string) =>
  `${Number.isInteger(value) ? value : Number(value.toFixed(2))}${unit ? ` ${unit}` : ''}`

function BarChart({ points, unit }: { points: ChartPoint[]; unit?: string }) {
  const labelWidth =
    Math.ceil(Math.min(160, Math.max(...points.map((point) => point.label.length)) * CHAR_WIDTH)) +
    12
  const valueWidth =
    Math.ceil(
      Math.max(...points.map((point) => formatValue(point.value, unit).length)) * CHAR_WIDTH
    ) + 8
  const max = Math.max(...points.map((point) => point.value), 0) || 1
  const height = points.length * BAR_ROW + 4
  return (
    <svg
      className="qmd-chart"
      width={labelWidth + BAR_MAX + valueWidth}
      height={height}
      role="img"
      aria-label={translate('components.chat.markdown.barChart', 'Bar chart')}
    >
      {points.map((point, index) => {
        const y = index * BAR_ROW + 2
        const width = Math.max(0, point.value / max) * BAR_MAX
        return (
          <g key={index}>
            <text className="qmd-chart-label" x={0} y={y + BAR_HEIGHT - 3}>
              {point.label}
            </text>
            <rect
              className={`qmd-chart-bar qmd-chart-hue-${index % HUES}`}
              x={labelWidth}
              y={y}
              width={width}
              height={BAR_HEIGHT}
              rx={3}
            />
            <text className="qmd-chart-value" x={labelWidth + width + 6} y={y + BAR_HEIGHT - 3}>
              {formatValue(point.value, unit)}
            </text>
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
  const xs = points.map((point) => point.x)
  const numeric = xs.every((x): x is number => x !== undefined)
  const first = numeric ? Math.min(...xs) : 0
  const last = numeric ? Math.max(...xs) : points.length - 1
  const at = (index: number, value: number): [number, number] => {
    const along = numeric ? (points[index]?.x ?? 0) - first : index
    return [
      LINE_LEFT + (last === first ? plotWidth / 2 : (along / (last - first)) * plotWidth),
      LINE_TOP + (1 - (value - low) / (high - low)) * plotHeight
    ]
  }
  const path = points.map((point, index) => at(index, point.value).join(',')).join(' ')
  return (
    <svg
      className="qmd-chart"
      width={LINE_WIDTH}
      height={LINE_HEIGHT}
      role="img"
      aria-label={translate('components.chat.markdown.lineChart', 'Line chart')}
    >
      <line
        className="qmd-chart-axis"
        x1={LINE_LEFT}
        y1={LINE_TOP + plotHeight}
        x2={LINE_WIDTH - LINE_RIGHT}
        y2={LINE_TOP + plotHeight}
      />
      <text className="qmd-chart-value" x={LINE_LEFT - 6} y={LINE_TOP + 4} textAnchor="end">
        {formatValue(high, unit)}
      </text>
      <text
        className="qmd-chart-value"
        x={LINE_LEFT - 6}
        y={LINE_TOP + plotHeight}
        textAnchor="end"
      >
        {formatValue(low)}
      </text>
      <polyline className="qmd-chart-line" points={path} fill="none" />
      {points.map((point, index) => {
        const [x, y] = at(index, point.value)
        return (
          <Fragment key={index}>
            <circle className="qmd-chart-dot" cx={x} cy={y} r={3} />
            <text className="qmd-chart-label" x={x} y={LINE_HEIGHT - 6} textAnchor="middle">
              {point.label}
            </text>
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
    if (isIncomplete) {
      return null
    }
    const spec = parseChartSpec(code)
    return 'error' in spec ? spec : resolveChart(spec, sources)
  }, [code, isIncomplete, sources])
  if (!outcome) {
    return <CodeBlock code={code} language={language} meta={meta} isIncomplete />
  }
  if ('error' in outcome) {
    return <Unreadable language={language} message={outcome.error} code={code} meta={meta} />
  }
  return (
    <BlockFrame
      label={
        outcome.title
          ? translate('components.chat.markdown.chartTitled', 'chart · {{title}}', {
              title: outcome.title
            })
          : 'chart'
      }
      language="chart"
      actions={
        <>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            data-qmd-button=""
            aria-pressed={showSource}
            onClick={() => setShowSource((value) => !value)}
          >
            {showSource
              ? translate('components.chat.markdown.chartToggle', 'Chart')
              : translate('components.chat.markdown.sourceToggle', 'Source')}
          </Button>
          <CopyButton code={code} />
        </>
      }
      state={{ 'data-qmd-data': 'chart' }}
    >
      {showSource ? (
        <pre className="qmd-source">{code}</pre>
      ) : (
        <div className="qmd-figure-body">
          {outcome.type === 'bar' ? (
            <BarChart points={outcome.points} unit={outcome.unit} />
          ) : (
            <LineChart points={outcome.points} unit={outcome.unit} />
          )}
        </div>
      )}
    </BlockFrame>
  )
}
