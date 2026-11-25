import { useCallback, useState } from 'react'
import type { ImportFromOrcaMode, ImportReport } from '../../../../shared/import-from-orca-types'

type ImportFromOrcaRun = {
  running: boolean
  report: ImportReport | null
  run: (mode: ImportFromOrcaMode) => Promise<void>
}

/** Runs the Orca Dev import through the preload bridge and holds its report. */
export function useImportFromOrca(): ImportFromOrcaRun {
  const [running, setRunning] = useState(false)
  const [report, setReport] = useState<ImportReport | null>(null)
  const run = useCallback(async (mode: ImportFromOrcaMode) => {
    setRunning(true)
    try {
      setReport(await window.api.importFromOrca.run({ mode }))
    } catch (error) {
      setReport({
        mode,
        ok: false,
        imported: {},
        notImported: [],
        normalizedAway: {},
        skippedSecrets: [],
        keychainItem: null,
        copiedFiles: [],
        errors: [
          {
            code: 'WRITE_FAILED',
            message: error instanceof Error ? error.message : String(error)
          }
        ]
      })
    } finally {
      setRunning(false)
    }
  }, [])
  return { running, report, run }
}
