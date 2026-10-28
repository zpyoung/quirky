import { closeSync, chmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

const STATE_FILENAME = 'cli-launchers.json'
const STATE_VERSION = 1

export type CliLaunchTarget = { executablePath: string; entrypointPath: string }
type LauncherTarget = CliLaunchTarget
type LauncherRecord = {
  id: string
  kind: 'command' | 'profile'
  name: string
  path: string
  profileHome: string
  target: LauncherTarget
  script: string
}
type LauncherState = { version: 1; launchers: LauncherRecord[] }

export type InstalledCommandStatus = {
  path: string
  target: string | null
  state: 'missing' | 'managed' | 'foreign'
  profileHome: string
}

export type ProfileLauncherStatus = {
  name: string
  path: string
  target: string | null
  state: 'missing' | 'managed' | 'foreign'
  profileHome: string
}

export type LauncherRemovalResult = { removed: boolean; state: 'missing' | 'foreign' }

function quoteShell(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'"
}

function absolutePath(value: string, field: string): string {
  if (!isAbsolute(value) || value.includes('\0')) throw new Error(`${field} must be an absolute path`)
  return resolve(value)
}

function launcherScript(target: LauncherTarget, profileHome: string, id: string): string {
  return [
    '#!/bin/sh',
    `# quirky-managed-launcher:v1:${id}`,
    `QUIRKY_HOME=${quoteShell(profileHome)}`,
    'export QUIRKY_HOME',
    `exec ${quoteShell(target.executablePath)} ${quoteShell(target.entrypointPath)} "$@"`,
    ''
  ].join('\n')
}

function validTarget(target: LauncherTarget): LauncherTarget {
  const executablePath = absolutePath(target.executablePath, 'executablePath')
  const entrypointPath = absolutePath(target.entrypointPath, 'entrypointPath')
  try {
    if (!statSync(executablePath).isFile()) throw new Error()
    accessSync(executablePath, constants.X_OK)
    if (!statSync(entrypointPath).isFile()) throw new Error()
  } catch {
    throw new Error('the CLI executable or entrypoint does not exist or is not executable')
  }
  return { executablePath, entrypointPath }
}

function validRecord(value: unknown): value is LauncherRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const target = record.target
  return typeof record.id === 'string' && record.id.length > 0 &&
    (record.kind === 'command' || record.kind === 'profile') && typeof record.name === 'string' &&
    typeof record.path === 'string' && isAbsolute(record.path) && typeof record.profileHome === 'string' && isAbsolute(record.profileHome) &&
    typeof record.script === 'string' && record.script.startsWith(`#!/bin/sh\n# quirky-managed-launcher:v1:${record.id}\n`) &&
    target !== null && typeof target === 'object' && !Array.isArray(target) &&
    typeof (target as Record<string, unknown>).executablePath === 'string' &&
    typeof (target as Record<string, unknown>).entrypointPath === 'string'
}

function statePath(home: string): string {
  return join(home, STATE_FILENAME)
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
}

function missingPath(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}


function readState(home: string): LauncherState {
  const path = statePath(home)
  if (!pathExists(path)) return { version: STATE_VERSION, launchers: [] }
  const info = lstatSync(path)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('CLI launcher metadata is not a regular file')
  chmodSync(path, 0o600)
  let value: unknown
  try { value = JSON.parse(readFileSync(path, 'utf8')) as unknown } catch { throw new Error('CLI launcher metadata is invalid JSON') }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('CLI launcher metadata is invalid')
  const state = value as Record<string, unknown>
  if (state.version !== STATE_VERSION || !Array.isArray(state.launchers) || !state.launchers.every(validRecord)) {
    throw new Error('CLI launcher metadata is invalid')
  }
  const launchers = state.launchers as LauncherRecord[]
  if (new Set(launchers.map((entry) => entry.path)).size !== launchers.length) throw new Error('CLI launcher metadata has duplicate paths')
  return { version: STATE_VERSION, launchers }
}

function writeState(home: string, state: LauncherState): void {
  mkdirSync(home, { recursive: true, mode: 0o700 })
  chmodSync(home, 0o700)
  const path = statePath(home)
  if (pathExists(path)) {
    const info = lstatSync(path)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('CLI launcher metadata is not a regular file')
  }
  const temporary = join(home, `.${STATE_FILENAME}.${randomUUID()}.tmp`)
  const descriptor = openSync(temporary, 'wx', 0o600)
  try {
    writeFileSync(descriptor, JSON.stringify(state, null, 2))
    fsyncSync(descriptor)
  } catch (error) {
    try { unlinkSync(temporary) } catch {}
    throw error
  } finally {
    closeSync(descriptor)
  }
  try {
    renameSync(temporary, path)
    chmodSync(path, 0o600)
  } catch (error) {
    try { unlinkSync(temporary) } catch {}
    throw error
  }
}

function recordState(path: string, record: LauncherRecord | undefined): 'missing' | 'managed' | 'foreign' {
  try {
    const info = lstatSync(path)
    if (!info.isFile() || info.isSymbolicLink() || !record) return 'foreign'
    return readFileSync(path, 'utf8') === record.script ? 'managed' : 'foreign'
  } catch (error) {
    if (missingPath(error)) return 'missing'
    return 'foreign'
  }
}

function atomicLauncherWrite(path: string, script: string): void {
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true, mode: 0o755 })
  const temporary = join(directory, `.${basename(path)}.${randomUUID()}.tmp`)
  const descriptor = openSync(temporary, 'wx', 0o755)
  try {
    writeFileSync(descriptor, script)
    fsyncSync(descriptor)
  } catch (error) {
    try { unlinkSync(temporary) } catch {}
    throw error
  } finally {
    closeSync(descriptor)
  }
  try {
    chmodSync(temporary, 0o755)
    renameSync(temporary, path)
    chmodSync(path, 0o755)
  } catch (error) {
    try { unlinkSync(temporary) } catch {}
    throw error
  }
}

function normalizePath(path: string): string {
  if (!isAbsolute(path) || path.includes('\0')) throw new Error('launcher path must be absolute')
  return resolve(path)
}

function upsert(home: string, record: LauncherRecord): void {
  const state = readState(home)
  writeState(home, { ...state, launchers: [...state.launchers.filter((entry) => entry.path !== record.path), record] })
}

function removeRecord(home: string, path: string): void {
  const state = readState(home)
  const launchers = state.launchers.filter((entry) => entry.path !== path)
  if (launchers.length !== state.launchers.length) writeState(home, { ...state, launchers })
}

function defaultCommandPath(): string {
  return process.env.QUIRKY_CLI_PATH ? normalizePath(process.env.QUIRKY_CLI_PATH) : join(homedir(), '.local', 'bin', 'quirky')
}

/** Resolves only a verified managed target or paths explicitly supplied by the host environment. */
export function commandTarget(home: string, commandPath = defaultCommandPath()): CliLaunchTarget | null {
  const path = normalizePath(commandPath)
  const state = readState(home)
  const command = state.launchers.find((entry) => entry.path === path && entry.kind === 'command')
  if (command && recordState(path, command) === 'managed') return { ...command.target }
  const profile = state.launchers.find((entry) => entry.kind === 'profile' && recordState(entry.path, entry) === 'managed')
  if (profile) return { ...profile.target }
  const executablePath = process.env.QUIRKY_CLI_EXECUTABLE
  const entrypointPath = process.env.QUIRKY_CLI_ENTRYPOINT
  if (!executablePath || !entrypointPath) return null
  try { return validTarget({ executablePath, entrypointPath }) } catch { return null }
}

export function defaultProfileLauncherPath(name: string, commandPath = defaultCommandPath()): string {
  const normalized = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  if (normalized.length === 0) throw new Error('profile name must contain a letter or number')
  return join(dirname(normalizePath(commandPath)), `quirky-${normalized}`)
}

function recordFor(home: string, path: string, kind: LauncherRecord['kind']): LauncherRecord | undefined {
  return readState(home).launchers.find((entry) => entry.path === path && entry.kind === kind)
}

function status(path: string, record: LauncherRecord | undefined, profileHome: string): InstalledCommandStatus {
  const state = recordState(path, record)
  if (state === 'managed' && record) {
    return { path, target: record.target.entrypointPath, state, profileHome: record.profileHome }
  }
  return { path, target: null, state, profileHome }
}

export function commandStatus(home: string, options: { path?: string; profileHome?: string } = {}): InstalledCommandStatus {
  const path = normalizePath(options.path ?? defaultCommandPath())
  return status(path, recordFor(home, path, 'command'), options.profileHome ?? home)
}

export function installCommand(home: string, input: {
  path?: string
  executablePath: string
  entrypointPath: string
  profileHome?: string
  replaceForeign?: boolean
}): InstalledCommandStatus {
  const path = normalizePath(input.path ?? defaultCommandPath())
  const profileHome = absolutePath(input.profileHome ?? home, 'profileHome')
  const target = validTarget(input)
  const previous = recordFor(home, path, 'command')
  const currentState = recordState(path, previous)
  if (currentState === 'foreign' && input.replaceForeign !== true) {
    throw new Error(`command path ${JSON.stringify(path)} is occupied by a foreign launcher; set replaceForeign=true to confirm replacement`)
  }
  const id = randomUUID()
  const script = launcherScript(target, profileHome, id)
  atomicLauncherWrite(path, script)
  upsert(home, { id, kind: 'command', name: 'quirky', path, profileHome, target, script })
  return status(path, recordFor(home, path, 'command'), profileHome)
}

export function uninstallCommand(home: string, pathInput?: string): LauncherRemovalResult {
  const path = normalizePath(pathInput ?? defaultCommandPath())
  const record = recordFor(home, path, 'command')
  const state = recordState(path, record)
  if (state === 'managed') unlinkSync(path)
  removeRecord(home, path)
  return { removed: state === 'managed', state: state === 'managed' ? 'missing' : state }
}

export function profileLauncherList(home: string): ProfileLauncherStatus[] {
  return readState(home).launchers.filter((entry) => entry.kind === 'profile').map((entry) => {
    const state = recordState(entry.path, entry)
    return {
      name: entry.name,
      path: entry.path,
      target: state === 'managed' ? entry.target.entrypointPath : null,
      state,
      profileHome: entry.profileHome
    }
  })
}

export function installProfileLauncher(home: string, input: {
  name: string
  path: string
  profileHome: string
  executablePath: string
  entrypointPath: string
  replaceForeign?: boolean
}): ProfileLauncherStatus {
  const name = input.name.trim()
  if (name.length === 0 || name.length > 80) throw new Error('profile name must be between 1 and 80 characters')
  const path = normalizePath(input.path)
  const profileHome = absolutePath(input.profileHome, 'profileHome')
  const target = validTarget(input)
  const previous = recordFor(home, path, 'profile')
  const currentState = recordState(path, previous)
  if (currentState === 'foreign' && input.replaceForeign !== true) {
    throw new Error(`profile launcher ${JSON.stringify(path)} is occupied by a foreign file; set replaceForeign=true to confirm replacement`)
  }
  const id = randomUUID()
  const script = launcherScript(target, profileHome, id)
  atomicLauncherWrite(path, script)
  upsert(home, { id, kind: 'profile', name, path, profileHome, target, script })
  return profileLauncherList(home).find((entry) => entry.path === path)!
}

export function uninstallProfileLauncher(home: string, pathInput: string): LauncherRemovalResult {
  const path = normalizePath(pathInput)
  const record = recordFor(home, path, 'profile')
  const state = recordState(path, record)
  if (state === 'managed') unlinkSync(path)
  removeRecord(home, path)
  return { removed: state === 'managed', state: state === 'managed' ? 'missing' : state }
}
