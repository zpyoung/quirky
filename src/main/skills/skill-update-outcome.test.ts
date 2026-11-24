import { describe, expect, it } from 'vitest'
import type {
  SkillFreshnessInstallation,
  SkillFreshnessStatus,
  SkillInstallationTopology
} from '../../shared/skill-freshness'
import { skillUpdateFailedNames } from './skill-update-outcome'

function placement(
  name: string,
  status: SkillFreshnessStatus,
  topology: SkillInstallationTopology = 'canonical-copy'
): SkillFreshnessInstallation {
  return {
    id: `${name}-${topology}-${status}`,
    name,
    rootId: 'home-agents',
    providers: ['agent-skills'],
    sourceKind: 'home',
    sourceLabel: 'Agent skills home',
    unresolvedPath: `/home/.agents/skills/${name}`,
    resolvedPath: `/home/.agents/skills/${name}`,
    physicalIdentity: `physical-${name}`,
    topology,
    status,
    currentPackageDigest: 'current',
    lockSource: 'zpyoung/quirky',
    errorCategory: null
  }
}

describe('skillUpdateFailedNames', () => {
  it('treats a convergent copy that is now current as landed', () => {
    expect(skillUpdateFailedNames(['quirky-cli'], [placement('quirky-cli', 'current')])).toEqual([])
  })

  it('reports a copy the run left outdated', () => {
    expect(skillUpdateFailedNames(['quirky-cli'], [placement('quirky-cli', 'outdated')])).toEqual([
      'quirky-cli'
    ])
  })

  it('reports an unreadable copy', () => {
    expect(
      skillUpdateFailedNames(['quirky-cli'], [placement('quirky-cli', 'inaccessible')])
    ).toEqual(['quirky-cli'])
  })

  it('reports a skill the run removed outright', () => {
    expect(skillUpdateFailedNames(['quirky-cli'], [])).toEqual(['quirky-cli'])
  })

  it('ignores placements the update command never writes to', () => {
    expect(
      skillUpdateFailedNames(
        ['quirky-cli'],
        [placement('quirky-cli', 'current'), placement('quirky-cli', 'outdated', 'plugin-cache')]
      )
    ).toEqual([])
  })

  it('fails the name when the run leaves a broken link behind', () => {
    expect(
      skillUpdateFailedNames(
        ['quirky-cli'],
        [placement('quirky-cli', 'current'), placement('quirky-cli', 'inaccessible', 'broken-link')]
      )
    ).toEqual(['quirky-cli'])
  })

  it('fails the name when any convergent alias was left behind', () => {
    expect(
      skillUpdateFailedNames(
        ['quirky-cli'],
        [placement('quirky-cli', 'current'), placement('quirky-cli', 'outdated', 'provider-alias')]
      )
    ).toEqual(['quirky-cli'])
  })

  it('judges each requested name independently', () => {
    expect(
      skillUpdateFailedNames(
        ['quirky-cli', 'orchestration'],
        [placement('quirky-cli', 'current'), placement('orchestration', 'outdated')]
      )
    ).toEqual(['orchestration'])
  })
})
