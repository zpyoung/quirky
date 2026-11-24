import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { judgmentAccessPath, readJudgmentAccess } from './access-store'

let root: string
let databasePath: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'quirky-judgment-access-'))
  databasePath = join(root, 'heimdall.db')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('judgment credential isolation', () => {
  it('does not expose malformed credential content in diagnostics', () => {
    const secret = 'private-api-key-that-must-never-enter-the-ledger'
    writeFileSync(judgmentAccessPath(databasePath), `{"enabled":true,"apiKey":"${secret}`, {
      mode: 0o600
    })
    let failure: unknown
    try {
      readJudgmentAccess(databasePath)
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(Error)
    expect(String(failure)).not.toContain(secret)
    expect(String(failure)).not.toContain(root)
  })

  it('defaults legacy enabled access to TypeSafe and accepts explicit OpenRouter access', () => {
    const path = judgmentAccessPath(databasePath)
    writeFileSync(path, JSON.stringify({ enabled: true, apiKey: 'typesafe-key' }), { mode: 0o600 })
    expect(readJudgmentAccess(databasePath)).toEqual({
      enabled: true,
      provider: 'typesafe',
      apiKey: 'typesafe-key'
    })

    writeFileSync(
      path,
      JSON.stringify({ enabled: true, provider: 'openrouter', apiKey: 'openrouter-key' }),
      { mode: 0o600 }
    )
    expect(readJudgmentAccess(databasePath)).toEqual({
      enabled: true,
      provider: 'openrouter',
      apiKey: 'openrouter-key'
    })

    writeFileSync(
      path,
      JSON.stringify({ enabled: true, provider: 'unknown', apiKey: 'wrong-provider-key' }),
      { mode: 0o600 }
    )
    expect(() => readJudgmentAccess(databasePath)).toThrow(
      'Judgment access unavailable: use valid private judgment-access.json'
    )
  })

  it.skipIf(process.platform === 'win32')(
    'refuses shared credentials until permissions are private',
    () => {
      const path = judgmentAccessPath(databasePath)
      writeFileSync(path, JSON.stringify({ enabled: true, apiKey: 'private-key' }), { mode: 0o600 })
      chmodSync(path, 0o644)
      expect(() => readJudgmentAccess(databasePath)).toThrow()
      chmodSync(path, 0o600)
      expect(readJudgmentAccess(databasePath)).toEqual({
        enabled: true,
        provider: 'typesafe',
        apiKey: 'private-key'
      })
    }
  )
})
