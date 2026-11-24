import type { CommandSpec } from '../args'
import { ASK_COMMAND_SPECS } from '../fork-ask-question-tool/specs'
import { HEIMDALL_COMMAND_SPECS } from '../fork-heimdall/specs'
import { LOOP_COMMAND_SPECS } from '../fork-loops/specs'
import { ACCOUNT_COMMAND_SPECS } from './account'
import { BROWSER_ADVANCED_COMMAND_SPECS } from './browser-advanced'
import { BROWSER_BASIC_COMMAND_SPECS } from './browser-basic'
import { AUTOMATION_COMMAND_SPECS } from './automations'
import { CORE_COMMAND_SPECS } from './core'
import { FILE_COMMAND_SPECS } from './file'
import { PROJECT_COMMAND_SPECS } from './project'
import { ORCHESTRATION_COMMAND_SPECS } from './orchestration'
import { COMPUTER_COMMAND_SPECS } from './computer'
import { ENVIRONMENT_COMMAND_SPECS } from './environment'
import { MANAGED_SERVER_COMMAND_SPECS } from './managed-server'
import { AGENT_HOOK_COMMAND_SPECS } from './agent-hooks'
import { AGENT_LAUNCH_COMMAND_SPECS } from './agent-launch'
import { DIAGNOSTICS_COMMAND_SPECS } from './diagnostics'
import { SPEECH_COMMAND_SPECS } from './speech'
import { TERMINAL_DAEMON_COMMAND_SPECS } from './terminal-daemon'
import { EMULATOR_COMMAND_SPECS } from './emulator'
import { INTROSPECTION_COMMAND_SPECS } from './introspection'
import { JIRA_COMMAND_SPECS } from './jira'
import { LINEAR_COMMAND_SPECS } from './linear'
import { VM_COMMAND_SPECS } from './vm'
import { SKILL_COMMAND_SPECS } from './skills'
import { LEDGER_COMMAND_SPECS } from './ledger'
import { SEARCH_COMMAND_SPECS } from './search'
import { PROFILE_STATE_COMMAND_SPECS } from './profile-state'
import { REFERENCE_COMMAND_SPECS } from './reference'

export const COMMAND_SPECS: CommandSpec[] = [
  ...CORE_COMMAND_SPECS,
  ...REFERENCE_COMMAND_SPECS,
  ...ASK_COMMAND_SPECS,
  ...HEIMDALL_COMMAND_SPECS,
  ...LOOP_COMMAND_SPECS,
  ...ACCOUNT_COMMAND_SPECS,
  ...PROJECT_COMMAND_SPECS,
  ...FILE_COMMAND_SPECS,
  ...AUTOMATION_COMMAND_SPECS,
  ...BROWSER_BASIC_COMMAND_SPECS,
  ...BROWSER_ADVANCED_COMMAND_SPECS,
  ...ORCHESTRATION_COMMAND_SPECS,
  ...COMPUTER_COMMAND_SPECS,
  ...AGENT_HOOK_COMMAND_SPECS,
  ...AGENT_LAUNCH_COMMAND_SPECS,
  ...DIAGNOSTICS_COMMAND_SPECS,
  ...SPEECH_COMMAND_SPECS,
  ...TERMINAL_DAEMON_COMMAND_SPECS,
  ...INTROSPECTION_COMMAND_SPECS,
  ...ENVIRONMENT_COMMAND_SPECS,
  ...MANAGED_SERVER_COMMAND_SPECS,
  ...JIRA_COMMAND_SPECS,
  ...LINEAR_COMMAND_SPECS,
  ...VM_COMMAND_SPECS,
  ...EMULATOR_COMMAND_SPECS,
  ...SKILL_COMMAND_SPECS,
  ...LEDGER_COMMAND_SPECS,
  ...SEARCH_COMMAND_SPECS,
  ...PROFILE_STATE_COMMAND_SPECS
]
