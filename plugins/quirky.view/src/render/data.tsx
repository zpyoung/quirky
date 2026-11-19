import type { CSSProperties } from 'react'
import { StatusDot, type UiStatus } from '@quirky/ui'
import { clampLabel, pointKey } from './point'
import { asItems, asString, oneOf, type Props } from './props'
import { LIST, MONO, MUTED, PANEL, ROW, TONE_COLOR, type Tone } from './styles'

const TONES = ['neutral', 'good', 'warn', 'bad'] as const
const CALLOUT_TONES = ['info', 'good', 'warn', 'bad'] as const
const STATUS_STATES = ['ok', 'warn', 'bad', 'pending'] as const
const STEP_STATES = ['done', 'active', 'pending', 'failed'] as const

const STATUS_DOT: Record<(typeof STATUS_STATES)[number], UiStatus> = { ok: 'working', warn: 'needs-you', bad: 'failing', pending: 'queued' }
const STEP_DOT: Record<(typeof STEP_STATES)[number], UiStatus> = { done: 'done', active: 'working', pending: 'queued', failed: 'failing' }

export function Stat({ props }: { props: Props }) {
  const tone: Tone = oneOf(props.tone, TONES, 'neutral')
  const delta = asString(props.delta)
  return (
    <div data-view-node="stat" style={{ ...PANEL, display: 'flex', flexDirection: 'column', gap: 'var(--ui-space-2)' }}>
      <div style={MUTED}>{asString(props.label)}</div>
      <div style={{ fontSize: 'var(--ui-font-title)', fontWeight: 600, overflowWrap: 'anywhere', color: TONE_COLOR[tone] }}>{asString(props.value)}</div>
      {delta !== '' && <div style={{ ...MUTED, color: tone === 'neutral' ? 'var(--ui-muted)' : TONE_COLOR[tone] }}>{delta}</div>}
    </div>
  )
}

export function KeyValue({ props }: { props: Props }) {
  return (
    <dl
      data-view-node="kv"
      style={{ display: 'grid', gridTemplateColumns: 'max-content minmax(0, 1fr)', gap: 'var(--ui-space-4) var(--ui-space-12)', margin: 0, minWidth: 0 }}
    >
      {asItems(props.items).map((item, index) => (
        <div key={index} style={{ display: 'contents' }}>
          <dt style={{ ...MUTED, overflowWrap: 'anywhere' }}>{asString(item.key)}</dt>
          <dd style={{ margin: 0, overflowWrap: 'anywhere' }}>{asString(item.value)}</dd>
        </div>
      ))}
    </dl>
  )
}

const CELL: CSSProperties = {
  textAlign: 'left',
  padding: 'var(--ui-space-4) var(--ui-space-8)',
  borderBottom: 'var(--ui-border-width) solid var(--ui-border)',
  overflowWrap: 'anywhere'
}

export function DataTable({ props }: { props: Props }) {
  const columns = Array.isArray(props.columns) ? props.columns.map((column) => asString(column)) : []
  const rows = Array.isArray(props.rows) ? props.rows.filter(Array.isArray) : []
  return (
    <div data-view-node="table" style={{ overflowX: 'auto', minWidth: 0 }}>
      <table style={{ borderCollapse: 'collapse', width: '100%' }}>
        <thead>
          <tr>
            {columns.map((column, index) => (
              <th key={index} scope="col" style={{ ...CELL, ...MUTED, fontWeight: 600 }}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex} data-point-key={pointKey('row', String(rowIndex))} data-point-label={clampLabel(asString(row[0]))}>
              {row.map((cell: unknown, cellIndex: number) => (
                <td key={cellIndex} style={CELL}>{asString(cell)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function StatusList({ props }: { props: Props }) {
  return (
    <ul data-view-node="status-list" style={LIST}>
      {asItems(props.items).map((item, index) => {
        const state = oneOf(item.state, STATUS_STATES, 'pending')
        const detail = asString(item.detail)
        return (
          <li key={index} style={ROW}>
            <StatusDot status={STATUS_DOT[state]} label={state} />
            <span style={{ overflowWrap: 'anywhere' }}>{asString(item.label)}</span>
            {detail !== '' && <span style={{ ...MUTED, overflowWrap: 'anywhere' }}>{detail}</span>}
          </li>
        )
      })}
    </ul>
  )
}

export function Steps({ props }: { props: Props }) {
  return (
    <ol data-view-node="steps" style={LIST}>
      {asItems(props.items).map((item, index) => {
        const state = oneOf(item.state, STEP_STATES, 'pending')
        return (
          <li key={index} style={ROW}>
            <StatusDot status={STEP_DOT[state]} />
            <span style={{ overflowWrap: 'anywhere', ...(state === 'pending' ? { color: 'var(--ui-muted)' } : {}) }}>{asString(item.text)}</span>
            <span style={MUTED}>{state}</span>
          </li>
        )
      })}
    </ol>
  )
}

const BLOCK: CSSProperties = {
  ...MONO,
  margin: 0,
  padding: 'var(--ui-space-8)',
  overflow: 'auto',
  background: 'var(--ui-selected)',
  borderRadius: 'var(--ui-radius-control)',
  whiteSpace: 'pre'
}

export function Code({ props }: { props: Props }) {
  const language = asString(props.language)
  return (
    <pre data-view-node="code" data-language={language || undefined} style={BLOCK}>
      <code>{asString(props.text)}</code>
    </pre>
  )
}

function diffColor(line: string): string {
  if (line.startsWith('+')) return 'var(--ui-working)'
  if (line.startsWith('-')) return 'var(--ui-failing)'
  if (line.startsWith('@@')) return 'var(--ui-muted)'
  return 'var(--ui-text)'
}

export function FileDiff({ props }: { props: Props }) {
  const lines = asString(props.diff).split('\n')
  return (
    <figure data-view-node="file-diff" style={{ margin: 0, display: 'flex', flexDirection: 'column', gap: 'var(--ui-space-4)', minWidth: 0 }}>
      <figcaption style={{ ...MONO, overflowWrap: 'anywhere' }}>{asString(props.path)}</figcaption>
      <pre style={BLOCK}>
        <code>
          {lines.map((line, index) => (
            <span key={index} style={{ display: 'block', color: diffColor(line) }}>{line === '' ? ' ' : line}</span>
          ))}
        </code>
      </pre>
    </figure>
  )
}

export function Callout({ props }: { props: Props }) {
  const tone = oneOf(props.tone, CALLOUT_TONES, 'info')
  return (
    <div
      data-view-node="callout"
      data-tone={tone}
      role="note"
      style={{
        ...PANEL,
        background: 'var(--ui-selected)',
        borderInlineStart: `var(--ui-focus-width) solid ${TONE_COLOR[tone]}`,
        overflowWrap: 'anywhere'
      }}
    >
      {asString(props.text)}
    </div>
  )
}
