import type { Automation } from '../../../shared/automations-types'
import type { AutomationRunLaunchSettings } from '../../../shared/fork-automation-launch-settings/automation-run-launch-settings'
import type { Repo } from '../../../shared/repo-types'
import type { QuirkyRuntimeService } from '../../runtime/quirky-runtime'

/** The run's launch snapshot, or null when the runtime offers no snapshot (partial test doubles). */
export function automationRunLaunchSettingsFor(
  runtime: Pick<QuirkyRuntimeService, 'buildAutomationRunLaunchSettings'>,
  automation: Automation,
  repo: Repo
): AutomationRunLaunchSettings | null {
  return 'buildAutomationRunLaunchSettings' in runtime
    ? runtime.buildAutomationRunLaunchSettings(automation, repo)
    : null
}
