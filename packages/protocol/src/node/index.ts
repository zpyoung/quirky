/**
 * Bun-only helpers for locating, starting and connecting to quirkyd. The UI must not import this
 * module; it reaches the daemon through the URL the desktop shell gives it.
 */
import { spawn } from 'node:child_process'
import {
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { QuirkyClient } from '../client'
import { RPC_PATH, type ClientRole } from '../rpc'

/** Written by quirkyd at startup (mode 0600) and removed on clean exit. */
export type RuntimeInfo = {
  pid: number
  port: number
  /** Authenticates RPC clients: `ws://127.0.0.1:<port>/rpc?token=<token>`. */
  token: string
  /** Authenticates agent hook POSTs; given to sessions in their env, never to RPC clients. */
  hookToken: string
  daemonVersion: string
  protocolVersion: number
  startedAt: number
}

export const HEALTH_PATH = '/health'

export function quirkyHome(): string {
  return process.env.QUIRKY_HOME ?? join(homedir(), '.quirky')
}

/**
 * Creates the Quirky home (0700) if needed and returns it. An existing home owned by the current
 * user is tightened to 0700 because it holds credentials; one owned by anyone else is refused.
 */
export function ensureHome(home = quirkyHome()): string {
  mkdirSync(home, { recursive: true, mode: 0o700 })
  const stats = statSync(home)
  if (process.getuid && stats.uid !== process.getuid()) {
    throw new Error(`${home} is not owned by the current user; set QUIRKY_HOME to a directory you own`)
  }
  if ((stats.mode & 0o777) !== 0o700) chmodSync(home, 0o700)
  return home
}

/**
 * Opens `path` for appending as a private log: the file is 0600 and its directory 0700, including
 * when either already existed with looser permissions. Returns the file descriptor.
 */
export function openPrivateLog(path: string): number {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  const fd = openSync(path, 'a', 0o600)
  fchmodSync(fd, 0o600)
  return fd
}

export function runtimeFilePath(home = quirkyHome()): string {
  return join(home, 'runtime.json')
}

export function readRuntime(home = quirkyHome()): RuntimeInfo | null {
  try {
    return JSON.parse(readFileSync(runtimeFilePath(home), 'utf8')) as RuntimeInfo
  } catch {
    return null
  }
}

/** Atomic write so a reader never sees a half-written file. */
export function writePrivateJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 })
  chmodSync(temp, 0o600)
  renameSync(temp, path)
}

export function rpcUrl(info: RuntimeInfo): string {
  return `ws://127.0.0.1:${info.port}${RPC_PATH}?token=${encodeURIComponent(info.token)}`
}

/** True when the daemon described by `info` answers its health check. */
export async function isDaemonAlive(info: RuntimeInfo | null, timeoutMs = 1500): Promise<boolean> {
  if (!info) return false
  try {
    const response = await fetch(`http://127.0.0.1:${info.port}${HEALTH_PATH}`, {
      signal: AbortSignal.timeout(timeoutMs)
    })
    if (!response.ok) return false
    const body = (await response.json()) as { pid?: number }
    return body.pid === info.pid
  } catch {
    return false
  }
}

export function defaultDaemonEntry(): string {
  return (
    process.env.QUIRKY_DAEMON_ENTRY ??
    fileURLToPath(new URL('../../../daemon/src/main.ts', import.meta.url))
  )
}

/**
 * Returns the running daemon's runtime info, starting a detached daemon first if none answers.
 * The daemon outlives its starter. Its output goes to `<home>/logs/daemon.log`.
 */
export async function ensureDaemon(
  options: { home?: string; daemonEntry?: string; bunPath?: string; timeoutMs?: number } = {}
): Promise<RuntimeInfo> {
  const home = ensureHome(options.home ?? quirkyHome())
  const existing = readRuntime(home)
  if (await isDaemonAlive(existing)) return existing as RuntimeInfo

  const entry = options.daemonEntry ?? defaultDaemonEntry()
  if (!existsSync(entry)) throw new Error(`quirkyd entry not found: ${entry}`)
  const log = openPrivateLog(join(home, 'logs', 'daemon.log'))
  const child = spawn(options.bunPath ?? process.execPath, [entry], {
    detached: true,
    stdio: ['ignore', log, log],
    env: { ...process.env, QUIRKY_HOME: home }
  })
  child.unref()
  closeSync(log)

  const deadline = Date.now() + (options.timeoutMs ?? 15000)
  while (Date.now() < deadline) {
    const info = readRuntime(home)
    if (info && info.pid !== existing?.pid && (await isDaemonAlive(info))) return info
    await Bun.sleep(100)
  }
  throw new Error(`quirkyd did not start within ${options.timeoutMs ?? 15000}ms; see ${join(home, 'logs', 'daemon.log')}`)
}

export async function connectDaemon(
  options: { role: ClientRole; name?: string; subscribe?: boolean; home?: string; autostart?: boolean }
): Promise<QuirkyClient> {
  const home = options.home ?? quirkyHome()
  let info = readRuntime(home)
  if (!(await isDaemonAlive(info))) {
    if (options.autostart === false) throw new Error('quirkyd is not running')
    info = await ensureDaemon({ home })
  }
  return QuirkyClient.connect(rpcUrl(info as RuntimeInfo), options)
}
