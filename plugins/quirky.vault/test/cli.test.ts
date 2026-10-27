import { afterEach, describe, expect, test } from 'bun:test'
import { runCli } from '../../../packages/cli/test/fixtures/fake-daemon'
import type { HostOutcome, PublicListResult, SearchResponse, SearchStatus } from '../src/types'
import { VaultRig } from './support/harness'

let rig: VaultRig | undefined

afterEach(async () => {
  await rig?.cleanup()
  rig = undefined
})

const start = async () => (rig = await VaultRig.start())
const run = (vault: VaultRig, args: string[]) => runCli(args, { home: vault.home })

describe('vault CLI', () => {
  test('list dispatches through quirky and emits the public JSON session records', async () => {
    const vault = await start()
    const result = await run(vault, ['vault', 'list', '--unlimited', '--json'])

    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    const payload = JSON.parse(result.stdout) as PublicListResult
    expect(payload.sessions).toHaveLength(25)
    expect(payload.hosts).toEqual([expect.objectContaining({ hostId: 'local', kind: 'ok' })])
    const expectedClaude = vault.expected.claude!
    expect(payload.sessions.find((session) => session.agent === 'claude')).toMatchObject({
      sessionId: expectedClaude.sessionId,
      title: expectedClaude.title,
      cwd: expectedClaude.cwd,
      source: { presence: 'present' }
    })
  })

  test('search index status is returned by the daemon as typed JSON', async () => {
    const vault = await start()
    const result = await run(vault, ['vault', 'search', '--index-status', '--json'])

    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    const payload = JSON.parse(result.stdout) as { status: SearchStatus; hosts: HostOutcome[] }
    expect(payload.status).toMatchObject({ enabled: false, filesIndexed: 0 })
    expect(payload.hosts).toEqual([expect.objectContaining({ hostId: 'local', kind: 'ok' })])
    expect(vault.searchDatabaseExists()).toBe(false)
  })

  test('rejects query/status conflicts and invalid filters before creating search data', async () => {
    const vault = await start()
    const statusWithQueryFlag = await run(vault, ['vault', 'search', '--index-status', '--agent', 'claude'])
    const invalidSince = await run(vault, ['vault', 'search', 'vault-fixture-claude-marker', '--since', '2026-10-27T10:00:00'])
    const tooManyPaths = await run(vault, [
      'vault',
      'search',
      'vault-fixture-claude-marker',
      ...Array.from({ length: 65 }, (_, index) => ['--path', `/tmp/path-${index}`]).flat()
    ])

    for (const result of [statusWithQueryFlag, invalidSince, tooManyPaths]) {
      expect(result.code).toBe(2)
      expect(result.stdout).toBe('')
      expect(result.stderr).not.toBe('')
      expect(result.stderr).not.toContain('vault-fixture-claude-marker')
    }
    expect(vault.searchDatabaseExists()).toBe(false)
  })

  test('disabled search reports its public status without exposing transcript text', async () => {
    const vault = await start()
    const result = await run(vault, ['vault', 'search', 'vault-fixture-claude-marker', '--json'])

    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    const payload = JSON.parse(result.stdout) as SearchResponse
    expect(payload).toMatchObject({
      kind: 'unavailable',
      reason: 'disabled'
    })
    expect(result.stdout).not.toContain('vault-fixture-claude-marker')
    expect(vault.searchDatabaseExists()).toBe(false)
  })
})
