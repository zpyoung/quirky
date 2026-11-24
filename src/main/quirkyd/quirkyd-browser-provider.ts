import { access, mkdir, open, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import {
  setRuntimeBrowserUnavailableCause,
  type RuntimeBrowserCommandsFactory,
  type RuntimeBrowserUnavailableCause
} from '../runtime/runtime-browser-commands-factory'
import { ExternalChromiumBrowserProcess } from './external-chromium-browser-process'
import type { ExternalChromiumLaunch } from './external-chromium-browser-session'
import { resolveQuirkydAgentBrowserBinary } from './quirkyd-agent-browser-binary'
import { ElectronServeBrowserProcess } from './electron-serve-browser-process'
import { openQuirkydBrowserInstallPark } from './quirkyd-browser-install-park'

export type QuirkydBrowserProvider = {
  kind: 'electron' | 'chromium'
  factory: RuntimeBrowserCommandsFactory
  isAvailable(): boolean
  stop(): Promise<void>
}

export type QuirkydBrowserProviderOptions = {
  userDataPath: string
  signal?: AbortSignal
  environment?: NodeJS.ProcessEnv
  resolveInstalledElectronExecutable?: () => Promise<string | null>
  resolveAgentBrowserBinary?: () => string | null
}

type ExecutableProbe = 'ok' | 'missing' | 'not_executable'

class QuirkydBrowserCleanupError extends AggregateError {}

async function cleanupFailedProvider(
  processHandle: { stop(): Promise<void> },
  startupError: unknown
): Promise<never> {
  try {
    await processHandle.stop()
  } catch (cleanupError) {
    throw new QuirkydBrowserCleanupError(
      [startupError, cleanupError],
      'quirkyd_browser_cleanup_failed'
    )
  }
  throw startupError
}

/** Splits the two failures apart: a wrong path and a forgotten chmod +x need different fixes. */
async function probeExecutable(path: string): Promise<ExecutableProbe> {
  const mode = process.platform === 'win32' ? constants.F_OK : constants.X_OK
  try {
    await access(path, mode)
    return 'ok'
  } catch {
    if (mode === constants.F_OK) {
      return 'missing'
    }
  }
  try {
    await access(path, constants.F_OK)
    return 'not_executable'
  } catch {
    return 'missing'
  }
}

async function executableExists(path: string): Promise<boolean> {
  return (await probeExecutable(path)) === 'ok'
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function installedElectronCandidates(
  platform: NodeJS.Platform,
  homePath: string,
  environment: NodeJS.ProcessEnv
): string[] {
  const joinPath = platform === 'win32' ? win32.join : posix.join
  if (platform === 'darwin') {
    return [
      '/Applications/Quirky.app/Contents/MacOS/Quirky',
      joinPath(homePath, 'Applications', 'Quirky.app', 'Contents', 'MacOS', 'Quirky')
    ]
  }
  if (platform === 'win32') {
    return [
      ...(environment.LOCALAPPDATA
        ? [joinPath(environment.LOCALAPPDATA, 'Programs', 'Quirky', 'Quirky.exe')]
        : []),
      ...(environment.ProgramFiles
        ? [joinPath(environment.ProgramFiles, 'Quirky', 'Quirky.exe')]
        : [])
    ]
  }
  return [
    joinPath(homePath, '.local', 'bin', 'quirky-ide'),
    '/usr/local/bin/quirky-ide',
    '/usr/bin/quirky-ide',
    '/opt/Quirky/quirky-ide'
  ]
}

/** The .deb/AppImage CLI shims (`quirky-ide` on PATH) are bash scripts, not Electron. */
async function isScriptShim(path: string): Promise<boolean> {
  try {
    const handle = await open(await realpath(path), 'r')
    try {
      const head = Buffer.alloc(2)
      const { bytesRead } = await handle.read(head, 0, 2, 0)
      return bytesRead === 2 && head[0] === 0x23 && head[1] === 0x21
    } finally {
      await handle.close()
    }
  } catch {
    return true
  }
}

/** Only paths with stable installer ownership qualify; never guess arbitrary AppImage locations. */
export async function resolveInstalledElectronExecutable(
  candidates: string[] = installedElectronCandidates(process.platform, homedir(), process.env)
): Promise<string | null> {
  for (const candidate of candidates) {
    if ((await executableExists(candidate)) && !(await isScriptShim(candidate))) {
      return candidate
    }
  }
  return null
}

async function startProvider(
  agentBrowserPath: string,
  launch: ExternalChromiumLaunch,
  userDataPath: string,
  signal?: AbortSignal
): Promise<QuirkydBrowserProvider> {
  const processHandle = new ExternalChromiumBrowserProcess(agentBrowserPath, launch, userDataPath)
  try {
    await processHandle.start(signal)
  } catch (error) {
    return cleanupFailedProvider(processHandle, error)
  }
  return {
    kind: launch.provider,
    factory: (host) => processHandle.createCommands(host),
    isAvailable: () => processHandle.isAvailable(),
    stop: () => processHandle.stop()
  }
}

async function startElectronServeProvider(
  executablePath: string,
  signal?: AbortSignal
): Promise<QuirkydBrowserProvider> {
  const processHandle = new ElectronServeBrowserProcess(executablePath)
  try {
    await processHandle.start(signal)
  } catch (error) {
    return cleanupFailedProvider(processHandle, error)
  }
  const installPark = openQuirkydBrowserInstallPark(executablePath, {
    pid: () => processHandle.pid(),
    stop: () => processHandle.stop(),
    start: async (restartSignal) => {
      try {
        await processHandle.start(restartSignal)
      } catch (error) {
        await processHandle.stop()
        throw error
      }
    }
  })
  return {
    kind: 'electron',
    factory: (host) => processHandle.createCommands(host),
    isAvailable: () => processHandle.isAvailable(),
    stop: async () => {
      await installPark?.close()
      await processHandle.stop()
    }
  }
}

/** Resolve once at startup: Electron first, then the operator-supplied Chromium. */
export async function resolveQuirkydBrowserProvider(
  options: QuirkydBrowserProviderOptions
): Promise<QuirkydBrowserProvider | null> {
  const environment = options.environment ?? process.env
  if (options.signal?.aborted) {
    return null
  }
  await mkdir(options.userDataPath, { recursive: true, mode: 0o700 })

  const declined = (cause: RuntimeBrowserUnavailableCause): null => {
    setRuntimeBrowserUnavailableCause(cause)
    return null
  }

  const installedElectronExecutable = await (
    options.resolveInstalledElectronExecutable ?? resolveInstalledElectronExecutable
  )()
  if (options.signal?.aborted) {
    return null
  }
  // Why held rather than reported now: Chromium may still resolve, and if it does not, its
  // own concrete fault is the more actionable one for an operator who set the env var.
  let electronFailure: RuntimeBrowserUnavailableCause | null = null
  if (installedElectronExecutable) {
    try {
      setRuntimeBrowserUnavailableCause(null)
      return await startElectronServeProvider(installedElectronExecutable, options.signal)
    } catch (error) {
      if (error instanceof QuirkydBrowserCleanupError) {
        throw error
      }
      if (options.signal?.aborted) {
        return null
      }
      console.warn('[quirkyd] Installed Electron browser provider unavailable:', error)
      electronFailure = { reason: 'electron_start_failed', detail: errorDetail(error) }
    }
  }

  // Why the env var is read before the driver: with it set, a missing driver is a driver
  // problem, not an unconfigured host. Telling someone to set QUIRKY_BROWSER_EXECUTABLE when
  // they already did is the misdirection this ordering exists to prevent.
  const chromiumExecutable = environment.QUIRKY_BROWSER_EXECUTABLE?.trim()
  if (!chromiumExecutable) {
    return declined(electronFailure ?? { reason: 'unconfigured' })
  }

  const agentBrowserPath = (options.resolveAgentBrowserBinary ?? resolveQuirkydAgentBrowserBinary)()
  if (!agentBrowserPath) {
    return declined({ reason: 'driver_missing' })
  }

  const probe = await probeExecutable(chromiumExecutable)
  if (options.signal?.aborted) {
    return null
  }
  if (probe !== 'ok') {
    return declined({
      reason: probe === 'missing' ? 'executable_not_found' : 'executable_not_executable',
      detail: chromiumExecutable
    })
  }

  try {
    setRuntimeBrowserUnavailableCause(null)
    return await startProvider(
      agentBrowserPath,
      { executablePath: chromiumExecutable, provider: 'chromium' },
      options.userDataPath,
      options.signal
    )
  } catch (error) {
    if (error instanceof QuirkydBrowserCleanupError) {
      throw error
    }
    if (options.signal?.aborted) {
      return null
    }
    console.warn('[quirkyd] External Chromium browser provider unavailable:', error)
    return declined({ reason: 'chromium_start_failed', detail: errorDetail(error) })
  }
}
