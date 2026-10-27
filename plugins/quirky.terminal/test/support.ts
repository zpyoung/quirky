import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Session } from '@quirky/protocol'
import { startHarness, makeTempHome, type Harness } from '../../../packages/daemon/test/helpers'

export { call, code, createSession, restartDaemon, seedPtySession, testCliContext } from '../../quirky.session/test/support'

const PLUGINS_ROOT = join(import.meta.dir, '..', '..')
const FAKES_ROOT = join(import.meta.dir, 'fakes')

export type PluginSet = {
  /** Real plugins of this repository, by ID. */
  real: string[]
  /** Fake plugins under `plugins/quirky.terminal/test/fakes`, by ID. */
  fakes: string[]
}

/** The real terminal plugin over fakes of the plugins it calls, so the tests exercise no other real plugin. */
export const TERMINAL_PLUGINS: PluginSet = {
  real: ['quirky.terminal'],
  fakes: ['quirky.session', 'quirky.worktree', 'quirky.agents']
}

/** A built-in plugins directory that links the named plugins, so the daemon sees them as built-ins. */
export function makeBuiltinDir(home: string, set: PluginSet, name = 'builtin'): string {
  const dir = join(home, name)
  mkdirSync(dir, { recursive: true })
  const link = (source: string, id: string) => {
    rmSync(join(dir, id), { force: true })
    symlinkSync(join(source, id), join(dir, id))
  }
  for (const id of set.real) link(PLUGINS_ROOT, id)
  for (const id of set.fakes) link(FAKES_ROOT, id)
  return dir
}

/** Starts a daemon with the fake PTY host whose only built-ins are those of `set`. */
export async function startPluginHarness(
  set: PluginSet,
  options: { home?: string } & Parameters<typeof startHarness>[0] = {}
): Promise<Harness> {
  const home = options.home ?? makeTempHome()
  return startHarness({ ...options, home, builtinPluginsDir: makeBuiltinDir(home, set) })
}

/** Puts terminal sessions into the fake session plugin's file, as records the session plugin kept across a restart. */
export function seedSessions(home: string, ids: string[]): void {
  const dir = join(home, 'plugin-data', 'quirky.session')
  mkdirSync(dir, { recursive: true })
  const sessions: Session[] = ids.map((id, index) => ({
    id,
    kind: 'terminal',
    agent: 'shell',
    worktreeId: 'wt_main',
    cwd: '/fake/alpha',
    title: 'Shell',
    status: 'running',
    createdAt: index + 1,
    lastActivityAt: index + 1,
    exitCode: null,
    exitSignal: null,
    exitCause: null,
    restorable: false
  }))
  writeFileSync(join(dir, 'sessions.json'), JSON.stringify(sessions))
}
