import { createRoot } from 'react-dom/client'
import type { UiPluginContext } from '@quirky/protocol'
import { SourceControl } from './SourceControl'
import type { ScmReport } from './scm'

/** Provides the source-control panel; it follows the worktree of the open view. */
export function activate(context: UiPluginContext): void {
  context.provide(
    'panel:quirky.git/source-control',
    (element: HTMLElement, props: { report?(state: unknown): void }) => {
      const root = createRoot(element)
      const report = (state: ScmReport) => props.report?.(state)
      root.render(<SourceControl context={context} report={report} />)
      return () => root.unmount()
    }
  )
}
