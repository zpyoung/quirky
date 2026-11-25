import { isUsableSkillsCliAgentKey } from './skills-cli-agent-keys'
import { QUIRKY_SKILLS_REPOSITORY_URL } from './fork-skills-repository/skills-repository-url'

export { QUIRKY_SKILLS_REPOSITORY_URL }

// Why: one skills CLI for every install rail. 1.5.x cannot fetch a commit, and a bare
// `npx skills` can reuse a stale cached copy or another binary (#18687).
export const SKILLS_CLI_VERSION = '1.7.2'

// Why: for a commit ref the skills CLI tries `clone --branch <sha>` first and falls back to
// fetching the commit only when git's error is in English, so a translated git fails every
// install (#28914, vercel-labs/skills#2505). Spread over the env of every spawned run.
export const SKILLS_CLI_ENV_OVERRIDES = { LC_ALL: 'C' } as const

export const QUIRKY_CLI_SKILL_NAME = 'quirky-cli'
export const COMPUTER_USE_SKILL_NAME = 'quirky-computer-use'
export const ORCHESTRATION_SKILL_NAME = 'quirky-orchestration'
export const EPHEMERAL_VMS_SKILL_NAME = 'quirky-per-workspace-env'
export const QUIRKY_LINEAR_SKILL_NAME = 'quirky-linear'
export const LINEAR_TICKETS_SKILL_NAME = 'quirky-linear-tickets'
export const LINEAR_AGENT_SKILL_NAMES = [
  QUIRKY_LINEAR_SKILL_NAME,
  LINEAR_TICKETS_SKILL_NAME
] as const

// Why: `yes` and `agents` default off so every Settings/onboarding string a human
// pastes keeps its interactive prompts and the CLI's own agent detection. Only an
// unattended spawn, which nothing can answer, opts in.
export type AgentFeatureSkillCommandOptions = {
  /** Full commit the running build was made from. */
  sourceCommit: string
  global?: boolean
  yes?: boolean
  agents?: readonly string[]
}

export function buildAgentFeatureSkillInstallArgs(
  skillNames: readonly string[],
  options: AgentFeatureSkillCommandOptions
): string[] {
  if (skillNames.length === 0) {
    throw new Error('At least one skill name is required.')
  }
  const global = options.global ?? true
  // Why: -y with no --agent is the one combination that makes `skills add` install
  // into every agent it knows. Refuse it here so no caller can express it.
  const agents = options.agents ?? []
  if (options.yes && agents.length === 0) {
    throw new Error('An install target is required when skipping prompts.')
  }
  // Why: a value the skills CLI would drop leaves it with no target at all, which
  // is the same all-agents install as passing no --agent.
  const unusable = agents.find((agent) => !isUsableSkillsCliAgentKey(agent))
  if (unusable !== undefined) {
    throw new Error(`"${unusable}" is not a usable install target.`)
  }
  // Why: one flag per name remains compatible with both single-value and variadic parsers.
  const skillArgs = skillNames.flatMap((name) => ['--skill', name])
  return [
    `skills@${SKILLS_CLI_VERSION}`,
    'add',
    // Why: pinned to the build's own commit so the installed bytes are the ones its bundled
    // manifest judges freshness against, on every channel (hourly builds have no tag in
    // this repo). `add` always re-copies, so the same command is install and update.
    `${QUIRKY_SKILLS_REPOSITORY_URL}/tree/${options.sourceCommit}`,
    ...skillArgs,
    ...(global ? ['--global'] : []),
    // Why: an explicit --agent stops `skills add` calling its own detection, whose
    // zero-detected branch installs into all ~75 known agents and litters a bare
    // host with agent config directories it has no agent for.
    ...agents.flatMap((agent) => ['--agent', agent]),
    // Why: without -y `skills add` opens an interactive agent picker and blocks
    // forever on any TTY, which is every ssh session.
    ...(options.yes ? ['-y'] : [])
  ]
}

export function buildAgentFeatureSkillInstallCommand(
  skillNames: readonly string[],
  options: AgentFeatureSkillCommandOptions
): string {
  return `npx ${buildAgentFeatureSkillInstallArgs(skillNames, options).join(' ')}`
}
