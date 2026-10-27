import { useState } from 'react'
import type { Session, UiPluginContext } from '@quirky/protocol'
import type { WorktreeSessions } from './model'
import { NewSessionMenu } from './NewSessionMenu'
import { PromptDialog, type NewSessionRequest } from './PromptDialog'
import { displayStatus } from './status'
import { StatusDot, UnreadBell, useNow } from './StatusDot'

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
