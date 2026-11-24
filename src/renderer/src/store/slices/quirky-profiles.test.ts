import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createTestStore } from './store-test-helpers'
import type {
  CreateLocalQuirkyProfileResult,
  QuirkyProfileListResult,
  TransferQuirkyProfileProjectResult
} from '../../../../shared/quirky-profiles'

const { toastErrorMock } = vi.hoisted(() => ({
  toastErrorMock: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: {
    error: toastErrorMock,
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn()
  }
}))

const listState: QuirkyProfileListResult = {
  activeProfileId: 'local-default',
  multiProfileUi: false,
  profiles: [
    {
      id: 'local-default',
      name: 'Personal',
      avatar: { kind: 'initials', initials: 'P', color: 'neutral' },
      kind: 'local',
      createdAt: 1,
      updatedAt: 1,
      lastOpenedAt: 1
    }
  ]
}

const createdState: CreateLocalQuirkyProfileResult = {
  activeProfileId: 'local-default',
  profiles: [
    ...listState.profiles,
    {
      id: 'local-work',
      name: 'Work',
      avatar: { kind: 'initials', initials: 'W', color: 'neutral' },
      kind: 'local',
      createdAt: 2,
      updatedAt: 2,
      lastOpenedAt: 2
    }
  ],
  profile: {
    id: 'local-work',
    name: 'Work',
    avatar: { kind: 'initials', initials: 'W', color: 'neutral' },
    kind: 'local',
    createdAt: 2,
    updatedAt: 2,
    lastOpenedAt: 2
  }
}

const quirkyProfilesApi = {
  list: vi.fn(),
  createLocal: vi.fn(),
  switchProfile: vi.fn(),
  transferProject: vi.fn()
}

describe('quirky profile slice', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    toastErrorMock.mockReset()
    vi.stubGlobal('window', {
      api: {
        quirkyProfiles: quirkyProfilesApi
      }
    })
  })

  it('fetches profiles into store state', async () => {
    quirkyProfilesApi.list.mockResolvedValue(listState)
    const store = createTestStore()

    await store.getState().fetchQuirkyProfiles()

    expect(store.getState().activeQuirkyProfileId).toBe('local-default')
    expect(store.getState().quirkyProfiles).toEqual(listState.profiles)
    expect(store.getState().quirkyProfilesMultiProfileUi).toBe(false)
    expect(store.getState().quirkyProfilesLoading).toBe(false)
  })

  it('stores the multi-profile UI flag from the list result', async () => {
    quirkyProfilesApi.list.mockResolvedValue({ ...listState, multiProfileUi: true })
    const store = createTestStore()

    await store.getState().fetchQuirkyProfiles()

    expect(store.getState().quirkyProfilesMultiProfileUi).toBe(true)
  })

  it('creates a local profile and returns the created summary', async () => {
    quirkyProfilesApi.createLocal.mockResolvedValue(createdState)
    const store = createTestStore()

    const profile = await store.getState().createLocalQuirkyProfile('Work')

    expect(profile).toEqual(createdState.profile)
    expect(quirkyProfilesApi.createLocal).toHaveBeenCalledWith({ name: 'Work' })
    expect(store.getState().quirkyProfiles).toEqual(createdState.profiles)
  })

  it('sets switching state while requesting a profile switch', async () => {
    quirkyProfilesApi.switchProfile.mockResolvedValue({ status: 'relaunching' })
    const store = createTestStore()
    store.setState({ activeQuirkyProfileId: 'local-default' })

    const result = await store.getState().switchQuirkyProfile('local-work')

    expect(result).toEqual({ status: 'relaunching' })
    expect(quirkyProfilesApi.switchProfile).toHaveBeenCalledWith({ profileId: 'local-work' })
    expect(store.getState().quirkyProfileSwitching).toBe(true)
  })

  it('releases switching state when main reports the profile is already active', async () => {
    // Why: a stale renderer activeQuirkyProfileId must not lock the switcher
    // forever when no relaunch is actually coming.
    quirkyProfilesApi.switchProfile.mockResolvedValue({ status: 'already-active' })
    const store = createTestStore()
    store.setState({ activeQuirkyProfileId: 'local-default' })

    const result = await store.getState().switchQuirkyProfile('local-work')

    expect(result).toEqual({ status: 'already-active' })
    expect(store.getState().quirkyProfileSwitching).toBe(false)
  })

  it('does not call main when switching to the active profile', async () => {
    const store = createTestStore()
    store.setState({ activeQuirkyProfileId: 'local-default' })

    const result = await store.getState().switchQuirkyProfile('local-default')

    expect(result).toEqual({ status: 'already-active' })
    expect(quirkyProfilesApi.switchProfile).not.toHaveBeenCalled()
  })

  it('transfers projects through the profile API', async () => {
    const transferResult: TransferQuirkyProfileProjectResult = {
      status: 'transferred',
      mode: 'copy',
      sourceProfileId: 'local-default',
      targetProfileId: 'local-work',
      sourceRepoId: 'repo-1',
      targetRepoId: 'repo-2',
      targetProjectId: 'repo:repo-2'
    }
    quirkyProfilesApi.transferProject.mockResolvedValue(transferResult)
    const store = createTestStore()

    const result = await store.getState().transferQuirkyProfileProject({
      sourceProfileId: 'local-default',
      targetProfileId: 'local-work',
      repoId: 'repo-1',
      mode: 'copy'
    })

    expect(result).toEqual(transferResult)
    expect(quirkyProfilesApi.transferProject).toHaveBeenCalledWith({
      sourceProfileId: 'local-default',
      targetProfileId: 'local-work',
      repoId: 'repo-1',
      mode: 'copy'
    })
  })

  it('marks profile switching when a project transfer relaunches the app', async () => {
    const transferResult: TransferQuirkyProfileProjectResult = {
      status: 'transferred',
      mode: 'move',
      sourceProfileId: 'local-default',
      targetProfileId: 'local-work',
      sourceRepoId: 'repo-1',
      targetRepoId: 'repo-1',
      targetProjectId: 'repo:repo-1',
      willRelaunch: true
    }
    quirkyProfilesApi.transferProject.mockResolvedValue(transferResult)
    const store = createTestStore()

    await store.getState().transferQuirkyProfileProject({
      sourceProfileId: 'local-default',
      targetProfileId: 'local-work',
      repoId: 'repo-1',
      mode: 'move'
    })

    expect(store.getState().quirkyProfileSwitching).toBe(true)
  })

  it('warns when a project already exists in the target profile', async () => {
    const transferResult: TransferQuirkyProfileProjectResult = {
      status: 'duplicate-target',
      sourceProfileId: 'local-default',
      targetProfileId: 'local-work',
      sourceRepoId: 'repo-1',
      duplicateRepoId: 'repo-existing'
    }
    quirkyProfilesApi.transferProject.mockResolvedValue(transferResult)
    const store = createTestStore()

    await store.getState().transferQuirkyProfileProject({
      sourceProfileId: 'local-default',
      targetProfileId: 'local-work',
      repoId: 'repo-1',
      mode: 'copy'
    })

    expect(toastErrorMock).toHaveBeenCalledWith('Project already exists in that profile')
    expect(store.getState().quirkyProfileSwitching).toBe(false)
  })
})
