import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { HISTORY_AGENTS } from '../src/agents'
import { createScanner } from '../src/scanner'
import {
  writeEveryAgentFixture,
  writeClaudeFixture,
  writeCursorFixture,
  writeJsonlFixture,
  writeOpenCodeLegacyFixture,
  writeScopeFixture
} from './fixtures/scanner-fixtures'
import type { VaultScanner } from '../src/types'

let tempRoots: string[] = []
const scanners: VaultScanner[] = []

async function temporaryHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'quirky-vault-scanner-'))
  tempRoots.push(root)
  return root
}

function scanner(sourceHome: string): VaultScanner {
  const value = createScanner({ sourceHome, dataDir: join(sourceHome, '.quirky-data'), env: { QUIRKY_VAULT_SOURCE_HOME: sourceHome } })
  scanners.push(value)
  return value
}

afterEach(async () => {
  await Promise.all(scanners.splice(0).map((value) => value.close()))
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('vault source scanner', () => {
  test('discovers and parses a concrete session from every supported source format', async () => {
    const home = await temporaryHome()
    const fixture = await writeEveryAgentFixture(home)
    const vault = scanner(home)
    const discovery = await vault.discover()

    expect(discovery.roots.some((root) => root.agent === 'claude' && root.presence === 'present')).toBe(true)
    expect(discovery.roots.some((root) => root.agent === 'zcode' && root.presence === 'present')).toBe(true)
    const result = await vault.list({ unlimited: true, force: true })
    const sessionsByAgent = new Map(result.sessions.map((session) => [session.agent, session]))

    expect(HISTORY_AGENTS).toHaveLength(25)
    expect(result.sessions).toHaveLength(25)
    expect([...sessionsByAgent.keys()].sort()).toEqual([...HISTORY_AGENTS].sort())
    for (const [agent, expected] of Object.entries(fixture.expected)) {
      const session = sessionsByAgent.get(agent)
      expect(session).toBeDefined()
      expect(session!.sessionId).toBe(expected.sessionId)
      expect(session!.title).toBe(expected.title)
      expect(session!.cwd).toBe(expected.cwd)
      expect(session!.messageCount).toBeGreaterThan(0)
      expect(session!.previewMessages.length).toBeGreaterThan(0)
      expect(session!.previewMessages.length).toBeLessThanOrEqual(5)
      expect(session!.presence).toBe('present')
    }
    expect(result.issues).toEqual([])
  })

  test('Claude title precedence selects the latest custom title ahead of generated and prompt titles', async () => {
    const home = await temporaryHome()
    await writeClaudeFixture(home, { titleRecords: true })
    const vault = scanner(home)
    const [candidate] = (await vault.discover()).candidates.filter((item) => item.agent === 'claude')

    expect(candidate).toBeDefined()
    const session = await vault.parse(candidate!)
    expect(session?.title).toBe('User custom title')
    expect(session?.firstUserPrompt).toBe('A concrete first request')
    expect(session?.model).toBe('claude-test-model')
    expect(session?.messageCount).toBe(2)
  })

  test('sidecar metadata participates in freshness and reparses changed metadata', async () => {
    const home = await temporaryHome()
    const { transcript, metadata } = await writeCursorFixture(home)
    const vault = scanner(home)
    const first = await vault.list({ unlimited: true, force: true })
    const firstCandidate = (await vault.discover()).candidates.find((item) => item.filePath === transcript)
    expect(first.sessions[0]?.title).toBe('Cursor sidecar title')
    expect(first.sessions[0]?.cwd).toBe('/tmp/cursor-fixture')
    expect(first.sessions[0]?.createdAt).toBe(1_787_039_612_017)
    expect(first.sessions[0]?.updatedAt).toBe(1_787_039_640_532)

    await writeFile(metadata, JSON.stringify({
      schemaVersion: 1,
      createdAtMs: Date.parse('2026-10-01T00:00:00.000Z'),
      updatedAtMs: Date.parse('2026-10-02T00:00:00.000Z'),
      cwd: '/tmp/cursor-changed',
      hasConversation: true,
      title: 'Changed sidecar title with longer text'
    }))
    const discovered = await vault.discover()
    const changed = discovered.candidates.find((item) => item.filePath === transcript)
    expect(changed).toBeDefined()
    expect(changed!.signature).not.toBe(firstCandidate?.signature)
    const second = await vault.list({ unlimited: true })
    expect(second.sessions[0]?.title).toBe('Changed sidecar title with longer text')
    expect(second.sessions[0]?.cwd).toBe('/tmp/cursor-changed')
    expect(second.sessions[0]?.createdAt).toBe(Date.parse('2026-10-01T00:00:00.000Z'))
    expect(second.sessions[0]?.updatedAt).toBe(Date.parse('2026-10-02T00:00:00.000Z'))
  })

  test('legacy OpenCode sessions rebuild chronological message-file transcripts', async () => {
    const home = await temporaryHome()
    const { filePath } = await writeOpenCodeLegacyFixture(home)
    const vault = scanner(home)
    const [candidate] = (await vault.discover()).candidates.filter((item) => item.filePath === filePath)
    const streamed: string[] = []
    const session = await vault.parse(candidate!, (message) => streamed.push(message.text))

    expect(session?.agent).toBe('opencode')
    expect(session?.sessionId).toBe('legacy-opencode-session')
    expect(session?.title).toBe('Legacy OpenCode title')
    expect(session?.cwd).toBe('/tmp/opencode-legacy')
    expect(session?.messageCount).toBe(2)
    expect(session?.previewMessages.map((message) => message.text)).toEqual(['Legacy first prompt', 'Legacy assistant answer'])
    expect(streamed).toEqual(['Legacy first prompt', 'Legacy assistant answer'])
  })

  test('SQLite-backed OpenCode, OpenCode 2 and ZCode sources preserve their own session identity', async () => {
    const home = await temporaryHome()
    await writeEveryAgentFixture(home)
    const vault = scanner(home)
    const result = await vault.list({ unlimited: true, agents: ['opencode', 'opencode2', 'zcode'], force: true })

    expect(Object.fromEntries(result.sessions.map(({ agent, sessionId, title }) => [agent, { sessionId, title }]))).toEqual({
      opencode: { sessionId: 'opencode-fixture-session', title: 'OpenCode fixture title' },
      opencode2: { sessionId: 'opencode2-fixture-session', title: 'OpenCode 2 fixture title' },
      zcode: { sessionId: 'zcode-fixture-session', title: 'ZCode fixture title' }
    })
    expect(result.sessions.every((session) => session.messageCount === 2)).toBe(true)
  })

  test('does not expose a partial final JSONL record and skips oversized records without losing later turns', async () => {
    const home = await temporaryHome()
    const filePath = await writeJsonlFixture(home, 'claude', 'bounded-session', [
      { type: 'user', sessionId: 'bounded-session', timestamp: '2026-10-01T00:00:00Z', message: { role: 'user', content: 'first request' } },
      { type: 'assistant', timestamp: '2026-10-01T00:00:01Z', message: { role: 'assistant', model: 'bounded-model', content: 'x'.repeat(10 * 1024 * 1024 + 16) } },
      { type: 'assistant', timestamp: '2026-10-01T00:00:02Z', message: { role: 'assistant', content: 'later complete response' } }
    ], { unterminatedTail: { type: 'user', message: { role: 'user', content: 'not committed yet' } } })
    const vault = scanner(home)
    const [candidate] = (await vault.discover()).candidates.filter((item) => item.filePath === filePath)
    const streamed: string[] = []
    const session = await vault.parse(candidate!, (message) => streamed.push(message.text))

    expect(session?.messageCount).toBe(2)
    expect(session?.previewMessages.map((message) => message.text)).toContain('later complete response')
    expect(session?.previewMessages.some((message) => message.text.includes('x'.repeat(1024)))).toBe(false)
    expect(streamed).toEqual(['first request', 'later complete response'])
    expect(await vault.firstPrompt(session!.id)).toBe('first request')
  })

  test('preserves scope-before-depth and excludes Claude subagent files from top-level history', async () => {
    const home = await temporaryHome()
    const { worktreeSessionId } = await writeScopeFixture(home, 24)
    const vault = scanner(home)
    const all = await vault.list({ limit: 1, force: true })
    const scoped = await vault.list({ limit: 1, scopePaths: ['/tmp/vault-worktree'], force: true })
    const parent = scoped.sessions[0]!
    const subagents = await vault.subagents(parent.id)

    expect(all.sessions).toHaveLength(1)
    expect(all.sessions[0]?.sessionId).not.toBe(worktreeSessionId)
    expect(scoped.sessions.map((session) => session.sessionId)).toEqual([worktreeSessionId])
    expect(subagents).toHaveLength(1)
    expect(subagents[0]?.subagent).toBe(true)
    expect((await vault.discover()).candidates.some((candidate) => candidate.filePath.includes('/subagents/'))).toBe(false)
  })

  test('delete targets are root-validated and never mutate originals', async () => {
    const home = await temporaryHome()
    const { sessionId, files } = await writeCursorFixture(home)
    const outside = join(await temporaryHome(), 'outside.jsonl')
    await writeFile(outside, '{}\n')
    const vault = scanner(home)
    const listed = await vault.list({ unlimited: true, force: true })
    const session = listed.sessions.find((item) => item.sessionId === sessionId)!
    const transcriptBefore = await readFile(files.transcript)
    const metadataBefore = await readFile(files.metadata)
    const targets = await vault.deleteTargets(session.id)

    expect(targets.map(({ path, kind }) => [path, kind])).toEqual([[files.transcript, 'file']])
    expect(targets.map(({ path }) => path)).not.toContain(outside)
    expect((await readFile(files.transcript)).equals(transcriptBefore)).toBe(true)
    expect((await readFile(files.metadata)).equals(metadataBefore)).toBe(true)
  })

  test('marks only provider-owned session directories as directory delete targets', async () => {
    const home = await temporaryHome()
    await writeEveryAgentFixture(home)
    const vault = scanner(home)
    const listed = await vault.list({ unlimited: true, force: true })
    const byAgent = new Map(listed.sessions.map((session) => [session.agent, session]))

    for (const agent of ['grok', 'rovo', 'cline'] as const) {
      const session = byAgent.get(agent)!
      const targets = await vault.deleteTargets(session.id)
      expect(targets.map(({ path, kind }) => [path, kind])).toEqual([[dirname(session.filePath), 'directory']])
    }

    const claude = byAgent.get('claude')!
    const claudeTargets = await vault.deleteTargets(claude.id)
    expect(claudeTargets.map(({ path, kind }) => [path, kind])).toEqual([
      [join(dirname(claude.filePath), claude.sessionId), 'directory'],
      [join(home, '.claude', 'session-env', claude.sessionId), 'directory'],
      [claude.filePath, 'file']
    ])
  })

  test('rejects symlink escapes, synthetic SQLite sources, unsupported deletion and stale cached reads', async () => {
    const home = await temporaryHome()
    const fixture = await writeEveryAgentFixture(home)
    const vault = scanner(home)
    const listed = await vault.list({ unlimited: true, force: true })
    const byAgent = new Map(listed.sessions.map((item) => [item.agent, item]))

    await expect(vault.deleteTargets(byAgent.get('codex')!.id)).rejects.toThrow('unsupported-agent')
    await expect(vault.deleteTargets(byAgent.get('opencode')!.id)).rejects.toThrow('unsupported-agent')
    const claude = byAgent.get('claude')!
    await vault.invalidate(claude.id)
    await writeFile(fixture.paths.claude!, '{"type":"user","sessionId":"claude-fixture-session","message":{"role":"user","content":"fresh"}}\n')
    const refreshed = await vault.get(claude.id)
    expect(refreshed?.previewMessages[0]?.text).toBe('fresh')

    const outside = join(await temporaryHome(), 'outside.jsonl')
    await writeFile(outside, '{}\n')
    const symlinkRoot = join(home, '.claude', 'projects', 'escape')
    await mkdir(symlinkRoot, { recursive: true })
    const linkPath = join(symlinkRoot, 'escape-session.jsonl')
    await symlink(outside, linkPath)
    const rejected = await vault.discover()
    expect(rejected.candidates.some((candidate) => candidate.filePath === linkPath)).toBe(false)
    await rm(fixture.paths.claude!, { force: true })
    await symlink(outside, fixture.paths.claude!)
    await expect(vault.deleteTargets(claude.id)).rejects.toThrow('invalid-path')
    expect(await readFile(outside, 'utf8')).toBe('{}\n')
  })
})
