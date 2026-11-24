import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import { getLedgerSettingsNavigation } from './ledger-settings-navigation'

const repos = [{ id: 'repo-a', displayName: 'quirky' } as Repo]
const projectId = 'repo:repo-a'

describe('ledger settings navigation', () => {
  it('deep links a project ledger to its project pane section', () => {
    expect(getLedgerSettingsNavigation({ tier: 'project', id: projectId }, repos)).toEqual({
      pane: 'repo',
      repoId: 'repo-a',
      sectionId: 'repo-repo-a-ledger'
    })
  })
  it.each([
    ['a group ledger', { tier: 'group', id: 'group-a' } as const],
    ['a detached ledger', null],
    ['an unknown project', { tier: 'project', id: 'github:acme/gone' } as const]
  ])('has no settings home for %s', (_case, owner) => {
    expect(getLedgerSettingsNavigation(owner, repos)).toBeNull()
  })
})
