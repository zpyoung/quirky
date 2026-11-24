import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'
import type {
  QuirkyProfileListResult,
  SwitchQuirkyProfileResult,
  TransferQuirkyProfileProjectResult
} from '../../shared/quirky-profiles'
import { prepareAndInvokeAppRestart } from '../renderer-restart-wiring'
import { awaitBeforeUnloadCheckpoint } from '../preload-runtime-support'

export const quirkyProfilesApi = {
  list: () => ipcRenderer.invoke('quirkyProfiles:list'),
  createLocal: (args) => ipcRenderer.invoke('quirkyProfiles:createLocal', args),
  switchProfile: (args) =>
    prepareAndInvokeAppRestart(
      window,
      (): Promise<SwitchQuirkyProfileResult> => ipcRenderer.invoke('quirkyProfiles:switch', args),
      awaitBeforeUnloadCheckpoint,
      (result) => result.status === 'relaunching'
    ),
  transferProject: async (args) => {
    const invoke = (): Promise<TransferQuirkyProfileProjectResult> =>
      ipcRenderer.invoke('quirkyProfiles:transferProject', args)
    if (args.mode !== 'move') {
      return invoke()
    }
    const current: QuirkyProfileListResult = await ipcRenderer.invoke('quirkyProfiles:list')
    if (args.sourceProfileId !== current.activeProfileId) {
      return invoke()
    }
    return prepareAndInvokeAppRestart(
      window,
      invoke,
      awaitBeforeUnloadCheckpoint,
      (result) => result.status === 'transferred' && result.willRelaunch === true
    )
  },
  findProjectProfiles: (args) => ipcRenderer.invoke('quirkyProfiles:findProjectProfiles', args)
} satisfies PreloadApi['quirkyProfiles']
