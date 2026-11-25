import { ipcMain } from 'electron'
import type {
  ImportDetectResult,
  ImportFromOrcaMode,
  ImportReport
} from '../../shared/import-from-orca-types'
import { detectImportFromOrca, importFromOrcaDev } from '../import-from-orca'
import type { Store } from '../persistence'

function parseMode(args: unknown): ImportFromOrcaMode {
  const mode = typeof args === 'object' && args !== null && 'mode' in args ? args.mode : args
  return mode === 'first-run' ? 'first-run' : 'rerun'
}

/** Registers the Orca Dev import's detect and run channels; a second run waits for the first. */
export function registerImportFromOrcaHandlers(store: Store): void {
  ipcMain.removeHandler('importFromOrca:detect')
  ipcMain.removeHandler('importFromOrca:run')

  let running: Promise<ImportReport> | null = null

  ipcMain.handle('importFromOrca:detect', (): ImportDetectResult => detectImportFromOrca({ store }))
  ipcMain.handle('importFromOrca:run', (_event, args: unknown): Promise<ImportReport> => {
    if (running === null) {
      running = importFromOrcaDev({ mode: parseMode(args) }, { store }).finally(() => {
        running = null
      })
    }
    return running
  })
}
