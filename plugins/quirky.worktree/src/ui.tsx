import { createRoot } from 'react-dom/client'
import type { MountFunction, UiPluginContext } from '@quirky/protocol'
import { createRequests } from './actions'
import { WorktreesSection } from './WorktreesSection'
import { RemoteWorkspace } from './RemoteWorkspace'
import { RemoteWorkspacesSection } from './RemoteWorkspacesSection'
import { VmEnvironments } from './VmEnvironments'

const WORKTREES_TOOL = 'sidebar-section:quirky.worktree/worktrees'

/**
 * Provides the workspace tree for the `worktrees` sidebar section and the `new-worktree` command,
 * which opens the create dialog on the project it names, the open worktree's, or the first, and the
 * `add-project` command, which shows the Worktrees tool and opens its Add project dialog.
 */
export function activate(context: UiPluginContext): void {
  const requests = createRequests()
  const addProjectRequests = createRequests()

  context.provide('sidebar-section:quirky.worktree/worktrees', (element: HTMLElement, props: { report?(state: unknown): void }) => {
    const root = createRoot(element)
    root.render(<WorktreesSection context={context} report={props.report} requests={requests} addProjectRequests={addProjectRequests} />)
    return () => root.unmount()
  })

  const mountRemote: MountFunction = (element, { input }) => {
    const workspace = typeof input === 'object' && input !== null && 'workspace' in input
      ? input.workspace
      : undefined
    const root = createRoot(element)
    root.render(typeof workspace === 'string' && workspace !== ''
      ? <RemoteWorkspace context={context} workspace={workspace} />
      : <p role="alert">Select an owner-bound remote workspace.</p>)
    return () => root.unmount()
  }
  context.provide('view:quirky.worktree/remote', mountRemote)
  const mountEnvironments: MountFunction = (element, { input }) => {
    const repo = typeof input === 'object' && input !== null && 'repo' in input ? input.repo : undefined
    const root = createRoot(element)
    root.render(<VmEnvironments context={context} initialRepo={typeof repo === 'string' ? repo : undefined} />)
    return () => root.unmount()
  }
  context.provide('view:quirky.worktree/environments', mountEnvironments)
  context.provide('sidebar-section:quirky.worktree/remote-workspaces', (element: HTMLElement) => {
    const root = createRoot(element)
    root.render(<RemoteWorkspacesSection context={context} />)
    return () => root.unmount()
  })

  context.provide('command:quirky.worktree/new-worktree', async (args?: unknown) => {
    const selector = (args as { repo?: unknown } | undefined)?.repo
    if (typeof selector !== 'string' || selector === '') return requests.request({})
    const repo = (await context.call('quirky.repo/resolve', { selector })) as { id: string }
    requests.request({ repoId: repo.id })
  })

  context.provide('command:quirky.worktree/add-project', () => {
    context.togglePanel(WORKTREES_TOOL, true)
    addProjectRequests.request({})
  })
}
