import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { constants } from 'node:os'
import { spawnProcess } from '@quirky/process-host'
import { resolveQuirkydInstallRoot } from './quirkyd-app-paths'
import { QUIRKYD_EXIT_CONFIGURATION } from './quirkyd-configuration-exit'
import {
  QUIRKYD_NODE_RUNTIME_MARKER_FILENAME,
  QUIRKYD_SERVER_TARGET_FILENAME,
  QUIRKYD_VERSION_FILENAME,
  quirkydNodeRuntimeRelativePath
} from '../../shared/quirkyd-artifacts'
import { NODE_RUNTIME_PIN, nodeRuntimeAsset } from '../../shared/node-runtime-pin'

export class QuirkydBundledRuntimeError extends Error {}
export const QUIRKYD_BUNDLED_LAUNCHER_ENV = 'QUIRKY_BUNDLED_LAUNCHER_CHANNEL'

/**
 * The pinned Node a packaged slot in `directory` runs on, or null for an unpackaged entry.
 * Throws when the slot is packaged but its runtime reference is torn or foreign.
 */
export function resolveBundledQuirkydRuntime(directory: string): string | null {
  const markerPath = join(directory, QUIRKYD_NODE_RUNTIME_MARKER_FILENAME)
  const targetPath = join(directory, QUIRKYD_SERVER_TARGET_FILENAME)
  const hasMarker = existsSync(markerPath)
  const hasTarget = existsSync(targetPath)
  if (!hasMarker && !hasTarget && !existsSync(join(directory, QUIRKYD_VERSION_FILENAME))) {
    return null
  }
  if (!hasTarget) {
    throw new QuirkydBundledRuntimeError('The bundled Quirky runtime target is missing')
  }
  if (!hasMarker) {
    throw new QuirkydBundledRuntimeError('The bundled Quirky runtime reference is missing')
  }
  const target = readFileSync(targetPath, 'utf8').trim()
  // A compat target (design D6 rung B) runs the same Node version built for an older glibc.
  const asset = nodeRuntimeAsset(target)
  if (!asset) {
    throw new QuirkydBundledRuntimeError(`The bundled Quirky runtime target is invalid: ${target}`)
  }
  const executableSha256 = readFileSync(markerPath, 'utf8').trim()
  // Why the pin and not only a digest shape: the marker becomes a path segment, and a slot
  // naming another runtime was not built by this code.
  if (executableSha256 !== asset.executableSha256) {
    throw new QuirkydBundledRuntimeError(
      `The bundled Quirky runtime reference does not name Node ${NODE_RUNTIME_PIN.version}`
    )
  }
  const runtime = join(directory, ...quirkydNodeRuntimeRelativePath(target, executableSha256))
  if (!existsSync(runtime)) {
    throw new QuirkydBundledRuntimeError('The bundled Quirky runtime is missing')
  }
  return runtime
}

/** The running entry's real slot, resolved as the handoff does, so a symlinked quirkyd.js is checked. */
export function resolveBundledQuirkydSlot(script = process.argv[1]): string {
  return resolveQuirkydInstallRoot(script && realpathSync(script))
}

/** True only inside the pinned runtime a packaged slot names. */
export function isRunningAsBundledQuirkydRuntime(directory: string): boolean {
  const runtime = resolveBundledQuirkydRuntime(directory)
  return runtime !== null && realpathSync(process.execPath) === realpathSync(runtime)
}

/** Refuse an old or substituted runtime before the server opens any profile state. */
export function assertQuirkydServerRuntime(): void {
  if (Number(process.versions.node.split('.')[0]) < 18) {
    throw new QuirkydBundledRuntimeError('The Quirky server requires Node.js 18 or newer')
  }
  const directory = resolveBundledQuirkydSlot()
  const runtime = resolveBundledQuirkydRuntime(directory)
  if (runtime && !isRunningAsBundledQuirkydRuntime(directory)) {
    throw new QuirkydBundledRuntimeError('Start the Quirky server with its bundled Node.js runtime')
  }
  if (runtime && process.versions.node !== NODE_RUNTIME_PIN.version) {
    throw new QuirkydBundledRuntimeError(
      `The bundled Quirky runtime must be Node ${NODE_RUNTIME_PIN.version}`
    )
  }
}

/** Keep old Node service commands usable without letting a host Node open the profile. */
export function handoffToBundledQuirkyd(): boolean {
  const script = process.argv[1]
  if (!script) {
    return false
  }
  const entry = realpathSync(script)
  const runtime = resolveBundledQuirkydRuntime(dirname(entry))
  if (!runtime) {
    return false
  }
  if (realpathSync(process.execPath) === realpathSync(runtime)) {
    if (process.versions.node !== NODE_RUNTIME_PIN.version) {
      throw new QuirkydBundledRuntimeError(
        `The bundled Quirky runtime must be Node ${NODE_RUNTIME_PIN.version}`
      )
    }
    return false
  }
  const child = spawnProcess({
    program: runtime,
    args: [entry, ...process.argv.slice(2)],
    env: { ...process.env, [QUIRKYD_BUNDLED_LAUNCHER_ENV]: '1' },
    // Windows' default child job kills the runtime before it can drain on launcher disconnect.
    detached: true,
    stdio: ['inherit', 'inherit', 'inherit', 'ipc']
  })
  // Node resets nohup's disposition; headless runtimes stop through INT/TERM or owner loss.
  const ignoreHangup = (): void => {}
  if (process.platform !== 'win32') {
    process.on('SIGHUP', ignoreHangup)
  }
  const forwards = (['SIGINT', 'SIGTERM'] as const).map((signal) => {
    const forward = (): void => {
      if (process.platform === 'win32') {
        // Detached Windows children have a separate console; kill() skips durable shutdown.
        if (child.connected) {
          child.disconnect()
        }
      } else {
        child.kill(signal)
      }
    }
    process.on(signal, forward)
    return { signal, forward }
  })
  const cleanup = (): void => {
    process.off('SIGHUP', ignoreHangup)
    for (const { signal, forward } of forwards) {
      process.off(signal, forward)
    }
  }
  child.once('error', (error) => {
    cleanup()
    console.error('quirkyd: could not start the bundled runtime:', error.message)
    process.exit(QUIRKYD_EXIT_CONFIGURATION)
  })
  child.once('exit', (code, signal) => {
    cleanup()
    if (signal && process.platform !== 'win32') {
      process.kill(process.pid, signal)
      return
    }
    process.exit(code ?? (signal ? 128 + constants.signals[signal] : 1))
  })
  return true
}
