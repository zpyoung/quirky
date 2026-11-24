import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ProfileStoragePaths from '../quirky-profiles/profile-storage-paths'

const {
  handlers,
  appExitMock,
  appQuitMock,
  appRelaunchMock,
  relaunchAppMock,
  destroySystemTrayMock,
  createLocalQuirkyProfileMock,
  getQuirkyProfileListStateMock,
  seedNewQuirkyProfileTelemetryConsentMock,
  setActiveQuirkyProfileMock,
  transferQuirkyProfileProjectMock,
  hasQuirkyProfileStateDatabaseMock
} = vi.hoisted(() => ({
  handlers: new Map<string, (_event: unknown, args?: unknown) => unknown>(),
  appExitMock: vi.fn(),
  appQuitMock: vi.fn(),
  appRelaunchMock: vi.fn(),
  relaunchAppMock: vi.fn(),
  destroySystemTrayMock: vi.fn(),
  createLocalQuirkyProfileMock: vi.fn(),
  getQuirkyProfileListStateMock: vi.fn(),
  seedNewQuirkyProfileTelemetryConsentMock: vi.fn(),
  setActiveQuirkyProfileMock: vi.fn(),
  transferQuirkyProfileProjectMock: vi.fn(),
  hasQuirkyProfileStateDatabaseMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    exit: appExitMock,
    quit: appQuitMock,
    relaunch: appRelaunchMock
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (_event: unknown, args?: unknown) => unknown) => {
      handlers.set(channel, handler)
    })
  }
}))

vi.mock('../tray/system-tray', () => ({
  destroySystemTray: destroySystemTrayMock
}))

vi.mock('../app-relaunch', () => ({
  relaunchApp: relaunchAppMock
}))

vi.mock('../quirky-profiles/profile-index-store', () => ({
  createLocalQuirkyProfile: createLocalQuirkyProfileMock,
  getQuirkyProfileListState: getQuirkyProfileListStateMock,
  seedNewQuirkyProfileTelemetryConsent: seedNewQuirkyProfileTelemetryConsentMock,
  setActiveQuirkyProfile: setActiveQuirkyProfileMock
}))

function makeStoreMock(flushPendingOrThrowAsync = vi.fn()) {
  const freezeWrites = vi.fn()
  const resumeMaintenance = vi.fn(async () => {})
  return {
    flushPendingOrThrowAsync,
    freezeWrites,
    resumeMaintenance,
    beginProfileMaintenance: vi.fn(async (options: unknown) => {
      await flushPendingOrThrowAsync(options)
      freezeWrites()
      return { resume: resumeMaintenance }
    }),
    getSettings: () => ({})
  }
}

vi.mock('../quirky-profiles/profile-project-transfer', () => ({
  transferQuirkyProfileProject: transferQuirkyProfileProjectMock
}))

vi.mock('../quirky-profiles/profile-storage-paths', async (importOriginal) => ({
  ...(await importOriginal<typeof ProfileStoragePaths>()),
  hasQuirkyProfileStateDatabase: hasQuirkyProfileStateDatabaseMock
}))

import { registerQuirkyProfileHandlers } from './quirky-profiles'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'

const ipcEvent = { sender: { isDestroyed: () => false, send: vi.fn() } }

describe('registerQuirkyProfileHandlers', () => {
  beforeEach(() => {
    // Why the port and per-test: userData resolves through AppEnvironment now, and
    // the global setup's beforeEach reinstates its own fake before this runs.
    installFakeAppEnvironment({ getPath: () => '/tmp/quirky-user-data' })
    vi.useFakeTimers()
    handlers.clear()
    ipcEvent.sender.send.mockClear()
    appExitMock.mockReset()
    appQuitMock.mockReset()
    appRelaunchMock.mockReset()
    relaunchAppMock.mockReset()
    relaunchAppMock.mockImplementation(() => appRelaunchMock())
    destroySystemTrayMock.mockReset()
    createLocalQuirkyProfileMock.mockReset()
    getQuirkyProfileListStateMock.mockReset()
    seedNewQuirkyProfileTelemetryConsentMock.mockReset()
    setActiveQuirkyProfileMock.mockReset()
    transferQuirkyProfileProjectMock.mockReset()
    hasQuirkyProfileStateDatabaseMock.mockReset().mockReturnValue(false)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('registers list and create handlers', async () => {
    const listState = {
      activeProfileId: 'local-default',
      profiles: [{ id: 'local-default', name: 'Personal' }]
    }
    const createState = {
      ...listState,
      profile: { id: 'local-work', name: 'Work' }
    }
    getQuirkyProfileListStateMock.mockReturnValue(listState)
    createLocalQuirkyProfileMock.mockReturnValue(createState)

    registerQuirkyProfileHandlers(makeStoreMock() as never)

    await expect(Promise.resolve(handlers.get('quirkyProfiles:list')?.(ipcEvent))).resolves.toEqual(
      {
        ...listState,
        multiProfileUi: false
      }
    )
    await expect(
      Promise.resolve(handlers.get('quirkyProfiles:createLocal')?.(ipcEvent, { name: 'Work' }))
    ).resolves.toBe(createState)
    expect(createLocalQuirkyProfileMock).toHaveBeenCalledWith({ name: 'Work' })
  })

  it('reports multiProfileUi when the env flag is set', async () => {
    const previous = process.env.QUIRKY_MULTI_PROFILE_UI
    process.env.QUIRKY_MULTI_PROFILE_UI = '1'
    try {
      getQuirkyProfileListStateMock.mockReturnValue({
        activeProfileId: 'local-default',
        profiles: []
      })
      registerQuirkyProfileHandlers(makeStoreMock() as never)

      await expect(
        Promise.resolve(handlers.get('quirkyProfiles:list')?.(ipcEvent))
      ).resolves.toEqual({
        activeProfileId: 'local-default',
        profiles: [],
        multiProfileUi: true
      })
    } finally {
      if (previous === undefined) {
        delete process.env.QUIRKY_MULTI_PROFILE_UI
      } else {
        process.env.QUIRKY_MULTI_PROFILE_UI = previous
      }
    }
  })

  it('marks the target profile active, flushes, and relaunches', async () => {
    const flush = vi.fn()
    const onBeforeRelaunch = vi.fn()
    getQuirkyProfileListStateMock.mockReturnValue({
      activeProfileId: 'local-default',
      profiles: []
    })
    setActiveQuirkyProfileMock.mockReturnValue({
      activeProfileId: 'local-work',
      profiles: []
    })
    registerQuirkyProfileHandlers(makeStoreMock(flush) as never, { onBeforeRelaunch })

    const resultPromise = Promise.resolve(
      handlers.get('quirkyProfiles:switch')?.(ipcEvent, { profileId: 'local-work' })
    )

    await expect(resultPromise).resolves.toEqual({ status: 'relaunching' })
    expect(setActiveQuirkyProfileMock).toHaveBeenCalledWith('local-work')
    expect(flush).toHaveBeenCalledOnce()
    expect(onBeforeRelaunch).toHaveBeenCalledOnce()
    expect(flush.mock.invocationCallOrder[0]).toBeLessThan(
      setActiveQuirkyProfileMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    )
    expect(flush).toHaveBeenCalledBefore(onBeforeRelaunch)
    expect(appRelaunchMock).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(150)

    expect(appRelaunchMock).toHaveBeenCalledOnce()
    expect(relaunchAppMock).toHaveBeenCalledWith('profile-switch')
    // Why quit, not exit: before-quit/will-quit teardown (scrollback capture,
    // PTY kill, daemon checkpoints) must run on a profile switch.
    expect(appQuitMock).toHaveBeenCalledOnce()
    expect(appExitMock).not.toHaveBeenCalled()
  })

  it('does not mark a profile active when current profile flush fails', async () => {
    const flush = vi.fn(() => {
      throw new Error('flush_failed')
    })
    getQuirkyProfileListStateMock.mockReturnValue({
      activeProfileId: 'local-default',
      profiles: []
    })
    registerQuirkyProfileHandlers(makeStoreMock(flush) as never)

    await expect(
      Promise.resolve(
        handlers.get('quirkyProfiles:switch')?.(ipcEvent, { profileId: 'local-work' })
      )
    ).rejects.toThrow('flush_failed')

    expect(setActiveQuirkyProfileMock).not.toHaveBeenCalled()
    expect(appRelaunchMock).not.toHaveBeenCalled()
  })

  it('does not switch profiles when persistence cannot reach quiescence', async () => {
    const flush = vi.fn(() => new Promise<void>(() => {}))
    const onBeforeRelaunch = vi.fn()
    getQuirkyProfileListStateMock.mockReturnValue({
      activeProfileId: 'local-default',
      profiles: []
    })
    registerQuirkyProfileHandlers(makeStoreMock(flush) as never, { onBeforeRelaunch })

    const switchProfile = Promise.resolve(
      handlers.get('quirkyProfiles:switch')?.(ipcEvent, { profileId: 'local-work' })
    )
    const rejection = expect(switchProfile).rejects.toThrow('quirky_profile_persistence_timeout')
    await vi.advanceTimersByTimeAsync(60_000)
    await rejection

    expect(setActiveQuirkyProfileMock).not.toHaveBeenCalled()
    expect(appRelaunchMock).not.toHaveBeenCalled()
    expect(onBeforeRelaunch).not.toHaveBeenCalled()
  })

  it('does not relaunch when switching to the active profile', async () => {
    getQuirkyProfileListStateMock.mockReturnValue({
      activeProfileId: 'local-default',
      profiles: []
    })
    registerQuirkyProfileHandlers(makeStoreMock() as never)

    await expect(
      Promise.resolve(
        handlers.get('quirkyProfiles:switch')?.(ipcEvent, { profileId: 'local-default' })
      )
    ).resolves.toEqual({ status: 'already-active' })

    expect(setActiveQuirkyProfileMock).not.toHaveBeenCalled()
    expect(appRelaunchMock).not.toHaveBeenCalled()
  })

  it('rejects invalid profile ids', async () => {
    registerQuirkyProfileHandlers(makeStoreMock() as never)

    await expect(
      Promise.resolve(handlers.get('quirkyProfiles:switch')?.(ipcEvent, { profileId: ' ' }))
    ).rejects.toThrow('invalid_quirky_profile_id')
  })

  it('transfers projects between inactive profiles after flushing active state', async () => {
    const flush = vi.fn()
    const result = {
      status: 'transferred',
      mode: 'copy',
      sourceProfileId: 'personal',
      targetProfileId: 'work',
      sourceRepoId: 'repo-1',
      targetRepoId: 'repo-2',
      targetProjectId: 'repo:repo-2'
    }
    getQuirkyProfileListStateMock.mockReturnValue({
      activeProfileId: 'personal',
      profiles: []
    })
    transferQuirkyProfileProjectMock.mockReturnValue(result)
    registerQuirkyProfileHandlers(makeStoreMock(flush) as never)

    await expect(
      Promise.resolve(
        handlers.get('quirkyProfiles:transferProject')?.(ipcEvent, {
          sourceProfileId: ' personal ',
          targetProfileId: ' work ',
          repoId: ' repo-1 ',
          mode: 'copy'
        })
      )
    ).resolves.toBe(result)

    expect(flush).toHaveBeenCalledOnce()
    expect(transferQuirkyProfileProjectMock).toHaveBeenCalledWith(
      {
        sourceProfileId: 'personal',
        targetProfileId: 'work',
        repoId: 'repo-1',
        mode: 'copy'
      },
      '/tmp/quirky-user-data'
    )
  })

  it('moves a project out of the active profile and relaunches into the target profile', async () => {
    const flush = vi.fn()
    const onBeforeRelaunch = vi.fn()
    const result = {
      status: 'transferred',
      mode: 'move',
      sourceProfileId: 'personal',
      targetProfileId: 'work',
      sourceRepoId: 'repo-1',
      targetRepoId: 'repo-1',
      targetProjectId: 'repo:repo-1'
    }
    getQuirkyProfileListStateMock.mockReturnValue({
      activeProfileId: 'personal',
      profiles: []
    })
    transferQuirkyProfileProjectMock.mockReturnValue(result)
    registerQuirkyProfileHandlers(makeStoreMock(flush) as never, { onBeforeRelaunch })

    await expect(
      Promise.resolve(
        handlers.get('quirkyProfiles:transferProject')?.(ipcEvent, {
          sourceProfileId: 'personal',
          targetProfileId: 'work',
          repoId: 'repo-1',
          mode: 'move'
        })
      )
    ).resolves.toEqual({ ...result, willRelaunch: true })

    expect(onBeforeRelaunch).toHaveBeenCalledOnce()
    expect(flush).toHaveBeenCalledOnce()
    expect(transferQuirkyProfileProjectMock).toHaveBeenCalledWith(
      {
        sourceProfileId: 'personal',
        targetProfileId: 'work',
        repoId: 'repo-1',
        mode: 'move'
      },
      '/tmp/quirky-user-data'
    )
    expect(setActiveQuirkyProfileMock).toHaveBeenCalledWith('work')
    expect(appRelaunchMock).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(150)

    expect(appRelaunchMock).toHaveBeenCalledOnce()
    expect(ipcEvent.sender.send).toHaveBeenCalledWith('app:restart-committed')
    expect(relaunchAppMock).toHaveBeenCalledWith('profile-transfer')
    expect(appQuitMock).toHaveBeenCalledOnce()
    expect(appExitMock).not.toHaveBeenCalled()
  })

  it('relaunches the closed source when a completed move cannot update the profile index', async () => {
    const store = makeStoreMock()
    getQuirkyProfileListStateMock.mockReturnValue({ activeProfileId: 'personal', profiles: [] })
    transferQuirkyProfileProjectMock.mockReturnValue({ status: 'transferred', mode: 'move' })
    setActiveQuirkyProfileMock.mockImplementationOnce(() => {
      throw new Error('profile index disk full')
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fixture supplies every Store operation exercised by these IPC handlers.
    registerQuirkyProfileHandlers(store as never)

    await expect(
      handlers.get('quirkyProfiles:transferProject')?.(ipcEvent, {
        sourceProfileId: 'personal',
        targetProfileId: 'work',
        repoId: 'repo-1',
        mode: 'move'
      })
    ).rejects.toThrow('profile index disk full')

    expect(store.freezeWrites).toHaveBeenCalledOnce()
    expect(store.resumeMaintenance).not.toHaveBeenCalled()
    expect(ipcEvent.sender.send).toHaveBeenCalledWith('app:restart-committed')
    await vi.advanceTimersByTimeAsync(150)
    expect(relaunchAppMock).toHaveBeenCalledWith('profile-transfer')
    expect(appQuitMock).toHaveBeenCalledOnce()
  })

  it('keeps the active profile writable during a transfer between inactive profiles', async () => {
    const store = makeStoreMock()
    getQuirkyProfileListStateMock.mockReturnValue({ activeProfileId: 'active', profiles: [] })
    transferQuirkyProfileProjectMock.mockReturnValue({ status: 'transferred', mode: 'copy' })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fixture supplies the Store operations exercised by the handlers.
    registerQuirkyProfileHandlers(store as never)
    await handlers.get('quirkyProfiles:transferProject')?.(ipcEvent, {
      sourceProfileId: 'personal',
      targetProfileId: 'work',
      repoId: 'repo-1',
      mode: 'copy'
    })
    expect(store.beginProfileMaintenance).not.toHaveBeenCalled()
    expect(store.freezeWrites).not.toHaveBeenCalled()
    expect(store.flushPendingOrThrowAsync).toHaveBeenCalledBefore(transferQuirkyProfileProjectMock)
  })

  it('rejects transfers that would mutate the active target profile offline', async () => {
    getQuirkyProfileListStateMock.mockReturnValue({
      activeProfileId: 'work',
      profiles: []
    })
    registerQuirkyProfileHandlers(makeStoreMock() as never)

    await expect(
      Promise.resolve(
        handlers.get('quirkyProfiles:transferProject')?.(ipcEvent, {
          sourceProfileId: 'personal',
          targetProfileId: 'work',
          repoId: 'repo-1',
          mode: 'copy'
        })
      )
    ).rejects.toThrow('active_target_quirky_profile_transfer_requires_relaunch')

    expect(transferQuirkyProfileProjectMock).not.toHaveBeenCalled()
  })

  it('freezes a newly migrated source after transfer failure and reopens its current profile', async () => {
    const store = makeStoreMock()
    const onBeforeRelaunch = vi.fn()
    getQuirkyProfileListStateMock.mockReturnValue({ activeProfileId: 'personal', profiles: [] })
    transferQuirkyProfileProjectMock.mockImplementation(() => {
      hasQuirkyProfileStateDatabaseMock.mockReturnValue(true)
      throw new Error('source commit interrupted')
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fixture supplies every Store operation exercised by these IPC handlers.
    registerQuirkyProfileHandlers(store as never, { onBeforeRelaunch })

    await expect(
      Promise.resolve(
        handlers.get('quirkyProfiles:transferProject')?.(ipcEvent, {
          sourceProfileId: 'personal',
          targetProfileId: 'work',
          repoId: 'repo-1',
          mode: 'move'
        })
      )
    ).rejects.toThrow('source commit interrupted')

    expect(store.flushPendingOrThrowAsync).toHaveBeenCalledBefore(transferQuirkyProfileProjectMock)
    expect(store.freezeWrites).toHaveBeenCalledOnce()
    expect(store.freezeWrites).toHaveBeenCalledBefore(onBeforeRelaunch)
    expect(setActiveQuirkyProfileMock).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(150)
    expect(ipcEvent.sender.send).toHaveBeenCalledWith('app:restart-committed')
    expect(relaunchAppMock).toHaveBeenCalledWith('profile-transfer')
    expect(appQuitMock).toHaveBeenCalledOnce()
  })

  it('keeps an active JSON source writable after validation fails without a migration', async () => {
    const store = makeStoreMock()
    const onBeforeRelaunch = vi.fn()
    getQuirkyProfileListStateMock.mockReturnValue({ activeProfileId: 'personal', profiles: [] })
    transferQuirkyProfileProjectMock.mockImplementation(() => {
      throw new Error('unknown_source_repo')
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fixture supplies every Store operation exercised by these IPC handlers.
    registerQuirkyProfileHandlers(store as never, { onBeforeRelaunch })

    await expect(
      Promise.resolve(
        handlers.get('quirkyProfiles:transferProject')?.(ipcEvent, {
          sourceProfileId: 'personal',
          targetProfileId: 'work',
          repoId: 'repo-1',
          mode: 'move'
        })
      )
    ).rejects.toThrow('unknown_source_repo')

    expect(store.resumeMaintenance).toHaveBeenCalledOnce()
    expect(onBeforeRelaunch).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(150)
    expect(relaunchAppMock).not.toHaveBeenCalled()
  })

  it.each([
    null,
    {},
    { sourceProfileId: 4 },
    {
      sourceProfileId: 'personal',
      targetProfileId: 'work',
      repoId: 'repo-1',
      mode: 'invalid'
    }
  ])('rejects malformed transfer arguments before disk work: %j', async (args) => {
    const store = makeStoreMock()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fixture supplies every Store operation exercised by these IPC handlers.
    registerQuirkyProfileHandlers(store as never)
    await expect(
      Promise.resolve(handlers.get('quirkyProfiles:transferProject')?.(ipcEvent, args))
    ).rejects.toThrow('invalid_quirky_profile_project_transfer')
    expect(store.flushPendingOrThrowAsync).not.toHaveBeenCalled()
    expect(transferQuirkyProfileProjectMock).not.toHaveBeenCalled()
  })
})
