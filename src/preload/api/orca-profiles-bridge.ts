import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'
import type {
  OrcaProfileListResult,
  SwitchOrcaProfileResult,
  TransferOrcaProfileProjectResult
} from '../../shared/orca-profiles'
import { prepareAndInvokeAppRestart } from '../renderer-restart-wiring'
import { awaitBeforeUnloadCheckpoint } from '../preload-runtime-support'

export const orcaProfilesApi = {
  list: () => ipcRenderer.invoke('orcaProfiles:list'),
  createLocal: (args) => ipcRenderer.invoke('orcaProfiles:createLocal', args),
  switchProfile: (args) =>
    prepareAndInvokeAppRestart(
      window,
      (): Promise<SwitchOrcaProfileResult> => ipcRenderer.invoke('orcaProfiles:switch', args),
      awaitBeforeUnloadCheckpoint,
      (result) => result.status === 'relaunching'
    ),
  transferProject: async (args) => {
    const invoke = (): Promise<TransferOrcaProfileProjectResult> =>
      ipcRenderer.invoke('orcaProfiles:transferProject', args)
    if (args.mode !== 'move') {
      return invoke()
    }
    const current: OrcaProfileListResult = await ipcRenderer.invoke('orcaProfiles:list')
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
  findProjectProfiles: (args) => ipcRenderer.invoke('orcaProfiles:findProjectProfiles', args)
} satisfies PreloadApi['orcaProfiles']
