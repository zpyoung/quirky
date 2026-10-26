import type { StructuredMessage } from '@quirky/protocol'

function firstLine(text: string): string {
  const line = text.split('\n', 1)[0] ?? ''
  return line.length > 120 ? `${line.slice(0, 120)}…` : line
}

export function MessageRow({ message }: { message: StructuredMessage }) {
  switch (message.role) {
    case 'tool':
      return (
        <details className="msg msg-tool">
          <summary>{firstLine(message.text) || 'tool'}</summary>
          <pre>{message.text}</pre>
        </details>
      )
    case 'result':
      return <div className="msg msg-result">{message.text}</div>
    case 'system':
      return <div className="msg msg-system">{message.text}</div>
    default:
      return (
        <div className={`msg msg-${message.role}`}>
          <div className="msg-role">{message.role}</div>
          <div className="msg-text">{message.text}</div>
        </div>
      )
  }
}
