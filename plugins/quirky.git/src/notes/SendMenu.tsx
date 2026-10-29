import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { ContextMenu, IconButton, StatusDot } from '@quirky/ui'
import type { ContextMenuItem, UiStatus } from '@quirky/ui'
import type { UiPluginContext } from '@quirky/protocol'
import type { NoteTarget } from '../daemon/targets'
import { messageOf, relativeTime } from '../panel/format'
import type { Note } from './useNotes'

/** What `quirky.git/sendNotes` is asked to take; the menu adds the target. */
export type SendParams = { scope: 'note'; id: string } | { scope: 'file'; path: string } | { scope: 'all' }

/** One thing the menu can send: a label, the notes it covers and the parameters that select them. */
export type SendScope = { id: string; label: string; notes: readonly Note[]; params: SendParams }

type Targets = { sessions: NoteTarget[]; agents: Array<{ id: string; label: string }> }

/** A keyboard request to open the shelf's menu; dropped once it is this old. */
export type SendRequest = { nonce: number; issuedAt: number }

export const SEND_REQUEST_TTL_MS = 5000

const heldIds = new Map<string, number>()
let heldVersion = 0
let request: SendRequest | null = null
const listeners = new Set<() => void>()

const notify = () => {
  heldVersion++
  for (const listener of [...listeners]) listener()
}
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

/** Whether a send started in this window is still carrying the note, so another send leaves it out. */
export const isHeld = (id: string): boolean => heldIds.has(id)

function hold(ids: readonly string[], settled: Promise<unknown>): void {
  for (const id of ids) heldIds.set(id, (heldIds.get(id) ?? 0) + 1)
  notify()
  const release = () => {
    for (const id of ids) {
      const left = (heldIds.get(id) ?? 1) - 1
      if (left <= 0) heldIds.delete(id)
      else heldIds.set(id, left)
    }
    notify()
  }
  settled.then(release, release)
}

/** Asks the Source Control shelf to open its send menu; `null` withdraws the pending request. */
export function postSendRequest(next: SendRequest | null): void {
  request = next
  notify()
}

const NO_REQUEST = () => request

function targetEntry(target: NoteTarget, send: (to: { session: string }) => void): ContextMenuItem {
  const state = target.state ?? target.status
  const label = state.charAt(0).toUpperCase() + state.slice(1)
  const status: UiStatus = state === 'waiting' || state === 'blocked' ? 'needs-you' : state === 'done' ? 'done' : 'working'
  const parts = [label, relativeTime(target.lastActivityAt), ...(target.title.trim() === '' ? [] : [target.title.trim()])]
  return {
    label: target.label,
    icon: <StatusDot status={status} label={label} />,
    detail: parts.join(' · '),
    enabled: target.sendable,
    ...(target.reason === undefined ? {} : { title: target.reason }),
    onSelect: () => send({ session: target.session })
  }
}

/** The rows that choose where a scope goes: running sessions, then agents to start. */
function targetEntries(targets: Targets, send: (to: { session: string } | { agent: string }) => void): ContextMenuItem[] {
  const rows: ContextMenuItem[] = [{ label: 'Send notes to', heading: true }, ...targets.sessions.map((target) => targetEntry(target, send))]
  rows.push({ label: 'New agent', heading: true, separatorBefore: true })
  for (const agent of targets.agents) rows.push({ label: agent.label, onSelect: () => send({ agent: agent.id }) })
  if (targets.agents.length === 0) rows.push({ label: 'No agents available', enabled: false })
  return rows
}

type Props = {
  context: UiPluginContext
  worktree: string
  /** One scope lists its targets directly; several list the scopes first, each opening the targets. */
  scopes: readonly SendScope[]
  /** The trigger's accessible name; "Send notes to an agent" by default. */
  ariaLabel?: string
  /** The trigger's content; a send icon by default. */
  children?: ReactNode
  /** Opens in answer to `postSendRequest`; enable on one instance per window. */
  respondToRequest?: boolean
}

/**
 * The button and menu that send notes to an agent. Notes a send of this window is carrying are
 * left out of every scope, so the trigger reads "Sending…" while all of them are on their way
 * and "All notes sent" when none are left. Sending toasts its progress and its failure.
 */
export function SendMenu({ context, worktree, scopes, ariaLabel, children, respondToRequest }: Props) {
  useSyncExternalStore(subscribe, () => heldVersion)
  const pending = useSyncExternalStore(subscribe, NO_REQUEST)
  const anchor = useRef<HTMLSpanElement>(null)
  const alive = useRef(true)
  const [menu, setMenu] = useState<{ x: number; y: number; targets: Targets } | null>(null)

  const sendable = scopes.map((scope) => ({ ...scope, unsent: scope.notes.filter((note) => !isHeld(note.id)) }))
  const deliverable = sendable.some((scope) => scope.unsent.length > 0)
  const idle = scopes.some((scope) => scope.notes.length > 0) ? 'Sending…' : 'All notes sent'

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const show = async () => {
    const box = anchor.current?.getBoundingClientRect()
    try {
      const targets = (await context.call('quirky.git/noteTargets', { worktree })) as Targets
      if (alive.current) setMenu({ x: box?.left ?? 0, y: box?.bottom ?? 0, targets })
    } catch (error) {
      context.toast('Failed to load agents', messageOf(error))
    }
  }

  useEffect(() => {
    if (!respondToRequest || pending === null) return
    postSendRequest(null)
    if (Date.now() - pending.issuedAt <= SEND_REQUEST_TTL_MS && deliverable) void show()
  }, [pending])

  const deliver = async (scope: (typeof sendable)[number], to: { session: string } | { agent: string }) => {
    const sending = context.call('quirky.git/sendNotes', { worktree, ...scope.params, ...to })
    hold(scope.unsent.map((note) => note.id), sending)
    context.toast('Sending notes...', '')
    try {
      await sending
      context.toast('Notes sent.', '')
    } catch (error) {
      context.toast('Failed to send notes', messageOf(error))
    }
  }

  const entries = (targets: Targets): ContextMenuItem[] => {
    const rowsFor = (scope: (typeof sendable)[number]) => targetEntries(targets, (to) => void deliver(scope, to))
    if (sendable.length === 1) return rowsFor(sendable[0]!)
    return [
      { label: 'Send notes', heading: true },
      ...sendable.map((scope) => ({ label: scope.label, badge: scope.unsent.length, enabled: scope.unsent.length > 0, submenu: rowsFor(scope) }))
    ]
  }

  return (
    <>
      <span ref={anchor}>
        <IconButton
          label={ariaLabel ?? 'Send notes to an agent'}
          aria-haspopup="menu"
          title={deliverable ? 'Send notes to an agent' : idle}
          disabled={!deliverable}
          onClick={() => void show()}
        >
          {children ?? '➤'}
        </IconButton>
      </span>
      {menu && <ContextMenu x={menu.x} y={menu.y} label="Send notes" items={entries(menu.targets)} onClose={() => setMenu(null)} />}
    </>
  )
}
