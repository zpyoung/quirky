import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import type { Session, UiPluginContext, UsageResult } from '@quirky/protocol'
import { Badge, Button, Dialog, IconButton, Tabs } from '@quirky/ui'
import { AgentPicker } from './chat/AgentPicker'
import { compactTokens } from './chat/ChatHeader'
import { RUN_BADGE_COMMAND, type WorktreeSessions } from './model'
import { NewSessionMenu } from './NewSessionMenu'
import { PromptDialog, type NewSessionRequest } from './PromptDialog'
import { sessionStatusPresentation, StatusDot, UNREAD_LABELS, UnreadBell, useNow } from './StatusDot'

const layout = {
  display: 'flex',
  flexDirection: 'column',
  minWidth: 0,
  color: 'var(--ui-text)',
  background: 'var(--ui-surface)'
} satisfies CSSProperties

const tabBar = {
  display: 'flex',
  alignItems: 'flex-end',
  gap: 'var(--ui-space-4)',
  minWidth: 0,
} satisfies CSSProperties

const tabs = { flex: '1 1 auto', minWidth: 0 } satisfies CSSProperties
const actions = { display: 'flex', alignItems: 'center', flex: '0 0 auto', gap: 'var(--ui-space-4)', paddingBottom: 'var(--ui-space-2)' } satisfies CSSProperties
const summary = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 'var(--ui-space-8)',
  padding: 'var(--ui-space-4) var(--ui-space-8)',
  borderBottom: 'var(--ui-border-width) solid var(--ui-border)',
  color: 'var(--ui-muted)',
  fontSize: 'var(--ui-font-label)',
  minWidth: 0
} satisfies CSSProperties
const sessionControls = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 'var(--ui-space-8)',
  padding: 'var(--ui-space-4) var(--ui-space-8)',
  borderBottom: 'var(--ui-border-width) solid var(--ui-border)',
  minWidth: 0
} satisfies CSSProperties
const sessionControlGroup = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 'var(--ui-space-4)',
  minWidth: 0
} satisfies CSSProperties
const sessionName = { color: 'var(--ui-muted)', fontSize: 'var(--ui-font-label)', overflowWrap: 'anywhere' } satisfies CSSProperties

type Props = { context: UiPluginContext; store: WorktreeSessions; sessions: Session[]; active: Session | null }

function tabLabel(session: Session, now: number, index: number): string {
  const presentation = sessionStatusPresentation(session, now)
  const labels = [session.title, presentation.label]
  if (session.unread) labels.push(UNREAD_LABELS[session.unread])
  if (presentation.progress !== null) labels.push(`${presentation.progress}%`)
  for (const badge of Object.values(session.badges ?? {})) labels.push(badge.label)
  if (index < 9) labels.push(`Cmd+${index + 1}`)
  return labels.join(' · ')
}

/** The conversation token total of each structured session in `sessions`, kept current as the daemon reports usage; sessions without data are absent. */
function useConversationTotals(context: UiPluginContext, sessions: readonly Session[]): Record<string, number> {
  const [totals, setTotals] = useState<Record<string, number>>({})
  const ids = sessions.filter((session) => session.kind === 'structured').map((session) => session.id)
  const key = ids.join(',')
  useEffect(() => {
    let cancelled = false
    const load = (id: string) => {
      context
        .call('quirky.structured/usage', { session: id })
        .then((result) => {
          const { conversation, turns } = result as UsageResult
          const total = turns >= 1 ? (conversation?.total ?? 0) : 0
          if (cancelled) return
          setTotals((current) => {
            const { [id]: _previous, ...others } = current
            return total > 0 ? { ...others, [id]: total } : others
          })
        })
        .catch(() => {})
    }
    for (const id of ids) load(id)
    const unsubscribe = context.subscribe((event) => {
      if (event.type !== 'quirky.structured/usageChanged') return
      const changed = (event.data as { sessionId?: string } | undefined)?.sessionId
      if (changed !== undefined && ids.includes(changed)) load(changed)
    })
    const unsubscribeConnection = context.onConnection((status) => {
      if (status === 'connected') for (const id of ids) load(id)
    })
    return () => {
      cancelled = true
      unsubscribe()
      unsubscribeConnection()
    }
  }, [context, key])
  return totals
}

export function SessionTabs({ context, store, sessions, active }: Props) {
  const [pending, setPending] = useState<NewSessionRequest | null>(null)
  const [choosing, setChoosing] = useState(false)
  const now = useNow()
  const totals = useConversationTotals(context, sessions)
  const items = useMemo(
    () =>
      sessions.map((session, index) => {
        const total = totals[session.id]
        return { id: session.id, label: tabLabel(session, now, index), ...(total === undefined ? {} : { tooltip: `${compactTokens(total)} tokens` }) }
      }),
    [sessions, now, totals]
  )

  const pick = (request: NewSessionRequest) => {
    if (request.agent === 'shell') void store.create('shell', '', false)
    else setPending(request)
  }

  const activePresentation = active ? sessionStatusPresentation(active, now) : null

  return (
    <div style={layout}>
      <div style={tabBar}>
        <div style={tabs}>
          <Tabs label="Sessions" items={items} value={active?.id ?? ''} onChange={(id) => store.open(id)} />
        </div>
        <div style={actions}><NewSessionMenu context={context} onPick={pick} onChat={() => setChoosing(true)} /></div>
      </div>
      {active && activePresentation && (
        <div style={summary} role="status">
          {active.unread ? <UnreadBell reason={active.unread} /> : <StatusDot session={active} now={now} />}
          <span>{active.unread ? `${UNREAD_LABELS[active.unread]} · ${activePresentation.label}` : activePresentation.label}</span>
          {activePresentation.progress !== null && (
            <Badge tone="accent" label={`Progress ${activePresentation.progress}%`}>
              {activePresentation.progress}%
            </Badge>
          )}
        </div>
      )}
      {sessions.length > 0 && (
        <div style={sessionControls} role="group" aria-label="Session actions">
          {sessions.map((session) => (
            <div key={session.id} style={sessionControlGroup} role="group" aria-label={`Actions for ${session.title}`}>
              <span style={sessionName}>{session.title}</span>
              {Object.entries(session.badges ?? {}).map(([key, badge]) => badge.command ? (
                <Button key={key} type="button" title={badge.tooltip} onClick={() => void context.executeCommand(RUN_BADGE_COMMAND, { session: session.id, badge: key })}>
                  {badge.label}
                </Button>
              ) : (
                <span key={key} title={badge.tooltip}>
                  <Badge label={badge.tooltip ?? badge.label}>{badge.label}</Badge>
                </span>
              ))}
              <IconButton
                label={`Close ${session.title}`}
                title={`Close ${session.title}`}
                onClick={() => void store.close(session)}
              >
                ×
              </IconButton>
            </div>
          ))}
        </div>
      )}
      {choosing && (
        <Dialog open title="New chat" onClose={() => setChoosing(false)}>
          <AgentPicker
            heading={false}
            context={context}
            worktree={store.report().worktree}
            onCreated={(created) => {
              setChoosing(false)
              store.open(created.id)
            }}
          />
        </Dialog>
      )}
      {pending && (
        <PromptDialog
          request={pending}
          store={store}
          onClose={() => setPending((current) => current === pending ? null : current)}
        />
      )}
    </div>
  )
}
