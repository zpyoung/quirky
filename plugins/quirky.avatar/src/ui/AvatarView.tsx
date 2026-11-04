import { useCallback, useEffect, useRef, useState } from 'react'
import { Badge, Button, EmptyState, ListRow, SectionHeader, Tabs, TextField, ToolPanelFrame, type UiStatus } from '@quirky/ui'
import type { UiPluginContext } from '@quirky/protocol'
import type { AvatarUiProps, JournalEntry, Level, NeedAction, NeedsYouItem, ReportModel, SwitchId, WorktreeState } from '../contracts'
import DecisionTrace, { describeToolInput } from './DecisionTrace'

/** What `quirky.avatar/status` returns. */
export type StatusResult = { handoffs: { worktreeId: string; name: string; state: WorktreeState; level: Level }[]; needsYouCount: number }

type Tab = 'live' | 'report' | 'log'

const CHANGED_EVENT = 'quirky.avatar/changed'
const LIVE_FEED_LIMIT = 30
const LOG_LIMIT = 100

const STATE_LABELS: Record<WorktreeState, string> = {
  checking: 'Checking',
  'gate-failed': 'Gate failed',
  briefing: 'Briefing',
  working: 'Working',
  'waiting-on-you': 'Waiting on you',
  'checking-done': 'Checking done',
  'in-review': 'In review',
  'merge-ready': 'Merge ready',
  merged: 'Merged',
  'pr-ready': 'PR ready',
  committed: 'Committed',
  parked: 'Parked',
  done: 'Done'
}

const LEVEL_LABELS: Record<Level, string> = { shadow: 'Shadow', local: 'Local', 'own-branch': 'Own branch', full: 'Full' }

const SWITCH_LABELS: Record<SwitchId, string> = { messaging: 'Messaging on', historyRewrite: 'History rewrites on', deploys: 'Deploys on' }

const ACTION_LABELS: Record<NeedAction, string> = {
  'allow-once': 'Allow once',
  deny: 'Deny',
  confirm: 'Confirm',
  redo: 'Redo',
  'review-accept': 'Accept edit',
  'review-reject': 'Reject edit',
  answer: 'Answer',
  restart: 'Restart',
  'take-back': 'Take back',
  'restart-to-handoff': 'Restart to hand off'
}

const OUTCOME_LABELS: Record<string, string> = { allow: 'Allowed', deny: 'Denied', held: 'Held', retry: 'Asked to retry', passthrough: 'Passed through' }

export const stateLabel = (state: WorktreeState): string => STATE_LABELS[state]
export const levelLabel = (level: Level): string => LEVEL_LABELS[level]

/** Maps a worktree state to the status dot the shared list rows draw. */
export function uiStatusOf(state: WorktreeState): UiStatus {
  switch (state) {
    case 'waiting-on-you':
    case 'parked':
      return 'needs-you'
    case 'gate-failed':
      return 'failing'
    case 'merge-ready':
    case 'merged':
    case 'pr-ready':
    case 'committed':
    case 'done':
      return 'done'
    default:
      return 'working'
  }
}

export const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

/**
 * Calls `quirky.avatar/<method>` on mount and again on every `quirky.avatar/changed` event.
 * A reply that arrives after a newer request, or after unmount, is dropped; a failed refresh keeps
 * the last good data and reports the error.
 */
export function useAvatarQuery<T>(context: UiPluginContext, method: string, params: Record<string, unknown> = {}) {
  const key = JSON.stringify(params)
  const [state, setState] = useState<{ data: T | null; error: string | null }>({ data: null, error: null })
  const generation = useRef(0)

  const refresh = useCallback(() => {
    const mine = ++generation.current
    context.call(`quirky.avatar/${method}`, JSON.parse(key) as Record<string, unknown>).then(
      (data) => {
        if (mine === generation.current) setState({ data: data as T, error: null })
      },
      (cause: unknown) => {
        if (mine === generation.current) setState((previous) => ({ data: previous.data, error: messageOf(cause) }))
      }
    )
  }, [context, method, key])

  useEffect(() => {
    refresh()
    const unsubscribe = context.subscribe((event) => {
      if (event.type === CHANGED_EVENT) refresh()
    })
    return () => {
      generation.current += 1
      unsubscribe()
    }
  }, [context, refresh])

  return { ...state, refresh }
}

const timeOf = (at: number): string => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

function describeEntry(entry: JournalEntry): string {
  const { data } = entry
  if (entry.kind === 'gate') {
    const outcome = typeof data.outcome === 'string' ? (OUTCOME_LABELS[data.outcome] ?? data.outcome) : 'Decided'
    const tool = typeof data.toolName === 'string' ? data.toolName : 'a call'
    const input = data.toolInput === undefined ? '' : describeToolInput(data.toolInput)
    return `${outcome} ${tool}${input === '' ? '' : `: ${input}`}`
  }
  for (const key of ['summary', 'message', 'title', 'reason']) {
    const value = data[key]
    if (typeof value === 'string' && value !== '') return `${entry.kind}: ${value}`
  }
  return entry.kind
}

function nameMap(status: StatusResult | null, report: ReportModel | null): Map<string, string> {
  const names = new Map<string, string>()
  for (const handoff of status?.handoffs ?? []) names.set(handoff.worktreeId, handoff.name)
  for (const story of report?.stories ?? []) names.set(story.worktreeId, story.name)
  return names
}

function Failure({ message }: { message: string | null }) {
  return message === null ? null : <p role="alert">{message}</p>
}

function LiveTab({ context }: { context: UiPluginContext }) {
  const status = useAvatarQuery<StatusResult>(context, 'status')
  const log = useAvatarQuery<JournalEntry[]>(context, 'log', { limit: LIVE_FEED_LIMIT })
  const [failure, setFailure] = useState<string | null>(null)
  const entries = log.data ?? []
  const names = nameMap(status.data, null)

  const takeBack = async (worktreeId: string) => {
    setFailure(null)
    try {
      await context.call('quirky.avatar/takeBack', { worktreeIds: [worktreeId] })
    } catch (cause) {
      setFailure(messageOf(cause))
    }
    status.refresh()
  }

  const handoffs = status.data?.handoffs ?? []
  return (
    <div role="tabpanel" aria-label="Live">
      <Failure message={failure ?? status.error ?? log.error} />
      {handoffs.length === 0 ? (
        <EmptyState message="Nothing handed off." />
      ) : (
        handoffs.map((handoff) => {
          const latest = entries.find((entry) => entry.worktreeId === handoff.worktreeId)
          return (
            <ListRow
              key={handoff.worktreeId}
              title={handoff.name}
              description={`${stateLabel(handoff.state)} · ${levelLabel(handoff.level)}${latest ? ` · ${describeEntry(latest)} · ${timeOf(latest.at)}` : ''}`}
              status={uiStatusOf(handoff.state)}
              trailing={
                <Button aria-label={`Take back ${handoff.name}`} onClick={() => void takeBack(handoff.worktreeId)}>
                  Take back
                </Button>
              }
            />
          )
        })
      )}
      <SectionHeader title="Live" />
      {entries.length === 0 ? (
        <p>No activity yet.</p>
      ) : (
        <ul>
          {entries.map((entry) => (
            <li key={entry.seq}>{`${timeOf(entry.at)} · ${entry.worktreeId === null ? 'all' : (names.get(entry.worktreeId) ?? entry.worktreeId)} · ${describeEntry(entry)}`}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

function NeedRow({ need, worktreeName, busy, onResolve }: { need: NeedsYouItem; worktreeName: string; busy: boolean; onResolve(action: NeedAction, text?: string): void }) {
  const [answer, setAnswer] = useState('')
  const detail = ['reason', 'question', 'summary', 'why'].map((key) => need.detail[key]).find((value): value is string => typeof value === 'string' && value !== '')
  const buttons = need.actions.map((action, index) => (
    <Button
      key={action}
      variant={index === 0 ? 'primary' : 'secondary'}
      disabled={busy || (action === 'answer' && answer.trim() === '')}
      onClick={() => onResolve(action, action === 'answer' ? answer.trim() : undefined)}
    >
      {ACTION_LABELS[action]}
    </Button>
  ))
  return (
    <ListRow
      title={need.title}
      description={
        <>
          <span>{[worktreeName, detail].filter(Boolean).join(' · ')}</span>
          {need.actions.includes('answer') && <TextField label="Your answer" value={answer} onChange={(event) => setAnswer(event.target.value)} />}
        </>
      }
      status="needs-you"
      trailing={<>{buttons}</>}
    />
  )
}

function summaryLine(summary: ReportModel['summary']): string {
  const parts = [`${summary.decisions} decisions: ${summary.allowed} allowed, ${summary.denied} denied, ${summary.held} held, ${summary.guesses} guesses.`]
  if (summary.sleeps.length > 0) {
    const minutes = Math.max(1, Math.round(summary.sleeps.reduce((total, sleep) => total + sleep.durationMs, 0) / 60_000))
    parts.push(`The Mac slept ${summary.sleeps.length === 1 ? 'once' : `${summary.sleeps.length} times`} for ${minutes} min.`)
  }
  if (summary.keptAwake) parts.push('Mac kept awake.')
  return parts.join(' ')
}

function ReportTab({ context, onOpenLog }: { context: UiPluginContext; onOpenLog(): void }) {
  const { data, error, refresh } = useAvatarQuery<ReportModel>(context, 'report')
  const [busyNeed, setBusyNeed] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const names = nameMap(null, data)

  const resolve = async (needId: string, action: NeedAction, text?: string) => {
    setBusyNeed(needId)
    setFailure(null)
    try {
      const result = (await context.call('quirky.avatar/resolveNeed', { needId, action, ...(text === undefined ? {} : { text }) })) as { ok: boolean; error?: string }
      if (!result.ok) setFailure(result.error ?? 'The avatar could not apply that answer.')
    } catch (cause) {
      setFailure(messageOf(cause))
    }
    setBusyNeed(null)
    refresh()
  }

  if (data === null) return <div role="tabpanel" aria-label="Report"><Failure message={error} /></div>
  const count = data.needsYou.length
  return (
    <div role="tabpanel" aria-label="Report">
      <Failure message={failure ?? error} />
      <SectionHeader title={count === 0 ? 'Nothing needs you' : `${count} ${count === 1 ? 'thing needs' : 'things need'} you`} />
      {data.topSkippedCalls.map((entry) => (
        <ListRow
          key={`skipped-${entry.seq}`}
          title={`A call ran without the gate: ${describeEntry(entry)}`}
          description={`${entry.worktreeId === null ? 'all' : (names.get(entry.worktreeId) ?? entry.worktreeId)} · ${timeOf(entry.at)}`}
          status="failing"
        />
      ))}
      {data.needsYou.map((need) => (
        <NeedRow
          key={need.id}
          need={need}
          worktreeName={names.get(need.worktreeId) ?? need.worktreeId}
          busy={busyNeed === need.id}
          onResolve={(action, text) => void resolve(need.id, action, text)}
        />
      ))}
      <SectionHeader title="While you were away" />
      {data.stories.length === 0 ? (
        <p>Nothing handed off.</p>
      ) : (
        data.stories.map((story) => (
          <ListRow
            key={story.worktreeId}
            title={story.name}
            description={
              <>
                {story.switchesOn.map((id) => (
                  <Badge key={id} tone="accent">{SWITCH_LABELS[id]}</Badge>
                ))}
                <span>{story.story}</span>
                {story.handedBackWith.length > 0 && <span>{`Handed back with: ${story.handedBackWith.join(', ')}`}</span>}
              </>
            }
          />
        ))
      )}
      <p>{summaryLine(data.summary)}</p>
      <Button onClick={onOpenLog}>Open decision log →</Button>
    </div>
  )
}

function LogEntryRow({ entry, worktreeName }: { entry: JournalEntry; worktreeName: string }) {
  const [open, setOpen] = useState(false)
  return (
    <li>
      <ListRow
        compact
        title={describeEntry(entry)}
        description={`${timeOf(entry.at)} · ${worktreeName}`}
        trailing={
          entry.kind === 'gate' ? (
            <Button aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Hide trace' : 'Show trace'}</Button>
          ) : undefined
        }
      />
      {open && <DecisionTrace entry={entry} />}
    </li>
  )
}

function LogTab({ context }: { context: UiPluginContext }) {
  const log = useAvatarQuery<JournalEntry[]>(context, 'log', { limit: LOG_LIMIT })
  const status = useAvatarQuery<StatusResult>(context, 'status')
  const names = nameMap(status.data, null)
  const entries = log.data ?? []
  return (
    <div role="tabpanel" aria-label="Log">
      <Failure message={log.error} />
      {entries.length === 0 ? (
        <EmptyState message="The log is empty." />
      ) : (
        <ul>
          {entries.map((entry) => (
            <LogEntryRow key={entry.seq} entry={entry} worktreeName={entry.worktreeId === null ? 'all' : (names.get(entry.worktreeId) ?? entry.worktreeId)} />
          ))}
        </ul>
      )}
    </div>
  )
}

function tabOf(input: unknown): Tab {
  const tab = typeof input === 'object' && input !== null ? (input as { tab?: unknown }).tab : undefined
  return tab === 'report' || tab === 'log' ? tab : 'live'
}

/** The Avatar view with its Live, Report and Log tabs; `input.tab` picks the tab it opens on. */
export default function AvatarView({ context, input }: AvatarUiProps) {
  const requested = tabOf(input)
  const [tab, setTab] = useState<Tab>(requested)
  const status = useAvatarQuery<StatusResult>(context, 'status')
  useEffect(() => setTab(requested), [requested])

  return (
    <ToolPanelFrame title="Avatar">
      <div data-avatar-ui="view">
        <Tabs
          label="Avatar view"
          value={tab}
          onChange={(id) => setTab(id as Tab)}
          items={[
            { id: 'live', label: 'Live' },
            { id: 'report', label: 'Report', count: status.data?.needsYouCount || undefined },
            { id: 'log', label: 'Log' }
          ]}
        />
        {tab === 'live' && <LiveTab context={context} />}
        {tab === 'report' && <ReportTab context={context} onOpenLog={() => setTab('log')} />}
        {tab === 'log' && <LogTab context={context} />}
      </div>
    </ToolPanelFrame>
  )
}
