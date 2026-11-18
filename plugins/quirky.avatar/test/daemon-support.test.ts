import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import {
  agentHomeProblem,
  answering,
  avatarBuiltins,
  cleanupDaemons,
  openAvatarStore,
  runGateShim,
  startAvatarHarness,
  stopKeepingHome,
  useTempAgentHome
} from './daemon-support'
import { codexHooksPath, isRealHomeInTest, piExtensionPath, processAgentEnv } from '../src/hooks/install'

const ENV_KEYS = ['HOME', 'CODEX_HOME', 'PI_CODING_AGENT_DIR', 'QUIRKY_HOME'] as const
const previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))

const agent = useTempAgentHome()
afterAll(() => {
  for (const key of ENV_KEYS) expect(process.env[key]).toBe(previousEnv[key])
  expect(existsSync(agent.home)).toBe(false)
})
const PLUGIN_DIR = resolve(import.meta.dir, '..')

afterEach(cleanupDaemons)

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return filesUnder(path)
    return entry.isFile() && /\.tsx?$/.test(entry.name) ? [path] : []
  })
}

describe('daemon test support', () => {
  test('points this file at an existing temp agent home', () => {
    expect(process.env.HOME).toBe(agent.home)
    expect(process.env.CODEX_HOME).toBe(join(agent.home, 'codex'))
    expect(process.env.PI_CODING_AGENT_DIR).toBe(join(agent.home, 'pi'))
    expect(process.env.QUIRKY_HOME).toBe(join(agent.home, 'quirky'))
    expect(existsSync(agent.home)).toBe(true)
    expect(agent.home).not.toBe(homedir())
  })

  test('makes the plugin resolve agent paths under the temp home', () => {
    const env = processAgentEnv()
    expect(env.home).toBe(agent.home)
    expect(isRealHomeInTest(env)).toBe(false)
    expect(codexHooksPath(env)).toBe(join(agent.home, 'codex', 'hooks.json'))
    expect(piExtensionPath('omp', env)).toStartWith(join(agent.home, 'pi'))
  })

  test('returns the plugin, child-process, and SSH environments', () => {
    expect(agent.agentEnv).toEqual({
      home: agent.home,
      env: {
        CODEX_HOME: join(agent.home, 'codex'),
        PI_CODING_AGENT_DIR: join(agent.home, 'pi')
      }
    })
    expect(agent.childEnv).toEqual({
      PATH: process.env.PATH ?? '',
      HOME: agent.home,
      CODEX_HOME: join(agent.home, 'codex'),
      PI_CODING_AGENT_DIR: join(agent.home, 'pi')
    })
    expect(Object.keys(agent.childEnv).sort()).toEqual(['CODEX_HOME', 'HOME', 'PATH', 'PI_CODING_AGENT_DIR'])
    expect(agent.sshConfig).toBe(join(agent.home, '.ssh', 'config'))
  })

  test('reports every unsafe agent home in precedence order', () => {
    const good = {
      HOME: '/tmp/a',
      CODEX_HOME: '/tmp/a/codex',
      PI_CODING_AGENT_DIR: '/tmp/a/pi',
      QUIRKY_HOME: '/tmp/a/quirky'
    }
    expect(agentHomeProblem(good, '/Users/me')).toBeNull()
    expect(agentHomeProblem({ ...good, HOME: '/tmp/a/.' }, '/Users/me')).toBeNull()
    expect(agentHomeProblem({ ...good, HOME: undefined }, '/Users/me')).toBe('HOME is not set')
    expect(agentHomeProblem({ ...good, HOME: '' }, '/Users/me')).toBe('HOME is not set')
    expect(agentHomeProblem({ ...good, HOME: '/Users/me' }, '/Users/me')).toBe('HOME is the real home')
    expect(agentHomeProblem({ ...good, HOME: '/Users/me/' }, '/Users/me')).toBe('HOME is the real home')
    expect(agentHomeProblem({ ...good, CODEX_HOME: undefined }, '/Users/me')).toBe('CODEX_HOME is not under HOME')
    expect(agentHomeProblem({ ...good, CODEX_HOME: '/Users/me/.codex' }, '/Users/me')).toBe('CODEX_HOME is not under HOME')
    expect(agentHomeProblem({ ...good, CODEX_HOME: '/tmp/ab/codex' }, '/Users/me')).toBe('CODEX_HOME is not under HOME')
    expect(agentHomeProblem({ ...good, PI_CODING_AGENT_DIR: undefined }, '/Users/me')).toBe('PI_CODING_AGENT_DIR is not under HOME')
    expect(agentHomeProblem({ ...good, PI_CODING_AGENT_DIR: '/tmp/ab/pi' }, '/Users/me')).toBe('PI_CODING_AGENT_DIR is not under HOME')
    expect(agentHomeProblem({ ...good, QUIRKY_HOME: undefined }, '/Users/me')).toBe('QUIRKY_HOME is not under HOME')
    expect(agentHomeProblem({ ...good, QUIRKY_HOME: '/tmp/ab/quirky' }, '/Users/me')).toBe('QUIRKY_HOME is not under HOME')
    expect(agentHomeProblem({ HOME: '/Users/me', CODEX_HOME: '/elsewhere' }, '/Users/me')).toBe('HOME is the real home')
    expect(agentHomeProblem({ HOME: '/tmp/a', PI_CODING_AGENT_DIR: '/elsewhere', QUIRKY_HOME: '/elsewhere' }, '/Users/me')).toBe('CODEX_HOME is not under HOME')
    expect(agentHomeProblem({ ...good, PI_CODING_AGENT_DIR: '/elsewhere', QUIRKY_HOME: '/elsewhere' }, '/Users/me')).toBe('PI_CODING_AGENT_DIR is not under HOME')
  })

  test('refuses to start before the daemon when any home is unsafe', async () => {
    const previousQuirkyHome = process.env.QUIRKY_HOME
    delete process.env.QUIRKY_HOME
    try {
      await expect(startAvatarHarness(join(agent.home, 'missing-builtins'))).rejects.toThrow(
        'avatar test daemon refused: QUIRKY_HOME is not under HOME; call useTempAgentHome() at the top of the test file'
      )
    } finally {
      if (previousQuirkyHome === undefined) delete process.env.QUIRKY_HOME
      else process.env.QUIRKY_HOME = previousQuirkyHome
    }
  })

  test('starts the real avatar and cleanup removes its home and built-ins', async () => {
    const builtins = avatarBuiltins()
    const harness = await startAvatarHarness(builtins)
    const client = await harness.connect('cli')
    const plugins = await client.call('plugin.list', {}) as { id: string; state: string }[]
    expect(plugins.find((plugin) => plugin.id === 'quirky.avatar')?.state).toBe('active')

    const store = openAvatarStore(harness.home)
    expect(store.mandates.get('missing-worktree')).toBeNull()
    await cleanupDaemons()
    expect(existsSync(harness.home)).toBe(false)
    expect(existsSync(builtins)).toBe(false)
    expect(() => store.mandates.get('missing-worktree')).toThrow()
  })

  test('writes all dependency stand-ins and serves answers from custom stand-ins', async () => {
    const answers = { list: [{ id: 'wt-1' }] }
    const builtins = avatarBuiltins({
      'quirky.worktree': answering('quirky.worktree', answers),
      'quirky.repo': answering('quirky.repo', { list: [] })
    })
    expect(realpathSync(join(builtins, 'quirky.avatar'))).toBe(PLUGIN_DIR)

    const manifest = JSON.parse(readFileSync(join(PLUGIN_DIR, 'quirky-plugin.json'), 'utf8')) as { dependencies: string[] }
    for (const id of manifest.dependencies) {
      const plugin = join(builtins, id)
      expect(existsSync(join(plugin, 'quirky-plugin.json'))).toBe(true)
      expect(existsSync(join(plugin, 'main.ts'))).toBe(id === 'quirky.worktree')
    }
    expect(existsSync(join(builtins, 'quirky.repo', 'main.ts'))).toBe(true)

    const harness = await startAvatarHarness(builtins)
    const client = await harness.connect('cli')
    await expect(client.callAny('quirky.worktree/list', {})).resolves.toEqual(answers.list)
  })

  test('stops a daemon without removing its home so it can be restarted there', async () => {
    const builtins = avatarBuiltins()
    const first = await startAvatarHarness(builtins)
    await stopKeepingHome(first)
    expect(existsSync(first.home)).toBe(true)

    const second = await startAvatarHarness(builtins, { home: first.home })
    const client = await second.connect('cli')
    const plugins = await client.call('plugin.list', {}) as { id: string; state: string }[]
    expect(plugins.find((plugin) => plugin.id === 'quirky.avatar')?.state).toBe('active')
  })

  test('runs the gate shim with only its supplied environment and JSON input', async () => {
    const quirkyHome = join(agent.home, 'shim-home')
    const shim = join(quirkyHome, 'bin', 'quirky-gate')
    mkdirSync(join(quirkyHome, 'bin'), { recursive: true })
    writeFileSync(shim, '#!/bin/sh\nprintf "%s\\n%s\\n%s\\n%s\\n%s\\n" "$1" "$2" "$HOME" "${NODE_ENV-unset}" "$SHIM_SENTINEL"\ncat\n')
    chmodSync(shim, 0o755)
    const payload = { hook_event_name: 'PreToolUse', tool_name: 'Read' }
    const result = await runGateShim(quirkyHome, ['claude', '5000'], {
      PATH: process.env.PATH ?? '',
      HOME: agent.home,
      CODEX_HOME: join(agent.home, 'codex'),
      PI_CODING_AGENT_DIR: join(agent.home, 'pi'),
      QUIRKY_HOME: quirkyHome,
      SHIM_SENTINEL: 'only-this-environment'
    }, payload)
    expect(result).toEqual({
      stdout: `claude\n5000\n${agent.home}\nunset\nonly-this-environment\n${JSON.stringify(payload)}`,
      stderr: '',
      code: 0
    })
  })

  test('keeps all daemon-level avatar tests behind the temp-home guard', () => {
    const excluded = new Set(['daemon-support.ts', 'daemon-support.test.ts'])
    const files = filesUnder(import.meta.dir).filter((path) => !excluded.has(relative(import.meta.dir, path)))
    const problems: string[] = []
    const guarded: string[] = []

    for (const path of files) {
      const relativePath = relative(import.meta.dir, path).split('\\').join('/')
      const source = readFileSync(path, 'utf8')
      const isTestFile = /\.test\.tsx?$/.test(path)
      const isConformance = relativePath.startsWith('conformance/')
      const importsActivate = /import\s+(?:\{[^}]*\bactivate\b[^}]*\}|activate)\s+from\s+['"]\.\.\/main['"]/.test(source)
      if (source.includes('useTempAgentHome(')) guarded.push(relativePath)
      if (source.includes('startHarness(')) problems.push(`${relativePath}: contains startHarness(`)
      if (source.includes('useTempAgentHome(') && source.includes('homedir(')) {
        problems.push(`${relativePath}: combines useTempAgentHome( and homedir(`)
      }
      if ((isTestFile && (source.includes('startAvatarHarness(') || source.includes('startAvatar(') || importsActivate)) || isConformance) {
        if (!source.includes('useTempAgentHome(')) problems.push(`${relativePath}: daemon-level test lacks useTempAgentHome(`)
      }
    }

    const required = [
      'gate-route.test.ts',
      'restart.test.ts',
      'manifest.test.ts',
      'app.test.ts',
      'e2e/handoff-gate.test.ts',
      'e2e/takeback.test.ts',
      'e2e/cli.test.ts',
      'conformance/claude.test.ts',
      'conformance/codex.test.ts',
      'conformance/pi.test.ts'
    ]
    for (const path of required) {
      if (!guarded.includes(path)) problems.push(`${path}: missing from useTempAgentHome() files`)
    }
    if (problems.length > 0) throw new Error(problems.join('\n'))
  })
})
