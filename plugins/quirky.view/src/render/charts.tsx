import { clampLabel, keyPart, pointKey } from './point'
import { asItems, asNumber, asString, type Props } from './props'
import { MUTED, ROW } from './styles'

const BAR_HEIGHT = 6
const PLOT_WIDTH = 100
const PLOT_HEIGHT = 40

const withUnit = (value: string | number, unit: string): string => (unit === '' ? String(value) : `${value} ${unit}`)

export function BarChart({ props }: { props: Props }) {
  const unit = asString(props.unit)
  const series = asItems(props.series).map((entry) => ({ label: asString(entry.label), value: asNumber(entry.value) ?? 0 }))
  const largest = Math.max(0, ...series.map((entry) => entry.value))
  const summary = `Bar chart: ${series.map((entry) => `${entry.label} ${withUnit(entry.value, unit)}`).join(', ')}`
  return (
    <div data-view-node="bar-chart" style={{ minWidth: 0 }}>
      <div role="img" aria-label={summary} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--ui-space-6)' }}>
        {series.map((entry, index) => {
          const width = largest > 0 ? (Math.max(0, entry.value) / largest) * PLOT_WIDTH : 0
          const hot = largest > 0 && entry.value === largest
          return (
            <div
              key={index}
              data-point-key={pointKey('pt', keyPart(entry.label, String(index)))}
              data-point-label={clampLabel(`${entry.label} ${withUnit(entry.value, unit)}`)}
              style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 12ch) minmax(0, 1fr) max-content', alignItems: 'center', gap: 'var(--ui-space-8)' }}
            >
              <span style={{ fontFamily: 'var(--ui-font-mono)', fontSize: 'var(--ui-font-mono)', overflowWrap: 'anywhere' }}>{entry.label}</span>
              <svg viewBox={`0 0 ${PLOT_WIDTH} ${BAR_HEIGHT}`} preserveAspectRatio="none" aria-hidden="true" style={{ display: 'block', width: '100%', height: 'var(--ui-space-8)' }}>
                <rect x={0} y={0} width={PLOT_WIDTH} height={BAR_HEIGHT} style={{ fill: 'var(--ui-border)' }} />
                <rect x={0} y={0} width={width} height={BAR_HEIGHT} style={{ fill: hot ? 'var(--ui-needs-you)' : 'var(--ui-accent)' }} />
              </svg>
              <span style={{ fontFamily: 'var(--ui-font-mono)', fontSize: 'var(--ui-font-mono)' }}>{withUnit(entry.value, unit)}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function LineChart({ props }: { props: Props }) {
  const unit = asString(props.unit)
  const points = asItems(props.points).map((point) => ({ x: asString(point.x), y: asNumber(point.y) ?? 0 }))
  const ys = points.map((point) => point.y)
  const low = Math.min(...ys)
  const high = Math.max(...ys)
  const span = high - low
  const coordinate = (index: number, value: number) => {
    const x = points.length > 1 ? (index / (points.length - 1)) * PLOT_WIDTH : PLOT_WIDTH / 2
    const y = span === 0 ? PLOT_HEIGHT / 2 : PLOT_HEIGHT - 2 - ((value - low) / span) * (PLOT_HEIGHT - 4)
    return `${x},${y}`
  }
  const line = points.map((point, index) => coordinate(index, point.y))
  if (points.length === 1) line.unshift(`0,${PLOT_HEIGHT / 2}`)
  if (points.length === 1) line.push(`${PLOT_WIDTH},${PLOT_HEIGHT / 2}`)
  const summary = `Line chart: ${points.map((point) => `${point.x} ${withUnit(point.y, unit)}`).join(', ')}`
  return (
    <div data-view-node="line-chart" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--ui-space-4)', minWidth: 0 }}>
      {points.length > 0 && (
        <div role="img" aria-label={summary} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--ui-space-4)' }}>
          <div style={MUTED}>{low === high ? withUnit(low, unit) : `${withUnit(low, unit)} to ${withUnit(high, unit)}`}</div>
          <svg viewBox={`0 0 ${PLOT_WIDTH} ${PLOT_HEIGHT}`} preserveAspectRatio="none" aria-hidden="true" style={{ display: 'block', width: '100%', height: 'calc(var(--ui-row-double) * 3)' }}>
            <line x1={0} y1={PLOT_HEIGHT} x2={PLOT_WIDTH} y2={PLOT_HEIGHT} vectorEffect="non-scaling-stroke" style={{ stroke: 'var(--ui-border)' }} />
            {points.map((point, index) => {
              const x = points.length > 1 ? (index / (points.length - 1)) * PLOT_WIDTH : PLOT_WIDTH / 2
              return (
                <line
                  key={index}
                  data-point-key={pointKey('pt', keyPart(point.x, String(index)))}
                  data-point-label={clampLabel(`${point.x} ${withUnit(point.y, unit)}`)}
                  x1={x}
                  y1={0}
                  x2={x}
                  y2={PLOT_HEIGHT}
                  strokeWidth={8}
                  vectorEffect="non-scaling-stroke"
                  style={{ stroke: 'var(--ui-accent)', strokeOpacity: 0.12 }}
                />
              )
            })}
            <polyline
              points={line.join(' ')}
              fill="none"
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
              style={{ stroke: 'var(--ui-accent)' }}
            />
          </svg>
          <div style={{ ...ROW, justifyContent: 'space-between', ...MUTED }}>
            <span>{points[0].x}</span>
            <span>{points[points.length - 1].x}</span>
          </div>
        </div>
      )}
    </div>
  )
}
