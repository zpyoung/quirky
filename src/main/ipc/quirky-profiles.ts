import { ipcMain, type WebContents } from 'electron'
import type { Store } from '../persistence'
import { relaunchApp, type AppRelaunchReason } from '../app-relaunch'
import { quitProcess } from '../startup/process-quit-request'
import type {
  CreateLocalQuirkyProfileArgs,
  CreateLocalQuirkyProfileResult,
  FindQuirkyProfileProjectsByPathArgs,
  FindQuirkyProfileProjectsByPathResult,
  QuirkyProfileListResult,
  SwitchQuirkyProfileArgs,
  SwitchQuirkyProfileResult,
  TransferQuirkyProfileProjectArgs,
  TransferQuirkyProfileProjectResult
} from '../../shared/quirky-profiles'
import {
  createLocalQuirkyProfile,
  getQuirkyProfileListState,
  setActiveQuirkyProfile
} from '../quirky-profiles/profile-index-store'
import { getProfileUserDataPath } from '../quirky-profiles/profile-storage-paths'
import { isMultiProfileUiEnabled } from '../quirky-profiles/profile-ui-scope'
import { transferQuirkyProfileProject } from '../quirky-profiles/profile-project-transfer'
import { transferActiveProfileProject } from '../quirky-profiles/profile-active-transfer'
import { findQuirkyProfileProjectsByPath } from '../quirky-profiles/profile-project-presence'
import {
  flushActiveProfileBeforeFileMutation,
  flushActiveProfileBeforeRelaunch
} from '../quirky-profiles/profile-persistence-deadline'
import { normalizeExecutionHostId } from '../../shared/execution-host'
import { transferProjectArgsFromUnknown } from './quirky-profile-project-transfer-args'

type RegisterQuirkyProfileHandlersOptions = {
  onBeforeRelaunch?: () => void | Promise<void>
}

function profileIdFromArgs(args: unknown): string {
  const profileId =
    args && typeof args === 'object' && 'profileId' in args && typeof args.profileId === 'string'
      ? args.profileId.trim()
      : ''
  if (!profileId) {
    throw new Error('invalid_quirky_profile_id')
  }
  return profileId
}

function findProjectsByPathArgsFromUnknown(args: unknown): FindQuirkyProfileProjectsByPathArgs {
  if (!args || typeof args !== 'object') {
    throw new Error('invalid_quirky_profile_project_path')
  }
  const candidate = args as FindQuirkyProfileProjectsByPathArgs
  const path = typeof candidate.path === 'string' ? candidate.path.trim() : ''
  if (!path) {
    throw new Error('invalid_quirky_profile_project_path')
  }
  let executionHostId: FindQuirkyProfileProjectsByPathArgs['executionHostId'] = null
  if (candidate.executionHostId !== null && candidate.executionHostId !== undefined) {
    if (typeof candidate.executionHostId !== 'string') {
      throw new Error('invalid_quirky_profile_project_path')
    }
    executionHostId = normalizeExecutionHostId(candidate.executionHostId)
    if (!executionHostId) {
      throw new Error('invalid_quirky_profile_project_path')
    }
  }
  return {
    path,
    connectionId:
      typeof candidate.connectionId === 'string' ? candidate.connectionId.trim() || null : null,
    executionHostId,
    excludeProfileId:
      typeof candidate.excludeProfileId === 'string'
        ? candidate.excludeProfileId.trim() || null
        : null
  }
}

async function runBeforeProfileRelaunch(
  onBeforeRelaunch?: () => void | Promise<void>
): Promise<void> {
  try {
    await onBeforeRelaunch?.()
  } catch (error) {
    console.warn(
      '[quirky-profiles] Pre-relaunch cleanup failed; continuing profile switch:',
      error instanceof Error ? error.name : typeof error
    )
  }
}

type ProfileRelaunchReason = Extract<AppRelaunchReason, `profile-${string}`>

function scheduleProfileRelaunch(reason: ProfileRelaunchReason, sender: WebContents): void {
  if (!sender.isDestroyed()) {
    sender.send('app:restart-committed')
  }
  setTimeout(() => {
    relaunchApp(reason)
    // Why: app.quit() (not app.exit) so before-quit/will-quit still run —
    // renderer scrollback capture, PTY kill, stats flush, and daemon final
    // checkpoints must not be skipped on a profile switch.
    quitProcess()
  }, 150)
}

export function registerQuirkyProfileHandlers(
  store: Store,
  options: RegisterQuirkyProfileHandlersOptions = {}
): void {
  ipcMain.handle('quirkyProfiles:list', (): QuirkyProfileListResult => ({
    ...getQuirkyProfileListState(),
    multiProfileUi: isMultiProfileUiEnabled()
  }))

  ipcMain.handle(
    'quirkyProfiles:createLocal',
    (_event, args?: CreateLocalQuirkyProfileArgs): CreateLocalQuirkyProfileResult => {
      const result = createLocalQuirkyProfile(args)
      return result
    }
  )

  ipcMain.handle(
    'quirkyProfiles:switch',
    async (event, args: SwitchQuirkyProfileArgs): Promise<SwitchQuirkyProfileResult> => {
      const profileId = profileIdFromArgs(args)
      const current = getQuirkyProfileListState()
      if (profileId === current.activeProfileId) {
        return { status: 'already-active' }
      }

      // Why: the current profile must be persisted before the global index
      // points startup at the target profile.
      // Switching leaves source files intact; relaunch cleanup still needs its live writer.
      await flushActiveProfileBeforeRelaunch(store)
      setActiveQuirkyProfile(profileId)
      await runBeforeProfileRelaunch(options.onBeforeRelaunch)

      scheduleProfileRelaunch('profile-switch', event.sender)

      return { status: 'relaunching' }
    }
  )

  ipcMain.handle(
    'quirkyProfiles:transferProject',
    async (
      event,
      rawArgs: TransferQuirkyProfileProjectArgs
    ): Promise<TransferQuirkyProfileProjectResult> => {
      const args = transferProjectArgsFromUnknown(rawArgs)
      const current = getQuirkyProfileListState()
      if (args.targetProfileId === current.activeProfileId) {
        throw new Error('active_target_quirky_profile_transfer_requires_relaunch')
      }
      if (args.mode === 'move' && args.sourceProfileId === current.activeProfileId) {
        // Why: transfer before any relaunch side effect so a duplicate-target
        // or validation failure cannot strand the app in a quitting state.
        const result = await transferActiveProfileProject(
          args,
          getProfileUserDataPath(),
          store,
          async () => {
            await runBeforeProfileRelaunch(options.onBeforeRelaunch)
            scheduleProfileRelaunch('profile-transfer', event.sender)
          }
        )
        if (result.status === 'transferred') {
          await runBeforeProfileRelaunch(options.onBeforeRelaunch)
          try {
            setActiveQuirkyProfile(args.targetProfileId)
          } finally {
            // The source has already changed and its writer cannot resume.
            scheduleProfileRelaunch('profile-transfer', event.sender)
          }
          return { ...result, willRelaunch: true }
        }
        return result
      }
      if (args.sourceProfileId !== current.activeProfileId) {
        await store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
        return transferQuirkyProfileProject(args, getProfileUserDataPath())
      }
      const maintenance = await flushActiveProfileBeforeFileMutation(store)
      try {
        return transferQuirkyProfileProject(args, getProfileUserDataPath())
      } finally {
        await maintenance.resume()
      }
    }
  )

  ipcMain.handle(
    'quirkyProfiles:findProjectProfiles',
    (_event, rawArgs: FindQuirkyProfileProjectsByPathArgs): FindQuirkyProfileProjectsByPathResult =>
      findQuirkyProfileProjectsByPath(
        findProjectsByPathArgsFromUnknown(rawArgs),
        getProfileUserDataPath()
      )
  )
}
