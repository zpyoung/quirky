import { runProcess } from '@quirky/process-host'

const KEYCHAIN_PROMPT_TIMEOUT_MS = 120_000

/**
 * Reads a generic-password item through `security`, so macOS shows its own access prompt.
 * Throws when the item is missing or the owner denies access.
 */
export async function readKeychainPasswordWithSecurity(
  service: string,
  account: string
): Promise<string> {
  const result = await runProcess({
    program: 'security',
    args: ['find-generic-password', '-w', '-s', service, '-a', account],
    timeoutMs: KEYCHAIN_PROMPT_TIMEOUT_MS,
    maxOutputBytes: 4096
  })
  if (result.code !== 0 || result.timedOut) {
    throw new Error('keychain read failed')
  }
  return result.stdout.replace(/\r?\n$/, '')
}
