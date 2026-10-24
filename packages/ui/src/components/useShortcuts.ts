import { useEffect, useRef } from 'react'
import { closeSession, createSession } from '../actions'
import { useAppState, useConnection, useDispatch } from '../context'
import { sessionsOf } from '../lib/state'

/** Cmd+T new shell, Cmd+W close the current session, Cmd+1..9 switch tab. */
export function useShortcuts(): void {
  const state = useAppState()
  const connection = useConnection()
  const dispatch = useDispatch()
  const latest = useRef(state)
  latest.current = state

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
      const current = latest.current
      const worktreeId = current.selectedWorktreeId
      if (!worktreeId) return
      const sessions = sessionsOf(current, worktreeId)
      if (event.key === 't') {
        event.preventDefault()
        void createSession(connection, worktreeId, 'shell', '', false)
      } else if (event.key === 'w') {
        event.preventDefault()
        const session = sessions.find((s) => s.id === current.selectedSessionId)
        if (session) void closeSession(connection, session)
      } else if (/^[1-9]$/.test(event.key)) {
        const session = sessions[Number(event.key) - 1]
        if (session) {
          event.preventDefault()
          dispatch({ type: 'selectSession', id: session.id })
        }
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [connection, dispatch])
}
