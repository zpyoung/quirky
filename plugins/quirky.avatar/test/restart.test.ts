import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { waitFor } from '../../../packages/daemon/test/helpers'
import { codexHooksInstalled, hasMarkerFile, markerDir, readMarkerFile, removeMarkerFile, writeMarkerFile } from '../src/hooks/install'
import { sampleMandate } from './support'
import { answering, avatarBuiltins, cleanupDaemons, openAvatarStore, runGateShim, startAvatarHarness, stopKeepingHome, useTempAgentHome } from './daemon-support'

const agent = useTempAgentHome()
const dirs: string[] = []

afterEach(async () => {
  await cleanupDaemons()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function boot() {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'qav-restart-wt-')))
  dirs.push(cwd)
  const worktrees = [{ id: 'wt-1', path: cwd, branch: 'feature', repoId: 'repo', isMain: false }]
  const listing = { defaultAgent: 'claude', agents: [{ id: 'codex', installed: true, enabled: true }] }
  const builtins = avatarBuiltins({
    'quirky.worktree': answering('quirky.worktree', { list: worktrees }),
    'quirky.agents': answering('quirky.agents', { list: listing })
  })
  const first = await startAvatarHarness(builtins)
  const home = first.home
  const store = openAvatarStore(home)
  store.mandates.put(sampleMandate())
  store.handoffs.put({ worktreeId: 'wt-1', state: 'pr-ready', sessionId: 'sess-1', active: true, handedOffAt: 1, takenBackAt: null })
  writeMarkerFile(home, 'sess-1', { worktreeId: 'wt-1', level: 'own-branch' })
  const read = { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: join(cwd, 'src', 'a.ts') } }
  const sshWrite = { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: agent.sshConfig, content: 'x' } }

  async function shim(payload: Record<string, unknown>, sessionId = 'sess-1') {
    return runGateShim(home, ['claude', '5000'], {
      ...agent.childEnv,
      QUIRKY_HOME: home,
      QUIRKY_SESSION_ID: sessionId,
      QUIRKY_HOOK_TOKEN: first.runtime.hookToken
    }, { cwd, ...payload })
  }

  async function stop() {
    await stopKeepingHome(first)
  }

  async function start() {
    return startAvatarHarness(builtins, { home })
  }

  return { home, store, read, sshWrite, shim, stop, start }
}

describe('avatar across a real daemon restart', () => {
  test('keeps workers gated while down and decides again using the original hook token', async () => {
    const s = await boot()
    const before = await s.shim(s.read)
    expect(before.code).toBe(0)
    expect(JSON.parse(before.stdout).hookSpecificOutput.permissionDecision).toBe('allow')
    await waitFor(() => codexHooksInstalled(agent.agentEnv), 5000)
    expect(codexHooksInstalled(agent.agentEnv)).toBe(true)

    await s.stop()
    expect(hasMarkerFile(s.home, 'sess-1')).toBe(true)
    expect(codexHooksInstalled(agent.agentEnv)).toBe(true)
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
