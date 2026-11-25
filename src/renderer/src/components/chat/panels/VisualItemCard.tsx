import { translate } from '@/i18n/i18n'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import type { PanelLinkOpener } from './panel-link-opening'
import { useVisualSpec } from './use-visual-spec'
import { ViewCard } from './view-render/ViewCard'
import type { WorkspaceImage } from './view-render/view-runtime'
import { ViewSpecError } from './view-render/ViewSpecError'
import type { VisualRenderItem } from './visual-spec-source'
import './panels.css'

export type VisualItemCardProps = {
  item: VisualRenderItem
  sessionId: string
  target: RuntimeClientTarget
  workspaceRoot: string | null
  framed?: boolean
  worktreeId?: string | null
  onOpenLink?: PanelLinkOpener
  readWorkspaceImage?: (relativePath: string) => Promise<WorkspaceImage>
}

/** One `visual` journal item as a card: its spec fetched whole if needed, validated, then drawn or explained. */
export function VisualItemCard({
  item,
  sessionId,
  target,
  workspaceRoot,
  framed,
  worktreeId,
  onOpenLink,
  readWorkspaceImage
}: VisualItemCardProps) {
  const state = useVisualSpec(item, { target, sessionId })
  const title = item.body.title ?? 'Visual'
  if (state.kind === 'loading') {
    return (
      <p role="status" className="native-chat-view-muted">
        {translate('components.chat.panels.visualLoading', 'Loading {{title}}…', { title })}
      </p>
    )
  }
  if (state.kind === 'failed') {
    return (
      <p role="alert" className="native-chat-view-error">
        {translate(
          'components.chat.panels.visualLoadFailed',
          'Could not load {{title}}: {{message}}',
          { title, message: state.message }
        )}
      </p>
    )
  }
  if (state.kind === 'invalid') {
    return <ViewSpecError title={title} errors={state.errors} source={state.source} />
  }
  return (
    <ViewCard
      spec={state.spec}
      viewId={item.body.viewId}
      workspaceRoot={workspaceRoot}
      closed={item.body.closed === true}
      {...(framed === undefined ? {} : { framed })}
      worktreeId={worktreeId}
      {...(onOpenLink ? { onOpenLink } : {})}
      {...(readWorkspaceImage ? { readWorkspaceImage } : {})}
    />
  )
}
