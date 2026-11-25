import { createDecipheriv } from 'node:crypto'
import { deriveOsCryptKey } from '../browser/browser-cookie-key'
import type { ImportKeychainItem } from '../../shared/import-from-orca-types'
import {
  FALLBACK_KEYCHAIN_ACCOUNT,
  FALLBACK_KEYCHAIN_SERVICE,
  PRIMARY_KEYCHAIN_ACCOUNT,
  PRIMARY_KEYCHAIN_SERVICE
} from './constants'

const OSCRYPT_PREFIX = 'v10'
const OSCRYPT_IV = Buffer.alloc(16, 0x20)

export type KeychainReader = (service: string, account: string) => string | Promise<string>

/** Whether a stored base64 value is an OSCrypt `v10` envelope with a whole number of AES blocks. */
export function isOsCryptValue(base64: unknown): base64 is string {
  if (typeof base64 !== 'string' || base64.length === 0) {
    return false
  }
  const raw = Buffer.from(base64, 'base64')
  const ciphertextLength = raw.length - OSCRYPT_PREFIX.length
  return (
    raw.subarray(0, 3).toString('latin1') === OSCRYPT_PREFIX &&
    ciphertextLength > 0 &&
    ciphertextLength % 16 === 0
  )
}

/** Decrypts one `v10` value; throws when the key is wrong or the result is not valid UTF-8. */
export function decryptOsCryptValue(key: Buffer, base64: string): string {
  const raw = Buffer.from(base64, 'base64')
  if (raw.subarray(0, 3).toString('latin1') !== OSCRYPT_PREFIX) {
    throw new Error('value is not a v10 envelope')
  }
  const decipher = createDecipheriv('aes-128-cbc', key, OSCRYPT_IV)
  const plain = Buffer.concat([decipher.update(raw.subarray(3)), decipher.final()])
  return new TextDecoder('utf-8', { fatal: true }).decode(plain)
}

export type ResolvedSecretKey =
  | { key: Buffer; item: Exclude<ImportKeychainItem, null> }
  | { key: null; item: null; denied: boolean }

function provesKey(key: Buffer, probes: readonly string[]): boolean {
  return probes.some((probe) => {
    try {
      decryptOsCryptValue(key, probe)
      return true
    } catch {
      return false
    }
  })
}

/**
 * Reads the primary keychain password once, proves it by decrypting any one of `probes`, and
 * only then tries the fallback item. `denied` is true only when a keychain read failed; a
 * password that reads fine but decrypts nothing leaves it false.
 */
export async function resolveSecretKey(
  readKeychainPassword: KeychainReader,
  probes: readonly string[]
): Promise<ResolvedSecretKey> {
  const candidates = [
    { item: 'primary', service: PRIMARY_KEYCHAIN_SERVICE, account: PRIMARY_KEYCHAIN_ACCOUNT },
    { item: 'fallback', service: FALLBACK_KEYCHAIN_SERVICE, account: FALLBACK_KEYCHAIN_ACCOUNT }
  ] as const
  let denied = false
  for (const candidate of candidates) {
    let password: string
    try {
      password = await readKeychainPassword(candidate.service, candidate.account)
    } catch {
      denied = true
      if (candidate.item === 'primary') {
        return { key: null, item: null, denied }
      }
      continue
    }
    const key = deriveOsCryptKey(password)
    if (provesKey(key, probes)) {
      return { key, item: candidate.item }
    }
  }
  return { key: null, item: null, denied }
}
