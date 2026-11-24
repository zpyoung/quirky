/** How quirkyd loads or first creates its master key, in the owner-only record beside the credentials. */
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import process from 'node:process'
import { withFileTransactionLock } from '../file-transaction-lock'
import { profileStateAccessMachineIdentity } from '../persistence/profile-state/profile-state-access-identity'
import {
  resolveQuirkydLegacyKeyringReader,
  type QuirkydLegacyKeyringReader
} from './quirkyd-legacy-keyring-key'
import {
  decodeMasterKey,
  isTemporaryKeyDir,
  quirkydSecretStateFileName,
  publishRecordExclusively,
  readStoredRecord,
  replaceRecord,
  restrictExistingRecord,
  type StoredKeyState
} from './quirkyd-secret-key-record'
import {
  describeQuirkydHostKeyGap,
  describeQuirkydDisposableProfile,
  describeQuirkydPlaintextOptOut,
  describeQuirkydSealingUnavailable,
  QUIRKYD_PLAINTEXT_SECRETS_ENV
} from './quirkyd-secret-protection-gap'
import {
  deriveQuirkydSealingKey,
  QUIRKYD_MASTER_KEY_BYTES,
  quirkydSealingKeyCheck
} from './quirkyd-secret-sealing'

export type StoreState =
  | { kind: 'pending' }
  | { kind: 'plaintext'; reason: string }
  | { kind: 'ready'; key: Buffer; gap: string | null }
  | { kind: 'unavailable'; message: string }

export type QuirkydSecretStorePrepareOptions = {
  /** Quirky's credential directory (`~/.quirky`), so the key lives exactly as long as what it seals. */
  keyDir: string
  /** A temporary profile keeps the legacy behavior and leaves `keyDir` untouched. */
  userDataPath?: string
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  /** Reads a key an older build kept in the OS keyring; only for migrating its record. */
  legacyKeyring?: QuirkydLegacyKeyringReader | null
  machineIdentity?: () => string | null
  isTemporaryKeyDir?: (keyDir: string) => boolean
}

type Context = {
  machineId: string | null
  statePath: string
  legacyKeyring: () => QuirkydLegacyKeyringReader | null
  log: (message: string) => void
  unavailable: (reason: string) => StoreState
}

export function quirkydSecretStatePath(options: QuirkydSecretStorePrepareOptions): string {
  const machineId = (options.machineIdentity ?? profileStateAccessMachineIdentity)()
  return join(options.keyDir, quirkydSecretStateFileName(machineId))
}

function newFileRecord(machineId: string | null): StoredKeyState {
  const master = randomBytes(QUIRKYD_MASTER_KEY_BYTES)
  return {
    version: 1,
    backend: 'host-file',
    key: master.toString('base64'),
    hostBound: machineId !== null,
    check: quirkydSealingKeyCheck(deriveQuirkydSealingKey(master, machineId ?? ''))
  }
}

/**
 * Migration (removable a few releases after it ships): copies a key an older build kept in the OS
 * keyring into the file record once. Keyring keys are never machine-bound, so an unbound file
 * record derives the same sealing key. When the keyring cannot give it up without UI (locked,
 * missing, slow), start a fresh file key instead of failing closed for good: credentials sealed
 * under the old key then report the plain decrypt error, and the user reconnects them.
 */
async function migrateKeyringRecord(
  stored: Extract<StoredKeyState, { backend: 'os-keyring' }>,
  context: Context
): Promise<StoreState | 'reload'> {
  const reader = context.legacyKeyring()
  const found = reader ? await reader(stored.account) : { failure: 'no OS keyring is reachable' }
  const master = 'key' in found ? decodeMasterKey(found.key) : null
  const matches =
    master !== null && quirkydSealingKeyCheck(deriveQuirkydSealingKey(master, '')) === stored.check
  const record: StoredKeyState =
    master && matches
      ? {
          version: 1,
          backend: 'host-file',
          key: master.toString('base64'),
          hostBound: false,
          check: stored.check
        }
      : newFileRecord(context.machineId)
  const replaced = replaceRecord(context.statePath, record, stored)
  if (replaced === 'changed') {
    return 'reload'
  }
  if (replaced !== 'replaced') {
    return context.unavailable(replaced)
  }
  const why = 'failure' in found ? found.failure : 'it is not the key the credentials use'
  context.log(
    matches
      ? '[secrets] Copied the credential key from the OS keyring into the owner-only key file.'
      : `[secrets] Could not read the credential key from the OS keyring (${why}); started a new ` +
          'key file. Reconnect any integration whose saved credential no longer opens.'
  )
  return 'reload'
}

async function loadStoredRecord(
  stored: StoredKeyState,
  context: Context
): Promise<StoreState | 'reload'> {
  if (stored.backend === 'os-keyring') {
    // Why a lock: concurrent starts must not each replace the record with a different key.
    // Why 4 retries: about 15s of backoff, longer than one bounded keyring read.
    return withFileTransactionLock(
      context.statePath,
      async () => {
        // Why re-read under the lock: another start may have migrated it while this one waited.
        const current = readStoredRecord(context.statePath)
        return current.kind === 'record' &&
          current.stored.backend === 'os-keyring' &&
          current.stored.check === stored.check
          ? migrateKeyringRecord(current.stored, context)
          : 'reload'
      },
      { retries: 4 }
    ).catch((error: unknown) =>
      context.unavailable(
        `its key record could not be locked against another server (${String(error)})`
      )
    )
  }
  const { unavailable } = context
  if (!(await restrictExistingRecord(context.statePath))) {
    return unavailable(`its key record ${context.statePath} could not be restricted to this user`)
  }
  const master = decodeMasterKey(stored.key)
  const binding = stored.hostBound ? context.machineId : ''
  if (!master || binding === null) {
    return unavailable('this machine no longer reports the machine ID its key is bound to')
  }
  const key = deriveQuirkydSealingKey(master, binding)
  if (quirkydSealingKeyCheck(key) !== stored.check) {
    return unavailable('its key is bound to a different machine ID')
  }
  return { kind: 'ready', key, gap: describeQuirkydHostKeyGap(stored.hostBound) }
}

export async function resolveState(
  options: QuirkydSecretStorePrepareOptions,
  log: (message: string) => void
): Promise<StoreState> {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  if (env[QUIRKYD_PLAINTEXT_SECRETS_ENV] === 'plaintext') {
    return { kind: 'plaintext', reason: describeQuirkydPlaintextOptOut() }
  }
  // Why: a disposable run (tests, smoke launchers) must not create keys in, or re-seal, the
  // user's persistent ~/.quirky; credentials it saves would outlive the run unreadable by others.
  if (
    options.userDataPath &&
    (options.isTemporaryKeyDir ?? isTemporaryKeyDir)(options.userDataPath)
  ) {
    return { kind: 'plaintext', reason: describeQuirkydDisposableProfile() }
  }
  const machineId = (options.machineIdentity ?? profileStateAccessMachineIdentity)()
  const statePath = join(options.keyDir, quirkydSecretStateFileName(machineId))
  const context: Context = {
    machineId,
    statePath,
    legacyKeyring: () =>
      options.legacyKeyring === undefined
        ? resolveQuirkydLegacyKeyringReader(platform, env)
        : options.legacyKeyring,
    log,
    unavailable: (reason) => ({
      kind: 'unavailable',
      message: describeQuirkydSealingUnavailable(reason, statePath)
    })
  }
  // Why loop: a lost create race or a migrated record means the record on disk is the one to load.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const existing = readStoredRecord(statePath)
    if (existing.kind === 'record') {
      const loaded = await loadStoredRecord(existing.stored, context)
      if (loaded !== 'reload') {
        return loaded
      }
      continue
    }
    if (existing.kind === 'unreadable') {
      return context.unavailable(existing.reason)
    }
    const record = newFileRecord(machineId)
    // Why fail closed: sealing with a key that did not reach disk loses every credential on restart.
    const published = publishRecordExclusively(statePath, record)
    if (published === 'published') {
      continue
    }
    if (published !== 'exists') {
      return context.unavailable(published)
    }
  }
  return context.unavailable('another server kept replacing its key record')
}
