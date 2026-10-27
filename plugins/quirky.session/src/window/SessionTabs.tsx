import { useState, type CSSProperties } from 'react'
import type { Session, UiPluginContext } from '@quirky/protocol'
import type { WorktreeSessions } from './model'
import { NewSessionMenu } from './NewSessionMenu'
import { PromptDialog, type NewSessionRequest } from './PromptDialog'
import { displayStatus } from './status'
import { StatusDot, UnreadBell, useNow } from './StatusDot'

const BADGE_STYLE: CSSProperties = {
  flex: 'none',
  maxWidth: 90,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  padding: '0 6px',
  border: '1px solid var(--border)',
  borderRadius: 8,
  background: 'var(--bg-hover)',
  color: 'var(--muted)',
  font: 'inherit',
  fontSize: 10,
  lineHeight: '14px'
}

type Props = { context: UiPluginContext; store: WorktreeSessions; sessions: Session[]; active: Session | null }

export function SessionTabs({ context, store, sessions, active }: Props) {
  const [pending, setPending] = useState<NewSessionRequest | null>(null)
  const now = useNow()

  const pick = (request: NewSessionRequest) => {
    if (request.agent === 'shell') void store.create('shell', '', false)
    else setPending(request)
  }

  return (
    <div className="tabs">
      <div className="tab-scroll" role="tablist">
        {sessions.map((session, index) => (
          <div
            key={session.id}
            role="tab"
            aria-selected={session.id === active?.id}
            className={`tab${session.id === active?.id ? ' active' : ''}`}
            onClick={() => store.open(session.id)}
            title={`${session.title} (${session.status})${index < 9 ? ` - Cmd+${index + 1}` : ''}`}
          >
            {session.unread ? (
              <UnreadBell reason={session.unread} />
            ) : (
              <StatusDot
                status={displayStatus(session.status)}
                summary={session.agentStatus}
                now={now}
                running={session.status !== 'exited'}
              />
            )}
            <span className="tab-title">{session.title}</span>
            {Object.entries(session.badges ?? {}).map(([key, badge]) =>
              badge.command ? (
                <button
                  key={key}
                  type="button"
                  title={badge.tooltip}
                  style={{ ...BADGE_STYLE, cursor: 'pointer' }}
                  onClick={(event) => {
                    event.stopPropagation()
                    void context.executeCommand(badge.command!, badge.args)
                  }}
                >
                  {badge.label}
                </button>
              ) : (
                <span key={key} title={badge.tooltip} style={BADGE_STYLE}>
                  {badge.label}
                </span>
              )
            )}
            <button
              className="icon-button"
              aria-label={`Close ${session.title}`}
              onClick={(event) => {
                event.stopPropagation()
                void store.close(session)
              }}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <NewSessionMenu context={context} onPick={pick} />
      {pending && (
        <PromptDialog
          request={pending}
          onClose={() => setPending(null)}
          onSubmit={(prompt) => {
            const request = pending
            setPending(null)
            void store.create(request.agent, prompt, request.background)
          }}
        />
      )}
    </div>
  )
}
