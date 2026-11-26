import { translate } from '@/i18n/i18n'
import type { ReactNode } from 'react'
import { asItems, asNumber, asString, oneOf, type NodeProps } from './view-prop-readers'

const GLYPH_KINDS = ['box', 'ellipse', 'line', 'arrow', 'text'] as const

/** A small stable pseudo-random offset for the nth wobble of a glyph, so a redraw looks the same. */
function wobble(seed: number, step: number, amount: number): number {
  const x = Math.sin(seed * 12.9898 + step * 78.233) * 43758.5453
  return (x - Math.floor(x) - 0.5) * 2 * amount
}

type Corner = [number, number]

/** A hand-drawn looking closed path through `corners`, each side bowed a little. */
function sketchy(corners: Corner[], seed: number): string {
  const wobbled = corners.map(([x, y], index): Corner => [
    x + wobble(seed, index, 2),
    y + wobble(seed, index + 9, 2)
  ])
  const first: Corner = wobbled[0] ?? [0, 0]
  const sides = wobbled.map(([x, y], index) => {
    const [nx, ny] = wobbled[(index + 1) % wobbled.length] ?? first
    return `Q ${(x + nx) / 2 + wobble(seed, index + 20, 3)} ${(y + ny) / 2 + wobble(seed, index + 30, 3)} ${nx} ${ny}`
  })
  return `M ${first[0]} ${first[1]} ${sides.join(' ')}`
}

function ellipsePath(cx: number, cy: number, rx: number, ry: number, seed: number): string {
  const around = Array.from({ length: 12 }, (_, index): Corner => {
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
  const wing = (turn: number) =>
    `${x2 - Math.cos(angle + turn) * 8} ${y2 - Math.sin(angle + turn) * 8}`
  return `M ${wing(0.45)} L ${x2} ${y2} L ${wing(-0.45)}`
}

function sketchGlyph(glyph: NodeProps, seed: number): ReactNode {
  const kind = oneOf(glyph.kind, GLYPH_KINDS, 'box')
  const x = asNumber(glyph.x) ?? 0
  const y = asNumber(glyph.y) ?? 0
  const w = asNumber(glyph.w) ?? 0
  const h = asNumber(glyph.h) ?? 0
  const x2 = asNumber(glyph.x2) ?? x
  const y2 = asNumber(glyph.y2) ?? y
  const label = asString(glyph.label)
  const text = (cx: number, cy: number) => (
    <text
      className="native-chat-view-sketch-text"
      x={cx}
      y={cy}
      textAnchor="middle"
      dominantBaseline="middle"
    >
      {label}
    </text>
  )
  switch (kind) {
    case 'box':
      return (
        <>
          <path
            className="native-chat-view-sketch-ink"
            d={sketchy(
              [
                [x, y],
                [x + w, y],
                [x + w, y + h],
                [x, y + h]
              ],
              seed
            )}
          />
          {text(x + w / 2, y + h / 2)}
        </>
      )
    case 'ellipse':
      return (
        <>
          <path
            className="native-chat-view-sketch-ink"
            d={ellipsePath(x + w / 2, y + h / 2, w / 2, h / 2, seed)}
          />
          {text(x + w / 2, y + h / 2)}
        </>
      )
    case 'line':
      return <path className="native-chat-view-sketch-ink" d={stroke(x, y, x2, y2, seed)} />
    case 'arrow':
      return (
        <>
          <path className="native-chat-view-sketch-ink" d={stroke(x, y, x2, y2, seed)} />
          <path className="native-chat-view-sketch-ink" d={arrowHead(x, y, x2, y2)} />
        </>
      )
    case 'text':
      return text(x, y)
  }
}

export function SketchNode({ props }: { props: NodeProps }) {
  const width = Math.max(1, asNumber(props.width) ?? 320)
  const height = Math.max(1, asNumber(props.height) ?? 200)
  const glyphs = asItems(props.shapes)
  const names = glyphs.map((glyph) => asString(glyph.label)).filter(Boolean)
  return (
    <figure data-view-node="sketch" className="native-chat-view-figure">
      <svg
        role="img"
        aria-label={translate('components.chat.viewRender.sketchLabel', 'Sketch: {{names}}', {
          names: names.join(', ')
        })}
        viewBox={`0 0 ${width} ${height}`}
        className="native-chat-view-sketch"
      >
        {glyphs.map((glyph, index) => (
          <g key={index}>{sketchGlyph(glyph, index + 1)}</g>
        ))}
      </svg>
    </figure>
  )
}
