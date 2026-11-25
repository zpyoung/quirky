import { asItems, asNumber, asString, asStrings, oneOf, type NodeProps } from './view-prop-readers'

const TONES = ['neutral', 'good', 'warn', 'bad'] as const
const FILE_STATUSES = ['added', 'modified', 'deleted', 'renamed', 'touched'] as const
const FILE_GLYPH = { added: '+', modified: '●', deleted: '−', renamed: '→', touched: '·' } as const
const SERIES_COUNT = 5

const parseDate = (text: string): number | undefined => {
  const time = Date.parse(text)
  return Number.isNaN(time) ? undefined : time
}

export function TimelineNode({ props }: { props: NodeProps }) {
  const items = asItems(props.items).map((item) => {
    const start = asString(item.start)
    const end = asString(item.end)
    return {
      label: asString(item.label),
      start,
      end,
      from: parseDate(start),
      to: parseDate(end) ?? parseDate(start),
      tone: oneOf(item.tone, TONES, 'neutral')
    }
  })
  const times = items
    .flatMap((item) => [item.from, item.to])
    .filter((time): time is number => time !== undefined)
  const first = Math.min(...times)
  const span = Math.max(...times) - first
  const at = (time: number | undefined): number =>
    time === undefined || span <= 0 ? 0 : ((time - first) / span) * 100
  const last = items.at(-1)
  return (
    <div data-view-node="timeline" className="native-chat-view-column">
      <div className="native-chat-view-row native-chat-view-between native-chat-view-muted">
        <span>{items[0]?.start}</span>
        <span>{last === undefined ? '' : last.end || last.start}</span>
      </div>
      {items.map((item, index) => {
        const width = Math.max(2, at(item.to) - at(item.from))
        const left = Math.min(at(item.from), 100 - width)
        return (
          <div key={index} className="native-chat-view-timeline-row">
            <span>{item.label}</span>
            <div aria-hidden="true" className="native-chat-view-timeline-track">
              <div
                className="native-chat-view-timeline-bar"
                data-tone={item.tone}
                style={{ left: `${left}%`, width: `${width}%` }}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}

export function BoardNode({ props }: { props: NodeProps }) {
  const columns = asItems(props.columns).map((column) => ({
    title: asString(column.title),
    cards: asItems(column.cards).map((card) => ({
      title: asString(card.title),
      detail: asString(card.detail),
      tone: oneOf(card.tone, TONES, 'neutral')
    }))
  }))
  return (
    <div
      data-view-node="board"
      className="native-chat-view-board"
      style={{ gridTemplateColumns: `repeat(${Math.max(1, columns.length)}, minmax(0, 1fr))` }}
    >
      {columns.map((column, columnIndex) => (
        <section
          key={columnIndex}
          aria-label={column.title}
          className="native-chat-view-board-column"
        >
          <h4 className="native-chat-view-muted native-chat-view-board-title">{column.title}</h4>
          {column.cards.map((card, cardIndex) => (
            <div
              key={cardIndex}
              className="native-chat-view-panel native-chat-view-board-card"
              data-tone={card.tone}
            >
              <div>{card.title}</div>
              {card.detail !== '' && <div className="native-chat-view-muted">{card.detail}</div>}
            </div>
          ))}
        </section>
      ))}
    </div>
  )
}

export function MatrixNode({ props }: { props: NodeProps }) {
  const columns = asStrings(props.columns)
  const rows = asItems(props.rows)
  return (
    <div data-view-node="matrix" className="native-chat-view-scroll-x">
      <table className="native-chat-view-table native-chat-view-matrix">
        <thead>
          <tr>
            <td />
            {columns.map((column, index) => (
              <th key={index} scope="col">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => {
            const cells = Array.isArray(row.cells) ? row.cells : []
            const highlight = asStrings(row.highlight)
            return (
              <tr key={rowIndex}>
                <th scope="row">{asString(row.label)}</th>
                {columns.map((column, columnIndex) => (
                  <td key={columnIndex} data-highlight={highlight.includes(column) || undefined}>
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
  if (match === null) {
    return undefined
  }
  const first = Number(match[1])
  return [first, Number(match[2] ?? match[1])]
}

export function AnnotatedCodeNode({ props }: { props: NodeProps }) {
  const language = asString(props.language)
  const lines = asString(props.code).replace(/\n$/, '').split('\n')
  const notes = asItems(props.notes).flatMap((note) => {
    const range = lineRange(asString(note.lines))
    return range === undefined ? [] : [{ range, text: asString(note.note) }]
  })
  return (
    <div
      data-view-node="annotated-code"
      data-language={language || undefined}
      className="native-chat-view-code"
    >
      {lines.map((line, index) => {
        const number = index + 1
        const noted = notes.some((note) => number >= note.range[0] && number <= note.range[1])
        return (
          <div key={index}>
            <div className="native-chat-view-code-line" data-noted={noted || undefined}>
              <span
                aria-hidden="true"
                className="native-chat-view-muted native-chat-view-line-number"
              >
                {number}
              </span>
              <code>{line === '' ? ' ' : line}</code>
            </div>
            {notes
              .filter((note) => note.range[1] === number)
              .map((note, noteIndex) => (
                <div key={noteIndex} className="native-chat-view-muted native-chat-view-code-note">
                  {note.text}
                </div>
              ))}
          </div>
        )
      })}
    </div>
  )
}

export function FileMapNode({ props }: { props: NodeProps }) {
  return (
    <ul data-view-node="file-map" className="native-chat-view-list native-chat-view-tight">
      {asItems(props.entries).map((entry, index) => {
        const path = asString(entry.path)
        const status = oneOf(entry.status, FILE_STATUSES, 'touched')
        const slash = path.lastIndexOf('/') + 1
        const note = asString(entry.note)
        return (
          <li key={index} className="native-chat-view-row native-chat-view-nowrap">
            <span
              className="native-chat-view-mono native-chat-view-file-status"
              data-status={status}
              role="img"
              aria-label={status}
            >
              {FILE_GLYPH[status]}
            </span>
            <span className="native-chat-view-mono">
              <span className="native-chat-view-muted">{path.slice(0, slash)}</span>
              {path.slice(slash)}
            </span>
            {note !== '' && <span className="native-chat-view-muted">{note}</span>}
          </li>
        )
      })}
    </ul>
  )
}

const PLOT_WIDTH = 100
const PLOT_HEIGHT = 50

export function PlotNode({ props }: { props: NodeProps }) {
  const series = asItems(props.series).map((entry) => ({
    label: asString(entry.label),
    points: asItems(entry.points).map((point) => ({
      x: asNumber(point.x) ?? 0,
      y: asNumber(point.y) ?? 0
    }))
  }))
  const all = series.flatMap((entry) => entry.points)
  if (all.length === 0) {
    return (
      <div data-view-node="plot" className="native-chat-view-muted">
        No points.
      </div>
    )
  }
  const xs = all.map((point) => point.x)
  const ys = all.map((point) => point.y)
  const [left, right, low, high] = [
    Math.min(...xs),
    Math.max(...xs),
    Math.min(...ys),
    Math.max(...ys)
  ]
  const scale = (value: number, from: number, to: number, size: number): number =>
    to === from ? size / 2 : ((value - from) / (to - from)) * size
  const xLabel = asString(props.xLabel)
  const yLabel = asString(props.yLabel)
  const summary = `Plot: ${series.map((entry) => `${entry.label} ${entry.points.length} points`).join(', ')}`
  return (
    <div data-view-node="plot" className="native-chat-view-column">
      <div className="native-chat-view-row native-chat-view-between native-chat-view-muted">
        <span>{yLabel === '' ? `${high}` : `${yLabel} ${high}`}</span>
        <ul className="native-chat-view-row native-chat-view-legend">
          {series.map((entry, index) => (
            <li key={index} className="native-chat-view-row">
              <span
                aria-hidden="true"
                className="native-chat-view-swatch"
                data-series={index % SERIES_COUNT}
              />
              {entry.label}
            </li>
          ))}
        </ul>
      </div>
      <svg
        role="img"
        aria-label={summary}
        viewBox={`0 0 ${PLOT_WIDTH} ${PLOT_HEIGHT}`}
        preserveAspectRatio="none"
        className="native-chat-view-plot"
      >
        <line
          className="native-chat-view-axis"
          x1={0}
          y1={PLOT_HEIGHT}
          x2={PLOT_WIDTH}
          y2={PLOT_HEIGHT}
          vectorEffect="non-scaling-stroke"
        />
        <line
          className="native-chat-view-axis"
          x1={0}
          y1={0}
          x2={0}
          y2={PLOT_HEIGHT}
          vectorEffect="non-scaling-stroke"
        />
        {series.map((entry, index) => (
          <polyline
            key={index}
            className="native-chat-view-line"
            data-series={index % SERIES_COUNT}
            fill="none"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
            points={entry.points
              .map(
                (point) =>
                  `${scale(point.x, left, right, PLOT_WIDTH)},${PLOT_HEIGHT - scale(point.y, low, high, PLOT_HEIGHT)}`
              )
              .join(' ')}
          />
        ))}
      </svg>
      <div className="native-chat-view-row native-chat-view-between native-chat-view-muted">
        <span>{`${left}`}</span>
        <span>{xLabel === '' ? `${right}` : `${xLabel} ${right}`}</span>
      </div>
    </div>
  )
}
