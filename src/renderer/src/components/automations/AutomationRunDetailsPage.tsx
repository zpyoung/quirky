import React from 'react'
import { Eye, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { cn } from '@/lib/utils'
import { getAgentCatalog } from '@/lib/agent-catalog'
import { translate } from '@/i18n/i18n'
import type { Automation, AutomationRun } from '../../../../shared/automations-types'
import { AutomationRunPageFrame } from './AutomationRunPageFrame'
import { getAutomationRunContent } from './automation-run-content'
import { formatAutomationRunLaunchSettings } from './fork-automation-launch-settings/automation-run-launch-display'
import type { AutomationRunViewState } from './automation-run-view-state'
import type { AutomationRunWorkspaceDisplay } from './automation-run-workspace-display'
import {
  formatAutomationDateTimeWithRelative,
  getAutomationRunStatusLabel,
  getAutomationRunStatusVariant
} from './automation-page-parts'

export function AutomationRunDetailsPage({
  automation,
  run,
  relativeNow,
  workspaceDisplay,
  viewState,
  canRerun,
  isRerunPending,
  onRerun,
  onOpenWorkspace,
  onBack
}: {
  automation: Automation | null
  run: AutomationRun
  relativeNow: number
  workspaceDisplay: AutomationRunWorkspaceDisplay | null
  viewState: AutomationRunViewState | null
  canRerun: boolean
  isRerunPending: boolean
  onRerun: () => void
  onOpenWorkspace: () => void
  onBack: () => void
}): React.JSX.Element {
  const runLaunchAgentId = run.launchSettings?.agentId
  const runLaunchAgentLabel =
    getAgentCatalog().find((agent) => agent.id === runLaunchAgentId)?.label ?? runLaunchAgentId
  const runLaunchDisplay = runLaunchAgentLabel
    ? formatAutomationRunLaunchSettings(run.launchSettings, runLaunchAgentLabel)
    : null
  return (
    <section className="flex min-h-0 flex-1 p-5">
      <AutomationRunPageFrame
        title={automation?.name ?? run.title}
        breadcrumbs={[
          formatAutomationDateTimeWithRelative(run.scheduledFor, relativeNow),
          'Quirky',
          workspaceDisplay?.detailLabel ??
            translate('auto.components.automations.AutomationsPage.noWorkspace', 'No workspace'),
          ...(runLaunchDisplay ? [runLaunchDisplay.summary] : [])
        ]}
        detail={
          [
            run.outputSnapshot?.truncated
              ? translate(
                  'auto.components.automations.AutomationsPage.latestSavedOutput',
                  'Latest saved output'
                )
              : null,
            runLaunchDisplay?.agentArgs
          ]
            .filter((value): value is string => Boolean(value))
            .join(' · ') || null
        }
        statusLabel={getAutomationRunStatusLabel(run.status)}
        statusVariant={getAutomationRunStatusVariant(run.status)}
        actions={
          <>
            {canRerun && automation ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={isRerunPending}
                onClick={onRerun}
              >
                <RefreshCw className={cn('size-3.5', isRerunPending && 'animate-spin')} />
                {translate('auto.components.automations.AutomationsPage.295698292f', 'Rerun')}
              </Button>
            ) : null}
            {/* Why: a disabled button with nothing to open reads as broken; status and content explain the run. */}
            {viewState?.canOpen ? (
              <Button type="button" variant="outline" size="sm" onClick={onOpenWorkspace}>
                <Eye className="size-3.5" />
                {viewState.actionLabel}
              </Button>
            ) : null}
          </>
        }
        onBack={onBack}
      >
        <CommentMarkdown
          variant="document"
          content={getAutomationRunContent(run)}
          className="text-sm leading-relaxed text-foreground"
        />
      </AutomationRunPageFrame>
    </section>
  )
}
