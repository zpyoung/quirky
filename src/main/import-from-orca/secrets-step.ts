import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { SecretStore } from '../../shared/secret-store'
import type { ImportError, ImportKeychainItem } from '../../shared/import-from-orca-types'
import {
  decryptOsCryptValue,
  isOsCryptValue,
  resolveSecretKey,
  type KeychainReader
} from './secrets'
import { collectSecretCiphertexts, type SecretSlot } from './plan'
import type { SourceState } from './source-state'

const ENVELOPE_PATTERN = /^([A-Za-z0-9-]+:v1:)encrypted:([A-Za-z0-9+/=]+)$/

export type SealedCredentialFile = { name: string; content: string }

export type SecretsOutcome = {
  plaintext: Map<SecretSlot, string>
  sealedFiles: SealedCredentialFile[]
  skipped: string[]
  keychainItem: ImportKeychainItem
  errors: ImportError[]
}

type Candidate =
  | { kind: 'slot'; label: SecretSlot; base64: string }
  | { kind: 'file'; label: string; prefix: string; base64: string }

async function listCredentialFiles(
  sourceHome: string,
  quirkyHome: string,
  skipped: string[]
): Promise<Extract<Candidate, { kind: 'file' }>[]> {
  if (!existsSync(sourceHome)) {
    return []
  }
  const found: Extract<Candidate, { kind: 'file' }>[] = []
  for (const entry of await readdir(sourceHome, { withFileTypes: true })) {
    if (
      !entry.isFile() ||
      !entry.name.endsWith('.enc') ||
      existsSync(join(quirkyHome, entry.name))
    ) {
      continue
    }
    const match = ENVELOPE_PATTERN.exec(
      (await readFile(join(sourceHome, entry.name), 'utf8')).trim()
    )
    if (match === null) {
      skipped.push(entry.name)
      continue
    }
    found.push({ kind: 'file', label: entry.name, prefix: match[1], base64: match[2] })
  }
  return found
}

function quirkyEnvelopePrefix(prefix: string): string {
  return prefix.startsWith('orca-') ? `quirky-${prefix.slice('orca-'.length)}` : prefix
}

/**
 * Decrypts the source's sealed values and returns them ready to apply: slot values as plaintext
 * held in memory only, credential files already re-sealed with Quirky's safeStorage. Anything
 * that cannot be carried over is listed in `skipped`; a keychain that cannot be read gives
 * `KEYCHAIN_DENIED` and the caller carries on without secrets.
 */
export async function resolveSecrets(args: {
  source: SourceState
  sourceHome: string
  quirkyHome: string
  alreadyImportedSlots: ReadonlySet<string>
  readKeychainPassword: KeychainReader
  safeStorage: Pick<SecretStore, 'isEncryptionAvailable' | 'encryptString'>
}): Promise<SecretsOutcome> {
  const skipped: string[] = []
  const outcome: SecretsOutcome = {
    plaintext: new Map(),
    sealedFiles: [],
    skipped,
    keychainItem: null,
    errors: []
  }
  const candidates: Candidate[] = []
  for (const [label, base64] of collectSecretCiphertexts(args.source)) {
    if (!args.alreadyImportedSlots.has(label)) {
      candidates.push({ kind: 'slot', label, base64 })
    }
  }
  candidates.push(...(await listCredentialFiles(args.sourceHome, args.quirkyHome, skipped)))
  const sealed = candidates.filter((candidate) => isOsCryptValue(candidate.base64))
  for (const candidate of candidates) {
    if (!sealed.includes(candidate)) {
      skipped.push(candidate.label)
    }
  }
  if (sealed.length === 0) {
    return outcome
  }
  if (!args.safeStorage.isEncryptionAvailable()) {
    skipped.push(...sealed.map((candidate) => candidate.label))
    return outcome
  }
  const resolved = await resolveSecretKey(args.readKeychainPassword, sealed[0].base64)
  if (resolved.key === null) {
    skipped.push(...sealed.map((candidate) => candidate.label))
    outcome.errors.push({
      code: 'KEYCHAIN_DENIED',
      message: resolved.denied
        ? 'Access to the Orca Dev keychain item was denied or the item is missing, so secrets were not imported.'
        : 'The Orca Dev keychain passwords did not unlock its secrets, so secrets were not imported.'
    })
    return outcome
  }
  outcome.keychainItem = resolved.item
  for (const candidate of sealed) {
    try {
      const plain = decryptOsCryptValue(resolved.key, candidate.base64)
      if (candidate.kind === 'slot') {
        outcome.plaintext.set(candidate.label, plain)
      } else {
        const content = `${quirkyEnvelopePrefix(candidate.prefix)}encrypted:${args.safeStorage
          .encryptString(plain)
          .toString('base64')}`
        outcome.sealedFiles.push({ name: candidate.label, content })
      }
    } catch {
      skipped.push(candidate.label)
    }
  }
  return outcome
}
