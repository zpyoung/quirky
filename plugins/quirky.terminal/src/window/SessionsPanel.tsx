import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, EmptyState, IconButton, ListRow, ToolPanelFrame } from '@quirky/ui'
import type { UiPluginContext } from '@quirky/protocol'

// inlined: plugins can't import each other
const SESSION_VIEW = 'view:quirky.session/worktree'

type SessionRow = {
  sessionId: string
  state: string
  worktreeId: string | null
  workspace: string
  cwd: string
  tabTitle: string | null
  worktreeName: string | null
}

export type SessionsReport = {
  count: number
  rows: { sessionId: string; workspace: string; state: string }[]
}

type Props = { context: UiPluginContext; report: (state: SessionsReport) => void }


function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function statusFor(state: string): 'working' | 'needs-you' | 'done' | 'idle' {
  switch (state) {
    case 'starting':
    case 'running':
    case 'working':
      return 'working'
    case 'waiting':
      return 'needs-you'
    case 'done':
      return 'done'
    case 'exited':
    default:
      return 'idle'
  }
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
      if (
        event.type === 'quirky.session/changed' ||
        event.type === 'quirky.session/removed' ||
        event.type === 'quirky.terminal/layout'
      ) void refresh()
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
    <div className="tt-tool-panel-fill tt-sessions-panel">
      <ToolPanelFrame
        title={`Sessions (${rows.length})`}
        actions={
          <span className="tt-panel-actions">
            <IconButton label="Refresh" title="Refresh" onClick={() => void refresh()}>↻</IconButton>
            <Button aria-label="Restart terminal host" title="Restart terminal host" onClick={() => void restart()}>Restart host</Button>
            <Button
              aria-label="Kill all sessions"
              title="Kill all sessions"
              variant="destructive"
              disabled={rows.length === 0}
              onClick={() => void killAll()}
            >
              Kill all
            </Button>
          </span>
        }
      >
        {rows.length === 0 ? (
          <EmptyState message="No sessions." action={{ label: 'Refresh', onAction: () => void refresh() }} />
        ) : (
          <ul className="tt-sessions-list">
            {rows.map((row) => (
              <li
                key={row.sessionId}
                data-session={row.sessionId}
                tabIndex={0}
                onClick={() => open(row)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && event.target === event.currentTarget) open(row)
                }}
              >
                <ListRow
                  title={<span className="sessions-workspace">{row.tabTitle ?? row.cwd}</span>}
                  description={
                    <span className="tt-session-meta">
                      {row.worktreeName !== null && <span>{row.worktreeName}</span>}
                      <span className="tt-session-state">{row.state}</span>
                    </span>
                  }
                  status={statusFor(row.state)}
                  trailing={
                    <IconButton
                      label={`Kill session ${row.sessionId}`}
                      title="Kill session"
                      variant="destructive"
                      onClick={(event) => {
                        event.stopPropagation()
                        void kill(row)
                      }}
                    >
                      ×
                    </IconButton>
                  }
                />
              </li>
            ))}
          </ul>
        )}
      </ToolPanelFrame>
    </div>
  )
}
