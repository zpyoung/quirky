import type { CallState, ChatItem, StructuredMessage } from '@quirky/protocol'
import { visibleMessages } from '../transcript'

type Of<K extends ChatItem['kind']> = Extract<ChatItem, { kind: K }>

export type ActivityItem = Of<'activity'>
export type FileChangeItem = Of<'file-change'>
export type TestsItem = Of<'tests'>
export type StepsItem = Of<'steps'>
export type PlanItem = Of<'plan'>

/** What a turn's steps card shows: its steps are not calls, so the state comes from the steps and the turn's end. */
export type StepsState = CallState

/** One tool call inside a folded activity group, with the span between its first and last journal entries. */
export type ActivityCall = { seq: number; item: ActivityItem; startAt: number; endAt: number }

/** A renderable piece of a turn, in journal order. */
export type Block =
  | { kind: 'prose'; seq: number; text: string; streaming: boolean }
  | { kind: 'activity'; seq: number; calls: ActivityCall[] }
  | { kind: 'file-change'; seq: number; item: FileChangeItem }
  | { kind: 'tests'; seq: number; item: TestsItem }
  | { kind: 'steps'; seq: number; item: StepsItem; state: StepsState }
  | { kind: 'plan'; seq: number; item: PlanItem }
  | { kind: 'ask'; seq: number; item: Of<'ask'> }
  | { kind: 'view'; seq: number; item: Of<'view'> }
  | { kind: 'view-error'; seq: number; item: Of<'view-error'> }
  | { kind: 'changes'; seq: number; item: Of<'changes'> }
  | { kind: 'error'; seq: number; item: Of<'error'> }
  | { kind: 'status'; seq: number; text: string }
  | { kind: 'legacy'; seq: number; message: StructuredMessage }

export type TurnEnd = { state: Of<'turn-end'>['state']; durationMs?: number }

/** A user message and everything the agent did in reply, up to the next user message. */
export type Turn = {
  key: string
  at: number
  user: { seq: number; text: string; images: string[] } | null
  blocks: Block[]
  end: TurnEnd | null
}

type CallEntry = { kind: 'call'; seq: number; item: ActivityItem | FileChangeItem | TestsItem | StepsItem; startAt: number; endAt: number }

type Entry =
  | CallEntry
  | PlainEntry
  | { kind: 'legacy'; seq: number; message: StructuredMessage }

type PlainEntry = { kind: 'plain'; seq: number; item: ChatItem }

type Draft = { turn: Turn; entries: Entry[] }

const isCall = (item: ChatItem): item is ActivityItem | FileChangeItem | TestsItem | StepsItem =>
  item.kind === 'activity' || item.kind === 'file-change' || item.kind === 'tests' || item.kind === 'steps'

const callIdOf = (item: ActivityItem | FileChangeItem | TestsItem | StepsItem): string => item.callId

/** Whether a journaled message is content the Claude CLI added to the conversation itself, such as a skill's SKILL.md. */
const isAgentInjected = (message: StructuredMessage): boolean =>
  typeof message.data === 'object' && message.data !== null && (message.data as { isSynthetic?: unknown }).isSynthetic === true

/**
 * `messages` (in journal order) as turns. A `user` item starts a turn, and a message before the
 * first one goes in a turn with no user message; a `user` item the agent injected itself is
 * dropped. Of the items sharing a `callId` only the last counts, shown where the first appeared, and
 * the same holds for the `plan` items of one version across turns. `mode` items only feed the
 * composer and never render. Messages with no `item` stay as `legacy` blocks, and `status` items and
 * diagnostics are left out unless `showAll`.
 */
export function groupTurns(messages: StructuredMessage[], { showAll = false }: { showAll?: boolean } = {}): Turn[] {
  const drafts: Draft[] = []
  const calls = new Map<string, CallEntry>()
  const plans = new Map<number, PlainEntry>()
  const open = (message: StructuredMessage, user: Turn['user']): Draft => {
    const draft: Draft = { turn: { key: `turn-${message.seq}`, at: message.at, user, blocks: [], end: null }, entries: [] }
    drafts.push(draft)
    return draft
  }

  for (const message of messages) {
    const item = message.item
    if (!item) {
      if (visibleMessages([message], showAll).length === 0) continue
      const draft = drafts[drafts.length - 1] ?? open(message, null)
      draft.entries.push({ kind: 'legacy', seq: message.seq, message })
      continue
    }
    if (item.kind === 'user') {
      if (isAgentInjected(message)) continue
      open(message, { seq: message.seq, text: item.text, images: item.images ?? [] })
      continue
    }
    if (item.kind === 'status' && !showAll) continue
    if (item.kind === 'mode') continue
    const draft = drafts[drafts.length - 1] ?? open(message, null)
    if (item.kind === 'turn-end') {
      draft.turn.end = { state: item.state, ...(item.durationMs === undefined ? {} : { durationMs: item.durationMs }) }
      continue
    }
    if (isCall(item)) {
      const existing = calls.get(callIdOf(item))
      if (existing) {
        existing.item = item
        existing.endAt = message.at
        continue
      }
      const entry: CallEntry = { kind: 'call', seq: message.seq, item, startAt: message.at, endAt: message.at }
      calls.set(callIdOf(item), entry)
      draft.entries.push(entry)
      continue
    }
    if (item.kind === 'plan') {
      const existing = plans.get(item.version)
      if (existing) {
        existing.item = item
        continue
      }
      const entry: PlainEntry = { kind: 'plain', seq: message.seq, item }
      plans.set(item.version, entry)
      draft.entries.push(entry)
      continue
    }
    draft.entries.push({ kind: 'plain', seq: message.seq, item })
  }

  return drafts.map(({ turn, entries }) => ({ ...turn, blocks: toBlocks(entries, turn.end) }))
}

const settle = <T extends { state: CallState }>(item: T, stopped: boolean): T =>
  stopped && item.state === 'running' ? { ...item, state: 'stopped' } : item

/** The steps card's state: stopped or failed when its turn ended that way with work left, done when every step is. */
function stepsState(item: StepsItem, end: TurnEnd | null): StepsState {
  if (item.steps.length > 0 && item.steps.every((step) => step.state === 'done')) return 'done'
  if (end?.state === 'stopped') return 'stopped'
  if (end?.state === 'failed') return 'failed'
  return end ? 'done' : 'running'
}

/** `entries` without the streaming prose partials that a later prose entry of the same turn replaced. */
function dropSupersededPartials(entries: Entry[]): Entry[] {
  const isProse = (entry: Entry) => entry.kind === 'plain' && entry.item.kind === 'prose'
  let lastProse = -1
  entries.forEach((entry, index) => {
    if (isProse(entry)) lastProse = index
  })
  return entries.filter((entry, index) => {
    if (entry.kind !== 'plain' || entry.item.kind !== 'prose' || entry.item.streaming !== true) return true
    return index === lastProse
  })
}

function toBlocks(allEntries: Entry[], end: TurnEnd | null): Block[] {
  const stopped = end?.state === 'stopped'
  const entries = dropSupersededPartials(allEntries)
  const blocks: Block[] = []
  for (const entry of entries) {
    if (entry.kind === 'legacy') {
      blocks.push({ kind: 'legacy', seq: entry.seq, message: entry.message })
      continue
    }
    const { item } = entry
    switch (item.kind) {
      case 'activity': {
        const { startAt, endAt } = entry as CallEntry
        const call: ActivityCall = { seq: entry.seq, item: settle(item, stopped), startAt, endAt }
        const last = blocks[blocks.length - 1]
        if (last?.kind === 'activity') last.calls.push(call)
        else blocks.push({ kind: 'activity', seq: entry.seq, calls: [call] })
        break
      }
      case 'file-change':
        blocks.push({ kind: 'file-change', seq: entry.seq, item: settle(item, stopped) })
        break
      case 'tests':
        blocks.push({ kind: 'tests', seq: entry.seq, item: settle(item, stopped) })
        break
      case 'steps':
        blocks.push({ kind: 'steps', seq: entry.seq, item, state: stepsState(item, end) })
        break
      case 'prose':
        if (item.text.trim() !== '' || item.streaming) blocks.push({ kind: 'prose', seq: entry.seq, text: item.text, streaming: item.streaming === true })
        break
      case 'status':
        blocks.push({ kind: 'status', seq: entry.seq, text: item.text })
        break
      case 'plan':
        blocks.push({ kind: 'plan', seq: entry.seq, item })
        break
      case 'ask':
      case 'view':
      case 'view-error':
      case 'changes':
      case 'error':
        blocks.push({ kind: item.kind, seq: entry.seq, item } as Block)
        break
      default:
        break
    }
  }
  return blocks
}

/** "12s" or "1m 05s"; empty under one second, so an instant call shows no time. */
export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 1) return ''
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
}

type Category = 'read' | 'search' | 'command' | 'web' | 'other'

/** Which family a tool belongs to, from its name in any of the four agents' spellings. */
export function categoryOf(tool: string): Category {
  const name = tool.toLowerCase().replace(/[^a-z]/g, '')
  if (name.startsWith('web') || name.startsWith('fetch') || name.startsWith('browse')) return 'web'
  if (name.startsWith('read') || name === 'view' || name === 'cat' || name.startsWith('open')) return 'read'
  if (/^(grep|glob|search|find|ls|list|rg)/.test(name)) return 'search'
  if (/^(bash|shell|exec|command|run|terminal)/.test(name)) return 'command'
  return 'other'
}

const NOUNS: Record<Category, [string, string]> = {
  read: ['file', 'files'],
  search: ['pattern', 'patterns'],
  command: ['command', 'commands'],
  web: ['page', 'pages'],
  other: ['other tool', 'other tools']
}

const VERBS: Record<Category, { done: string; running: string }> = {
  read: { done: 'read', running: 'reading' },
  search: { done: 'searched', running: 'searching' },
  command: { done: 'ran', running: 'running' },
  web: { done: 'fetched', running: 'fetching' },
  other: { done: 'used', running: 'using' }
}

const plural = (count: number, [one, many]: [string, string]) => `${count} ${count === 1 ? one : many}`

/**
 * One line for a folded group of calls: "Read 4 files · searched 2 patterns · 12s". Calls still
 * running read as "running 1 command" and have no time; failed and stopped calls are counted at
 * the end. The time spans the group's first to last journal entry.
 */
export function summarizeActivity(calls: ActivityCall[]): string {
  const order: Category[] = []
  const tally = new Map<Category, { done: number; running: number }>()
  let failed = 0
  let stopped = 0
  let running = 0
  for (const call of calls) {
    const category = categoryOf(call.item.tool)
    if (!tally.has(category)) {
      tally.set(category, { done: 0, running: 0 })
      order.push(category)
    }
    const counts = tally.get(category)!
    if (call.item.state === 'running') {
      counts.running += 1
      running += 1
    } else {
      counts.done += 1
      if (call.item.state === 'failed') failed += 1
      if (call.item.state === 'stopped') stopped += 1
    }
  }
  const parts: string[] = []
  for (const category of order) {
    const { done, running: active } = tally.get(category)!
    if (done > 0) parts.push(`${VERBS[category].done} ${plural(done, NOUNS[category])}`)
    if (active > 0) parts.push(`${VERBS[category].running} ${plural(active, NOUNS[category])}`)
  }
  const first = parts[0] ?? 'no activity'
  const line = [`${first.charAt(0).toUpperCase()}${first.slice(1)}`, ...parts.slice(1)]
  if (failed > 0) line.push(`${failed} failed`)
  if (stopped > 0) line.push(`${stopped} stopped`)
  if (running === 0 && calls.length > 0) {
    const span = formatDuration(Math.max(...calls.map((call) => call.endAt)) - Math.min(...calls.map((call) => call.startAt)))
    if (span !== '') line.push(span)
  }
  return line.join(' · ')
}

/** Whether the last turn is still open: it has a user message and no end yet. */
export function lastTurnOpen(turns: Turn[]): boolean {
  const last = turns[turns.length - 1]
  return last !== undefined && last.user !== null && last.end === null
}
