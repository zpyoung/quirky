import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { access, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createElectronHomeIsolation } from './electron-home-isolation'

const execFileAsync = promisify(execFile)
const RUNTIME_METADATA_FILE = 'quirky-runtime.json'
let quirkyDevUserDataPath: string | null = null
let quirkyServeProcess: ChildProcess | null = null
let quirkyServeStdout = ''
let quirkyServeStderr = ''

export type CliResult = {
  stdout: string
  stderr: string
}

type RunQuirkyCliOptions = {
  retryMissingRuntimeMetadata?: boolean
}

export async function runQuirkyCli(
  args: string[],
  options: RunQuirkyCliOptions = {}
): Promise<CliResult> {
  try {
    return await runQuirkyCliOnce(args)
  } catch (error) {
    if (
      options.retryMissingRuntimeMetadata !== false &&
      isMissingRuntimeMetadataError(args, error)
    ) {
      // Why: Windows CI can let the dev runtime exit while launching the
      // fixture app; reopen once so the desktop action gets a live runtime.
      await ensureQuirkyRuntimeLaunched()
      return await runQuirkyCliOnce(args)
    }
    throw error
  }
}

async function runQuirkyCliOnce(args: string[]): Promise<CliResult> {
  const devCli = join(process.cwd(), 'config/scripts/quirky-dev.mjs')
  const command = process.env.QUIRKY_COMPUTER_CLI ?? process.execPath
  const cliArgs = process.env.QUIRKY_COMPUTER_CLI ? args : [devCli, ...args]
  const env = process.env.QUIRKY_COMPUTER_CLI
    ? { ...process.env }
    : await createComputerE2ERuntimeEnv()
  try {
    const result = await execFileAsync(command, cliArgs, {
      env,
      maxBuffer: 20 * 1024 * 1024
    })
    return { stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    if (error && typeof error === 'object' && 'stdout' in error && 'stderr' in error) {
      const output = error as { message: string; stdout: string; stderr: string }
      throw new Error(`${output.message}\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`)
    }
    throw error
  }
}

export async function ensureQuirkyRuntimeLaunched(): Promise<void> {
  if (!process.env.QUIRKY_COMPUTER_CLI && process.platform === 'win32') {
    await ensureQuirkyRuntimeServed()
    return
  }
  await runQuirkyCli(['open', '--json'], { retryMissingRuntimeMetadata: false })
  await waitForQuirkyRuntimeReady()
}

export async function stopQuirkyRuntime(): Promise<void> {
  const processToStop = quirkyServeProcess
  if (!processToStop?.pid) {
    return
  }
  quirkyServeProcess = null
  if (process.platform === 'win32') {
    try {
      await execFileAsync('taskkill.exe', ['/PID', String(processToStop.pid), '/T', '/F'])
    } catch {
      // The foreground test runtime may already have exited.
    }
    return
  }
  processToStop.kill()
}

export function parseJsonOutput<T>(stdout: string): T {
  return JSON.parse(stdout) as T
}

async function getComputerE2eQuirkyDevUserDataPath(): Promise<string> {
  if (!quirkyDevUserDataPath) {
    // Why: the shared quirky-dev profile can keep an older runtime alive across
    // local test runs, making computer-use E2E exercise stale provider code.
    quirkyDevUserDataPath = await mkdtemp(join(tmpdir(), 'quirky-computer-runtime-'))
  }
  return quirkyDevUserDataPath
}

async function waitForQuirkyRuntimeReady(): Promise<void> {
  const userDataPath = await getComputerE2eQuirkyDevUserDataPath()
  const metadataPath = join(userDataPath, RUNTIME_METADATA_FILE)
  const deadline = Date.now() + 15000
  let lastError: unknown = null

  while (Date.now() < deadline) {
    try {
      await access(metadataPath)
      const status = parseJsonOutput<{
        result: { runtime: { reachable: boolean } }
      }>((await runQuirkyCli(['status', '--json'], { retryMissingRuntimeMetadata: false })).stdout)
      if (status.result.runtime.reachable) {
        return
      }
    } catch (error) {
      lastError = error
    }
    await delay(250)
  }

  const detail = [
    lastError instanceof Error ? `Last error: ${lastError.message}` : null,
    quirkyServeStdout.trim() ? `serve stdout: ${quirkyServeStdout.trim()}` : null,
    quirkyServeStderr.trim() ? `serve stderr: ${quirkyServeStderr.trim()}` : null
  ]
    .filter(Boolean)
    .join(' ')
  throw new Error(`Quirky runtime metadata was not ready at ${metadataPath}.${detail}`)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function ensureQuirkyRuntimeServed(): Promise<void> {
  if (!quirkyServeProcess || quirkyServeProcess.exitCode !== null) {
    const devCli = join(process.cwd(), 'config/scripts/quirky-dev.mjs')
    const env = await createComputerE2ERuntimeEnv()
    quirkyServeStdout = ''
    quirkyServeStderr = ''
    quirkyServeProcess = spawn(process.execPath, [devCli, 'serve', '--no-pairing', '--json'], {
      env,
      windowsHide: true
    })
    quirkyServeProcess.stdout?.on('data', (chunk) => {
      quirkyServeStdout += String(chunk)
    })
    quirkyServeProcess.stderr?.on('data', (chunk) => {
      quirkyServeStderr += String(chunk)
    })
    quirkyServeProcess.once('exit', () => {
      quirkyServeProcess = null
    })
    process.once('exit', () => {
      quirkyServeProcess?.kill()
    })
  }
  await waitForQuirkyRuntimeReady()
}

async function createComputerE2ERuntimeEnv(): Promise<NodeJS.ProcessEnv> {
  const userDataDir =
    process.env.QUIRKY_DEV_USER_DATA_PATH ?? (await getComputerE2eQuirkyDevUserDataPath())
  // Why: agent runtimes export ELECTRON_RUN_AS_NODE, which would make the
  // spawned Electron behave as plain Node; strip it like every other caller.
  const { ELECTRON_RUN_AS_NODE: _electronRunAsNode, ...inheritedEnv } = process.env
  void _electronRunAsNode
  const isolation = createElectronHomeIsolation({
    inheritedEnv,
    launchEnv: {},
    extraEnv: {},
    userDataDir
  })
  return {
    ...isolation.env,
    // Why: the Node CLI and the Electron child must resolve the same runtime
    // metadata while the E2E boundary owns their home and Codex paths.
    QUIRKY_DEV_USER_DATA_PATH: userDataDir
  }
}

function isMissingRuntimeMetadataError(args: string[], error: unknown): boolean {
  if (args[0] !== 'computer') {
    return false
  }
  if (!error || typeof error !== 'object' || !('message' in error)) {
    return false
  }
  const message = String((error as { message?: unknown }).message)
  return (
    message.includes('"code": "runtime_unavailable"') &&
    message.includes('Could not read Quirky runtime metadata')
  )
}
