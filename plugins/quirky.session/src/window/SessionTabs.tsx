import { useMemo, useState, type CSSProperties } from 'react'
import type { Session, UiPluginContext } from '@quirky/protocol'
import { Badge, Button, IconButton, Tabs } from '@quirky/ui'
import type { WorktreeSessions } from './model'
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

export function SessionTabs({ context, store, sessions, active }: Props) {
  const [pending, setPending] = useState<NewSessionRequest | null>(null)
  const now = useNow()
  const items = useMemo(() => sessions.map((session, index) => ({ id: session.id, label: tabLabel(session, now, index) })), [sessions, now])

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
        <div style={actions}><NewSessionMenu context={context} onPick={pick} /></div>
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
                <Button key={key} type="button" title={badge.tooltip} onClick={() => void context.executeCommand(badge.command!, badge.args)}>
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
      {pending && (
        <PromptDialog
          request={pending}
          onClose={() => setPending(null)}
          onSubmit={async (prompt) => {
            const request = pending
            if (await store.create(request.agent, prompt, request.background)) {
              setPending((current) => current === request ? null : current)
            }
          }}
        />
      )}
    </div>
  )
}
