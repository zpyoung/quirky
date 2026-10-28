import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { runCli } from '../../../packages/cli/test/fixtures/fake-daemon'
import type { HostOutcome, PublicListResult, SearchResponse, SearchStatus, ViewState } from '../src/types'
import { VaultRig } from './support/harness'
import { TrashVolume } from './support/trash-volume'

let rig: VaultRig | undefined
let trashVolume: TrashVolume | undefined
let previousQuirkyHome: string | undefined
let processHomeOverridden = false

afterEach(async () => {
  try {
    await rig?.cleanup()
  } finally {
    rig = undefined
    try {
      trashVolume?.cleanup()
    } finally {
      trashVolume = undefined
      if (processHomeOverridden) {
        if (previousQuirkyHome === undefined) delete process.env.QUIRKY_HOME
        else process.env.QUIRKY_HOME = previousQuirkyHome
        previousQuirkyHome = undefined
        processHomeOverridden = false
      }
    }
  }
})


const start = async () => (rig = await VaultRig.start())
const startWithTrashVolume = async (volume: TrashVolume): Promise<VaultRig> => {
  const previousTmpdir = process.env.TMPDIR
  process.env.TMPDIR = volume.tmpDir
  try {
    const vault = await start()
    previousQuirkyHome = process.env.QUIRKY_HOME
    processHomeOverridden = true
    process.env.QUIRKY_HOME = vault.home
    return vault
  } finally {
    if (previousTmpdir === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = previousTmpdir
  }
}
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

  test('every declared inspect, search, action, view and UI CLI command performs its public transition', async () => {
    const vault = await start()
    const listed = JSON.parse((await run(vault, ['vault', 'list', '--unlimited', '--json'])).stdout) as PublicListResult
    const claude = listed.sessions.find((session) => session.agent === 'claude')
    if (!claude) throw new Error('CLI list omitted the real Claude fixture')

    const providerPath = join(vault.home, 'absolute-cli-provider')
    const providerLog = join(vault.home, 'cli-provider-output.log')
    writeFileSync(providerPath, `#!/bin/sh\nprintf 'cwd=%s\\\\n' \"$PWD\" >> \"$VAULT_CAPTURE_LOG\"\nprintf 'arg=%s\\\\n' \"$@\" >> \"$VAULT_CAPTURE_LOG\"\n`, { mode: 0o700 })
    chmodSync(providerPath, 0o700)
    await vault.client.callAny('quirky.agents/configure', {
      agent: 'claude',
      command: `'${providerPath}'`,
      args: "--vault-cli-configured 'literal argument'",
      env: { VAULT_CAPTURE_LOG: providerLog }
    })

    const enabled = await run(vault, ['vault', 'enable', '--history-days', '30', '--json'])
    expect(enabled.code).toBe(0)
    expect(JSON.parse(enabled.stdout)).toMatchObject({ status: { enabled: true } })
    const status = await run(vault, ['vault', 'search-status', '--json'])
    expect(JSON.parse(status.stdout)).toMatchObject({ status: { enabled: true } })
    const searched = await run(vault, [
      'vault', 'search', 'vault-fixture-claude-marker', '--fresh', '--agent', 'claude', '--json'
    ])
    expect(searched.code).toBe(0)
    const searchResult = JSON.parse(searched.stdout) as SearchResponse
    expect(searchResult.kind).toBe('results')
    if (searchResult.kind === 'results') {
      expect(searchResult.hits.some((hit) => hit.id === claude.id)).toBe(true)
    }

    const inspected = await run(vault, ['vault', 'get', claude.id, '--json'])
    expect(inspected.code).toBe(0)
    expect(JSON.parse(inspected.stdout)).toMatchObject({
      id: claude.id,
      sessionId: claude.sessionId,
      source: { filePath: claude.source.filePath }
    })

    const resumed = await run(vault, ['vault', 'resume', claude.id, '--json'])
    expect(resumed.code).toBe(0)
    expect(JSON.parse(resumed.stdout)).toMatchObject({
      agent: 'claude',
      cwd: claude.cwd,
      providerSession: { id: claude.sessionId }
    })

    const changedView = await run(vault, [
      'vault', 'view', '--group', 'agent', '--browse-sort', 'created', '--search-sort', 'newest',
      '--hide-empty-sessions', '--session-limit', '500', '--json'
    ])
    expect(changedView.code).toBe(0)
    expect(await vault.call<ViewState>('getView')).toMatchObject({
      group: 'agent',
      browseSort: 'created',
      searchSort: 'newest',
      hideEmptySessions: true,
      sessionLimit: 500
    })

    const opened = await run(vault, [
      'vault', 'open', '--agent', 'claude', '--session', claude.sessionId,
      '--query', 'vault-fixture-claude-marker', '--json'
    ])
    expect(opened.code).toBe(0)
    expect(await vault.call<ViewState>('getView')).toMatchObject({
      selectedId: claude.id,
      expandedIds: [claude.id],
      focusedSearch: true
    })
    const unknownAgentOpen = await run(vault, [
      'vault', 'open', '--agent', 'unknown-vault-agent', '--session', claude.sessionId, '--json'
    ])
    expect(unknownAgentOpen.code).toBe(0)
    expect(await vault.call<ViewState>('getView')).toMatchObject({
      query: claude.sessionId,
      selectedId: null,
      expandedIds: [],
      disabledAgents: expect.arrayContaining(['claude'])
    })
    expect((await vault.call<ViewState>('getView')).disabledAgents).toHaveLength(25)
    const openedWithoutAgent = await run(vault, ['vault', 'open', '--session', claude.sessionId, '--json'])
    expect(openedWithoutAgent.code).toBe(0)
    expect(await vault.call<ViewState>('getView')).toMatchObject({
      query: '',
      selectedId: claude.id,
      expandedIds: [claude.id],
      focusedSearch: true
    })
    const openedState = await vault.client.callAny('ui.state', {}) as { layout: { panel: string | null } }
    expect(openedState.layout.panel).toBe('panel:quirky.vault/history')

    const settings = await run(vault, ['vault', 'settings', '--json'])
    expect(settings.code).toBe(0)
    const settingsState = await vault.client.callAny('ui.state', {}) as { layout: { view: { id: string } | null } }
    expect(settingsState.layout.view?.id).toBe('view:quirky.vault/search-settings')

    const cleared = await run(vault, ['vault', 'clear', '--yes', '--json'])
    expect(cleared.code).toBe(0)
    expect(JSON.parse(cleared.stdout)).toMatchObject({ cleared: true, status: { enabled: false } })
    expect(vault.searchDatabaseExists()).toBe(false)
    expect(claude.source.filePath).toBeTruthy()
  })
  test.skipIf(process.platform !== 'darwin')(
    'delete executes through the CLI and moves exactly the selected original into owned APFS Trash',
    async () => {
      const volume = trashVolume = TrashVolume.create()
      const vault = await startWithTrashVolume(volume)
      const sessions = await vault.call<PublicListResult>('list', { agents: ['claude'], unlimited: true })
      const selected = sessions.sessions[0]
      if (!selected?.source.filePath) throw new Error('Claude source fixture path was redacted')
      const originalBytes = readFileSync(selected.source.filePath)
      volume.assertSafeDeletionTarget(selected.source.filePath, vault.sourceHome, vault.home)

      const deleted = await run(vault, ['vault', 'delete', selected.id, '--yes', '--json'])
      expect(deleted.code).toBe(0)
      expect(JSON.parse(deleted.stdout)).toMatchObject({ deleted: true, trashed: 1, alreadyMissing: false })
      expect(existsSync(selected.source.filePath)).toBe(false)
      expect(readFileSync(volume.trashPathFor(basename(selected.source.filePath)))).toEqual(originalBytes)

      const trashAfterFirstDelete = volume.listTrashEntries()
      const repeated = await run(vault, ['vault', 'delete', selected.id, '--yes', '--json'])
      expect(repeated.code).toBe(0)
      expect(JSON.parse(repeated.stdout)).toMatchObject({ deleted: true, trashed: 0, alreadyMissing: true })
      expect(volume.listTrashEntries()).toEqual(trashAfterFirstDelete)
    },
    120_000
  )
})
