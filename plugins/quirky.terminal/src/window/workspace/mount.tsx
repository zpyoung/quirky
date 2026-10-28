import { createRoot } from 'react-dom/client'
import { EmptyState } from '@quirky/ui'
import type { UiPluginContext } from '@quirky/protocol'
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
 * it current from events, reports through `props.report`, and returns the function that ends it.
 */
export function mountWorkspace(
  context: UiPluginContext,
  element: HTMLElement,
  props: { input?: unknown; report?(state: unknown): void },
  options: WorkspaceOptions = {}
): () => void {
  Object.assign(element.style, { display: 'flex', flexDirection: 'column', flex: '1', minHeight: '0', minWidth: '0', position: 'relative' })
  const root = createRoot(element)
  const { worktree, session } = parseInput(props.input)
  const floating = options.workspace === 'floating'

  if (!floating && worktree === null) {
    root.render(<EmptyState message="Pick a worktree to see its sessions." />)
    props.report?.({ worktree: null, tabs: [], active: null, visibleSessions: [] })
    return () => root.unmount()
  }

  const controller = new WorkspaceController(context, floating ? FLOATING_WORKSPACE : worktree!, options, session)
  controller.root = element
  controller.onReport = (report) => props.report?.(report)
  const unregister = registerController(controller)
  controller.start()
  root.render(<WorkspaceView controller={controller} />)
  return () => {
    unregister()
    controller.stop()
    root.unmount()
  }
}
