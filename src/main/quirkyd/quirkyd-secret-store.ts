/**
 * quirkyd's SecretStore: credentials are sealed on the execution host, with a master key the host
 * owns, kept in an owner-only file beside the credentials in `~/.quirky`, mixed with the machine ID.
 *
 * Why always "available": answering false makes every credential writer fall back to plaintext.
 * When the recorded key cannot be loaded (changed machine, unreadable record), seal and unseal
 * throw instead, so saves fail closed and existing sealed files are left untouched.
 */
import type { SecretStore } from '../../shared/secret-store'
import { sweepStaleRecordStaging } from './quirkyd-secret-key-record'
import {
  quirkydSecretStatePath,
  resolveState,
  type QuirkydSecretStorePrepareOptions,
  type StoreState
} from './quirkyd-secret-key-resolution'
import { openQuirkydSecret, sealQuirkydSecret } from './quirkyd-secret-sealing'

export type QuirkydSecretStore = SecretStore & {
  /** Resolves whether sealing works now, i.e. the key loaded. */
  prepare(options: QuirkydSecretStorePrepareOptions): Promise<boolean>
}

export function createQuirkydSecretStore(
  log: (message: string) => void = (message) => console.warn(message)
): QuirkydSecretStore {
  let state: StoreState = { kind: 'pending' }
  const readyKey = (): Buffer => {
    if (state.kind === 'ready') {
      return state.key
    }
    throw new Error(
      state.kind === 'unavailable'
        ? state.message
        : 'quirkyd_secret_store_not_prepared — the headless secret store has not loaded its key yet'
    )
  }
  return {
    isEncryptionAvailable: () => state.kind !== 'plaintext',
    encryptString: (plainText) => sealQuirkydSecret(readyKey(), plainText),
    decryptString: (cipher) => openQuirkydSecret(readyKey(), cipher),
    describeProtectionGap: () => {
      switch (state.kind) {
        case 'ready':
          return state.gap
        case 'unavailable':
          return state.message
        case 'plaintext':
          return state.reason
        case 'pending':
          return "Quirky's headless server has not loaded its credential key yet."
      }
    },
    async prepare(next) {
      sweepStaleRecordStaging(quirkydSecretStatePath(next))
      state = await resolveState(next, log)
      return state.kind === 'ready'
    }
  }
}
