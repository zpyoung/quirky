import { useState } from 'react'
import type { Session, Worktree } from '@quirky/protocol'
import { closeSession, createSession } from '../actions'
import { useAppState, useConnection, useDispatch, usePluginHost } from '../context'
import { displayStatus } from '../lib/status'
import { NewSessionMenu } from './NewSessionMenu'
import { PromptDialog, type NewSessionRequest } from './PromptDialog'
import { StatusDot } from './StatusDot'

type Props = { worktree: Worktree; sessions: Session[] }

export function SessionTabs({ worktree, sessions }: Props) {
  const state = useAppState()
  const connection = useConnection()
  const dispatch = useDispatch()
  const host = usePluginHost()
  const [pending, setPending] = useState<NewSessionRequest | null>(null)

  const pick = (request: NewSessionRequest) => {
    if (request.agent === 'shell') void createSession(connection, worktree.id, 'shell', '', false)
    else setPending(request)
  }

  return (
    <div className="tabs">
      <div className="tab-scroll" role="tablist">
        {sessions.map((session, index) => (
          <div
            key={session.id}
            role="tab"
            aria-selected={session.id === state.selectedSessionId}
            className={`tab${session.id === state.selectedSessionId ? ' active' : ''}`}
            onClick={() => {
              dispatch({ type: 'selectSession', id: session.id })
              host.closeView()
            }}
            title={`${session.title} (${session.status})${index < 9 ? ` - Cmd+${index + 1}` : ''}`}
          >
            <StatusDot status={displayStatus(session.status)} />
            <span className="tab-title">{session.title}</span>
            <button
              className="icon-button"
              aria-label={`Close ${session.title}`}
              onClick={(event) => {
                event.stopPropagation()
                void closeSession(connection, session)
              }}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <NewSessionMenu onPick={pick} />
      {pending && (
        <PromptDialog
          request={pending}
          onClose={() => setPending(null)}
          onSubmit={(prompt) => {
            const request = pending
            setPending(null)
            void createSession(connection, worktree.id, request.agent, prompt, request.background)
          }}
        />
      )}
    </div>
  )
}
