import { createRoot } from 'react-dom/client'
import type { MountFunction, Session, UiPluginContext } from '@quirky/protocol'
import { ActivityNavigation, ActivityView } from './ActivityView'

const PLUGIN_ID = 'quirky.agent-status'
const ACTIVITY_VIEW_ID = `view:${PLUGIN_ID}/activity`
const ACTIVITY_SIDEBAR_ID = `sidebar-section:${PLUGIN_ID}/activity`
const SESSION_VIEW_ID = 'view:quirky.session/worktree'
const GROUPS = ['status', 'worktree', 'provider', 'none'] as const

type ActivityGroup = (typeof GROUPS)[number]

function objectArgs(args: unknown): Record<string, unknown> {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return {}
  return args as Record<string, unknown>
}

function activityInput(args: unknown): Record<string, unknown> {
  const value = objectArgs(args)
  const group = GROUPS.includes(value.group as ActivityGroup) ? (value.group as ActivityGroup) : 'status'
  return {
    ...(typeof value.worktree === 'string' ? { worktree: value.worktree } : {}),
    ...(typeof value.text === 'string' ? { text: value.text } : {}),
    ...(typeof value.unreadOnly === 'boolean' ? { unreadOnly: value.unreadOnly } : {}),
    group
  }
}

async function openActivityThread(context: UiPluginContext, args: unknown): Promise<void> {
  const input = objectArgs(args)
  const sessionId = input.sessionId
  const worktreeId = input.worktreeId
  const turn = input.turn
  if (typeof sessionId !== 'string' || sessionId === '' || typeof worktreeId !== 'string' || worktreeId === '' || typeof turn !== 'string' || turn === '') {
    throw new Error('Activity destination is unavailable: its exact session, worktree or turn is missing')
  }

  let session: Session
  try {
    session = (await context.call('quirky.session/get', { session: sessionId })) as Session
    if (session.id !== sessionId || session.worktreeId !== worktreeId || session.kind !== 'terminal' || session.status === 'exited') {
      throw new Error('the exact terminal session is no longer available')
    }
    const worktree = (await context.call('quirky.worktree/resolve', { selector: `id:${worktreeId}` })) as { id?: unknown }
    if (worktree.id !== worktreeId) throw new Error('the exact worktree is no longer available')
  } catch (cause) {
    throw new Error(`Activity destination unavailable for ${sessionId}: ${cause instanceof Error ? cause.message : String(cause)}`)
  }

  context.openView(SESSION_VIEW_ID, { worktree: worktreeId, session: sessionId })
  try {
    await context.call('quirky.agent-status/acknowledge', { session: sessionId, turn })
  } catch (cause) {
    context.toast('Activity thread opened, but could not be marked read', cause instanceof Error ? cause.message : String(cause))
  }
}

/** Registers Activity's sidebar entry, view, and public window commands. */
export function activate(context: UiPluginContext): void {
  const mountView: MountFunction = (element, { input }) => {
    Object.assign(element.style, { display: 'flex', flexDirection: 'column', flex: '1', minHeight: '0', minWidth: '0', overflow: 'auto' })
    const root = createRoot(element)
    root.render(<ActivityView context={context} input={input} />)
    return () => root.unmount()
  }
  const mountSidebar: MountFunction = (element) => {
    const root = createRoot(element)
    root.render(<ActivityNavigation context={context} />)
    return () => root.unmount()
  }

  context.provide(ACTIVITY_VIEW_ID, mountView)
  context.provide(ACTIVITY_SIDEBAR_ID, mountSidebar)
  context.provide(`command:${PLUGIN_ID}/openActivity`, (args?: unknown) => context.openView(ACTIVITY_VIEW_ID, activityInput(args)))
  context.provide(`command:${PLUGIN_ID}/openActivityThread`, (args?: unknown) => openActivityThread(context, args))
}
