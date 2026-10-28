import { ActivityPanel } from './activity'
import { FilesTasksPanel } from './files-tasks'
import { SourceControlPanel } from './source-control'
import type { MobileRoute } from '../contracts'
import type { PanelProps, PanelRoute } from './contracts'

export function isPanelRoute(route: MobileRoute): route is PanelRoute {
  return route.kind !== 'workspaces' && route.kind !== 'session'
}

export function PanelApp(props: PanelProps) {
  switch (props.route.kind) {
    case 'source-control':
    case 'review':
      return <SourceControlPanel {...props} />
    case 'files':
    case 'file-preview':
    case 'tasks':
      return <FilesTasksPanel {...props} />
    case 'accounts':
    case 'agent-history':
    case 'notifications':
      return <ActivityPanel {...props} />
  }
}
