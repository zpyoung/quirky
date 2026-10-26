import { statSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentEntry } from './core/types'

export type SearchDirs = { dirs: string[]; loginDirs: Set<string> }

export type Detection = {
  /** Whether the agent's detect command (or an alias) and every required command were found. */
  installed(id: string): boolean
  /** The first search directory holding an executable regular file called `command`. */
  locate(command: string): { path: string; onLoginPath: boolean } | null
  /**
   * The absolute path of `name` when it was found only outside the login PATH and the quirky bin
   * directory, where the launch shell would not look; null otherwise.
   */
  resolveExecutable(name: string): string | null
}

const INSTALL_DIRS = ['.local/bin', '.bun/bin', '.npm-global/bin', '.cargo/bin', '.deno/bin']
const SYSTEM_INSTALL_DIRS = ['/opt/homebrew/bin', '/usr/local/bin']

const splitPath = (path: string) => path.split(':').filter((entry) => entry !== '')

/**
 * Asks the user's login shell for its PATH, because the daemon's own PATH is usually the narrow
 * one it was started with. Null on a failed, empty or timed-out answer; a hung shell is killed.
 */
export async function readLoginPath(shell: string, timeoutMs = 5000): Promise<string | null> {
  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn([shell, '-l', '-c', 'printf %s "$PATH"'], { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' })
  } catch {
    return null
  }
  const output = new Response(proc.stdout as ReadableStream).text().catch(() => '')
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs)
  })
  try {
    const outcome = await Promise.race([proc.exited, timedOut])
    if (outcome === 'timeout') {
      proc.kill('SIGKILL')
      return null
    }
    if (outcome !== 0) return null
    return (await output).trim() || null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The directories detection walks, in lookup order: the login PATH (or the fallback), the quirky
 * bin directory, then well-known install directories. `override`, the value of
 * `QUIRKY_AGENT_SEARCH_DIRS`, replaces the install directories. `loginDirs` are the ones the
 * launch shell finds commands in by itself.
 */
export function searchDirs(input: {
  loginPath: string | null
  fallbackPath: string
  quirkyBin: string
  home: string
  override?: string
}): SearchDirs {
  const login = splitPath(input.loginPath ?? input.fallbackPath)
  const installs =
    typeof input.override === 'string'
      ? splitPath(input.override)
      : [...INSTALL_DIRS.map((dir) => join(input.home, dir)), ...SYSTEM_INSTALL_DIRS]
  return {
    dirs: [...new Set([...login, input.quirkyBin, ...installs].filter((entry) => entry !== ''))],
    loginDirs: new Set([...login, input.quirkyBin])
  }
}

const isExecutableFile = (path: string) => {
  try {
    const stat = statSync(path)
    return stat.isFile() && (stat.mode & 0o111) !== 0
  } catch {
    return false
  }
}

/** Snapshots which agents are installed by looking for files; nothing is ever executed. */
export function detect(entries: AgentEntry[], search: SearchDirs): Detection {
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  const found = new Map<string, { path: string; onLoginPath: boolean } | null>()

  const locate = (command: string) => {
    if (found.has(command)) return found.get(command)!
    let hit: { path: string; onLoginPath: boolean } | null = null
    if (command.includes('/')) {
      if (isExecutableFile(command)) hit = { path: command, onLoginPath: true }
    } else {
      for (const dir of search.dirs) {
        const path = join(dir, command)
        if (isExecutableFile(path)) {
          hit = { path, onLoginPath: search.loginDirs.has(dir) }
          break
        }
      }
    }
    found.set(command, hit)
    return hit
  }

  return {
    locate,
    installed(id) {
      const entry = byId.get(id)
      if (!entry) return false
      return [entry.detect, ...entry.detectAliases].some((name) => locate(name)) && entry.detectRequires.every((name) => locate(name))
    },
    resolveExecutable(name) {
      const hit = locate(name)
      return hit && !hit.onLoginPath ? hit.path : null
    }
  }
}
