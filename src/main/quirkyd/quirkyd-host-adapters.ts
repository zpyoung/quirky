/** The Node host's stand-ins for Electron's app environment and secret store. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { QUIRKYD_CLI_PACKAGE_FILENAME } from '../../shared/quirkyd-artifacts'
import { setAppEnvironment, type AppEnvironment } from '../../shared/app-environment'
import { setSecretStore } from '../../shared/secret-store'
import { resolveQuirkydInstallRoot, resolveQuirkydPath } from './quirkyd-app-paths'
import { getQuirkydCliLauncherPath } from './quirkyd-cli-launcher'
import { createQuirkydSecretStore, type QuirkydSecretStore } from './quirkyd-secret-store'
import { setSpeechServiceFactories } from '../speech/speech-runtime-service'
import { quirkydSpeechServiceFactories } from './quirkyd-speech-services'

let quitRegisteredHandlers = (): void => {}

export function runQuirkydQuitHandlers(): void {
  quitRegisteredHandlers()
}

function createNodeAppEnvironment(): AppEnvironment {
  const quitHandlers: (() => void)[] = []
  // The main signal handler awaits runtime and browser teardown before process.exit.
  // Keep will-quit callbacks synchronous, but never let them pre-empt that async barrier.
  quitRegisteredHandlers = (): void => {
    const errors: unknown[] = []
    for (const handler of quitHandlers.splice(0)) {
      try {
        handler()
      } catch (error) {
        errors.push(error)
      }
    }
    // Why throw: a quit handler that failed may leave a writer running, which keeps the lock.
    if (errors.length > 0) {
      throw new AggregateError(errors, 'quirkyd_quit_handlers_failed')
    }
  }
  return {
    getPath: resolveQuirkydPath,
    getAppPath: () => resolveQuirkydInstallRoot(),
    getVersion: () => process.env.QUIRKY_VERSION ?? '0.0.0-quirkyd',
    // Why still true: consumers read this as "production build, not a dev checkout" —
    // it gates HTTPS-only skill downloads, the real CLI command name, and shell-PATH
    // hydration. Answering false to satisfy a path resolver would relax a security
    // posture. Layout questions must ask whether the app root is an asar archive
    // instead (see parcel-watcher-entry-path.ts).
    isPackaged: () => true,
    getCliLauncherPath: getQuirkydCliLauncherPath,
    onWillQuit: (handler) => quitHandlers.push(handler),
    exit: (code = 0) => process.exit(code),
    // Why []: there are no Chromium processes on this host to measure.
    getAppMetrics: () => []
  }
}

let quirkydSecretStore: QuirkydSecretStore | null = null

/** Loads the sealing key kept in `keyDir`; resolves whether sealing works. */
export async function prepareQuirkydSecretStore(
  keyDir: string,
  userDataPath: string
): Promise<boolean> {
  if (!quirkydSecretStore) {
    throw new Error('quirkyd_secret_store_not_installed — call installQuirkydHostAdapters() first')
  }
  return quirkydSecretStore.prepare({ keyDir, userDataPath })
}

/**
 * The Quirky release this server was built from, stamped into the bundle's own `out/package.json`.
 * Why: `status.get` and the updater report QUIRKY_APP_VERSION, which only the desktop's preflight
 * sets, so a server read `0.0.0-dev`. The bundle wins over an inherited value from another build.
 */
export function stampQuirkydAppVersion(
  installRoot: () => string = resolveQuirkydInstallRoot
): void {
  let version: unknown
  try {
    const path = join(installRoot(), ...QUIRKYD_CLI_PACKAGE_FILENAME.split('/'))
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    version = parsed && typeof parsed === 'object' && 'version' in parsed ? parsed.version : null
  } catch {
    return
  }
  if (typeof version === 'string' && version.length > 0) {
    process.env.QUIRKY_APP_VERSION = version
  }
}

export function installQuirkydHostAdapters(): void {
  stampQuirkydAppVersion()
  setAppEnvironment(createNodeAppEnvironment())
  quirkydSecretStore = createQuirkydSecretStore()
  setSecretStore(quirkydSecretStore)
  setSpeechServiceFactories(quirkydSpeechServiceFactories)
}
