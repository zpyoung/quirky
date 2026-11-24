import type { LinkedWorkItemContext } from '@/lib/linked-work-item-context'
import type { AgentLaunchOptionSelection } from '../../../shared/fork-automation-launch-settings/agent-launch-overrides'
import type { TaskProvider } from '../../../shared/task-providers'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { LaunchSource } from '../../../shared/agent-kind'

export type LaunchableWorkItem = {
  provider?: TaskProvider
  title: string
  url: string
  type: 'issue' | 'pr' | 'mr'
  number: number | null
  repoId?: string
  branchName?: string
  baseRefName?: string
  isCrossRepository?: boolean
  pasteContent?: string
  linearIdentifier?: string
  linearWorkspaceId?: string
  linearOrganizationUrlKey?: string
  linkedContext?: LinkedWorkItemContext
}

export type LaunchWorkItemDirectArgs = {
  item: LaunchableWorkItem
  repoId: string
  openModalFallback: () => void
  baseBranch?: string
  launchSource: LaunchSource
  agentOverride?: TuiAgent
  agentArgs?: string | null
  launchOptions?: AgentLaunchOptionSelection | null
  promptDelivery?: 'draft' | 'submit-after-ready'
  launchPlatform?: NodeJS.Platform
}
