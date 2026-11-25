import { mkdir, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import { getDefaultSettings } from '../../shared/constants'
import type {
  ImportDetectResult,
  ImportError,
  ImportFromOrcaMode,
  ImportReport
} from '../../shared/import-from-orca-types'
import { getSecretStore, type SecretStore } from '../../shared/secret-store'
import { applyImportPlan, type ApplyResult, type ImportStore } from './apply'
import { SOURCE_DEFAULT_SUBDIR, SOURCE_HOME_DIRNAME } from './constants'
import { copyAccountDirs, copyKeybindings, removeWritten, writeSealedFile } from './files'
import { ImportFailure } from './import-failure'
import { readKeychainPasswordWithSecurity } from './keychain'
import { ORCA_AUTOMATION_CREATION_KEY_PREFIX, buildImportPlan } from './plan'
import {
  readReceipt,
  receiptCopiedFiles,
  receiptIds,
  receiptPath,
  receiptSecretSlots,
  type ImportReceipt
} from './receipt'
import type { KeychainReader } from './secrets'
import { resolveSecrets } from './secrets-step'
import { readSourceState, sourceDatabaseExists } from './source-state'

/** Everything environment-specific the importer touches, injectable so tests never reach real data. */
export type ImportFromOrcaDeps = {
  /** Orca Dev's application-support folder. */
  sourceRoot: string
  /** Orca Dev's dot-folder in the home directory. */
  sourceHome: string
  readKeychainPassword: KeychainReader
  /** Quirky's own secret store; sealing of imported secrets happens through it. */
  safeStorage: Pick<SecretStore, 'isEncryptionAvailable' | 'encryptString'>
  store: ImportStore
  userDataPath: string
  homeDir: string
  tempDir: string
  now: () => Date
}

/** Fills in the real locations for anything the caller did not inject; the store has no default. */
export function resolveImportDeps(
  partial: Partial<ImportFromOrcaDeps> & { store: ImportStore }
): ImportFromOrcaDeps {
  const home = partial.homeDir ?? homedir()
  const environment = (): ReturnType<typeof getAppEnvironment> => getAppEnvironment()
  return {
    sourceRoot: partial.sourceRoot ?? join(home, ...SOURCE_DEFAULT_SUBDIR),
    sourceHome: partial.sourceHome ?? join(home, SOURCE_HOME_DIRNAME),
    readKeychainPassword: partial.readKeychainPassword ?? readKeychainPasswordWithSecurity,
    safeStorage: partial.safeStorage ?? getSecretStore(),
    store: partial.store,
    userDataPath: partial.userDataPath ?? environment().getPath('userData'),
    homeDir: home,
    tempDir: partial.tempDir ?? environment().getPath('temp'),
    now: partial.now ?? (() => new Date())
  }
}

function idsOf(items: readonly { id: string }[]): Set<string> {
  return new Set(items.map((item) => item.id))
}

function knownIdsFor(
  deps: ImportFromOrcaDeps,
  receipt: ImportReceipt
): (domain: string) => Set<string> {
  const { store } = deps
  const settings = store.getSettings()
  const current: Record<string, Set<string>> = {
    repos: idsOf(store.getRepos()),
    projectHostSetups: idsOf(store.getProjectHostSetups()),
    worktreeMeta: new Set(Object.keys(store.getAllWorktreeMeta())),
    worktreeLineageById: new Set(Object.keys(store.getAllWorktreeLineage())),
    workspaceLineageByChildKey: new Set(Object.keys(store.getAllWorkspaceLineage())),
    sshTargets: idsOf(store.getSshTargets()),
    deletedSshConfigAliases: new Set(store.getDeletedSshConfigAliases()),
    removedSshTargetTombstones: new Set(
      store.getRemovedSshTargetTombstones().map((tombstone) => tombstone.oldTargetId)
    ),
    sparsePresetsByRepo: new Set(
      store.getRepos().flatMap((repo) => store.getSparsePresets(repo.id).map((preset) => preset.id))
    ),
    automations: new Set(
      store
        .listAutomations()
        .flatMap((automation) =>
          automation.creationKey?.startsWith(ORCA_AUTOMATION_CREATION_KEY_PREFIX)
            ? [automation.creationKey.slice(ORCA_AUTOMATION_CREATION_KEY_PREFIX.length)]
            : []
        )
    ),
    'settings.claudeManagedAccounts': idsOf(settings.claudeManagedAccounts),
    'settings.codexManagedAccounts': idsOf(settings.codexManagedAccounts)
  }
  return (domain) => new Set([...receiptIds(receipt, domain), ...(current[domain] ?? [])])
}

async function writeReceiptFile(path: string, receipt: ImportReceipt): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const staging = `${path}.tmp`
  await writeFile(staging, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 })
  await rename(staging, path)
}

function countImported(imported: Record<string, string[]>): Record<string, number> {
  return Object.fromEntries(Object.entries(imported).map(([domain, ids]) => [domain, ids.length]))
}

function emptyReport(mode: ImportFromOrcaMode): ImportReport {
  return {
    mode,
    ok: false,
    imported: {},
    notImported: [],
    normalizedAway: {},
    skippedSecrets: [],
    keychainItem: null,
    copiedFiles: [],
    errors: []
  }
}

/** Tells the first-launch offer whether Orca Dev data exists and Quirky is still empty. */
export function detectImportFromOrca(
  partial: Partial<ImportFromOrcaDeps> & { store: ImportStore }
): ImportDetectResult {
  const deps = resolveImportDeps(partial)
  const sourceFound = sourceDatabaseExists(deps.sourceRoot)
  const quirkyHasRepos = deps.store.getRepos().length > 0
  const alreadyImported = readReceipt(deps.userDataPath, deps.sourceRoot).runs.length > 0
  return {
    sourceFound,
    quirkyHasRepos,
    offerFirstRun: sourceFound && !quirkyHasRepos && !alreadyImported
  }
}

/**
 * Brings the owner's Orca Dev setup into Quirky's active profile. Orca Dev's files are only
 * read; secrets are decrypted in memory and handed to Quirky's own sealing. Errors come back
 * in the report by code, and a write failure rolls back everything this run wrote.
 */
export async function importFromOrcaDev(
  options: { mode: ImportFromOrcaMode },
  partial: Partial<ImportFromOrcaDeps> & { store: ImportStore }
): Promise<ImportReport> {
  const deps = resolveImportDeps(partial)
  const report = emptyReport(options.mode)
  const written: string[] = []
  const quirkyHome = join(deps.homeDir, '.quirky')
  let applied: ApplyResult | null = null
  try {
    const source = await readSourceState(deps.sourceRoot, deps.tempDir)
    const receipt = readReceipt(deps.userDataPath, deps.sourceRoot)
    const secrets = await resolveSecrets({
      source,
      sourceHome: deps.sourceHome,
      quirkyHome,
      alreadyImportedSlots: receiptSecretSlots(receipt),
      readKeychainPassword: deps.readKeychainPassword,
      safeStorage: deps.safeStorage
    })
    report.keychainItem = secrets.keychainItem
    report.skippedSecrets = [...secrets.skipped]
    report.errors.push(...secrets.errors)

    const plan = buildImportPlan({
      source,
      known: knownIdsFor(deps, receipt),
      plaintextSecrets: secrets.plaintext,
      userDataPath: deps.userDataPath,
      homeDir: deps.homeDir
    })
    report.notImported = plan.notImported
    report.normalizedAway = plan.normalizedAway

    const alreadyCopied = receiptCopiedFiles(receipt)
    report.copiedFiles.push(
      ...(await copyAccountDirs(deps.sourceRoot, deps.userDataPath, written, alreadyCopied)),
      ...(await copyKeybindings(deps.sourceHome, quirkyHome, written, alreadyCopied))
    )
    for (const file of secrets.sealedFiles) {
      if (await writeSealedFile(quirkyHome, file.name, file.content, written)) {
        report.copiedFiles.push(file.name)
      }
    }

    applied = await applyImportPlan(deps.store, plan, receipt.idMap ?? {}, {
      defaultSettings: getDefaultSettings(homedir())
    })
    const run = {
      at: deps.now().toISOString(),
      mode: options.mode,
      imported: applied.imported,
      skippedSecrets: report.skippedSecrets,
      secretsImported: applied.secretsImported,
      copiedFiles: [...report.copiedFiles]
    }
    await writeReceiptFile(receiptPath(deps.userDataPath), {
      ...receipt,
      idMap: {
        projectGroups: { ...receipt.idMap?.projectGroups, ...applied.idMap.projectGroups },
        folderWorkspaces: { ...receipt.idMap?.folderWorkspaces, ...applied.idMap.folderWorkspaces }
      },
      runs: [...receipt.runs, run]
    })
    report.imported = countImported(applied.imported)
    report.ok = true
  } catch (error) {
    const failure: ImportError =
      error instanceof ImportFailure
        ? { code: error.code, message: error.message }
        : {
            code: 'WRITE_FAILED',
            message: `The import failed: ${error instanceof Error ? error.message : String(error)}`
          }
    console.error('[import-from-orca] import failed', error)
    report.errors.push(failure)
    report.ok = false
    await applied?.rollback()
    report.imported = {}
    report.copiedFiles = []
    await removeWritten(written).catch(() => undefined)
  }
  return report
}
