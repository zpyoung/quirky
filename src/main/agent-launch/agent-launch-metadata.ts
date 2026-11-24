import { launchSourceSchema, tuiAgentToAgentKind } from '../../shared/agent-kind'
import type { TuiAgent } from '../../shared/tui-agent'
import type { WorktreeStartupLaunch } from '../../shared/worktree/launch-types'

/**
 * The launch descriptor for an agent launch the host builds. `agent_kind` and `request_kind` are
 * derived, never accepted, so a caller cannot misreport them; a launch source this build has never
 * heard of (a newer client) resolves to `unknown` instead of gating the launch.
 */
export function hostAgentLaunchMetadata(
  agent: TuiAgent,
  launchSource: string | undefined
): NonNullable<WorktreeStartupLaunch['telemetry']> {
  const parsed = launchSourceSchema.safeParse(launchSource)
  return {
    agent_kind: tuiAgentToAgentKind(agent),
    launch_source: parsed.success ? parsed.data : 'unknown',
    request_kind: 'new'
  }
}
