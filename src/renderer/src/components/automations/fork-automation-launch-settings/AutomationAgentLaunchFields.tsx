import AgentCombobox from '@/components/agent/AgentCombobox'
import { AgentLaunchOverridesFields } from '@/components/fork-automation-launch-settings/AgentLaunchOverridesFields'
import { isEmptyAgentLaunchOverrides } from '../../../../../shared/fork-automation-launch-settings/agent-launch-overrides'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import type { TuiAgent } from '../../../../../shared/tui-agent'
import type { AgentCatalogEntry } from '@/lib/agent-catalog'
import { translate } from '@/i18n/i18n'
import { AUTOMATION_EDITOR_SECTION_LABEL_CLASS, Field } from '../automation-page-parts'
import type { AutomationLaunchOverridesGate } from './automation-launch-overrides-gate'
import type { AutomationDraft } from '../AutomationEditorDialog'

type AutomationAgentLaunchFieldsProps = {
  draft: AutomationDraft
  settings: GlobalSettings | null
  visibleAgents: AgentCatalogEntry[]
  pickerTriggerClassName: string
  launchOverridesGate: AutomationLaunchOverridesGate
  onDraftChange: (updater: (current: AutomationDraft) => AutomationDraft) => void
}

/** Render the Quirky automation agent picker and its model/effort launch settings. */
export function AutomationAgentLaunchFields({
  draft,
  settings,
  visibleAgents,
  pickerTriggerClassName,
  launchOverridesGate,
  onDraftChange
}: AutomationAgentLaunchFieldsProps): React.JSX.Element {
  const launchOverridesDisabledReason =
    launchOverridesGate !== 'unsupported'
      ? undefined
      : isEmptyAgentLaunchOverrides(draft.launchOverrides)
        ? translate(
            'auto.components.automations.AutomationAgentLaunchFields.launchSettingsUnsupported',
            "This automation's host doesn't support launch settings. Update the remote Quirky server."
          )
        : translate(
            'auto.components.automations.AutomationAgentLaunchFields.launchSettingsNotSaved',
            "Launch settings can't be saved to this host and won't apply to runs."
          )

  // Why: model/effort ids are agent-specific, so an agent switch clears them.
  const changeAgent = (agentId: TuiAgent): void => {
    onDraftChange((current) => ({ ...current, agentId, launchOverrides: {} }))
  }

  return (
    <>
      <Field
        labelClassName={AUTOMATION_EDITOR_SECTION_LABEL_CLASS}
        label={translate('auto.components.automations.AutomationEditorDialog.57b722cbba', 'Agent')}
      >
        <AgentCombobox
          agents={visibleAgents}
          value={draft.agentId}
          onValueChange={(agentId) => agentId && changeAgent(agentId)}
          defaultAgent={settings?.defaultTuiAgent ?? null}
          triggerClassName={`h-9 w-full min-w-0 ${pickerTriggerClassName}`}
          allowNarrowTrigger
        />
      </Field>
      <AgentLaunchOverridesFields
        agent={draft.agentId}
        value={draft.launchOverrides}
        onChange={(updater) =>
          onDraftChange((current) => ({
            ...current,
            launchOverrides: updater(current.launchOverrides)
          }))
        }
        showAgentArgs={false}
        reuseSessionNote={draft.workspaceMode === 'existing' && draft.reuseSession}
        disabled={launchOverridesGate !== 'supported'}
        disabledReason={launchOverridesDisabledReason}
        idPrefix="automation-launch"
      />
    </>
  )
}
