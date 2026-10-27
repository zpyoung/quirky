import { createRoot } from 'react-dom/client'
import type { MountFunction, UiPluginContext } from '@quirky/protocol'
import { WORKTREE_VIEW_ID, WorktreeSessions } from './window/model'
import { WorktreeView } from './window/WorktreeView'

const PLUGIN_ID = 'quirky.session'
const TAB_SHORTCUTS = [1, 2, 3, 4, 5, 6, 7, 8, 9]

/** The worktree the layout's open session view names, if any. */
function layoutWorktree(context: UiPluginContext): string | null {
  const view = context.getLayout().view
  const worktree = view?.id === WORKTREE_VIEW_ID ? (view.input as { worktree?: unknown } | undefined)?.worktree : undefined
  return typeof worktree === 'string' && worktree !== '' ? worktree : null
}

function parseInput(input: unknown): { worktree: string | null; session: string | undefined } {
  const { worktree, session } = (input ?? {}) as { worktree?: unknown; session?: unknown }
  return {
    worktree: typeof worktree === 'string' && worktree !== '' ? worktree : null,
    session: typeof session === 'string' && session !== '' ? session : undefined
  }
}

/**
 * Activates the session plugin's window code: the worktree view with its tabs, terminal and
 * transcript, and the commands that act on the open view.
 */
export function activate(context: UiPluginContext): void {
  let current: WorktreeSessions | null = null

  const mountView: MountFunction = (element, { input, report }) => {
    const { worktree, session } = parseInput(input)
    Object.assign(element.style, { display: 'flex', flexDirection: 'column', flex: '1', minHeight: '0' })
    const root = createRoot(element)
    if (worktree === null) {
      root.render(<p className="muted pad">Pick a worktree to see its sessions.</p>)
      report?.({ worktree: null, tabs: [], active: null, visibleSessions: [] })
      return () => root.unmount()
    }
    const store = new WorktreeSessions(context, worktree, session)
    current = store
    const unsubscribe = store.subscribe(() => {
      if (store.getSnapshot().status !== 'loading') report?.(store.report())
    })
    store.start()
    root.render(<WorktreeView context={context} store={store} themeSource={element} />)
    return () => {
      if (current === store) current = null
      unsubscribe()
      store.stop()
      root.unmount()
    }
  }

  const selectTab = (index: number) => {
    const target = current?.tab(index)
    if (target) current?.open(target.id)
  }

  context.provide(WORKTREE_VIEW_ID, mountView)
  context.provide(`command:${PLUGIN_ID}/new-shell`, () => {
    if (current) return current.create('shell', '', false)
    const worktree = layoutWorktree(context)
    if (worktree === null) return undefined
    return new WorktreeSessions(context, worktree).create('shell', '', false)
  })
  context.provide(`command:${PLUGIN_ID}/close-session`, () => {
    const active = current?.getSnapshot().active
    if (current && active) return current.close(active)
    return undefined
  })
  context.provide(`command:${PLUGIN_ID}/select-tab`, (args?: unknown) => {
    selectTab(Number((args as { index?: unknown } | undefined)?.index))
  })
  for (const index of TAB_SHORTCUTS) context.provide(`command:${PLUGIN_ID}/select-tab-${index}`, () => selectTab(index))
}
