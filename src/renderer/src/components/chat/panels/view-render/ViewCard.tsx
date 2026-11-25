import { translate } from '@/i18n/i18n'
import { useMemo } from 'react'
import { Badge } from '@/components/ui/badge'
import type { ViewNode, ViewSpec } from '../../../../../../shared/view-spec/view-spec-types'
import { openPanelLink, openPanelPreview, type PanelLinkOpener } from '../panel-link-opening'
import { ViewNodeRenderer } from './ViewNodeRenderer'
import { ViewRuntimeContext, type ViewRuntime, type WorkspaceImage } from './view-runtime'
import { readLocalWorkspaceImage } from './workspace-image-read'

export type ViewCardProps = {
  spec: ViewSpec
  viewId: string
  /** The workspace folder `image` nodes read from; null disables them. */
  workspaceRoot: string | null
  /** Shown in place of the content once the agent closed the view. */
  closed?: boolean
  /** Draws the card's own border; a host that already frames it leaves this off. */
  framed?: boolean
  /** Lets a localhost preview open in this workspace's browser tab. */
  worktreeId?: string | null
  onOpenLink?: PanelLinkOpener
  /** Reads a workspace image where the default local-disk read cannot, as on a remote workspace. */
  readWorkspaceImage?: (relativePath: string) => Promise<WorkspaceImage>
}

const hasInteractiveHtml = (node: ViewNode): boolean =>
  (node.type === 'html' && node.props?.interactive === true) ||
  (node.children ?? []).some(hasInteractiveHtml)

/** One validated view spec: its title and content. Buttons and fields render but answer nothing. */
export function ViewCard({
  spec,
  viewId,
  workspaceRoot,
  closed = false,
  framed = true,
  worktreeId,
  onOpenLink,
  readWorkspaceImage
}: ViewCardProps) {
  const runtime = useMemo<ViewRuntime>(
    () => ({
      viewId,
      workspaceRoot,
      openLink: onOpenLink ?? ((href) => openPanelLink(href, worktreeId)),
      openPreview: (url) => openPanelPreview(url, worktreeId),
      readWorkspaceImage:
        readWorkspaceImage ??
        ((relativePath) => readLocalWorkspaceImage(workspaceRoot, relativePath))
    }),
    [viewId, workspaceRoot, onOpenLink, worktreeId, readWorkspaceImage]
  )
  if (closed) {
    return (
      <p role="status" className="native-chat-view-muted" data-view-record={viewId}>
        {translate('components.chat.viewRender.viewClosed', '{{title}} closed', {
          title: spec.title
        })}
      </p>
    )
  }
  return (
    <article
      className="native-chat-view-card"
      data-framed={framed || undefined}
      data-view-card={viewId}
      aria-label={spec.title}
    >
      <header className="native-chat-view-row">
        <h3 className="native-chat-view-title">{spec.title}</h3>
        {hasInteractiveHtml(spec.root) && (
          <Badge variant="outline">
            {translate('components.chat.viewRender.sandboxed', 'sandboxed · no network')}
          </Badge>
        )}
      </header>
      <ViewRuntimeContext.Provider value={runtime}>
        <ViewNodeRenderer node={spec.root} />
      </ViewRuntimeContext.Provider>
    </article>
  )
}
