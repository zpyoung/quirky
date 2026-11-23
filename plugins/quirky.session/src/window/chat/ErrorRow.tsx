import { useState, type CSSProperties } from 'react'
import type { AgentCapabilities, ChatItem, Session, UiPluginContext } from '@quirky/protocol'
import { Button } from '@quirky/ui'
import { Card, grow, mono, muted } from './cards/Card'
import { resumeInPlace } from './resumeInPlace'

type ErrorItem = Extract<ChatItem, { kind: 'error' }>

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

const TITLES: Record<ErrorItem['reason'], string> = {
  exited: 'stopped unexpectedly',
  spawn: 'could not start',
  protocol: 'sent something Quirky could not read'
}

const tail = {
  ...mono,
  margin: 0,
  padding: 'var(--ui-space-6) var(--ui-space-8)',
  whiteSpace: 'pre-wrap',
  background: 'var(--ui-selected)',
  borderRadius: 'var(--ui-radius-control)'
} satisfies CSSProperties
const actions = { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--ui-space-6)', marginTop: 'var(--ui-space-8)' } satisfies CSSProperties

/** Why Restart is off: the agent's own capability reason when it has one, else a general one. */
function restartReason(capabilities: AgentCapabilities | null): string {
  if (capabilities && !capabilities.resume.ok) return capabilities.resume.reason
  return 'This conversation cannot be resumed'
}

/**
 * The row an agent exit leaves in the transcript: the last stderr lines, Restart (which resumes the
 * native conversation when the runner says it can) and Open in terminal for the same agent and worktree.
 */
export function ErrorRow({
  context,
  session,
  item,
  capabilities
}: {
  context: UiPluginContext
  session: Session
  item: ErrorItem
  capabilities: AgentCapabilities | null
}) {
  const [busy, setBusy] = useState(false)
  const reason = item.resumable ? undefined : restartReason(capabilities)

  const restart = async () => {
    setBusy(true)
    try {
      await resumeInPlace(context, session)
    } catch (error) {
      context.toast('Could not restart', messageOf(error))
    } finally {
      setBusy(false)
    }
  }

  const openTerminal = async () => {
    try {
      await context.call('quirky.terminal/newTab', { workspace: session.worktreeId, agent: session.agent })
    } catch (error) {
      context.toast('Could not open a terminal', messageOf(error))
    }
  }

  return (
    <div role="alert">
      <Card
        label="Error"
        ariaLabel="Agent error"
        tone="failing"
        header={<strong>{`${session.agent} ${TITLES[item.reason]}`}</strong>}
      >
        {item.stderrTail.length > 0 && <pre style={tail}>{item.stderrTail.join('\n')}</pre>}
        <div style={actions}>
          <Button variant="primary" disabled={!item.resumable || busy} title={reason} onClick={() => void restart()}>
            Restart
          </Button>
          <Button onClick={() => void openTerminal()}>Open in terminal</Button>
          <span style={grow} />
          <span style={muted}>{reason ?? 'Your transcript is kept either way.'}</span>
        </div>
      </Card>
    </div>
  )
}
