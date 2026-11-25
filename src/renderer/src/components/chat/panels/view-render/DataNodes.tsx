import { ChatMarkdown } from '../../markdown'
import { asItems, asString, asStrings, oneOf, type NodeProps } from './view-prop-readers'
import { useViewRuntime } from './view-runtime'

const TONES = ['neutral', 'good', 'warn', 'bad'] as const
const CALLOUT_TONES = ['info', 'good', 'warn', 'bad'] as const
const STATUS_STATES = ['ok', 'warn', 'bad', 'pending'] as const
const STEP_STATES = ['done', 'active', 'pending', 'failed'] as const

const STATUS_GLYPH = { ok: '✓', warn: '!', bad: '✕', pending: '…' } as const
const STEP_GLYPH = { done: '✓', active: '●', pending: '○', failed: '✕' } as const

export function MarkdownNode({ props }: { props: NodeProps }) {
  const { openLink } = useViewRuntime()
  return (
    <div data-view-node="markdown" className="native-chat-view-markdown">
      <ChatMarkdown text={asString(props.text)} onOpenLink={openLink} />
    </div>
  )
}

export function StatNode({ props }: { props: NodeProps }) {
  const tone = oneOf(props.tone, TONES, 'neutral')
  const delta = asString(props.delta)
  return (
    <div
      data-view-node="stat"
      data-tone={tone}
      className="native-chat-view-panel native-chat-view-stat"
    >
      <div className="native-chat-view-muted">{asString(props.label)}</div>
      <div className="native-chat-view-stat-value">{asString(props.value)}</div>
      {delta !== '' && (
        <div className="native-chat-view-muted native-chat-view-stat-delta">{delta}</div>
      )}
    </div>
  )
}

export function KeyValueNode({ props }: { props: NodeProps }) {
  return (
    <dl data-view-node="kv" className="native-chat-view-kv">
      {asItems(props.items).map((item, index) => (
        <div key={index} className="native-chat-view-contents">
          <dt className="native-chat-view-muted">{asString(item.key)}</dt>
          <dd>{asString(item.value)}</dd>
        </div>
      ))}
    </dl>
  )
}

export function TableNode({ props }: { props: NodeProps }) {
  const columns = asStrings(props.columns)
  const rows = Array.isArray(props.rows) ? props.rows.filter(Array.isArray) : []
  return (
    <div data-view-node="table" className="native-chat-view-scroll-x">
      <table className="native-chat-view-table">
        <thead>
          <tr>
            {columns.map((column, index) => (
              <th key={index} scope="col">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell: unknown, cellIndex: number) => (
                <td key={cellIndex}>{asString(cell)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function StatusListNode({ props }: { props: NodeProps }) {
  return (
    <ul data-view-node="status-list" className="native-chat-view-list">
      {asItems(props.items).map((item, index) => {
        const state = oneOf(item.state, STATUS_STATES, 'pending')
        const detail = asString(item.detail)
        return (
          <li key={index} className="native-chat-view-row">
            <span
              className="native-chat-view-mark"
              data-state={state}
              role="img"
              aria-label={state}
            >
              {STATUS_GLYPH[state]}
            </span>
            <span>{asString(item.label)}</span>
            {detail !== '' && <span className="native-chat-view-muted">{detail}</span>}
          </li>
        )
      })}
    </ul>
  )
}

export function StepsNode({ props }: { props: NodeProps }) {
  return (
    <ol data-view-node="steps" className="native-chat-view-list">
      {asItems(props.items).map((item, index) => {
        const state = oneOf(item.state, STEP_STATES, 'pending')
        return (
          <li key={index} className="native-chat-view-row" data-state={state}>
            <span className="native-chat-view-mark" data-state={state} aria-hidden="true">
              {STEP_GLYPH[state]}
            </span>
            <span className="native-chat-view-step-text">{asString(item.text)}</span>
            <span className="native-chat-view-muted">{state}</span>
          </li>
        )
      })}
    </ol>
  )
}

export function CodeNode({ props }: { props: NodeProps }) {
  const language = asString(props.language)
  return (
    <pre
      data-view-node="code"
      data-language={language || undefined}
      className="native-chat-view-code"
    >
      <code>{asString(props.text)}</code>
    </pre>
  )
}

function diffKind(line: string): 'add' | 'remove' | 'hunk' | 'context' {
  if (line.startsWith('+')) {
    return 'add'
  }
  if (line.startsWith('-')) {
    return 'remove'
  }
  return line.startsWith('@@') ? 'hunk' : 'context'
}

export function FileDiffNode({ props }: { props: NodeProps }) {
  const lines = asString(props.diff).split('\n')
  return (
    <figure data-view-node="file-diff" className="native-chat-view-figure">
      <figcaption className="native-chat-view-mono">{asString(props.path)}</figcaption>
      <pre className="native-chat-view-code">
        <code>
          {lines.map((line, index) => (
            <span key={index} className="native-chat-view-diff-line" data-kind={diffKind(line)}>
              {line === '' ? ' ' : line}
            </span>
          ))}
        </code>
      </pre>
    </figure>
  )
}

export function CalloutNode({ props }: { props: NodeProps }) {
  const tone = oneOf(props.tone, CALLOUT_TONES, 'info')
  return (
    <div
      data-view-node="callout"
      data-tone={tone}
      role="note"
      className="native-chat-view-panel native-chat-view-callout"
    >
      {asString(props.text)}
    </div>
  )
}
