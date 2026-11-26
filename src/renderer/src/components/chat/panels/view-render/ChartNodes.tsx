import { translate } from '@/i18n/i18n'
import { asItems, asNumber, asString, type NodeProps } from './view-prop-readers'
import { positionKeyed } from '../../position-keyed'

const BAR_HEIGHT = 6
const PLOT_WIDTH = 100
const PLOT_HEIGHT = 40

const withUnit = (value: string | number, unit: string): string =>
  unit === '' ? String(value) : `${value} ${unit}`

export function BarChartNode({ props }: { props: NodeProps }) {
  const unit = asString(props.unit)
  const series = asItems(props.series).map((entry) => ({
    label: asString(entry.label),
    value: asNumber(entry.value) ?? 0
  }))
  const largest = Math.max(0, ...series.map((entry) => entry.value))
  const summary = `Bar chart: ${series.map((entry) => `${entry.label} ${withUnit(entry.value, unit)}`).join(', ')}`
  return (
    <div
      data-view-node="bar-chart"
      className="native-chat-view-column native-chat-view-tight"
      role="img"
      aria-label={summary}
    >
      {positionKeyed(series).map(({ key, item: entry }) => {
        const width = largest > 0 ? (Math.max(0, entry.value) / largest) * PLOT_WIDTH : 0
        return (
          <div key={key} className="native-chat-view-bar-row">
            <span className="native-chat-view-mono">{entry.label}</span>
            <svg
              viewBox={`0 0 ${PLOT_WIDTH} ${BAR_HEIGHT}`}
              preserveAspectRatio="none"
              aria-hidden="true"
              className="native-chat-view-bar"
            >
              <rect
                className="native-chat-view-bar-track"
                x={0}
                y={0}
                width={PLOT_WIDTH}
                height={BAR_HEIGHT}
              />
              <rect
                className="native-chat-view-bar-fill"
                data-hot={(largest > 0 && entry.value === largest) || undefined}
                x={0}
                y={0}
                width={width}
                height={BAR_HEIGHT}
              />
            </svg>
            <span className="native-chat-view-mono">{withUnit(entry.value, unit)}</span>
          </div>
        )
      })}
    </div>
  )
}

export function LineChartNode({ props }: { props: NodeProps }) {
  const unit = asString(props.unit)
  const points = asItems(props.points).map((point) => ({
    x: asString(point.x),
    y: asNumber(point.y) ?? 0
  }))
  if (points.length === 0) {
    return (
      <div data-view-node="line-chart" className="native-chat-view-muted">
        {translate('components.chat.viewRender.noPoints', 'No points.')}
      </div>
    )
  }
  const ys = points.map((point) => point.y)
  const low = Math.min(...ys)
  const high = Math.max(...ys)
  const span = high - low
  const coordinate = (index: number, value: number) => {
    const x = points.length > 1 ? (index / (points.length - 1)) * PLOT_WIDTH : PLOT_WIDTH / 2
    const y =
      span === 0 ? PLOT_HEIGHT / 2 : PLOT_HEIGHT - 2 - ((value - low) / span) * (PLOT_HEIGHT - 4)
    return `${x},${y}`
  }
  const line = points.map((point, index) => coordinate(index, point.y))
  if (points.length === 1) {
    line.unshift(`0,${PLOT_HEIGHT / 2}`)
    line.push(`${PLOT_WIDTH},${PLOT_HEIGHT / 2}`)
  }
  const summary = `Line chart: ${points.map((point) => `${point.x} ${withUnit(point.y, unit)}`).join(', ')}`
  return (
    <div
      data-view-node="line-chart"
      className="native-chat-view-column native-chat-view-tight"
      role="img"
      aria-label={summary}
    >
      <div className="native-chat-view-muted">
        {low === high
          ? withUnit(low, unit)
          : translate('components.chat.viewRender.pointRange', '{{low}} to {{high}}', {
              low: withUnit(low, unit),
              high: withUnit(high, unit)
            })}
      </div>
      <svg
        viewBox={`0 0 ${PLOT_WIDTH} ${PLOT_HEIGHT}`}
        preserveAspectRatio="none"
        aria-hidden="true"
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
        <polyline
          className="native-chat-view-line"
          data-series="0"
          points={line.join(' ')}
          fill="none"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <div className="native-chat-view-row native-chat-view-between native-chat-view-muted">
        <span>{points[0]?.x}</span>
        <span>{points.at(-1)?.x}</span>
      </div>
    </div>
  )
}
