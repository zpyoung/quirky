import { createRoot } from 'react-dom/client'
import { EmptyState } from '@quirky/ui'
import type { MountCleanup, UiPluginContext } from '@quirky/protocol'
import { FLOATING_WORKSPACE } from '../../layout/types'
import { WorkspaceController, type WorkspaceOptions } from './controller'
import { registerController } from './registry'
import { WorkspaceView } from './WorkspaceView'

function parseInput(input: unknown): { worktree: string | null; session: string | undefined } {
  const { worktree, session } = (input ?? {}) as { worktree?: unknown; session?: unknown }
  return {
    worktree: typeof worktree === 'string' && worktree !== '' ? worktree : null,
    session: typeof session === 'string' && session !== '' ? session : undefined
  }
}

/**
 * Mounts a workspace into `element`: the worktree view for input `{worktree, session?}`, or with
 * `options.workspace = 'floating'` the floating workspace. It draws what the daemon holds, keeps
 * it current from events, reports through `props.report`, and returns an in-place updater.
 */
export function mountWorkspace(
  context: UiPluginContext,
  element: HTMLElement,
  props: { input?: unknown; report?(state: unknown): void },
  options: WorkspaceOptions = {}
): MountCleanup {
  Object.assign(element.style, { display: 'flex', flexDirection: 'column', flex: '1', minHeight: '0', minWidth: '0', position: 'relative' })
  const root = createRoot(element)
  const { worktree, session } = parseInput(props.input)
  const floating = options.workspace === 'floating'

  if (!floating && worktree === null) {
    root.render(<EmptyState message="Pick a worktree to see its sessions." />)
    props.report?.({ worktree: null, tabs: [], active: null, visibleSessions: [] })
    const cleanup: MountCleanup = () => root.unmount()
    cleanup.updateInput = () => false
    return cleanup
  }

  const controller = new WorkspaceController(context, floating ? FLOATING_WORKSPACE : worktree!, options, session)
  controller.root = element
  controller.onReport = (report) => props.report?.(report)
  const unregister = registerController(controller)
  controller.start()
  root.render(<WorkspaceView controller={controller} />)
  const cleanup: MountCleanup = () => {
    unregister()
    controller.stop()
    root.unmount()
  }
  cleanup.updateInput = (input) => {
    const next = parseInput(input)
    if (floating || worktree === null || next.worktree === null) return false
    if (next.worktree !== worktree && next.worktree !== controller.workspaceId) return false
    controller.selectSession(next.session)
    return true
  }
  return cleanup
}
