import { ipcRenderer } from 'electron'
import type {
  ImportDetectResult,
  ImportFromOrcaMode,
  ImportReport
} from '../../shared/import-from-orca-types'
import type { PreloadApi } from '../api-types'

export const importFromOrcaApi = {
  detect: (): Promise<ImportDetectResult> => ipcRenderer.invoke('importFromOrca:detect'),
  run: (args: { mode: ImportFromOrcaMode }): Promise<ImportReport> =>
    ipcRenderer.invoke('importFromOrca:run', args)
} satisfies PreloadApi['importFromOrca']
