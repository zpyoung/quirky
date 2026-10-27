import { createRoot } from 'react-dom/client'
import type { UiPluginContext } from '@quirky/protocol'
import { createRequests } from './actions'
import { WorktreesSection } from './WorktreesSection'

/**
 * Provides the workspace tree for the `worktrees` sidebar section and the `new-worktree` command,
 * which opens the create dialog on the project it names, the open worktree's, or the first.
 */
export function activate(context: UiPluginContext): void {
  const requests = createRequests()

  context.provide('sidebar-section:quirky.worktree/worktrees', (element: HTMLElement, props: { report?(state: unknown): void }) => {
    const root = createRoot(element)
    root.render(<WorktreesSection context={context} report={props.report} requests={requests} />)
    return () => root.unmount()
  })

  context.provide('command:quirky.worktree/new-worktree', async (args?: unknown) => {
    const selector = (args as { repo?: unknown } | undefined)?.repo
    if (typeof selector !== 'string' || selector === '') return requests.request({})
    const repo = (await context.call('quirky.repo/resolve', { selector })) as { id: string }
    requests.request({ repoId: repo.id })
  })
}
