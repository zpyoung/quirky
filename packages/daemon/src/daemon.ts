import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROTOCOL_VERSION } from '@quirky/protocol'
import {
  ensureHome,
  readRuntime,
  runtimeFilePath,
  writePrivateJson,
  type RuntimeInfo
} from '@quirky/protocol/node'
import pkg from '../package.json'
import * as realGit from './git'
import type { GitApi } from './git-api'
import { defaultCliEntry, installIntegrationFiles } from './launch'
import { osascriptNotifier, type Notifier } from './notify'
import { PluginHost } from './plugins/host'
import { createPluginRuntime, type PluginRuntime } from './plugins/runtime'
import { buildUiModel } from './plugins/ui-model'
import { PtyClient } from './pty-client'
import { startServer } from './server'
import { Core } from './service'
import { Store } from './store'
import { createClaudeRunner } from './structured/claude-runner'
import type { StructuredRunnerFactory } from './structured/runner'

export type DaemonOptions = {
  home: string
  /** Listen port; 0 tries the previous port from `daemon-identity.json`, then any free one. */
  port?: number
  git?: GitApi
  notifier?: Notifier
  runnerFactory?: StructuredRunnerFactory
  uiDir?: string
  /** Directory of built-in plugins; null for none. Defaults to `$QUIRKY_BUILTIN_PLUGINS_DIR` or the repo's `plugins/`. */
  builtinPluginsDir?: string | null
  /** Bounds each plugin activation and deactivate; defaults to 10 seconds. */
  pluginActivationTimeoutMs?: number
  /** Bounds each launch hook when a session starts; defaults to 5 seconds. */
  launchHookTimeoutMs?: number
  /** Longest a job timer sleeps before re-checking the clock; defaults to 60 seconds. */
  schedulerRecheckMs?: number
  ptyHostEntry?: string
  cliEntry?: string
  /** Login shell that agents run under; defaults to `$SHELL`. */
  shell?: string
  /** Pause between a bracketed paste and its Enter in `terminal.send`. */
  enterDelayMs?: number
  resolveClaudePath?: () => Promise<string>
  ptyConnectTimeoutMs?: number
  log?: (message: string) => void
}

export type DaemonHandle = {
  port: number
  runtime: RuntimeInfo
  plugins: PluginHost
  stop(): Promise<void>
}

export const daemonVersion: string = pkg.version

/** Survives restarts so agents that outlive the daemon keep working: both tokens are reused. */
type DaemonIdentity = { port: number; token: string; hookToken: string }

function identityFilePath(home: string): string {
  return join(home, 'daemon-identity.json')
}

const validToken = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length >= 16 ? value : undefined

function readIdentity(home: string): Partial<DaemonIdentity> {
  try {
    const value = JSON.parse(readFileSync(identityFilePath(home), 'utf8'))
    return {
      port: Number.isInteger(value.port) && value.port > 0 && value.port < 65536 ? value.port : undefined,
      token: validToken(value.token),
      hookToken: validToken(value.hookToken)
    }
  } catch {
    return {}
  }
}

function isAddressInUse(error: unknown): boolean {
  return (error as { code?: string })?.code === 'EADDRINUSE'
}

function defaultUiDir(): string {
  return process.env.QUIRKY_UI_DIR ?? fileURLToPath(new URL('../../ui/dist', import.meta.url))
}

function defaultBuiltinPluginsDir(): string {
  return process.env.QUIRKY_BUILTIN_PLUGINS_DIR ?? fileURLToPath(new URL('../../../plugins', import.meta.url))
}

async function resolveClaudeThroughLoginShell(shell: string): Promise<string> {
  const proc = Bun.spawn([shell, '-l', '-c', 'command -v claude'], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'ignore'
  })
  const output = (await new Response(proc.stdout).text()).trim().split('\n').pop() ?? ''
  await proc.exited
  if (!output) throw new Error('could not find the claude executable on the login shell PATH')
  return output
}

/**
 * Starts quirkyd in this process: opens the stores, connects to the PTY host, listens on
 * loopback and publishes `runtime.json`. Callers decide whether a daemon already owns the home.
 */
export async function startDaemon(options: DaemonOptions): Promise<DaemonHandle> {
  const home = ensureHome(options.home)
  mkdirSync(join(home, 'logs'), { recursive: true, mode: 0o700 })
  const installedPluginsDir = join(home, 'plugins')
  mkdirSync(installedPluginsDir, { recursive: true, mode: 0o700 })
  const log = options.log ?? ((message: string) => console.error(`[quirkyd] ${message}`))
  const startedAt = Date.now()
  const shell = options.shell ?? process.env.SHELL ?? '/bin/zsh'
  const cliEntry = options.cliEntry ?? defaultCliEntry()
  const identity = readIdentity(home)
  const rpcToken = identity.token ?? randomBytes(24).toString('hex')
  const hookToken = identity.hookToken ?? randomBytes(24).toString('hex')

  const store = new Store(join(home, 'quirky.db'))
  const pty = new PtyClient({
    home,
    hostEntry: options.ptyHostEntry,
    connectTimeoutMs: options.ptyConnectTimeoutMs,
    log
  })
  let port = 0
  // the core and the host are built before the runtime that serves them, so they reach it late-bound
  let lateRuntime: PluginRuntime | undefined
  const core = new Core({
    home,
    store,
    git: options.git ?? realGit,
    pty,
    notifier: options.notifier ?? osascriptNotifier,
    runnerFactory: options.runnerFactory ?? createClaudeRunner,
    resolveClaudePath: options.resolveClaudePath ?? (() => resolveClaudeThroughLoginShell(shell)),
    shell,
    cliEntry,
    enterDelayMs: options.enterDelayMs ?? 300,
    daemonVersion,
    startedAt,
    hookToken,
    hookUrl: () => `http://127.0.0.1:${port}/hook`,
    onEvent: (event) => lateRuntime?.events.deliver(event),
    prepareLaunch: async (input) => (await lateRuntime?.prepareLaunch(input)) ?? { env: {}, args: [] }
  })

  const plugins = new PluginHost({
    builtinDir: options.builtinPluginsDir === undefined ? defaultBuiltinPluginsDir() : options.builtinPluginsDir,
    installedDir: installedPluginsDir,
    store,
    emit: (event) => {
      core.broadcast(event)
      if (event.type === 'plugin.changed') lateRuntime?.scheduler.sync()
    },
    log,
    activationTimeoutMs: options.pluginActivationTimeoutMs,
    deriveDiagnostics: (view) => buildUiModel({ ...view, chosenTheme: 'default' }).warnings,
    extension: {
      create: (plugin, isRevoked) => lateRuntime!.extension.create(plugin, isRevoked),
      revoke: (pluginId) => lateRuntime?.extension.revoke(pluginId)
    }
  })
  const pluginRuntime = createPluginRuntime({
    home,
    plugins,
    core,
    store,
    log,
    launchHookTimeoutMs: options.launchHookTimeoutMs ?? 5000,
    schedulerRecheckMs: options.schedulerRecheckMs ?? 60_000
  })
  lateRuntime = pluginRuntime

  installIntegrationFiles(home, cliEntry)

  try {
    await pty.connect()
    await core.reconcile({ startup: true })
  } catch (error) {
    log(`pty host unavailable at startup: ${(error as Error).message}`)
  }

  plugins.load()
  await plugins.activateStartup()
  pluginRuntime.scheduler.start()

  const requestedPort = options.port ?? Number(process.env.QUIRKY_PORT ?? 0)
  const listen = (listenPort: number) =>
    startServer({
      core,
      dispatcher: pluginRuntime.dispatcher,
      pluginFile: (id) => plugins.pluginFiles(id),
      port: listenPort,
      rpcToken,
      daemonVersion,
      uiDir: options.uiDir ?? defaultUiDir(),
      log
    })
  let server: ReturnType<typeof listen>
  if (requestedPort === 0 && identity.port) {
    try {
      server = listen(identity.port)
    } catch (error) {
      if (!isAddressInUse(error)) throw error
      log(`previous port ${identity.port} is taken; using a free one`)
      server = listen(0)
    }
  } else {
    server = listen(requestedPort)
  }
  port = server.port as number
  writePrivateJson(identityFilePath(home), { port, token: rpcToken, hookToken } satisfies DaemonIdentity)

  const runtime: RuntimeInfo = {
    pid: process.pid,
    port,
    token: rpcToken,
    hookToken,
    daemonVersion,
    protocolVersion: PROTOCOL_VERSION,
    startedAt
  }
  writePrivateJson(runtimeFilePath(home), runtime)

  let stopped = false
  return {
    port,
    runtime,
    plugins,
    async stop() {
      if (stopped) return
      stopped = true
      if (readRuntime(home)?.pid === process.pid) rmSync(runtimeFilePath(home), { force: true })
      await server.stop(true)
      pluginRuntime.scheduler.stop()
      await plugins.stop()
      pty.close()
      store.close()
    }
  }
}
