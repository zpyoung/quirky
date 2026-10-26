import { useEffect, useRef } from 'react'
import { closeSession, createSession } from '../actions'
import { useAppState, useConnection, useDispatch, usePluginHost } from '../context'
import { sessionForDigit } from '../lib/shortcuts'
import { sessionsOf } from '../lib/state'
import { isPaletteChord } from '../plugins/palette'

/**
 * Cmd+T new shell, Cmd+W close the current session, Cmd+1..9 switch tab, Cmd+Shift+P toggle the
 * command palette; any other chord goes to the plugins' keybindings.
 */
export function useShortcuts(togglePalette: () => void): void {
  const state = useAppState()
  const connection = useConnection()
  const dispatch = useDispatch()
  const host = usePluginHost()
  const latest = useRef(state)
  latest.current = state
  const toggle = useRef(togglePalette)
  toggle.current = togglePalette

  useEffect(() => {
    const v1Shortcuts = (event: KeyboardEvent) => {
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
      } else {
        const session = sessionForDigit(sessions, event.key)
        if (session) {
          event.preventDefault()
          // selecting the already-selected session changes no state, so MainArea can't close the view
          host.closeView()
          dispatch({ type: 'selectSession', id: session.id })
        }
      }
    }
    const onKey = (event: KeyboardEvent) => {
      if (isPaletteChord(event)) {
        event.preventDefault()
        event.stopPropagation()
        toggle.current()
        return
      }
      v1Shortcuts(event)
      if (host.handleKey(event)) {
        event.preventDefault()
        event.stopPropagation()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [connection, dispatch, host])
}
