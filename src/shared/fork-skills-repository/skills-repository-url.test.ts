import { describe, expect, it } from 'vitest'

import {
  buildAgentFeatureSkillInstallCommand,
  SKILLS_CLI_VERSION
} from '../agent-feature-install-commands'
import { ORCA_SKILLS_REPOSITORY_URL } from './skills-repository-url'

describe('fork skills repository url', () => {
  it('names the fork, not upstream', () => {
    expect(ORCA_SKILLS_REPOSITORY_URL).toBe('https://github.com/zpyoung/quirky')
  })

  // Why: an upstream sync that reverts the seam in agent-feature-install-commands.ts leaves this
  // module intact, so only the built command proves the two are still wired together.
  it('is the repository every install command clones', () => {
    const sourceCommit = '0123456789abcdef0123456789abcdef01234567'
    expect(buildAgentFeatureSkillInstallCommand(['orca-cli'], { sourceCommit })).toBe(
      `npx skills@${SKILLS_CLI_VERSION} add ${ORCA_SKILLS_REPOSITORY_URL}/tree/${sourceCommit} --skill orca-cli --global`
    )
  })
})
