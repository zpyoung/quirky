import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { HOOK_TOKEN_HEADER, type PluginStore, type ToolGateDecision } from '@quirky/protocol'
import { makeTempHome, startHarness, type Harness } from '../../../packages/daemon/test/helpers'
import type { Level } from '../src/contracts'
import { writeMarkerFile } from '../src/hooks/install'
import { createAvatarStore } from '../src/store'
import { sampleMandate } from './support'

const PLUGIN_DIR = resolve(import.meta.dir, '..')
const DEPENDENCIES = [
  'quirky.worktree', 'quirky.session', 'quirky.agent-status', 'quirky.agents', 'quirky.ask', 'quirky.checks',
  'quirky.git', 'quirky.hosting', 'quirky.structured', 'quirky.heimdall', 'quirky.notifications'
]

const harnesses = new Set<Harness>()
const dirs: string[] = []
const databases: Database[] = []

afterEach(async () => {
  for (const db of databases.splice(0)) db.close()
  for (const harness of [...harnesses]) await harness.cleanup()
  harnesses.clear()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

type ListedWorktree = { id: string; path: string; branch: string; repoId: string; isMain: boolean }

function avatarPluginsDir(worktrees: ListedWorktree[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'qav-route-bi-'))
  dirs.push(dir)
  symlinkSync(PLUGIN_DIR, join(dir, 'quirky.avatar'))
  for (const id of DEPENDENCIES) {
    mkdirSync(join(dir, id))
    const manifest: Record<string, unknown> = { id, apiVersion: '1.0.0', name: id, version: '0.1.0', activation: 'lazy' }
    if (id === 'quirky.worktree') {
      Object.assign(manifest, { main: 'main.ts', contributes: { method: [{ id: 'list', description: 'Worktrees.', readOnly: true, params: { type: 'object' }, result: { type: 'array' } }] } })
      writeFileSync(
        join(dir, id, 'main.ts'),
        `export function activate(context) {\n  context.provide('method:quirky.worktree/list', () => ${JSON.stringify(worktrees)})\n}\n`
      )
    }
    writeFileSync(join(dir, id, 'quirky-plugin.json'), JSON.stringify(manifest))
  }
  return dir
}

function fileStore(path: string): PluginStore {
  const db = new Database(path)
  databases.push(db)
  return {
    version: 0,
    run: (sql, ...params) => {
      const result = db.query(sql).run(...(params as never[]))
      return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) }
    },
    get: (sql, ...params) => (db.query(sql).get(...(params as never[])) as never) ?? null,
    all: (sql, ...params) => db.query(sql).all(...(params as never[])) as never,
    exec: (sql) => db.exec(sql),
    transaction: (work) => db.transaction(work)()
  }
}

/** A daemon with the avatar loaded and `wt-1` handed off with a marker for session `sess-1`. */
async function boot(level: Level = 'own-branch', options: { listWorktree?: boolean } = {}) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'qav-route-wt-')))
  dirs.push(cwd)
  const listed: ListedWorktree[] = options.listWorktree === false ? [] : [{ id: 'wt-1', path: cwd, branch: 'feature', repoId: 'repo', isMain: false }]
  const harness = await startHarness({ home: makeTempHome('qav-route-'), builtinPluginsDir: avatarPluginsDir(listed) })
  harnesses.add(harness)
  const store = createAvatarStore(fileStore(join(harness.home, 'plugin-data', 'quirky.avatar', 'store.db')))
  store.mandates.put(sampleMandate({ level }))
  store.handoffs.put({ worktreeId: 'wt-1', state: 'working', sessionId: 'sess-1', active: true, handedOffAt: 1, takenBackAt: null })
  writeMarkerFile(harness.home, 'sess-1', { worktreeId: 'wt-1', level })
  const base = `http://127.0.0.1:${harness.runtime.port}`

  async function gate(agent: string, payload: Record<string, unknown>, query = 'session=sess-1&event=PreToolUse&deadline=5000'): Promise<ToolGateDecision> {
    const response = await fetch(`${base}/gate/${agent}?${query}`, {
      method: 'POST',
      headers: { [HOOK_TOKEN_HEADER]: harness.runtime.hookToken },
      body: JSON.stringify({ cwd, ...payload })
    })
    expect(response.status).toBe(200)
    return (await response.json()) as ToolGateDecision
  }

  async function shim(agent: string, payload: Record<string, unknown>, env: Record<string, string> = {}) {
    const proc = Bun.spawn(['sh', join(harness.home, 'bin', 'quirky-gate'), agent, '5000'], {
      env: {
        PATH: process.env.PATH ?? '',
        QUIRKY_HOME: harness.home,
        QUIRKY_SESSION_ID: 'sess-1',
        QUIRKY_HOOK_TOKEN: harness.runtime.hookToken,
        ...env
      },
      stdin: Buffer.from(JSON.stringify({ cwd, ...payload })),
      stdout: 'pipe',
      stderr: 'pipe'
    })
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    return { stdout, stderr, code }
  }

  return { harness, store, cwd, gate, shim }
}

const read = (cwd: string) => ({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: join(cwd, 'src', 'a.ts') } })
const sshWrite = { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: join(homedir(), '.ssh', 'config'), content: 'x' } }

describe('/gate/ through the real daemon with the avatar loaded', () => {
  test('allows a read in the worktree, encoded for Claude', async () => {
    const s = await boot()
    const decision = await s.gate('claude', read(s.cwd))
    expect(decision).toMatchObject({ decision: 'allow', exitCode: 0 })
    expect(JSON.parse(decision.encoded!)).toMatchObject({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } })
    expect(s.store.receipts.list({ sessionId: 'sess-1' })).toHaveLength(1)
    const [entry] = s.store.journalPage({ worktreeId: 'wt-1' })
    expect(entry).toMatchObject({ kind: 'gate', data: { outcome: 'allow', toolName: 'Read', sawWorkerExplanation: false } })
  })

  test('holds a write to ~/.ssh: a deny the worker can read, and an item for the user', async () => {
    const s = await boot()
    const decision = await s.gate('claude', sshWrite)
    expect(decision.decision).toBe('deny')
    const output = JSON.parse(decision.encoded!).hookSpecificOutput
    expect(output).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' })
    expect(output.permissionDecisionReason).toContain('Held for the user')
    const needs = s.store.needs.list({ worktreeId: 'wt-1' })
    expect(needs).toHaveLength(1)
    expect(needs[0]).toMatchObject({ kind: 'held-call', actions: ['allow-once', 'deny'], resolvedAt: null })
  })

  test('answers each agent in its own encoding', async () => {
    const s = await boot()
    expect((await s.gate('codex', read(s.cwd))).encoded).toBe('{}')
    const codexHeld = await s.gate('codex', sshWrite)
    expect(JSON.parse(codexHeld.encoded!).hookSpecificOutput.permissionDecision).toBe('deny')
    const permission = await s.gate('codex', { ...read(s.cwd), hook_event_name: 'PermissionRequest' }, 'session=sess-1&event=PermissionRequest&deadline=5000')
    expect(JSON.parse(permission.encoded!)).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } })
    const piRead = { hook_event_name: 'tool_call', tool_name: 'read', tool_input: { path: join(s.cwd, 'a.ts') } }
    expect(await s.gate('pi', piRead, 'session=sess-1&event=tool_call&deadline=5000')).toMatchObject({ decision: 'allow', encoded: '' })
    const piHeld = await s.gate('omp', { hook_event_name: 'tool_call', tool_name: 'write', tool_input: { path: join(homedir(), '.ssh', 'config') } }, 'session=sess-1&event=tool_call&deadline=5000')
    expect(JSON.parse(piHeld.encoded!)).toMatchObject({ block: true })
  })

  test('a session with no marker is passthrough, and so is one the avatar does not supervise', async () => {
    const s = await boot()
    expect(await s.gate('claude', sshWrite, 'session=someone-else&event=PreToolUse&deadline=5000')).toMatchObject({ decision: 'passthrough', encoded: '{}' })
  })

  test('a worktree the daemon cannot list is refused with the retry reason, even for a read', async () => {
    const s = await boot('own-branch', { listWorktree: false })
    const decision = await s.gate('claude', read(s.cwd))
    expect(decision.decision).toBe('deny')
    expect(JSON.parse(decision.encoded!).hookSpecificOutput.permissionDecisionReason).toBe("Quirky's avatar gate couldn't confirm the worktree; try again shortly.")
    expect(s.store.journalPage({ worktreeId: 'wt-1' })[0]!.data.outcome).toBe('retry')
  })

  test('Shadow answers passthrough for a write that would be held', async () => {
    const s = await boot('shadow')
    expect(await s.gate('claude', sshWrite)).toMatchObject({ decision: 'passthrough', encoded: '{}' })
    expect(s.store.needs.list()).toEqual([])
    expect(s.store.journalPage({ worktreeId: 'wt-1' })[0]!.data).toMatchObject({ outcome: 'passthrough', wouldHave: { outcome: 'held' } })
  })

  test('a call that needs the brain is refused with a retry reason while the brain is not ready', async () => {
    const s = await boot()
    const decision = await s.gate('claude', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'bun test --update-snapshots' } })
    expect(decision.decision).toBe('deny')
    expect(JSON.parse(decision.encoded!).hookSpecificOutput.permissionDecisionReason).toContain('try the same call again')
    expect(s.store.journalPage({ worktreeId: 'wt-1' })[0]!.data.outcome).toBe('retry')
  })

  test('the quirky-gate shim prints the daemon encoding verbatim', async () => {
    const s = await boot()
    const allowed = await s.shim('claude', read(s.cwd))
    expect(allowed.code).toBe(0)
    expect(JSON.parse(allowed.stdout).hookSpecificOutput.permissionDecision).toBe('allow')
    const held = await s.shim('claude', sshWrite)
    expect(held.code).toBe(0)
    expect(JSON.parse(held.stdout).hookSpecificOutput.permissionDecision).toBe('deny')
  })

  test('the shim is passthrough with no marker and blocks with exit 2 when the daemon cannot be reached', async () => {
    const s = await boot()
    expect(await s.shim('claude', sshWrite, { QUIRKY_SESSION_ID: 'unmarked' })).toMatchObject({ stdout: '{}\n', code: 0 })
    writeFileSync(join(s.harness.home, 'runtime.json'), JSON.stringify({ port: 1 }))
    const down = await s.shim('claude', read(s.cwd))
    expect(down.code).toBe(2)
    expect(down.stderr).toContain("Quirky's avatar gate is unavailable")
  })

  test('taking the worktree back by removing the marker returns it to passthrough at the shim', async () => {
    const s = await boot()
    rmSync(join(s.harness.home, 'plugin-data', 'quirky.avatar', 'supervised', 'sess-1'))
    expect(existsSync(join(s.harness.home, 'plugin-data', 'quirky.avatar', 'supervised', 'sess-1'))).toBe(false)
    expect(await s.shim('claude', sshWrite)).toMatchObject({ stdout: '{}\n', code: 0 })
  })
})
