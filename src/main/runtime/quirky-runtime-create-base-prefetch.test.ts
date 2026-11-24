import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as WorktreeCreatePreparation from '../worktree-create-preparation'
import type { Project } from '../../shared/project-types'
import type { Repo } from '../../shared/repo-types'

const mocks = vi.hoisted(() => ({
  prefetchWorktreeCreateBase: vi.fn(),
  prepareWorktreeCreateForRepo: vi.fn()
}))

vi.mock('../worktree-create-base-prefetch', () => ({
  prefetchWorktreeCreateBase: mocks.prefetchWorktreeCreateBase
}))
vi.mock('../worktree-create-preparation', async (importOriginal) => ({
  ...(await importOriginal<typeof WorktreeCreatePreparation>()),
  prepareWorktreeCreateForRepo: mocks.prepareWorktreeCreateForRepo
}))

import { QuirkyRuntimeService } from './quirky-runtime'

const repo: Repo = {
  id: 'repo-1',
  displayName: 'Repo',
  path: String.raw`C:\workspace\repo`,
  badgeColor: '#000000',
  addedAt: 0
}

const project: Project = {
  id: 'project-1',
  displayName: 'Project',
  badgeColor: '#000000',
  sourceRepoIds: ['repo-1'],
  createdAt: 0,
  updatedAt: 0,
  localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
}

function makeStore(overrides: Partial<Project> = {}): unknown {
  return {
    getRepos: () => [repo],
    getRepo: (id: string) => (id === repo.id ? repo : undefined),
    getProjects: () => [{ ...project, ...overrides }],
    getSettings: () => ({ localWindowsRuntimeDefault: { kind: 'windows-host' } })
  }
}

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
}

const hostPlatform = process.platform

beforeEach(() => {
  mocks.prefetchWorktreeCreateBase.mockReset().mockResolvedValue(undefined)
  mocks.prepareWorktreeCreateForRepo.mockReset().mockResolvedValue(undefined)
})

afterEach(() => {
  setPlatform(hostPlatform)
})

// The RPC/relay prefetch is the only warm-up a remote client reaches, so it has
// to resolve the same project runtime the IPC handler does. Constructed through
// the barrel because the split chain resolves selectors in a later subclass.
describe('prefetchManagedWorktreeCreateBase (quirky-runtime-get-worktree-terminal-provisioning-host)', () => {
  it('warms up on host git when no project runtime routes the repo', async () => {
    setPlatform('darwin')
    const runtime = new QuirkyRuntimeService(makeStore() as never)

    await runtime.prefetchManagedWorktreeCreateBase({ repoSelector: 'repo-1' })

    expect(mocks.prefetchWorktreeCreateBase).toHaveBeenCalledWith(
      expect.objectContaining({ gitOptions: {} })
    )
  })
})
