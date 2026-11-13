import { Database } from 'bun:sqlite'
import { afterAll, beforeAll } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { PLUGIN_API_VERSION, type PluginStore } from '@quirky/protocol'
import type { DaemonOptions } from '../../../packages/daemon/src/daemon'
import { startHarness, type Harness } from '../../../packages/daemon/test/helpers'
import type { AgentEnv } from '../src/hooks/install'
import { createAvatarStore } from '../src/store'

/** The agent home one test file runs on. */
export type TempAgentHome = {
  /** A temp directory that stands in for the user's home. */
  home: string
  /** What the plugin sees: `home`, with `CODEX_HOME` at `<home>/codex` and `PI_CODING_AGENT_DIR` at `<home>/pi`. */
  agentEnv: AgentEnv
  /** The environment for a child process that must not see the real home: `PATH`, `HOME`, `CODEX_HOME` and `PI_CODING_AGENT_DIR`. */
  childEnv: Record<string, string>
  /** `<home>/.ssh/config`, a path the gate treats as a credential. */
  sshConfig: string
}

const ENV_KEYS = ['HOME', 'CODEX_HOME', 'PI_CODING_AGENT_DIR', 'QUIRKY_HOME'] as const
const PLUGIN_DIR = resolve(import.meta.dir, '..')
const directories = new Set<string>()
const databases = new Set<Database>()
const daemons = new Map<Harness, { clientsClosed: boolean; daemonStopped: boolean; ptyStopped: boolean }>()

/**
 * Points this test file at a temp agent home. From the file's `beforeAll` to its `afterAll`, `HOME`,
 * `CODEX_HOME`, `PI_CODING_AGENT_DIR` and `QUIRKY_HOME` in `process.env` name directories under it.
 * Call it once at the top of the file.
 */
export function useTempAgentHome(): TempAgentHome {
  const home = mkdtempSync(join(tmpdir(), 'qav-agent-'))
  const codexHome = join(home, 'codex')
  const piHome = join(home, 'pi')
  const quirkyHome = join(home, 'quirky')
  mkdirSync(codexHome)
  mkdirSync(piHome)
  mkdirSync(quirkyHome)

  const previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
  const agentEnv: AgentEnv = { home, env: { CODEX_HOME: codexHome, PI_CODING_AGENT_DIR: piHome } }
  const childEnv = {
    PATH: process.env.PATH ?? '',
    HOME: home,
    CODEX_HOME: codexHome,
    PI_CODING_AGENT_DIR: piHome
  }

  beforeAll(() => {
    process.env.HOME = home
    process.env.CODEX_HOME = codexHome
    process.env.PI_CODING_AGENT_DIR = piHome
    process.env.QUIRKY_HOME = quirkyHome
  })
  afterAll(() => {
    for (const key of ENV_KEYS) {
      const value = previousEnv[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(home, { recursive: true, force: true })
  })

  return { home, agentEnv, childEnv, sshConfig: join(home, '.ssh', 'config') }
}

/** Why `env` would let a test daemon reach the real agent configs, or null when it can't. */
export function agentHomeProblem(env: Record<string, string | undefined>, realHome: string): string | null {
  const home = env.HOME
  if (home === undefined || home === '') return 'HOME is not set'
  const resolvedHome = resolve(home)
  if (resolvedHome === resolve(realHome)) return 'HOME is the real home'

  for (const key of ['CODEX_HOME', 'PI_CODING_AGENT_DIR', 'QUIRKY_HOME'] as const) {
    const path = env[key]
    if (path === undefined || path === '') return `${key} is not under HOME`
    const resolvedPath = resolve(path)
    const homePrefix = resolvedHome.endsWith(sep) ? resolvedHome : `${resolvedHome}${sep}`
    if (resolvedPath !== resolvedHome && !resolvedPath.startsWith(homePrefix)) return `${key} is not under HOME`
  }
  return null
}

/** A stand-in built-in plugin: the methods and events it declares, and its `main.ts` source. */
export type StandIn = { methods: string[]; events?: string[]; source: string }

/** A stand-in whose methods answer fixed JSON values. */
export function answering(plugin: string, answers: Record<string, unknown>): StandIn {
  const methods = Object.keys(answers)
  const providers = Object.entries(answers).map(([method, answer]) => {
    const methodId = JSON.stringify(`method:${plugin}/${method}`)
    const sourceValue = JSON.stringify(answer) ?? 'undefined'
    return `  context.provide(${methodId}, () => (${sourceValue}))`
  })
  return { methods, source: `export function activate(context) {\n${providers.join('\n')}\n}\n` }
}

function writeStandIn(root: string, id: string, stub: StandIn): void {
  const directory = join(root, id)
  mkdirSync(directory, { recursive: true })
  const loose = { type: 'object', additionalProperties: true }
  const manifest = {
    id,
    apiVersion: PLUGIN_API_VERSION,
    name: id,
    version: '0.1.0',
    activation: 'lazy',
    main: 'main.ts',
    contributes: {
      method: stub.methods.map((method) => ({ id: method, params: loose })),
      ...(stub.events === undefined ? {} : { event: stub.events.map((event) => ({ id: event, data: loose })) })
    }
  }
  writeFileSync(join(directory, 'quirky-plugin.json'), JSON.stringify(manifest))
  writeFileSync(join(directory, 'main.ts'), stub.source)
}

function writeEmptyStandIn(root: string, id: string): void {
  const directory = join(root, id)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'quirky-plugin.json'), JSON.stringify({
    id,
    apiVersion: PLUGIN_API_VERSION,
    name: id,
    version: '0.1.0',
    activation: 'lazy'
  }))
}

/**
 * A built-ins directory holding the real avatar and one plugin for each of its dependencies: the
 * stand-in given for it, or an empty plugin. Stand-ins for other ids are written too.
 */
export function avatarBuiltins(standIns: Record<string, StandIn> = {}): string {
  if ('quirky.avatar' in standIns) throw new Error('avatarBuiltins always links the real quirky.avatar plugin')

  const directory = mkdtempSync(join(tmpdir(), 'qav-avatar-builtins-'))
  directories.add(directory)
  try {
    symlinkSync(PLUGIN_DIR, join(directory, 'quirky.avatar'))
    const avatarManifest = JSON.parse(readFileSync(join(PLUGIN_DIR, 'quirky-plugin.json'), 'utf8')) as { dependencies: string[] }
    const ids = new Set([...avatarManifest.dependencies, ...Object.keys(standIns)])
    for (const id of ids) {
      const standIn = standIns[id]
      if (standIn === undefined) writeEmptyStandIn(directory, id)
      else writeStandIn(directory, id, standIn)
    }
  } catch (error) {
    rmSync(directory, { recursive: true, force: true })
    directories.delete(directory)
    throw error
  }
  return directory
}

async function stopHarness(harness: Harness, state: { clientsClosed: boolean; daemonStopped: boolean; ptyStopped: boolean }): Promise<void> {
  const errors: unknown[] = []
  if (!state.clientsClosed) {
    let clientsClosed = true
    for (const client of harness.clients) {
      try {
        await client.close()
      } catch (error) {
        clientsClosed = false
        errors.push(error)
      }
    }
    state.clientsClosed = clientsClosed
  }
  if (!state.daemonStopped) {
    try {
      await harness.daemon.stop()
      state.daemonStopped = true
    } catch (error) {
      errors.push(error)
    }
  }
  if (!state.ptyStopped) {
    try {
      harness.pty.stop()
      state.ptyStopped = true
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'could not fully stop avatar test daemon')
}

/** Starts a daemon on `builtins`. Throws before anything starts unless `useTempAgentHome()` is in effect. */
export async function startAvatarHarness(builtins: string, options: Partial<DaemonOptions> = {}): Promise<Harness> {
  const problem = agentHomeProblem(process.env, homedir())
  if (problem !== null) {
    throw new Error(`avatar test daemon refused: ${problem}; call useTempAgentHome() at the top of the test file`)
  }
  const harness = await startHarness({ ...options, builtinPluginsDir: builtins })
  daemons.set(harness, { clientsClosed: false, daemonStopped: false, ptyStopped: false })
  return harness
}

/** Stops a daemon and its PTY host and leaves its home in place, so a second daemon can start on it. */
export async function stopKeepingHome(harness: Harness): Promise<void> {
  let state = daemons.get(harness)
  if (state === undefined) {
    state = { clientsClosed: false, daemonStopped: false, ptyStopped: false }
    daemons.set(harness, state)
  }
  await stopHarness(harness, state)
}

/** The avatar's store file under `quirkyHome`, opened for seeding and checking. */
export function openAvatarStore(quirkyHome: string): ReturnType<typeof createAvatarStore> {
  const path = join(quirkyHome, 'plugin-data', 'quirky.avatar', 'store.db')
  mkdirSync(dirname(path), { recursive: true })
  const database = new Database(path)
  databases.add(database)
  const store: PluginStore = {
    version: 0,
    run(sql, ...params) {
      const result = database.query(sql).run(...(params as never[]))
      return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) }
    },
    get(sql, ...params) {
      return (database.query(sql).get(...(params as never[])) as never) ?? null
    },
    all(sql, ...params) {
      return database.query(sql).all(...(params as never[])) as never
    },
    exec(sql) {
      database.exec(sql)
    },
    transaction(work) {
      return database.transaction(work)()
    }
  }
  return createAvatarStore(store)
}

/** Runs `<quirkyHome>/bin/quirky-gate` with `args`, `payload` as JSON on stdin and exactly `env`. */
export async function runGateShim(
  quirkyHome: string,
  args: string[],
  env: Record<string, string>,
  payload: unknown
): Promise<{ stdout: string; stderr: string; code: number }> {
  const process = Bun.spawn(['sh', join(quirkyHome, 'bin', 'quirky-gate'), ...args], {
    env,
    stdin: Buffer.from(JSON.stringify(payload) as string),
    stdout: 'pipe',
    stderr: 'pipe'
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited
  ])
  return { stdout, stderr, code }
}

/** Stops every daemon this module started, closes every store it opened and removes every directory it made. Call from `afterEach`. */
export async function cleanupDaemons(): Promise<void> {
  const errors: unknown[] = []
  for (const database of databases) {
    try {
      database.close()
    } catch (error) {
      errors.push(error)
    }
  }
  databases.clear()

  const homes = new Set<string>()
  for (const [harness, state] of daemons) {
    homes.add(harness.home)
    try {
      await stopHarness(harness, state)
    } catch (error) {
      errors.push(error)
    }
  }
  daemons.clear()

  for (const directory of directories) {
    try {
      rmSync(directory, { recursive: true, force: true })
    } catch (error) {
      errors.push(error)
    }
  }
  directories.clear()
  for (const home of homes) {
    try {
      rmSync(home, { recursive: true, force: true })
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'could not fully clean avatar test daemons')
}
