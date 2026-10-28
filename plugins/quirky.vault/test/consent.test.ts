import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { builtinsDir, makeTempHome, startHarness } from '../../../packages/daemon/test/helpers'

// Real API path: browsing must not silently create a searchable copy of private text.
test('SC-05/07: transcript content becomes searchable only after explicit consent', async () => {
  const home = makeTempHome('qvault-consent-')
  const previous = process.env.QUIRKY_VAULT_SOURCE_HOME
  process.env.QUIRKY_VAULT_SOURCE_HOME = home
  const source = join(home, '.claude/projects/example')
  mkdirSync(source, { recursive: true })
  writeFileSync(join(source, 'session.jsonl'), [
    { type: 'user', sessionId: 'vault-consent', cwd: home, timestamp: '2026-10-27T10:00:00Z', message: { role: 'user', content: 'Repair login' } },
    { type: 'assistant', sessionId: 'vault-consent', cwd: home, timestamp: '2026-10-27T10:01:00Z', message: { role: 'assistant', content: [{ type: 'text', text: 'privatezebramarker' }] } }
  ].map(value => JSON.stringify(value)).join('\n') + '\n')
  const harness = await startHarness({ home, builtinPluginsDir: builtinsDir() })
  try {
    const client = await harness.connect()
    const status = await client.call('quirky.vault/searchStatus' as never, {} as never).catch(error => ({ error: String(error) })) as { status?: { enabled: boolean } }
    expect(status.status?.enabled).toBe(false)
    const result = await client.call('quirky.vault/list' as never, { unlimited: true } as never) as { sessions: { sessionId: string }[] }
    expect(result.sessions.map(session => session.sessionId)).toContain('vault-consent')
    const db = join(home, 'plugin-data/quirky.vault/session-search.sqlite')
    expect(existsSync(db)).toBe(false)
    const disabled = await client.call('quirky.vault/search' as never, { query: 'privatezebramarker' } as never) as { kind: string; reason?: string }
    expect(disabled).toMatchObject({ kind: 'unavailable', reason: 'disabled' })
    await client.call('quirky.vault/setSearchEnabled' as never, { enabled: true } as never)
    const matches = await client.call('quirky.vault/search' as never, { query: 'privatezebramarker', freshness: 'wait-until-current' } as never) as { kind: string; hits: { sessionId: string }[] }
    expect(matches.kind).toBe('results')
    expect(matches.hits.map(hit => hit.sessionId)).toEqual(['vault-consent'])
    expect(existsSync(db)).toBe(true)
  } finally {
    await harness.cleanup()
    if (previous === undefined) delete process.env.QUIRKY_VAULT_SOURCE_HOME
    else process.env.QUIRKY_VAULT_SOURCE_HOME = previous
  }
}, 20000)
