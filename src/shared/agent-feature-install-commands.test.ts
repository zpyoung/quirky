import { describe, expect, it } from 'vitest'
import {
  buildAgentFeatureSkillInstallArgs,
  buildAgentFeatureSkillInstallCommand,
  SKILLS_CLI_VERSION
} from './agent-feature-install-commands'
import { QUIRKY_SKILLS_REPOSITORY_URL } from './fork-skills-repository/skills-repository-url'

const sourceCommit = '0123456789abcdef0123456789abcdef01234567'
const source = `${QUIRKY_SKILLS_REPOSITORY_URL}/tree/${sourceCommit}`

describe('agent feature skill commands', () => {
  it('pins the skills CLI and the source to the build commit', () => {
    expect(buildAgentFeatureSkillInstallArgs(['quirky-cli'], { sourceCommit }).slice(0, 3)).toEqual(
      [`skills@${SKILLS_CLI_VERSION}`, 'add', source]
    )
  })

  it('builds a global install command by default', () => {
    expect(buildAgentFeatureSkillInstallCommand(['quirky-cli'], { sourceCommit })).toBe(
      `npx skills@${SKILLS_CLI_VERSION} add ${source} --skill quirky-cli --global`
    )
  })

  it('drops --global when installing locally', () => {
    expect(
      buildAgentFeatureSkillInstallCommand(['quirky-cli'], { sourceCommit, global: false })
    ).toBe(`npx skills@${SKILLS_CLI_VERSION} add ${source} --skill quirky-cli`)
  })

  it('repeats --skill per name for multi-skill installs', () => {
    expect(
      buildAgentFeatureSkillInstallCommand(['quirky-cli', 'orchestration'], { sourceCommit })
    ).toBe(
      `npx skills@${SKILLS_CLI_VERSION} add ${source} --skill quirky-cli --skill orchestration --global`
    )
    expect(
      buildAgentFeatureSkillInstallArgs(['quirky-cli', 'orchestration'], { sourceCommit })
    ).toEqual([
      `skills@${SKILLS_CLI_VERSION}`,
      'add',
      source,
      '--skill',
      'quirky-cli',
      '--skill',
      'orchestration',
      '--global'
    ])
  })

  it('rejects an empty skill list', () => {
    expect(() => buildAgentFeatureSkillInstallArgs([], { sourceCommit })).toThrow(
      'At least one skill name is required.'
    )
  })

  it('keeps the copyable Settings commands interactive by default', () => {
    // Why: -y skips the agent picker. A human pasting from Settings should still
    // get it; only an unattended spawn opts in.
    expect(buildAgentFeatureSkillInstallCommand(['quirky-cli'], { sourceCommit })).not.toContain(
      '-y'
    )
  })

  it('refuses to skip prompts without an install target', () => {
    // Why: -y with no --agent is the one combination that makes `skills add`
    // install into every agent it knows (~75). No caller may express it.
    expect(() =>
      buildAgentFeatureSkillInstallCommand(['quirky-cli'], { sourceCommit, yes: true })
    ).toThrow('An install target is required when skipping prompts.')
  })

  it('refuses a target the skills CLI would drop', () => {
    // Why: defence in depth behind the CLI's own check — the skills CLI silently
    // drops a `-`-leading --agent value, which empties its target list and
    // installs into every agent it knows.
    expect(() =>
      buildAgentFeatureSkillInstallCommand(['quirky-cli'], {
        sourceCommit,
        yes: true,
        agents: ['-y']
      })
    ).toThrow('"-y" is not a usable install target.')
    expect(() =>
      buildAgentFeatureSkillInstallArgs(['quirky-cli'], {
        sourceCommit,
        yes: true,
        agents: ['universal', 'a b']
      })
    ).toThrow('"a b" is not a usable install target.')
  })

  it('appends -y and the targets for an unattended run', () => {
    expect(
      buildAgentFeatureSkillInstallCommand(['quirky-cli'], {
        sourceCommit,
        yes: true,
        agents: ['universal']
      })
    ).toBe(
      `npx skills@${SKILLS_CLI_VERSION} add ${source} --skill quirky-cli --global --agent universal -y`
    )
  })
})
