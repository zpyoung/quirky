import type { CSSProperties, ReactNode } from 'react'
import { asItems, asNumber, asString, oneOf, type Props } from './props'
import { clampLabel, keyPart, pointKey } from './point'
import { COLUMN, MONO, MUTED, PANEL, ROW, TONE_COLOR, type Tone } from './styles'
import { MIN_TRACK, ScrollX } from './layout'
import { when } from './when'

const TONES = ['neutral', 'good', 'warn', 'bad'] as const
const STATUSES = ['added', 'modified', 'deleted', 'renamed', 'touched'] as const
const SHAPES = ['box', 'ellipse', 'line', 'arrow', 'text'] as const

const BLOCK: CSSProperties = {
  ...MONO,
  margin: 0,
  padding: 'var(--ui-space-8)',
  overflow: 'auto',
  background: 'var(--ui-selected)',
  borderRadius: 'var(--ui-radius-control)'
}

const FIGURE: CSSProperties = { margin: 0, display: 'flex', flexDirection: 'column', gap: 'var(--ui-space-4)', minWidth: 0 }

/** The fill a tone gives a bar or card edge; neutral reads as the accent so an unmarked item still stands out. */
const toneColor = (tone: Tone): string => (tone === 'neutral' ? 'var(--ui-accent)' : TONE_COLOR[tone])

const itemKey = (id: string, index: number): string => pointKey('item', keyPart(id, String(index)))

const parseDate = (text: string): number | undefined => {
  const time = Date.parse(text)
  return Number.isNaN(time) ? undefined : time
}

export function Timeline({ props }: { props: Props }) {
  const items = asItems(props.items).map((item, index) => {
    const start = asString(item.start)
    const end = asString(item.end)
    return { key: itemKey(asString(item.id), index), label: asString(item.label), start, end, from: parseDate(start), to: parseDate(end) ?? parseDate(start), tone: oneOf(item.tone, TONES, 'neutral') }
  })
  const times = items.flatMap((item) => [item.from, item.to]).filter((time): time is number => time !== undefined)
  const first = Math.min(...times)
  const last = Math.max(...times)
  const span = last - first
  const at = (time: number | undefined): number => (time === undefined || span <= 0 ? 0 : ((time - first) / span) * 100)
  const lastItem = items[items.length - 1]
  const lastLabel = lastItem === undefined ? '' : lastItem.end || lastItem.start
  return (
    <div data-view-node="timeline" style={COLUMN}>
      <div style={{ ...ROW, justifyContent: 'space-between', ...MUTED }}>
        <span>{items[0]?.start}</span>
        <span>{lastLabel}</span>
      </div>
      {items.map((item) => {
        const width = Math.max(2, at(item.to) - at(item.from))
        const left = Math.min(at(item.from), 100 - width)
        return (
          <div key={item.key} data-point-key={item.key} data-point-label={clampLabel(item.label)} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 14ch) minmax(0, 1fr)', alignItems: 'center', gap: 'var(--ui-space-8)' }}>
            <span style={{ overflowWrap: 'anywhere' }}>{item.label}</span>
            <div aria-hidden="true" style={{ position: 'relative', height: 'var(--ui-space-12)', background: 'var(--ui-selected)', borderRadius: 'var(--ui-radius-mark)' }}>
              <div style={{ position: 'absolute', top: 0, bottom: 0, left: `${left}%`, width: `${width}%`, background: toneColor(item.tone), borderRadius: 'var(--ui-radius-mark)' }} />
            </div>
          </div>
        )
      })}
    </div>
  )
}

export function Board({ props }: { props: Props }) {
  let running = 0
  const columns = asItems(props.columns).map((column) => ({
    title: asString(column.title),
    cards: asItems(column.cards).map((card) => ({
      key: itemKey(asString(card.id), running++),
      title: asString(card.title),
      detail: asString(card.detail),
      tone: oneOf(card.tone, TONES, 'neutral')
    }))
  }))
  return (
    <ScrollX node="board" style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.max(1, columns.length)}, minmax(${MIN_TRACK}, 1fr))`, gap: 'var(--ui-space-8)', alignItems: 'start' }}>
      {columns.map((column, index) => (
        <section key={index} aria-label={column.title} style={{ ...COLUMN, gap: 'var(--ui-space-6)', background: 'var(--ui-rail)', borderRadius: 'var(--ui-radius-control)', padding: 'var(--ui-space-6)' }}>
          <h4 style={{ ...MUTED, margin: 0, fontWeight: 600 }}>{column.title}</h4>
          {column.cards.map((card) => (
            <div
              key={card.key}
              data-point-key={card.key}
              data-point-label={clampLabel(card.title)}
              style={{ ...PANEL, borderInlineStart: `var(--ui-focus-width) solid ${card.tone === 'neutral' ? 'var(--ui-border)' : toneColor(card.tone)}` }}
            >
              <div>{card.title}</div>
              {when(card.detail !== '', () => <div style={MUTED}>{card.detail}</div>)}
            </div>
          ))}
        </section>
      ))}
    </ScrollX>
  )
}

const CELL: CSSProperties = { padding: 'var(--ui-space-4) var(--ui-space-8)', borderBottom: 'var(--ui-border-width) solid var(--ui-border)', textAlign: 'center', overflowWrap: 'anywhere' }

export function Matrix({ props }: { props: Props }) {
  const columns = Array.isArray(props.columns) ? props.columns.map((column) => asString(column)) : []
  const rows = asItems(props.rows)
  return (
    <div data-view-node="matrix" style={{ overflowX: 'auto', minWidth: 0 }}>
      <table style={{ borderCollapse: 'collapse', width: '100%' }}>
        <thead>
          <tr>
            <td style={CELL} />
            {columns.map((column, index) => (
              <th key={index} scope="col" style={{ ...CELL, ...MUTED, fontWeight: 600 }}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => {
            const label = asString(row.label)
            const cells = Array.isArray(row.cells) ? row.cells : []
            const highlight = Array.isArray(row.highlight) ? row.highlight.map((entry) => asString(entry)) : []
            return (
              <tr key={rowIndex}>
                <th scope="row" style={{ ...CELL, textAlign: 'left', fontWeight: 600 }}>{label}</th>
                {columns.map((column, columnIndex) => (
                  <td
                    key={columnIndex}
                    data-point-key={pointKey('cell', keyPart(label, String(rowIndex)), keyPart(column, String(columnIndex)))}
                    data-point-label={clampLabel(`${label} › ${column}`)}
                    style={{ ...CELL, ...(highlight.includes(column) ? { background: 'var(--ui-diff-add-bg)', color: 'var(--ui-diff-add-text)' } : {}) }}
                  >
                    {asString(cells[columnIndex])}
                  </td>
                ))}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/** The lines a note such as "4" or "3-7" covers, as a first and last line number. */
function lineRange(text: string): [number, number] | undefined {
  const match = /^\s*(\d+)(?:\s*-\s*(\d+))?\s*$/.exec(text)
  if (match === null) return undefined
  const first = Number(match[1])
  return [first, Number(match[2] ?? match[1])]
}

export function AnnotatedCode({ props }: { props: Props }) {
  const language = asString(props.language)
  const lines = asString(props.code).replace(/\n$/, '').split('\n')
  const notes = asItems(props.notes).flatMap((note) => {
    const range = lineRange(asString(note.lines))
    return range === undefined ? [] : [{ range, text: asString(note.note) }]
  })
  return (
    <div data-view-node="annotated-code" data-language={language || undefined} style={{ ...BLOCK, whiteSpace: 'pre' }}>
      {lines.map((line, index) => {
        const number = index + 1
        const noted = notes.some((note) => number >= note.range[0] && number <= note.range[1])
        const closing = notes.filter((note) => note.range[1] === number)
        const shown = line === '' ? ' ' : line
        return (
          <div key={index}>
            <div data-point-key={pointKey('line', String(number))} data-point-label={`line ${number}`} style={{ display: 'grid', gridTemplateColumns: 'max-content minmax(0, 1fr)', gap: 'var(--ui-space-8)', background: noted ? 'var(--ui-mark-bg)' : undefined }}>
              <span aria-hidden="true" style={{ ...MUTED, textAlign: 'end' }}>{number}</span>
              <code>{shown}</code>
            </div>
            {closing.map((note, noteIndex) => (
              <div key={noteIndex} style={{ ...MUTED, whiteSpace: 'normal', paddingInlineStart: 'var(--ui-space-24)', fontFamily: 'inherit' }}>{note.text}</div>
            ))}
          </div>
        )
      })}
    </div>
  )
}

const STATUS_MARK: Record<(typeof STATUSES)[number], { glyph: string; color: string }> = {
  added: { glyph: '+', color: 'var(--ui-working)' },
  modified: { glyph: '●', color: 'var(--ui-needs-you)' },
  deleted: { glyph: '−', color: 'var(--ui-failing)' },
  renamed: { glyph: '→', color: 'var(--ui-accent)' },
  touched: { glyph: '·', color: 'var(--ui-muted)' }
}

export function FileMap({ props }: { props: Props }) {
  const entries = asItems(props.entries)
  return (
    <ul data-view-node="file-map" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 'var(--ui-space-2)' }}>
      {entries.map((entry, index) => {
        const path = asString(entry.path)
        const status = oneOf(entry.status, STATUSES, 'touched')
        const slash = path.lastIndexOf('/') + 1
        const note = asString(entry.note)
        return (
          <li key={index} data-point-key={pointKey('file', String(index))} data-point-label={clampLabel(path)} style={{ ...ROW, flexWrap: 'nowrap' }}>
            <span role="img" aria-label={status} style={{ ...MONO, color: STATUS_MARK[status].color, fontWeight: 600 }}>{STATUS_MARK[status].glyph}</span>
            <span style={{ ...MONO, overflowWrap: 'anywhere' }}>
              <span style={{ color: 'var(--ui-muted)' }}>{path.slice(0, slash)}</span>
              {path.slice(slash)}
            </span>
            {when(note !== '', () => <span style={{ ...MUTED, overflowWrap: 'anywhere' }}>{note}</span>)}
          </li>
        )
      })}
    </ul>
  )
}

const SERIES_COLORS = ['var(--ui-accent)', 'var(--ui-working)', 'var(--ui-needs-you)', 'var(--ui-failing)', 'var(--ui-hue-violet)', 'var(--ui-hue-teal)', 'var(--ui-hue-coral)', 'var(--ui-hue-azure)']

const PLOT_WIDTH = 100
const PLOT_HEIGHT = 50

export function Plot({ props }: { props: Props }) {
  const series = asItems(props.series).map((entry, index) => ({
    label: asString(entry.label),
    color: SERIES_COLORS[index % SERIES_COLORS.length]!,
    points: asItems(entry.points).map((point) => ({ x: asNumber(point.x) ?? 0, y: asNumber(point.y) ?? 0 }))
  }))
  const all = series.flatMap((entry) => entry.points)
  const xs = all.map((point) => point.x)
  const ys = all.map((point) => point.y)
  const [left, right, low, high] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
  const scale = (value: number, from: number, to: number, size: number): number => (to === from ? size / 2 : ((value - from) / (to - from)) * size)
  const xLabel = asString(props.xLabel)
  const yLabel = asString(props.yLabel)
  const summary = `Plot: ${series.map((entry) => `${entry.label} ${entry.points.length} points`).join(', ')}`
  const top = yLabel === '' ? `${high}` : `${yLabel} ${high}`
  const bottom = xLabel === '' ? `${right}` : `${xLabel} ${right}`
  return (
    <div data-view-node="plot" style={COLUMN}>
      <div style={{ ...ROW, justifyContent: 'space-between', ...MUTED }}>
        <span>{top}</span>
        <ul style={{ ...ROW, listStyle: 'none', margin: 0, padding: 0 }}>
          {series.map((entry, index) => (
            <li key={index} style={ROW}>
              <span aria-hidden="true" style={{ width: 'var(--ui-space-8)', height: 'var(--ui-space-8)', borderRadius: 'var(--ui-radius-mark)', background: entry.color }} />
              {entry.label}
            </li>
          ))}
        </ul>
      </div>
      <svg role="img" aria-label={summary} viewBox={`0 0 ${PLOT_WIDTH} ${PLOT_HEIGHT}`} preserveAspectRatio="none" style={{ display: 'block', width: '100%', height: 'calc(var(--ui-row-double) * 3)' }}>
        <line x1={0} y1={PLOT_HEIGHT} x2={PLOT_WIDTH} y2={PLOT_HEIGHT} vectorEffect="non-scaling-stroke" style={{ stroke: 'var(--ui-border)' }} />
        <line x1={0} y1={0} x2={0} y2={PLOT_HEIGHT} vectorEffect="non-scaling-stroke" style={{ stroke: 'var(--ui-border)' }} />
        {series.map((entry, index) => (
          <polyline
            key={index}
            fill="none"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
            points={entry.points.map((point) => `${scale(point.x, left, right, PLOT_WIDTH)},${PLOT_HEIGHT - scale(point.y, low, high, PLOT_HEIGHT)}`).join(' ')}
            style={{ stroke: entry.color }}
          />
        ))}
      </svg>
      <div style={{ ...ROW, justifyContent: 'space-between', ...MUTED }}>
        <span>{`${left}`}</span>
        <span>{bottom}</span>
      </div>
    </div>
  )
}

/** A small stable pseudo-random offset for the nth wobble of a shape, so a redraw looks the same. */
function wobble(seed: number, step: number, amount: number): number {
  const x = Math.sin(seed * 12.9898 + step * 78.233) * 43758.5453
  return (x - Math.floor(x) - 0.5) * 2 * amount
}

/** A hand-drawn looking closed path through `corners`, each side bowed a little. */
function sketchy(corners: [number, number][], seed: number): string {
  const wobbled = corners.map(([x, y], index): [number, number] => [x + wobble(seed, index, 2), y + wobble(seed, index + 9, 2)])
  const sides = wobbled.map(([x, y], index) => {
    const [nx, ny] = wobbled[(index + 1) % wobbled.length]!
    return `Q ${(x + nx) / 2 + wobble(seed, index + 20, 3)} ${(y + ny) / 2 + wobble(seed, index + 30, 3)} ${nx} ${ny}`
  })
  return `M ${wobbled[0]![0]} ${wobbled[0]![1]} ${sides.join(' ')}`
}

function ellipsePath(cx: number, cy: number, rx: number, ry: number, seed: number): string {
  const around = Array.from({ length: 12 }, (_, index): [number, number] => {
    const angle = (index / 12) * Math.PI * 2
    return [cx + Math.cos(angle) * rx, cy + Math.sin(angle) * ry]
  })
  return sketchy(around, seed)
}

function stroke(x: number, y: number, x2: number, y2: number, seed: number): string {
  return `M ${x} ${y} Q ${(x + x2) / 2 + wobble(seed, 1, 4)} ${(y + y2) / 2 + wobble(seed, 2, 4)} ${x2} ${y2}`
}

function arrowHead(x: number, y: number, x2: number, y2: number): string {
  const angle = Math.atan2(y2 - y, x2 - x)
  const wing = (turn: number) => `${x2 - Math.cos(angle + turn) * 8} ${y2 - Math.sin(angle + turn) * 8}`
  return `M ${wing(0.45)} L ${x2} ${y2} L ${wing(-0.45)}`
}

const INK: CSSProperties = { fill: 'none', stroke: 'var(--ui-text)', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' }

function sketchShape(shape: Props, seed: number): ReactNode {
  const kind = oneOf(shape.kind, SHAPES, 'box')
  const x = asNumber(shape.x) ?? 0
  const y = asNumber(shape.y) ?? 0
  const w = asNumber(shape.w) ?? 0
  const h = asNumber(shape.h) ?? 0
  const x2 = asNumber(shape.x2) ?? x
  const y2 = asNumber(shape.y2) ?? y
  const label = asString(shape.label)
  const text = (cx: number, cy: number) => <text x={cx} y={cy} textAnchor="middle" dominantBaseline="middle" style={{ fill: 'var(--ui-text)', fontFamily: 'cursive', fontSize: 'var(--ui-font-body)' }}>{label}</text>
  const draw: Record<(typeof SHAPES)[number], () => ReactNode> = {
    box: () => (
      <>
        <path d={sketchy([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], seed)} style={{ ...INK, fill: 'var(--ui-surface)', fillOpacity: 0.01, pointerEvents: 'all' }} />
        {text(x + w / 2, y + h / 2)}
      </>
    ),
    ellipse: () => (
      <>
        <path d={ellipsePath(x + w / 2, y + h / 2, w / 2, h / 2, seed)} style={{ ...INK, fill: 'var(--ui-surface)', fillOpacity: 0.01, pointerEvents: 'all' }} />
        {text(x + w / 2, y + h / 2)}
      </>
    ),
    line: () => <path d={stroke(x, y, x2, y2, seed)} style={INK} />,
    arrow: () => (
      <>
        <path d={stroke(x, y, x2, y2, seed)} style={INK} />
        <path d={arrowHead(x, y, x2, y2)} style={INK} />
      </>
    ),
    text: () => text(x, y)
  }
  return draw[kind]()
}

export function Sketch({ props }: { props: Props }) {
  const width = Math.max(1, asNumber(props.width) ?? 320)
  const height = Math.max(1, asNumber(props.height) ?? 200)
  const shapes = asItems(props.shapes)
  return (
    <figure data-view-node="sketch" style={FIGURE}>
      <svg role="img" aria-label={`Sketch: ${shapes.map((shape) => asString(shape.label)).filter(Boolean).join(', ')}`} viewBox={`0 0 ${width} ${height}`} style={{ display: 'block', width: '100%', maxHeight: 'calc(var(--ui-row-double) * 10)' }}>
        {shapes.map((shape, index) => (
          <g key={index} data-point-key={itemKey(asString(shape.id), index)} data-point-label={clampLabel(asString(shape.label) || `${asString(shape.kind)} ${index + 1}`)}>
            {sketchShape(shape, index + 1)}
          </g>
        ))}
      </svg>
    </figure>
  )
}

