import { Database } from 'bun:sqlite'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { PluginStore } from '@quirky/protocol'
import { makeTempHome, startHarness, waitFor, type Harness } from '../../../packages/daemon/test/helpers'
import { codexHooksInstalled, hasMarkerFile, markerDir, readMarkerFile, removeMarkerFile, writeMarkerFile } from '../src/hooks/install'
import { createAvatarStore } from '../src/store'
import { sampleMandate } from './support'

const DEPENDENCIES = [
  'quirky.worktree', 'quirky.session', 'quirky.agent-status', 'quirky.agents', 'quirky.ask', 'quirky.checks',
  'quirky.git', 'quirky.hosting', 'quirky.structured', 'quirky.heimdall', 'quirky.notifications'
]
const ENV_KEYS = ['HOME', 'CODEX_HOME', 'PI_CODING_AGENT_DIR', 'QUIRKY_HOME'] as const
const previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
const agentHome = makeTempHome('qav-restart-agents-')
const agentEnv = { home: agentHome, env: { CODEX_HOME: join(agentHome, 'codex') } }
const harnesses = new Set<Harness>()
const dirs: string[] = []
const databases: Database[] = []

beforeAll(() => {
  process.env.HOME = agentHome
  process.env.CODEX_HOME = agentEnv.env.CODEX_HOME
  process.env.PI_CODING_AGENT_DIR = join(agentHome, 'pi')
  process.env.QUIRKY_HOME = join(agentHome, 'quirky')
})

afterEach(async () => {
  for (const db of databases.splice(0)) db.close()
  for (const harness of [...harnesses]) await harness.cleanup()
  harnesses.clear()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (previousEnv[key] === undefined) delete process.env[key]
    else process.env[key] = previousEnv[key]
  }
  rmSync(agentHome, { recursive: true, force: true })
})

function pluginsDir(cwd: string): string {
  const dir = makeTempHome('qav-restart-plugins-')
  dirs.push(dir)
  symlinkSync(resolve(import.meta.dir, '..'), join(dir, 'quirky.avatar'))
  for (const id of DEPENDENCIES) {
    mkdirSync(join(dir, id))
    const manifest: Record<string, unknown> = { id, apiVersion: '1.0.0', name: id, version: '0.1.0', activation: 'lazy' }
    if (id === 'quirky.worktree') {
      const worktrees = [{ id: 'wt-1', path: cwd, branch: 'feature', repoId: 'repo', isMain: false }]
      Object.assign(manifest, { main: 'main.ts', contributes: { method: [{ id: 'list', description: 'Worktrees.', readOnly: true, params: { type: 'object' }, result: { type: 'array' } }] } })
      writeFileSync(join(dir, id, 'main.ts'), `export function activate(context) { context.provide('method:quirky.worktree/list', () => ${JSON.stringify(worktrees)}) }\n`)
    }
    if (id === 'quirky.agents') {
      const listing = { defaultAgent: 'claude', agents: [{ id: 'codex', installed: true, enabled: true }] }
      Object.assign(manifest, { main: 'main.ts', contributes: { method: [{ id: 'list', description: 'Agents.', readOnly: true, params: { type: 'object' }, result: { type: 'object' } }] } })
      writeFileSync(join(dir, id, 'main.ts'), `export function activate(context) { context.provide('method:quirky.agents/list', () => (${JSON.stringify(listing)})) }\n`)
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

async function boot() {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'qav-restart-wt-')))
  dirs.push(cwd)
  const home = makeTempHome('qav-restart-')
  dirs.push(home)
  const builtinPluginsDir = pluginsDir(cwd)
  const first = await startHarness({ home, builtinPluginsDir })
  harnesses.add(first)
  const store = createAvatarStore(fileStore(join(home, 'plugin-data', 'quirky.avatar', 'store.db')))
  store.mandates.put(sampleMandate())
  store.handoffs.put({ worktreeId: 'wt-1', state: 'pr-ready', sessionId: 'sess-1', active: true, handedOffAt: 1, takenBackAt: null })
  writeMarkerFile(home, 'sess-1', { worktreeId: 'wt-1', level: 'own-branch' })
  const read = { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: join(cwd, 'src', 'a.ts') } }
  const sshWrite = { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: join(homedir(), '.ssh', 'config'), content: 'x' } }

  async function shim(payload: Record<string, unknown>, sessionId = 'sess-1') {
    const proc = Bun.spawn(['sh', join(home, 'bin', 'quirky-gate'), 'claude', '5000'], {
      env: {
        PATH: process.env.PATH ?? '',
        HOME: agentHome,
        QUIRKY_HOME: home,
        QUIRKY_SESSION_ID: sessionId,
        QUIRKY_HOOK_TOKEN: first.runtime.hookToken
      },
      stdin: Buffer.from(JSON.stringify({ cwd, ...payload })),
      stdout: 'pipe',
      stderr: 'pipe'
    })
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    return { stdout, stderr, code }
  }

  async function stop() {
    await first.daemon.stop()
    first.pty.stop()
    harnesses.delete(first)
  }

  async function start() {
    const second = await startHarness({ home, builtinPluginsDir })
    harnesses.add(second)
    return second
  }

  return { home, store, read, sshWrite, shim, stop, start }
}

describe('avatar across a real daemon restart', () => {
  test('keeps workers gated while down and decides again using the original hook token', async () => {
    const s = await boot()
    const before = await s.shim(s.read)
    expect(before.code).toBe(0)
    expect(JSON.parse(before.stdout).hookSpecificOutput.permissionDecision).toBe('allow')
    await waitFor(() => codexHooksInstalled(agentEnv), 5000)
    expect(codexHooksInstalled(agentEnv)).toBe(true)

    await s.stop()
    expect(hasMarkerFile(s.home, 'sess-1')).toBe(true)
    expect(codexHooksInstalled(agentEnv)).toBe(true)
    const down = await s.shim(s.read)
    expect(down.code).toBe(2)
    expect(down.stderr).toContain("Quirky's avatar gate is unavailable")

    await s.start()
    const allowed = await s.shim(s.read)
    expect(allowed.code).toBe(0)
    expect(JSON.parse(allowed.stdout).hookSpecificOutput.permissionDecision).toBe('allow')
    const held = await s.shim(s.sshWrite)
    expect(held.code).toBe(0)
    expect(JSON.parse(held.stdout).hookSpecificOutput.permissionDecision).toBe('deny')
    expect(s.store.handoffs.get('wt-1')).toMatchObject({ active: true, state: 'pr-ready' })
  })

  test('repairs a missing marker and removes an unaccounted marker on activation', async () => {
    const s = await boot()
    await s.stop()
    removeMarkerFile(s.home, 'sess-1')
    writeMarkerFile(s.home, 'sess-gone', { worktreeId: 'wt-9', level: 'own-branch' })

    await s.start()
    await waitFor(() => hasMarkerFile(s.home, 'sess-1') && !existsSync(join(markerDir(s.home), 'sess-gone')))
    expect(readMarkerFile(s.home, 'sess-1')).toEqual({ worktreeId: 'wt-1', level: 'own-branch' })
    expect(s.store.journalPage({ worktreeId: 'wt-1' }).some((entry) => entry.kind === 'event' && entry.data.type === 'restored' && entry.data.marker === 'written')).toBe(true)
    const held = await s.shim(s.sshWrite)
    expect(held.code).toBe(0)
    expect(JSON.parse(held.stdout).hookSpecificOutput.permissionDecision).toBe('deny')
    expect(await s.shim(s.read, 'sess-gone')).toMatchObject({ code: 0, stdout: '{}\n' })
  })
})
