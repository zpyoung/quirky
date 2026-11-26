import { translate } from '@/i18n/i18n'
import { useState } from 'react'
import { X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { AgentJournalRenderItem } from '../../../../../shared/agent-session-journal-types'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import type { PanelLinkOpener } from './panel-link-opening'
import type { WorkspaceImage } from './view-render/view-runtime'
import { VisualItemCard } from './VisualItemCard'
import { latestVisualsNewestFirst } from './visual-spec-source'
import './panels.css'

export type VisualPanelProps = {
  items: AgentJournalRenderItem[]
  sessionId: string
  target: RuntimeClientTarget
  workspaceRoot: string | null
  /** A view id to show; the panel follows it whenever it changes. */
  openViewId?: string
  onClose(): void
  worktreeId?: string | null
  onOpenLink?: PanelLinkOpener
  readWorkspaceImage?: (relativePath: string) => Promise<WorkspaceImage>
}

/** The views the agent opened, newest first, with the selected one drawn below the list. */
export function VisualPanel({
  items,
  sessionId,
  target,
  workspaceRoot,
  openViewId,
  onClose,
  worktreeId,
  onOpenLink,
  readWorkspaceImage
}: VisualPanelProps) {
  const visuals = latestVisualsNewestFirst(items)
  const [picked, setPicked] = useState<string | null>(null)
  const [seenOpenViewId, setSeenOpenViewId] = useState(openViewId)
  if (seenOpenViewId !== openViewId) {
    setSeenOpenViewId(openViewId)
    setPicked(null)
  }
  const wanted = picked ?? openViewId
  const selected =
    visuals.find((item) => item.body.viewId === wanted) ??
    visuals.find((item) => item.body.closed !== true) ??
    visuals[0]

  return (
    <section
      className="native-chat-panel-panel"
      aria-label={translate('components.chat.panels.visualPanelLabel', 'Visuals')}
      data-visual-panel
    >
      <header className="native-chat-panel-panel-header">
        <h3 className="native-chat-panel-panel-title">
          {translate('components.chat.panels.visualTitle', 'Visuals')}
        </h3>
        <Button
          className="ml-auto"
          size="icon-xs"
          variant="ghost"
          aria-label={translate('components.chat.panels.visualClose', 'Close visuals')}
          onClick={onClose}
        >
          <X />
        </Button>
      </header>
      {selected === undefined ? (
        <p className="native-chat-panel-muted native-chat-panel-pad">
          {translate('components.chat.panels.visualNone', 'No visuals yet.')}
        </p>
      ) : (
        <>
          <ul
            className="native-chat-panel-version-list"
            aria-label={translate('components.chat.panels.visualList', 'Visuals')}
          >
            {visuals.map((item) => (
              <li key={item.body.viewId}>
                <button
                  type="button"
                  className="native-chat-panel-version"
                  data-selected={item.body.viewId === selected.body.viewId || undefined}
                  aria-current={item.body.viewId === selected.body.viewId || undefined}
                  onClick={() => setPicked(item.body.viewId)}
                >
                  <span className="native-chat-panel-clip">
                    {item.body.title ?? item.body.viewId}
                  </span>
                  {item.body.closed === true && (
                    <Badge variant="outline">
                      {translate('components.chat.panels.visualClosed', 'closed')}
                    </Badge>
                  )}
                </button>
              </li>
            ))}
          </ul>
          <div className="native-chat-panel-visual-body">
            <VisualItemCard
              key={`${selected.body.viewId}:${selected.revision}`}
              item={selected}
              sessionId={sessionId}
              target={target}
              workspaceRoot={workspaceRoot}
              framed={false}
              worktreeId={worktreeId}
              onOpenLink={onOpenLink}
              readWorkspaceImage={readWorkspaceImage}
            />
          </div>
        </>
      )}
    </section>
  )
}
