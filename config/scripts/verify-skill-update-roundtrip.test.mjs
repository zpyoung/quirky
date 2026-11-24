import { describe, expect, it } from 'vitest'
import { buildAgentFeatureSkillInstallArgs } from '../../src/shared/agent-feature-install-commands'
import { QUIRKY_SKILLS_REPOSITORY_SLUG } from '../../src/shared/fork-skills-repository/skills-repository-url'
import { roundTripAddArgs } from './verify-skill-update-roundtrip.mjs'

const COMMIT = 'a'.repeat(40)

describe('skill update round trip', () => {
  it('runs exactly the shared builder’s unattended add, pinned skills CLI included', () => {
    expect(roundTripAddArgs(QUIRKY_SKILLS_REPOSITORY_SLUG, COMMIT, 'quirky-cli')).toEqual(
      buildAgentFeatureSkillInstallArgs(['quirky-cli'], {
        sourceCommit: COMMIT,
        yes: true,
        agents: ['claude-code', 'universal']
      })
    )
  })
})
