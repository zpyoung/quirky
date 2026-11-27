import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { ApprovalCategory } from '../../../../shared/public-rpc/public-method-spec'
import { translate } from '@/i18n/i18n'
import {
  SettingsRow,
  SettingsSegmentedControl,
  SettingsSubsectionHeader
} from './SettingsFormControls'

type ApprovalPolicy = GlobalSettings['agentApprovalPolicy']
type ApprovalChoice = ApprovalPolicy[ApprovalCategory]

type AgentApprovalsSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
}

const DEFAULT_APPROVAL_POLICY: ApprovalPolicy = {
  'workspace-delete': 'agent',
  'file-overwrite-delete': 'agent',
  'chat-discard-rewind': 'agent',
  'permission-answers': 'agent',
  'security-settings': 'agent'
}

function getApprovalRows(): readonly {
  category: ApprovalCategory
  label: string
  description: string
}[] {
  return [
    {
      category: 'workspace-delete',
      label: translate('settings.agents.approvals.workspaceDelete', 'Workspace deletion'),
      description: translate(
        'settings.agents.approvals.workspaceDeleteDescription',
        'Removing a workspace and its worktree.'
      )
    },
    {
      category: 'file-overwrite-delete',
      label: translate(
        'settings.agents.approvals.fileOverwriteDelete',
        'File overwrite or deletion'
      ),
      description: translate(
        'settings.agents.approvals.fileOverwriteDeleteDescription',
        'Replacing or removing files in a workspace.'
      )
    },
    {
      category: 'chat-discard-rewind',
      label: translate('settings.agents.approvals.chatDiscardRewind', 'Chat discard or rewind'),
      description: translate(
        'settings.agents.approvals.chatDiscardRewindDescription',
        'Discarding a chat or rewinding it to an earlier turn.'
      )
    },
    {
      category: 'permission-answers',
      label: translate('settings.agents.approvals.permissionAnswers', 'Permission answers'),
      description: translate(
        'settings.agents.approvals.permissionAnswersDescription',
        'Answering permission requests from other agents.'
      )
    },
    {
      category: 'security-settings',
      label: translate('settings.agents.approvals.securitySettings', 'Security-relevant settings'),
      description: translate(
        'settings.agents.approvals.securitySettingsDescription',
        'Changing settings that widen what agents are allowed to do.'
      )
    }
  ]
}

/** Per category, whether an agent calling the Quirky API may confirm the action itself or must ask you first. */
export function AgentApprovalsSetting({
  settings,
  updateSettings
}: AgentApprovalsSettingProps): React.JSX.Element {
  // a remote host running an older Quirky has no policy yet, which means every category is 'agent'
  const policy: ApprovalPolicy = { ...DEFAULT_APPROVAL_POLICY, ...settings.agentApprovalPolicy }
  const title = translate('settings.agents.approvals.title', 'Approvals')
  const options: readonly { value: ApprovalChoice; label: string }[] = [
    {
      value: 'agent',
      label: translate('settings.agents.approvals.agentMayConfirm', 'Agent may confirm')
    },
    { value: 'ask', label: translate('settings.agents.approvals.askMe', 'Ask me') }
  ]
  return (
    <section className="space-y-1">
      <SettingsSubsectionHeader
        title={title}
        description={translate(
          'settings.agents.approvals.description',
          'Choose which actions an agent can confirm on its own and which need your answer first.'
        )}
      />
      <div className="divide-y divide-border/60">
        {getApprovalRows().map(({ category, label, description }) => (
          <SettingsRow
            key={category}
            label={label}
            description={description}
            control={
              <SettingsSegmentedControl<ApprovalChoice>
                value={policy[category]}
                onChange={(next) =>
                  updateSettings({ agentApprovalPolicy: { ...policy, [category]: next } })
                }
                ariaLabel={label}
                size="sm"
                options={options}
              />
            }
          />
        ))}
      </div>
    </section>
  )
}
