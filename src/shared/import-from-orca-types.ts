/** Which entry point started an import; a rerun only adds what is new in Orca Dev. */
export type ImportFromOrcaMode = 'first-run' | 'rerun'

export type ImportErrorCode =
  | 'SOURCE_MISSING'
  | 'SOURCE_INCOMPATIBLE'
  | 'KEYCHAIN_DENIED'
  | 'WRITE_FAILED'

export type ImportError = {
  code: ImportErrorCode
  message: string
}

/** Which Orca Dev keychain item unlocked the secrets; null when none did. */
export type ImportKeychainItem = 'primary' | 'fallback' | null

/** What an import did, in terms safe to show: counts, names and slot labels, never secret values. */
export type ImportReport = {
  mode: ImportFromOrcaMode
  /** False when the import stopped before or while writing; `errors` says why. */
  ok: boolean
  /** Items added per domain. */
  imported: Record<string, number>
  /** Domains of Orca Dev state this import version does not know how to bring over. */
  notImported: string[]
  /** Items dropped because they named a provider or host kind Quirky no longer has, per domain. */
  normalizedAway: Record<string, number>
  /** Secret slots or credential files that could not be carried over. */
  skippedSecrets: string[]
  keychainItem: ImportKeychainItem
  /** Account folders and files copied, relative to their roots. */
  copiedFiles: string[]
  errors: ImportError[]
}

export type ImportDetectResult = {
  sourceFound: boolean
  quirkyHasRepos: boolean
  /** True when Quirky is empty and Orca Dev data exists, so the first-launch offer applies. */
  offerFirstRun: boolean
}
