import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import type { UiPluginContext } from '@quirky/protocol'

// inlined: plugins can't import each other
const SESSION_VIEW = 'view:quirky.session/worktree'

type SessionRow = {
  sessionId: string
  state: string
  worktreeId: string | null
  workspace: string
}

export type SessionsReport = {
  count: number
  rows: { sessionId: string; workspace: string; state: string }[]
}

type Props = { context: UiPluginContext; report: (state: SessionsReport) => void }

const style: Record<string, CSSProperties> = {
  header: { alignItems: 'center' },
  actions: { display: 'flex', gap: 2 },
  list: { listStyle: 'none', margin: 0, padding: 0, overflowY: 'auto' },
  row: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 10px', cursor: 'pointer' },
  workspace: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The live terminal host sessions with the per-row kill, Kill all and Restart actions. Every
 * destructive action asks through the window's own dialog and then calls with `yes`.
 */
export function SessionsPanel({ context, report }: Props) {
  const [rows, setRows] = useState<SessionRow[]>([])
  const mounted = useRef(true)

  const refresh = useCallback(async () => {
    try {
      const result = (await context.call('quirky.terminal/sessions', {})) as { sessions: SessionRow[] }
      if (mounted.current) setRows(result.sessions)
    } catch (error) {
      context.toast('Could not load sessions', messageOf(error))
    }
  }, [context])

  useEffect(() => {
    mounted.current = true
    void refresh()
    const unsubscribe = context.subscribe((event) => {
      if (event.type === 'quirky.session/changed' || event.type === 'quirky.session/removed') void refresh()
    })
    return () => {
      mounted.current = false
      unsubscribe()
    }
  }, [context, refresh])

  useEffect(() => {
    report({
      count: rows.length,
      rows: rows.map(({ sessionId, workspace, state }) => ({ sessionId, workspace, state }))
    })
  }, [report, rows])

  const open = (row: SessionRow) => {
    if (row.worktreeId !== null) context.openView(SESSION_VIEW, { worktree: row.worktreeId, session: row.sessionId })
  }

  const kill = async (row: SessionRow) => {
    const ok = await context.confirm({
      title: 'Kill this session?',
      body: `Force-quits ${row.sessionId}. Any unsaved work in that pane is lost. This can't be undone.`,
      confirmLabel: 'Kill session'
    })
    if (!ok) return
    try {
      await context.call('quirky.terminal/kill', { session: row.sessionId, yes: true })
      context.toast('Killed session.', '')
    } catch (error) {
      context.toast('Could not kill session', messageOf(error))
    }
    await refresh()
  }

  const killAll = async () => {
    const ok = await context.confirm({ title: 'Kill all terminal sessions?', confirmLabel: 'Kill all' })
    if (!ok) return
    try {
      const result = (await context.call('quirky.terminal/killAll', { yes: true })) as { killedCount: number }
      context.toast(`Killed ${result.killedCount} ${result.killedCount === 1 ? 'session' : 'sessions'}.`, '')
    } catch (error) {
      context.toast('Could not kill sessions', messageOf(error))
    }
    await refresh()
  }

  const restart = async () => {
    const ok = await context.confirm({
      title: 'Restart the terminal service?',
      body: 'Open terminals and agents will restart. Terminals on remote hosts are not affected.',
      confirmLabel: 'Restart'
    })
    if (!ok) return
    try {
      await context.call('quirky.terminal/restartHost', { yes: true })
      context.toast('Terminal host restarted.', '')
    } catch (error) {
      context.toast('Restart failed — check logs.', messageOf(error))
    }
    await refresh()
  }

  return (
    <div className="scm">
      <header className="scm-header" style={style.header}>
        <strong>Sessions ({rows.length})</strong>
        <span style={style.actions}>
          <button className="icon-button" aria-label="Refresh" title="Refresh" onClick={() => void refresh()}>
            ↻
          </button>
          <button
            className="icon-button"
            aria-label="Kill all sessions"
            title="Kill all sessions"
            disabled={rows.length === 0}
            onClick={() => void killAll()}
          >
            ✕
          </button>
          <button className="icon-button" aria-label="Restart terminal host" title="Restart terminal host" onClick={() => void restart()}>
            ⟳
          </button>
        </span>
      </header>
      {rows.length === 0 ? (
        <p className="muted pad">No sessions.</p>
      ) : (
        <ul style={style.list}>
          {rows.map((row) => (
            <li
              key={row.sessionId}
              data-session={row.sessionId}
              style={style.row}
              tabIndex={0}
              onClick={() => open(row)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && event.target === event.currentTarget) open(row)
              }}
            >
              <span className="dot dot-done" aria-hidden />
              <span className="sessions-workspace" style={style.workspace}>
                {row.workspace}
              </span>
              <span className="sessions-id muted">{row.sessionId}</span>
              <button
                className="icon-button"
                aria-label={`Kill session ${row.sessionId}`}
                title="Kill session"
                onClick={(event) => {
                  event.stopPropagation()
                  void kill(row)
                }}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
