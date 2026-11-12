import { afterEach, describe, expect, jest, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runLaunchHooks } from '../../../packages/daemon/src/plugins/launch-hooks'
import { codexInstaller } from '../../quirky.agent-status/src/install/claude-json'
import { claudeSettings } from '../../quirky.agent-status/src/claude-settings'
import {
  claudeGateSettings, claudeVersionAtLeast, clearMarkerFiles, codexHooksInstalled, codexHooksPath, createGateLaunchHook, gateCommand,
  hasHookedRecord, hasMarkerFile, hookedDir, installCodexHooks, installPiExtensions, launchHasGateHook, markerDir, parseClaudeVersion, piExtensionPath,
  readMarkerFile, removeCodexHooks, removeMarkerFile, removePiExtensions, writeMarkerFile, type AgentEnv
} from '../src/hooks/install'
import { QUIRKY_GATE_SCRIPT } from '../../../packages/daemon/src/launch'
import { GATE_EXTENSION_FILE, gateExtensionSource } from '../src/hooks/pi-extension'

const dirs: string[] = []
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'avatar-hooks-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const agentEnv = (env: Record<string, string> = {}): AgentEnv => ({ home: scratch(), env })
const RETRY = "Quirky's avatar gate is unavailable; try again shortly."
const PR_DENY = `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Quirky's avatar gate is unavailable; try again shortly."}}}`
const GATE_EVENTS = ['PreToolUse', 'PermissionRequest'] as const
const GATE_AGENTS = ['claude', 'codex'] as const
const runShell = (command: string, env: Record<string, string>, stdin = '') =>
  Bun.spawnSync(['/bin/sh', '-c', command], {
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env },
    stdin: new Blob([stdin]),
    stdout: 'pipe',
    stderr: 'pipe'
  })
const gateStub = (home: string, body = '#!/bin/sh\nprintf \'%s\\n\' "$1" "$2" "$3" "$QUIRKY_HOME" "$QUIRKY_SESSION_ID"\ncat\n'): string => {
  const path = join(home, 'bin', 'quirky-gate')
  mkdirSync(join(home, 'bin'), { recursive: true })
  writeFileSync(path, body, { mode: 0o755 })
  return path
}
const expectRefusal = (
  result: { stdout: { toString(): string }; stderr: { toString(): string }; exitCode: number | null },
  event: string
) => {
  expect(result.stdout.toString()).toBe(event === 'PermissionRequest' ? `${PR_DENY}\n` : '')
  expect(result.exitCode).toBe(event === 'PermissionRequest' ? 0 : 2)
  expect(result.stderr.toString().endsWith(`${RETRY}\n`)).toBe(true)
}

describe('supervision markers', () => {
  test('a marker is a 0600 file named for the session holding the worktree and level', () => {
    const home = scratch()
    writeMarkerFile(home, 's-1', { worktreeId: 'wt-1', level: 'own-branch' })
    const path = join(markerDir(home), 's-1')
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ worktreeId: 'wt-1', level: 'own-branch' })
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(readMarkerFile(home, 's-1')).toEqual({ worktreeId: 'wt-1', level: 'own-branch' })
    expect(hasMarkerFile(home, 's-1')).toBe(true)
  })

  test('removing a marker, or clearing all of them, returns sessions to passthrough', () => {
    const home = scratch()
    writeMarkerFile(home, 's-1', { worktreeId: 'wt-1', level: 'full' })
    writeMarkerFile(home, 's-2', { worktreeId: 'wt-2', level: 'full' })
    removeMarkerFile(home, 's-1')
    expect(hasMarkerFile(home, 's-1')).toBe(false)
    expect(hasMarkerFile(home, 's-2')).toBe(true)
    clearMarkerFiles(home)
    expect(hasMarkerFile(home, 's-2')).toBe(false)
    removeMarkerFile(home, 'never-existed')
  })

  test('a session id that is not a plain file name never reaches the filesystem', () => {
    const home = scratch()
    for (const id of ['', '../escape', 'a/b', '.hidden']) writeMarkerFile(home, id, { worktreeId: 'wt-1', level: 'full' })
    expect(existsSync(markerDir(home))).toBe(false)
    expect(readMarkerFile(home, '../escape')).toBeNull()
  })

  test('an unreadable marker reads as null', () => {
    const home = scratch()
    mkdirSync(markerDir(home), { recursive: true })
    writeFileSync(join(markerDir(home), 's-1'), 'not json')
    expect(readMarkerFile(home, 's-1')).toBeNull()
  })
})

describe('gateCommand', () => {
  const sessionEnv = (home: string, sessionId = 's-1') => ({ QUIRKY_HOME: home, QUIRKY_SESSION_ID: sessionId })

  test('answers passthrough outside a Quirky install', () => {
    const result = runShell(gateCommand('claude', 'PreToolUse', 60000), {})
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toBe('{}\n')
  })

  test.each([
    ['unset', undefined],
    ['empty', ''],
    ['contains a slash', 'a/b'],
    ['starts with a dot', '.x']
  ])('does not run the shim when the session ID is %s', (_name, sessionId) => {
    const home = scratch()
    writeMarkerFile(home, 's-1', { worktreeId: 'wt-1', level: 'full' })
    gateStub(home)
    const env: Record<string, string> = { QUIRKY_HOME: home }
    if (sessionId !== undefined) env.QUIRKY_SESSION_ID = sessionId
    const result = runShell(gateCommand('claude', 'PreToolUse', 60000), env)
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toBe('{}\n')
  })

  test('does not run the shim for an unmarked session', () => {
    const home = scratch()
    writeMarkerFile(home, 's-1', { worktreeId: 'wt-1', level: 'full' })
    gateStub(home)
    const result = runShell(gateCommand('claude', 'PreToolUse', 60000), sessionEnv(home, 's-2'))
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toBe('{}\n')
  })

  test('passes the event and supervised session data to the shim', () => {
    const home = scratch()
    writeMarkerFile(home, 's-1', { worktreeId: 'wt-1', level: 'full' })
    gateStub(home)
    for (const event of GATE_EVENTS) {
      const result = runShell(gateCommand('codex', event, 60000), sessionEnv(home), 'PAYLOAD')
      expect(result.exitCode).toBe(0)
      expect(result.stdout.toString()).toBe(`codex\n60000\n${event}\n${home}\ns-1\nPAYLOAD`)
    }
  })

  test('refuses when the shim is missing for either agent and event', () => {
    const home = scratch()
    writeMarkerFile(home, 's-1', { worktreeId: 'wt-1', level: 'full' })
    for (const agent of GATE_AGENTS) {
      for (const event of GATE_EVENTS) {
        expectRefusal(runShell(gateCommand(agent, event, 60000), sessionEnv(home)), event)
      }
    }
  })

  test('refuses when the shim is not executable at either event', () => {
    const home = scratch()
    const path = join(home, 'bin', 'quirky-gate')
    mkdirSync(join(home, 'bin'))
    writeFileSync(path, '#!/bin/sh\nprintf ok\n', { mode: 0o644 })
    writeMarkerFile(home, 's-1', { worktreeId: 'wt-1', level: 'full' })
    for (const event of GATE_EVENTS) {
      expectRefusal(runShell(gateCommand('claude', event, 60000), sessionEnv(home)), event)
    }
  })

  test('passes exit 2 through only for PreToolUse', () => {
    for (const event of GATE_EVENTS) {
      const home = scratch()
      gateStub(home, '#!/bin/sh\nprintf "%s\\n" shimline >&2\nexit 2\n')
      writeMarkerFile(home, 's-1', { worktreeId: 'wt-1', level: 'full' })
      const result = runShell(gateCommand('claude', event, 60000), sessionEnv(home))
      if (event === 'PreToolUse') {
        expect(result.stdout.toString()).toBe('')
        expect(result.stderr.toString()).toBe('shimline\n')
        expect(result.exitCode).toBe(2)
      } else {
        expectRefusal(result, event)
      }
    }
  })

  test.each([
    ['exit 1', 'exit 1'],
    ['exit 126', 'exit 126'],
    ['signal 9', 'kill -9 $$']
  ])('refuses when the shim exits with %s at either event', (_name, body) => {
    for (const event of GATE_EVENTS) {
      const home = scratch()
      gateStub(home, `#!/bin/sh\n${body}\n`)
      writeMarkerFile(home, 's-1', { worktreeId: 'wt-1', level: 'full' })
      expectRefusal(runShell(gateCommand('codex', event, 60000), sessionEnv(home)), event)
    }
  })

  test('runs an identity-form command without Quirky environment variables', () => {
    const home = scratch()
    gateStub(home)
    writeMarkerFile(home, 's-1', { worktreeId: 'wt-1', level: 'full' })
    const result = runShell(gateCommand('claude', 'PreToolUse', 60000, { quirkyHome: home, sessionId: 's-1' }), {})
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toBe(`claude\n60000\nPreToolUse\n${home}\ns-1\n`)
  })

  test('uses the embedded identity instead of conflicting environment values', () => {
    const home = scratch()
    gateStub(home)
    writeMarkerFile(home, 's-1', { worktreeId: 'wt-1', level: 'full' })
    const result = runShell(
      gateCommand('claude', 'PreToolUse', 60000, { quirkyHome: home, sessionId: 's-1' }),
      { QUIRKY_HOME: '/nowhere', QUIRKY_SESSION_ID: 'other' }
    )
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toBe(`claude\n60000\nPreToolUse\n${home}\ns-1\n`)
  })

  test('quotes spaces, apostrophes, and dollar signs in an embedded identity', () => {
    const home = join(scratch(), "a b'c $d")
    gateStub(home)
    writeMarkerFile(home, "s'1 $x", { worktreeId: 'wt-1', level: 'full' })
    const result = runShell(gateCommand('claude', 'PreToolUse', 60000, { quirkyHome: home, sessionId: "s'1 $x" }), {})
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toBe(`claude\n60000\nPreToolUse\n${home}\ns'1 $x\n`)
  })

  test('passes through for an identity whose session ID is not plain', () => {
    const home = scratch()
    const result = runShell(gateCommand('claude', 'PreToolUse', 60000, { quirkyHome: home, sessionId: '../s' }), {})
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toBe('{}\n')
  })

  test('matches the real gate shim refusal for each event', () => {
    const home = scratch()
    const shim = join(scratch(), 'quirky-gate')
    writeFileSync(shim, QUIRKY_GATE_SCRIPT, { mode: 0o755 })
    writeMarkerFile(home, 's-1', { worktreeId: 'wt-1', level: 'full' })
    for (const event of GATE_EVENTS) {
      const env = sessionEnv(home)
      const command = runShell(gateCommand('claude', event, 1000), env)
      const actual = Bun.spawnSync([shim, 'claude', '1000', event], {
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env },
        stdin: new Blob([]),
        stdout: 'pipe',
        stderr: 'pipe'
      })
      expect(actual.stdout.equals(command.stdout)).toBe(true)
      expect(actual.exitCode).toBe(command.exitCode)
    }
  })

  test('every generated command names the gate shim', () => {
    for (const agent of GATE_AGENTS) {
      for (const event of GATE_EVENTS) {
        expect(gateCommand(agent, event, 60000)).toContain('/bin/quirky-gate')
      }
    }
  })
})

describe('Claude launch hook', () => {
  const launch = (agent: string, jsonArgs: Record<string, Record<string, unknown>> = {}, sessionId = 's') =>
    ({ sessionId, worktreeId: 'w', repoId: 'r', cwd: '/x', agent, env: {}, args: [], jsonArgs }) as never
  const dataDir = mkdtempSync(join(tmpdir(), 'avatar-hooked-'))
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }))
  const hook = (version: string | null, seconds = 55, quirkyHome = scratch()) =>
    createGateLaunchHook({ judgmentTimeoutSeconds: () => seconds, claudeVersion: async () => version, dataDir, quirkyHome })

  test('adds one identity-bound command entry for each event', async () => {
    const home = scratch()
    gateStub(home)
    writeMarkerFile(home, 's-1', { worktreeId: 'wt-1', level: 'full' })
    const patch = (await hook('2.1.300 (Claude Code)', 55, home)(launch('claude', {}, 's-1'))) as { jsonArgs: Record<string, { hooks: Record<string, any[]> }> }
    const settings = patch.jsonArgs['--settings']!
    for (const event of GATE_EVENTS) {
      expect(settings.hooks[event]).toHaveLength(1)
      const [entry] = settings.hooks[event]!
      expect(entry.matcher).toBe('*')
      expect(entry.hooks[0]).toMatchObject({ type: 'command', onFailure: 'block', timeout: 85 })
      const result = runShell(entry.hooks[0].command, {})
      expect(result.exitCode).toBe(0)
      expect(result.stdout.toString()).toBe(`claude\n60000\n${event}\n${home}\ns-1\n`)
    }
  })

  test('the deadline and hook timeout follow the judgment timeout', async () => {
    const home = scratch()
    gateStub(home)
    writeMarkerFile(home, 's', { worktreeId: 'wt-1', level: 'full' })
    const patch = (await hook('2.1.300', 30, home)(launch('claude'))) as { jsonArgs: Record<string, { hooks: Record<string, any[]> }> }
    const command = patch.jsonArgs['--settings']!.hooks.PreToolUse![0].hooks[0]
    expect(command.timeout).toBe(60)
    const result = runShell(command.command, {})
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toBe(`claude\n35000\nPreToolUse\n${home}\ns\n`)
  })


  test.each([['2.1.294'], ['1.9.9'], [null], ['claude: not found']])('a Claude version of %p gets no gate hook', async (version) => {
    expect(await hook(version)(launch('claude'))).toEqual({})
  })

  test('records the session as hooked (mode 0600) only when it adds the gate settings', async () => {
    await hook('2.1.300 (Claude Code)')(launch('claude'))
    expect(hasHookedRecord(dataDir, 's')).toBe(true)
    const file = join(hookedDir(dataDir), 's')
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ agent: 'claude', claudeVersion: '2.1.300' })
    expect(typeof JSON.parse(readFileSync(file, 'utf8')).at).toBe('number')
  })

  test.each([['2.1.294'], [null]])('a Claude version of %p leaves no hooked record', async (version) => {
    await hook(version)(launch('claude'))
    expect(hasHookedRecord(dataDir, 's')).toBe(false)
  })

  test('other agents leave no hooked record', async () => {
    for (const agent of ['codex', 'pi', 'omp', 'shell']) await hook('2.1.300')(launch(agent))
    expect(existsSync(hookedDir(dataDir))).toBe(false)
  })

  test('a session id that is not a plain file name is not recorded', async () => {
    const odd = { sessionId: '../escape', worktreeId: 'w', repoId: 'r', cwd: '/x', agent: 'claude', env: {}, args: [], jsonArgs: {} } as never
    await hook('2.1.300')(odd)
    expect(existsSync(join(dataDir, 'escape'))).toBe(false)
    expect(hasHookedRecord(dataDir, '../escape')).toBe(false)
  })

  test('other agents are not given Claude settings', async () => {
    for (const agent of ['codex', 'pi', 'omp', 'shell']) expect(await hook('2.1.300')(launch(agent))).toEqual({})
  })

  test('keeps the status reporter hooks already in --settings and adds its own beside them', async () => {
    const reporter = claudeSettings(['SessionStart', 'PreToolUse', 'PermissionRequest', 'Stop'])
    const patch = (await hook('2.1.300')(launch('claude', { '--settings': reporter }))) as { jsonArgs: Record<string, { hooks: Record<string, any[]> }> }
    const hooks = patch.jsonArgs['--settings']!.hooks
    expect(Object.keys(hooks).sort()).toEqual(['PermissionRequest', 'PreToolUse', 'SessionStart', 'Stop'])
    expect(hooks.PreToolUse!).toHaveLength(2)
    expect(hooks.PreToolUse![0]).toEqual(reporter.hooks.PreToolUse![0])
    expect(hooks.PreToolUse![1].hooks[0].command).toContain('quirky-gate')
  })

  test('running after the status reporter in the daemon pipeline leaves both in the launch args', async () => {
    const reporterHook = async () => ({ jsonArgs: { '--settings': claudeSettings(['SessionStart', 'PreToolUse']) } })
    const plugins = {
      contributions: () => [
        { id: 'launch-hook:quirky.agent-status/hooks', plugin: 'quirky.agent-status', data: {} },
        { id: 'launch-hook:quirky.avatar/gate-hooks', plugin: 'quirky.avatar', data: {} }
      ],
      resolveImplementation: async (id: string) => (id.includes('avatar') ? hook('2.1.300') : reporterHook)
    }
    const added = await runLaunchHooks({
      plugins,
      input: { sessionId: 's', worktreeId: 'w', repoId: 'r', cwd: '/x', agent: 'claude' },
      timeoutMs: 1000,
      warn: (_plugin, message) => {
        throw new Error(message)
      }
    })
    const index = added.args.indexOf('--settings')
    const settings = JSON.parse(added.args[index + 1]!)
    expect(settings.hooks.SessionStart).toHaveLength(1)
    expect(settings.hooks.PreToolUse).toHaveLength(2)
    expect(launchHasGateHook(added.args)).toBe(true)
  })

  test('settings without an identity keep using the session environment and remain idempotent', () => {
    const home = scratch()
    gateStub(home)
    writeMarkerFile(home, 's-1', { worktreeId: 'wt-1', level: 'full' })
    const settings = claudeGateSettings({}, 55) as { hooks: Record<string, { hooks: { command: string }[] }[]> }
    for (const event of GATE_EVENTS) {
      expect(settings.hooks[event]).toHaveLength(1)
      const command = settings.hooks[event]![0]!.hooks[0]!.command
      expect(command).toContain('QUIRKY_HOME')
      expect(command).toContain('QUIRKY_SESSION_ID')
      const result = runShell(command, { QUIRKY_HOME: home, QUIRKY_SESSION_ID: 's-1' })
      expect(result.exitCode).toBe(0)
      expect(result.stdout.toString()).toBe(`claude\n60000\n${event}\n${home}\ns-1\n`)
    }
    expect(claudeGateSettings(settings, 55)).toEqual(settings)
  })

  test('a replayed launch replaces the old identity without duplicating entries', () => {
    const home = scratch()
    gateStub(home)
    writeMarkerFile(home, 'new', { worktreeId: 'wt-1', level: 'full' })
    const oldSettings = claudeGateSettings({}, 55, { quirkyHome: home, sessionId: 'old' })
    const settings = claudeGateSettings(oldSettings, 55, { quirkyHome: home, sessionId: 'new' }) as { hooks: Record<string, { hooks: { command: string }[] }[]> }
    for (const event of GATE_EVENTS) {
      expect(settings.hooks[event]).toHaveLength(1)
      const result = runShell(settings.hooks[event]![0]!.hooks[0]!.command, {})
      expect(result.exitCode).toBe(0)
      expect(result.stdout.toString()).toBe(`claude\n60000\n${event}\n${home}\nnew\n`)
    }
    expect(claudeGateSettings(settings, 55, { quirkyHome: home, sessionId: 'new' })).toEqual(settings)
  })
})

describe('launchHasGateHook', () => {
  const settings = JSON.stringify(claudeGateSettings({}, 55))

  test('finds the avatar hook in a separate or an = form --settings argument', () => {
    expect(launchHasGateHook(['--model', 'x', '--settings', settings])).toBe(true)
    expect(launchHasGateHook([`--settings=${settings}`])).toBe(true)
  })

  test('does not count the status reporter, a file path or no settings', () => {
    expect(launchHasGateHook(['--settings', JSON.stringify(claudeSettings(['PreToolUse']))])).toBe(false)
    expect(launchHasGateHook(['--settings', '/etc/claude.json'])).toBe(false)
    expect(launchHasGateHook([])).toBe(false)
  })
})

describe('Claude version', () => {
  test('parses the first x.y.z in the output', () => {
    expect(parseClaudeVersion('2.1.310 (Claude Code)')).toBe('2.1.310')
    expect(parseClaudeVersion('nope')).toBeNull()
  })

  test('2.1.295 is the first version that can fail closed, and an unknown version never is', () => {
    expect(claudeVersionAtLeast('2.1.295')).toBe(true)
    expect(claudeVersionAtLeast('2.2.0')).toBe(true)
    expect(claudeVersionAtLeast('3.0.0')).toBe(true)
    expect(claudeVersionAtLeast('2.1.294')).toBe(false)
    expect(claudeVersionAtLeast('1.99.99')).toBe(false)
    expect(claudeVersionAtLeast(null)).toBe(false)
  })
})

describe('Codex hooks.json', () => {
  const read = (env: AgentEnv) => readFileSync(codexHooksPath(env), 'utf8')
  const gateEntries = (env: AgentEnv, event: string) => (JSON.parse(read(env)).hooks[event] as { hooks: { command: string; timeout: number }[] }[]).filter((entry) => entry.hooks.some((hook) => hook.command.includes('quirky-gate')))

  test('installs one event-specific environment-form entry for each Codex event', () => {
    const env = agentEnv()
    gateStub(env.home)
    writeMarkerFile(env.home, 's-1', { worktreeId: 'wt-1', level: 'full' })
    expect(installCodexHooks(env, 55)).toBe(true)
    expect(codexHooksInstalled(env)).toBe(true)
    for (const event of GATE_EVENTS) {
      const [entry] = gateEntries(env, event)
      expect(entry!.hooks[0]).toMatchObject({ type: 'command', timeout: 85 })
      const command = entry!.hooks[0]!.command
      expect(command).toContain(`/bin/quirky-gate" codex 60000 ${event}`)
      expect(command).toContain('QUIRKY_HOME')
      expect(command).toContain('QUIRKY_SESSION_ID')
      const result = runShell(command, { QUIRKY_HOME: env.home, QUIRKY_SESSION_ID: 's-1' })
      expect(result.exitCode).toBe(0)
      expect(result.stdout.toString()).toBe(`codex\n60000\n${event}\n${env.home}\ns-1\n`)
    }
    expect(codexHooksPath(env)).toBe(join(env.home, '.codex', 'hooks.json'))
  })

  test('install is idempotent and a second run leaves the file untouched', () => {
    const env = agentEnv()
    installCodexHooks(env, 55)
    const before = read(env)
    const mtime = statSync(codexHooksPath(env)).mtimeMs
    expect(installCodexHooks(env, 55)).toBe(false)
    expect(read(env)).toBe(before)
    expect(statSync(codexHooksPath(env)).mtimeMs).toBe(mtime)
  })

  test('a changed timeout replaces one event-specific avatar entry per event', () => {
    const env = agentEnv()
    installCodexHooks(env, 55)
    expect(installCodexHooks(env, 30)).toBe(true)
    for (const event of GATE_EVENTS) {
      expect(gateEntries(env, event)).toHaveLength(1)
      const hook = gateEntries(env, event)[0]!.hooks[0]!
      expect(hook.timeout).toBe(60)
      expect(hook.command).toContain(`/bin/quirky-gate" codex 35000 ${event}`)
    }
  })

  test('follows CODEX_HOME when it is absolute', () => {
    const codexHome = scratch()
    const env = agentEnv({ CODEX_HOME: codexHome })
    expect(codexHooksPath(env)).toBe(join(codexHome, 'hooks.json'))
    expect(codexHooksPath({ home: env.home, env: { CODEX_HOME: 'relative' } })).toBe(join(env.home, '.codex', 'hooks.json'))
  })

  test('other entries stay byte-for-byte as they were through install and remove', () => {
    const env = agentEnv()
    const path = codexHooksPath(env)
    mkdirSync(join(env.home, '.codex'))
    const user = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo   "mine"', timeout: 5 }] }
    const original = `${JSON.stringify({ model: 'x', hooks: { PreToolUse: [user], Stop: [{ hooks: [{ type: 'command', command: 'true' }] }] } }, null, 2)}\n`
    writeFileSync(path, original)
    installCodexHooks(env, 55)
    const installed = JSON.parse(read(env))
    expect(installed.model).toBe('x')
    expect(JSON.stringify(installed.hooks.PreToolUse[0])).toBe(JSON.stringify(user))
    expect(installed.hooks.Stop).toEqual(JSON.parse(original).hooks.Stop)
    expect(removeCodexHooks(env)).toBe(true)
    expect(read(env)).toBe(original)
  })

  describe('surgical edits keep every other byte of hooks.json', () => {
    const seed = (original: string): AgentEnv => {
      const env = agentEnv()
      mkdirSync(join(env.home, '.codex'))
      writeFileSync(codexHooksPath(env), original)
      return env
    }
    const other = '{"type":"command","command":"echo   hi"}'

    test('a tab-indented file with compact inline hooks only gains the avatar entries', () => {
      const original = `{\n\t"hooks": {"Stop": [ { "hooks": [${other}] } ] },\n\t"model":   "x"\n}\n`
      const env = seed(original)
      expect(installCodexHooks(env, 55)).toBe(true)
      const installed = read(env)
      expect(installed).toContain(`"Stop": [ { "hooks": [${other}] } ]`)
      expect(installed).toContain(`{"Stop": [ { "hooks": [${other}] } ],"PreToolUse": [`)
      expect(installed.startsWith('{\n\t"hooks": {"Stop": [ { "hooks": [')).toBe(true)
      expect(installed.endsWith(`,\n\t"model":   "x"\n}\n`)).toBe(true)
      expect(codexHooksInstalled(env)).toBe(true)
      expect(installCodexHooks(env, 55)).toBe(false)
      expect(removeCodexHooks(env)).toBe(true)
      expect(read(env)).toBe(original)
    })

    test('a fully compact single-line file keeps its text through install and remove', () => {
      const original = `{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[${other}]}],"Stop":[]},"x":1}`
      const env = seed(original)
      installCodexHooks(env, 55)
      const installed = read(env)
      expect(installed).not.toContain('\n')
      expect(installed).toContain(`{"matcher":"Bash","hooks":[${other}]}`)
      expect(installed).toContain('],"Stop":[],"PermissionRequest":[')
      expect(installed.endsWith('}]}]},"x":1}')).toBe(true)
      expect(removeCodexHooks(env)).toBe(true)
      expect(read(env)).toBe(original)
    })

    test('other agents entries under the same events are untouched when the avatar entry is updated', () => {
      const env = seed(`{\n\t"hooks": {\n\t\t"PreToolUse": [\n\t\t\t${other.replace('echo   hi', 'a  b')}\n\t\t]\n\t}\n}\n`)
      installCodexHooks(env, 55)
      const withGate = read(env)
      installCodexHooks(env, 30)
      const updated = read(env)
      expect(updated).toContain(`\t\t\t${other.replace('echo   hi', 'a  b')},\n`)
      expect(updated.split('\n\t\t\t').length).toBe(withGate.split('\n\t\t\t').length)
      expect(JSON.parse(updated).hooks.PreToolUse).toHaveLength(2)
      expect(JSON.parse(updated).hooks.PreToolUse[1].hooks[0].command).toContain('codex 35000 PreToolUse')
      removeCodexHooks(env)
      expect(read(env)).toBe(`{\n\t"hooks": {\n\t\t"PreToolUse": [\n\t\t\t${other.replace('echo   hi', 'a  b')}\n\t\t]\n\t}\n}\n`)
    })

    test('an object with no hooks key or an empty hooks object gains them without touching the rest', () => {
      const bare = seed('{\n    "model": "x"  ,\n    "n": [1,2]\n}')
      installCodexHooks(bare, 55)
      expect(read(bare).startsWith('{\n    "model": "x"  ,\n    "n": [1,2],\n    "hooks": {')).toBe(true)
      expect(read(bare).endsWith('\n}')).toBe(true)
      removeCodexHooks(bare)
      expect(read(bare)).toBe('{\n    "model": "x"  ,\n    "n": [1,2]\n}')
      const empty = seed('{\n  "hooks": {}\n}\n')
      installCodexHooks(empty, 55)
      expect(codexHooksInstalled(empty)).toBe(true)
      expect(read(empty).endsWith('\n}\n')).toBe(true)
    })

    test('restores the original empty JSON text after removing the avatar entries', () => {
      const env = seed('{}\n')
      installCodexHooks(env, 55)
      expect(removeCodexHooks(env)).toBe(true)
      expect(read(env)).toBe('{}\n')
    })
  })

  test('keeps a zero-byte hooks.json and leaves it as an empty object', () => {
    const env = agentEnv()
    mkdirSync(join(env.home, '.codex'))
    writeFileSync(codexHooksPath(env), '')
    installCodexHooks(env, 55)
    expect(removeCodexHooks(env)).toBe(true)
    expect(existsSync(codexHooksPath(env))).toBe(true)
    expect(JSON.parse(read(env))).toEqual({})
  })


  test('keeps a newly created hooks.json as an empty object after removal', () => {
    const env = agentEnv()
    installCodexHooks(env, 55)
    expect(removeCodexHooks(env)).toBe(true)
    expect(existsSync(codexHooksPath(env))).toBe(true)
    expect(JSON.parse(read(env))).toEqual({})
    expect(removeCodexHooks(env)).toBe(false)
    expect(codexHooksInstalled(env)).toBe(false)
  })

  test('keeps the file when other top-level keys remain after remove', () => {
    const env = agentEnv()
    mkdirSync(join(env.home, '.codex'))
    writeFileSync(codexHooksPath(env), `${JSON.stringify({ note: 'keep' }, null, 2)}\n`)
    installCodexHooks(env, 55)
    removeCodexHooks(env)
    expect(JSON.parse(read(env))).toEqual({ note: 'keep' })
  })

  test('refuses to overwrite a file it cannot parse', () => {
    const env = agentEnv()
    mkdirSync(join(env.home, '.codex'))
    writeFileSync(codexHooksPath(env), '{ not json')
    expect(() => installCodexHooks(env, 55)).toThrow()
    expect(read(env)).toBe('{ not json')
    expect(codexHooksInstalled(env)).toBe(false)
  })

  test("the status reporter's Codex install and remove leave the avatar's entries intact", () => {
    const env = agentEnv()
    const target = { home: env.home, env: env.env, quirkyHome: scratch() }
    installCodexHooks(env, 55)
    const gateBefore = gateEntries(env, 'PreToolUse')
    codexInstaller.install(target)
    const doc = JSON.parse(read(env))
    expect(doc.hooks.PreToolUse).toHaveLength(2)
    expect(gateEntries(env, 'PreToolUse')).toEqual(gateBefore)
    expect(gateEntries(env, 'PermissionRequest')).toHaveLength(1)
    codexInstaller.install(target)
    expect(gateEntries(env, 'PreToolUse')).toEqual(gateBefore)
    codexInstaller.remove(target)
    expect(codexHooksInstalled(env)).toBe(true)
    expect(JSON.parse(read(env)).hooks.PreToolUse).toEqual(gateBefore)
  })

  test("removing the avatar's entries leaves the status reporter's alone", () => {
    const env = agentEnv()
    const target = { home: env.home, env: env.env, quirkyHome: scratch() }
    codexInstaller.install(target)
    const reporterBefore = JSON.stringify(JSON.parse(read(env)).hooks.PreToolUse)
    installCodexHooks(env, 55)
    removeCodexHooks(env)
    expect(JSON.stringify(JSON.parse(read(env)).hooks.PreToolUse)).toBe(reporterBefore)
  })
})

describe('pi and omp extension file', () => {
  const withAgentDirs = (): AgentEnv => {
    const env = agentEnv()
    mkdirSync(join(env.home, '.pi', 'agent'), { recursive: true })
    mkdirSync(join(env.home, '.omp', 'agent'), { recursive: true })
    return env
  }

  test('is written into the extensions dir of each agent that is installed', () => {
    const env = withAgentDirs()
    const written = installPiExtensions(env)
    expect(written.sort()).toEqual([piExtensionPath('omp', env), piExtensionPath('pi', env)].sort())
    expect(piExtensionPath('pi', env)).toBe(join(env.home, '.pi', 'agent', 'extensions', GATE_EXTENSION_FILE))
    expect(readFileSync(piExtensionPath('omp', env), 'utf8')).toBe(gateExtensionSource())
  })

  test('installs only the selected pi extension when asked for pi alone', () => {
    const env = withAgentDirs()
    expect(installPiExtensions(env, ['pi'])).toEqual([piExtensionPath('pi', env)])
    expect(existsSync(piExtensionPath('pi', env))).toBe(true)
    expect(existsSync(piExtensionPath('omp', env))).toBe(false)
  })

  test('skips an agent whose directory does not exist', () => {
    const env = agentEnv()
    mkdirSync(join(env.home, '.pi', 'agent'), { recursive: true })
    expect(installPiExtensions(env)).toEqual([piExtensionPath('pi', env)])
    expect(existsSync(join(env.home, '.omp'))).toBe(false)
  })

  test('shares one file when PI_CODING_AGENT_DIR is set', () => {
    const dir = scratch()
    const env = agentEnv({ PI_CODING_AGENT_DIR: dir })
    expect(installPiExtensions(env)).toEqual([join(dir, 'extensions', GATE_EXTENSION_FILE)])
  })

  test('a current file keeps its modification time, because the gate check compares it with the session start', () => {
    const env = withAgentDirs()
    installPiExtensions(env)
    const path = piExtensionPath('pi', env)
    utimesSync(path, new Date(1_000_000), new Date(1_000_000))
    expect(installPiExtensions(env)).toEqual([])
    expect(statSync(path).mtimeMs).toBe(1_000_000)
  })

  test('a stale avatar file is replaced and a file the avatar did not write is left alone', () => {
    const env = withAgentDirs()
    installPiExtensions(env)
    const pi = piExtensionPath('pi', env)
    writeFileSync(pi, `// ${'Managed by Quirky\'s avatar. Do not edit; changes may be overwritten.'}\nold`)
    const omp = piExtensionPath('omp', env)
    writeFileSync(omp, 'export default function () {}\n')
    expect(installPiExtensions(env)).toEqual([pi])
    expect(readFileSync(pi, 'utf8')).toBe(gateExtensionSource())
    expect(readFileSync(omp, 'utf8')).toBe('export default function () {}\n')
  })

  test('removes only the avatar extension and leaves the user extension untouched', () => {
    const env = withAgentDirs()
    const pi = piExtensionPath('pi', env)
    const omp = piExtensionPath('omp', env)
    const userContent = 'export default function userExtension() {}\n'
    mkdirSync(join(env.home, '.pi', 'agent', 'extensions'))
    mkdirSync(join(env.home, '.omp', 'agent', 'extensions'))
    writeFileSync(pi, gateExtensionSource())
    writeFileSync(omp, userContent)
    expect(removePiExtensions(env)).toEqual([pi])
    expect(existsSync(pi)).toBe(false)
    expect(readFileSync(omp, 'utf8')).toBe(userContent)
    expect(removePiExtensions(env)).toEqual([])
  })

  test('removes one shared extension path only once', () => {
    const dir = scratch()
    const env = agentEnv({ PI_CODING_AGENT_DIR: dir })
    const path = piExtensionPath('pi', env)
    mkdirSync(join(dir, 'extensions'), { recursive: true })
    writeFileSync(path, gateExtensionSource())
    expect(removePiExtensions(env)).toEqual([path])
  })
})

describe('the generated pi and omp extension', () => {
  const saved = { fetch: globalThis.fetch, env: { ...process.env } }
  let counter = 0

  afterEach(() => {
    globalThis.fetch = saved.fetch
    for (const key of ['QUIRKY_SESSION_ID', 'QUIRKY_HOME', 'QUIRKY_HOOK_TOKEN', 'QUIRKY_HOOK_URL']) {
      if (saved.env[key] === undefined) delete process.env[key]
      else process.env[key] = saved.env[key]
    }
  })

  type Handler = (event: unknown, ctx: unknown) => Promise<unknown>

  async function loadHandler(options: { marker: boolean; fetch?: (url: string, init: RequestInit) => Promise<Response> }): Promise<{ handler: Handler; requests: { url: string; init: RequestInit }[] }> {
    const home = scratch()
    writeFileSync(join(home, 'runtime.json'), JSON.stringify({ port: 4321 }))
    if (options.marker) writeMarkerFile(home, 'sess-1', { worktreeId: 'wt-1', level: 'full' })
    process.env.QUIRKY_SESSION_ID = 'sess-1'
    process.env.QUIRKY_HOME = home
    process.env.QUIRKY_HOOK_TOKEN = 'tok'
    const requests: { url: string; init: RequestInit }[] = []
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      requests.push({ url, init })
      if (options.fetch === undefined) throw new Error('no network in this test')
      return options.fetch(url, init)
    }) as never
    const file = join(scratch(), `ext-${counter++}.ts`)
    writeFileSync(file, gateExtensionSource())
    const module = (await import(file)) as { default: (pi: { on(name: string, handler: Handler): void }) => void }
    let handler: Handler | undefined
    module.default({ on: (name, fn) => void (name === 'tool_call' && (handler = fn)) })
    if (handler === undefined) throw new Error('the extension registered no tool_call handler')
    return { handler, requests }
  }

  const reply = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status })
  const call = { toolName: 'bash', input: { command: 'ls' } }

  test('does nothing for a session with no marker, and makes no request', async () => {
    const { handler, requests } = await loadHandler({ marker: false })
    expect(await handler(call, { cwd: '/w' })).toBeUndefined()
    expect(requests).toEqual([])
  })

  test('asks /gate/<agent> with the session, the deadline and the token, and passes the call on allow', async () => {
    const { handler, requests } = await loadHandler({ marker: true, fetch: reply({ decision: 'allow', reason: 'ok', encoded: '' }) })
    expect(await handler(call, { cwd: '/w' })).toBeUndefined()
    expect(requests).toHaveLength(1)
    expect(requests[0]!.url).toBe('http://127.0.0.1:4321/gate/pi?session=sess-1&event=tool_call&deadline=25000')
    expect((requests[0]!.init.headers as Record<string, string>)['x-quirky-hook-token']).toBe('tok')
    expect(JSON.parse(String(requests[0]!.init.body))).toEqual({ hook_event_name: 'tool_call', tool_name: 'bash', tool_input: { command: 'ls' }, cwd: '/w' })
  })

  test('passes the call on passthrough', async () => {
    const { handler } = await loadHandler({ marker: true, fetch: reply({ decision: 'passthrough', reason: '', encoded: '' }) })
    expect(await handler(call, {})).toBeUndefined()
  })

  test('blocks with the gate reason on deny', async () => {
    const encoded = JSON.stringify({ block: true, reason: 'held for you' })
    const { handler } = await loadHandler({ marker: true, fetch: reply({ decision: 'deny', reason: 'held for you', encoded }) })
    expect(await handler(call, {})).toEqual({ block: true, reason: 'held for you' })
  })

  test('blocks on a deny whose encoded text is missing', async () => {
    const { handler } = await loadHandler({ marker: true, fetch: reply({ decision: 'deny', reason: 'no', encoded: null }) })
    expect(await handler(call, {})).toEqual({ block: true, reason: 'no' })
  })

  test('blocks when the daemon says unavailable, answers an error status or returns a bad body', async () => {
    for (const fetch of [reply({ decision: 'unavailable', reason: 'no provider', encoded: null }), reply({}, 500), async () => new Response('not json')]) {
      const { handler } = await loadHandler({ marker: true, fetch })
      expect(await handler(call, {})).toMatchObject({ block: true })
    }
  })

  test('blocks when the request fails', async () => {
    const { handler } = await loadHandler({ marker: true })
    expect(await handler(call, {})).toEqual({ block: true, reason: "Quirky's avatar gate is unavailable; try again shortly." })
  })

  test('blocks when the request never answers within the deadline', async () => {
    jest.useFakeTimers()
    try {
      const { handler } = await loadHandler({
        marker: true,
        fetch: (_url, init) => new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))))
      })
      const pending = handler(call, {})
      await Promise.resolve()
      ;(jest as unknown as { advanceTimersByTime(ms: number): void }).advanceTimersByTime(27_001)
      expect(await pending).toMatchObject({ block: true })
    } finally {
      jest.useRealTimers()
    }
  })
})
