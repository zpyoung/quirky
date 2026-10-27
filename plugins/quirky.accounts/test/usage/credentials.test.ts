import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { resolveClaudeOAuthCredential } from '../../src/usage/credentials'

type KeychainRead =
  | { status: 'found'; value: string }
  | { status: 'missing' }
  | { status: 'error' }

const roots: string[] = []

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'quirky-usage-credentials-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Claude usage credential resolution', () => {
  test('uses only the selected managed home keychain scope and then that home file', async () => {
    const root = tempRoot()
    const homeA = join(root, 'profile-a')
    const homeB = join(root, 'profile-b')
    mkdirSync(homeA)
    mkdirSync(homeB)
    const scopedA = `Claude Code-credentials-${createHash('sha256').update(homeA.normalize('NFC')).digest('hex').slice(0, 8)}`
    const scopedB = `Claude Code-credentials-${createHash('sha256').update(homeB.normalize('NFC')).digest('hex').slice(0, 8)}`
    const queried: string[] = []
    const keychain = async (service: string): Promise<KeychainRead> => {
      queried.push(service)
      return service === scopedB
        ? { status: 'found', value: JSON.stringify({ claudeAiOauth: { accessToken: 'token-b' } }) }
        : { status: 'missing' }
    }

    const resultA = await resolveClaudeOAuthCredential({
      configDir: homeA,
      systemDefault: false,
      keychain
    })
    expect(resultA.token).toBeNull()
    expect(queried).toEqual([scopedA])
    expect(queried).not.toContain('Claude Code-credentials')

    writeFileSync(
      join(homeA, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'file-token-a', refreshToken: 'refresh-a' } }),
      { mode: 0o600 }
    )
    const resultWithFile = await resolveClaudeOAuthCredential({
      configDir: homeA,
      systemDefault: false,
      keychain: async () => ({ status: 'missing' })
    })
    expect(resultWithFile).toMatchObject({ token: 'file-token-a', source: 'credentials-file' })

    const resultB = await resolveClaudeOAuthCredential({
      configDir: homeB,
      systemDefault: false,
      keychain
    })
    expect(resultB).toMatchObject({ token: 'token-b', source: 'scoped-keychain' })
    expect(resultB.token).not.toBe(resultWithFile.token)
  })

  test('system default may fall back from its scoped keychain item to the legacy item', async () => {
    const root = tempRoot()
    const configDir = join(root, 'custom-claude-home')
    mkdirSync(configDir)
    const scoped = `Claude Code-credentials-${createHash('sha256').update(configDir.normalize('NFC')).digest('hex').slice(0, 8)}`
    const queried: string[] = []
    const result = await resolveClaudeOAuthCredential({
      configDir,
      systemDefault: true,
      keychain: async (service) => {
        queried.push(service)
        return service === 'Claude Code-credentials'
          ? { status: 'found', value: JSON.stringify({ claudeAiOauth: { accessToken: 'system-token' } }) }
          : { status: 'missing' }
      }
    })
    expect(result).toMatchObject({ token: 'system-token', source: 'legacy-keychain' })
    expect(queried).toEqual([scoped, 'Claude Code-credentials'])
  })
})
