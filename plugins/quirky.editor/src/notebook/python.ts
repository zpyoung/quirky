import type { ProcessSpawner, SpawnExit, SpawnedProcess } from '@quirky/protocol'
import { accessSync, constants, existsSync, realpathSync } from 'node:fs'
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export type PythonEnvironment = {
  path: string
  name: string
  version: string
  source: 'workspace' | 'path' | 'selected' | 'venv'
  hasIpykernel: boolean
  hasPip: boolean
  externallyManaged: boolean
}
export type PythonCandidate = { path: string; name: string; source: 'workspace' | 'path' | 'venv' }
type CommandResult = { code: number | null; stdout: string; stderr: string }

const MAX_SETUP_OUTPUT = 256 * 1024
const PROBE_CODE = [
  'import importlib.util, json, os, platform, sys, sysconfig',
  'managed = sys.prefix == getattr(sys, "base_prefix", sys.prefix) and os.path.isfile(os.path.join(sysconfig.get_path("stdlib"), "EXTERNALLY-MANAGED"))',
  'print(json.dumps({"path": sys.executable, "version": platform.python_version(), "ipykernel": importlib.util.find_spec("ipykernel") is not None, "pip": importlib.util.find_spec("pip") is not None, "externallyManaged": managed}))'
].join('; ')

function appendBounded(current: string, chunk: string, limit: number): string {
  if (limit <= 0) return ''
  if (chunk.length >= limit) return chunk.slice(-limit)
  const remaining = limit - chunk.length
  return current.length > remaining ? current.slice(-remaining) + chunk : current + chunk
}

type StdoutPump = { promise: Promise<string>; cancel(): Promise<void> }

function collectStdout(stream: ReadableStream<Uint8Array>, limit: number): StdoutPump {
  const reader = stream.getReader()
  let released = false
  const promise = (async () => {
    const decoder = new TextDecoder()
    let output = ''
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) {
          output = appendBounded(output, decoder.decode(), limit)
          return output
        }
        output = appendBounded(output, decoder.decode(value, { stream: true }), limit)
      }
    } finally {
      released = true
      reader.releaseLock()
    }
  })()
  return {
    promise,
    async cancel() {
      if (released) return
      try {
        await reader.cancel()
      } catch {
        return
      }
    }
  }
}

function stopForCleanup(child: SpawnedProcess): Promise<SpawnExit | undefined> {
  try {
    return Promise.resolve(child.stop({ signal: 'SIGKILL' })).catch(() => undefined)
  } catch {
    return Promise.resolve(undefined)
  }
}

export async function runCommand(
  runner: ProcessSpawner,
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number; tailCharacters?: number }
): Promise<CommandResult> {
  const tailCharacters = options.tailCharacters ?? MAX_SETUP_OUTPUT
  const child = runner.spawn([command, ...args], {
    cwd: options.cwd,
    env: process.env,
    timeoutMs: options.timeoutMs,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'tail',
    stderrTailBytes: tailCharacters * 4,
    killGraceMs: 0
  })

  let output: StdoutPump
  try {
    output = collectStdout(child.stdout, tailCharacters)
  } catch (cause) {
    await stopForCleanup(child)
    throw cause
  }
  let stdoutFailure: unknown
  let stdoutFailed = false
  const stdoutPromise = output.promise.catch((cause) => {
    stdoutFailure = cause
    stdoutFailed = true
    throw cause
  })

  let timedOut = false
  let forcedStop: Promise<SpawnExit | undefined> | undefined
  const deadline = Promise.withResolvers<never>()
  const timer = setTimeout(() => {
    timedOut = true
    forcedStop ??= stopForCleanup(child)
    deadline.reject(new Error(`command timed out after ${options.timeoutMs} ms`))
  }, options.timeoutMs)

  let completion: [SpawnExit, string]
  try {
    completion = await Promise.race([
      Promise.all([child.exited, stdoutPromise]),
      deadline.promise
    ])
  } catch (cause) {
    forcedStop ??= stopForCleanup(child)
    await Promise.allSettled([forcedStop, output.cancel()])
    if (stdoutFailed) throw stdoutFailure
    if (timedOut) throw new Error(`command timed out after ${options.timeoutMs} ms`)
    throw cause
  } finally {
    clearTimeout(timer)
  }

  const [exit, stdout] = completion
  if (exit.spawnError) throw new Error(exit.spawnError.message)
  if (exit.stopped === 'timeout') throw new Error(`command timed out after ${options.timeoutMs} ms`)
  if (exit.stopped === 'aborted') throw new Error('command was aborted')
  if (exit.stopped === 'stop') throw new Error('command was stopped')
  const stderr = child.stderrTail()
  return {
    code: exit.exitCode,
    stdout,
    stderr: tailCharacters <= 0 ? '' : stderr.slice(-tailCharacters)
  }
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function addCandidate(
  candidates: PythonCandidate[],
  seen: Set<string>,
  path: string,
  name: string,
  source: PythonCandidate['source']
): void {
  if (!isAbsolute(path) || !existsSync(path) || !isExecutable(path)) return
  const launcher = resolve(path)
  if (seen.has(launcher)) return
  seen.add(launcher)
  candidates.push({ path: launcher, name, source })
}

export function discoverPythonCandidates(notebookDir: string, rootPath: string): PythonCandidate[] {
  const candidates: PythonCandidate[] = []
  const seen = new Set<string>()
  const root = resolve(rootPath)
  let directory = resolve(notebookDir)
  const relativeToRoot = relative(root, directory)
  const startsInWorkspace = relativeToRoot === '' || (relativeToRoot !== '..' && !relativeToRoot.startsWith(`..${sep}`) && !isAbsolute(relativeToRoot))
  for (;;) {
    for (const env of ['.venv', '.conda']) {
      const base = process.platform === 'win32' ? join(directory, env, 'Scripts') : join(directory, env, 'bin')
      const executable = process.platform === 'win32' ? join(base, 'python.exe') : join(base, 'python')
      addCandidate(candidates, seen, executable, `${env} Python`, env === '.venv' ? 'venv' : 'workspace')
    }
    if (!startsInWorkspace || directory === root || directory === parseRoot(directory)) break
    directory = dirname(directory)
  }
  const pathEntries = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  const commandNames = process.platform === 'win32' ? ['python.exe'] : ['python3', 'python']
  for (const name of commandNames) {
    for (const entry of pathEntries) {
      const candidate = join(entry, name)
      if (isExecutable(candidate)) {
        addCandidate(candidates, seen, candidate, name, 'path')
        break
      }
    }
  }
  return candidates
}

function parseRoot(path: string): string {
  let current = path
  while (dirname(current) !== current) current = dirname(current)
  return current
}

export async function describePython(
  runner: ProcessSpawner,
  path: string,
  source: PythonEnvironment['source'] = 'selected'
): Promise<PythonEnvironment> {
  if (!path.trim()) throw new Error('Python executable path is required')
  const executable = isAbsolute(path) ? resolve(path) : path
  if (isAbsolute(executable) && !isExecutable(executable)) throw new Error(`Python is not executable: ${path}`)
  const result = await runCommand(runner, executable, ['-c', PROBE_CODE], { cwd: process.cwd(), timeoutMs: 10_000 })
  if (result.code !== 0) throw new Error(`Python validation failed: ${result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`}`)
  let metadata: unknown
  try {
    metadata = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '')
  } catch {
    throw new Error(`Python did not return a valid version description: ${result.stderr.trim()}`)
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('Python did not return a valid version description')
  const info = metadata as Record<string, unknown>
  if (typeof info.path !== 'string' || typeof info.version !== 'string' || typeof info.ipykernel !== 'boolean' || typeof info.pip !== 'boolean' || typeof info.externallyManaged !== 'boolean') {
    throw new Error('Python returned an incomplete version description')
  }
  const canonical = isAbsolute(info.path) ? realpathSync(info.path) : info.path
  const launcher = isAbsolute(executable) ? executable : info.path
  return {
    path: launcher,
    name: basename(canonical),
    version: info.version,
    source,
    hasIpykernel: info.ipykernel,
    hasPip: info.pip,
    externallyManaged: info.externallyManaged
  }
}

export async function describeCandidates(runner: ProcessSpawner, candidates: PythonCandidate[]): Promise<PythonEnvironment[]> {
  const result: PythonEnvironment[] = []
  for (const candidate of candidates) {
    try {
      result.push(await describePython(runner, candidate.path, candidate.source))
    } catch {
      // A candidate can disappear between discovery and probe; omit only that unusable interpreter.
    }
  }
  return result
}

export async function installIpykernel(
  runner: ProcessSpawner,
  python: PythonEnvironment,
  cwd: string
): Promise<{ python: PythonEnvironment; command: string }> {
  if (python.externallyManaged) throw new Error('This Python is externally managed; create a workspace virtual environment instead.')
  if (!python.hasPip) {
    const ensured = await runCommand(runner, python.path, ['-m', 'ensurepip'], { cwd, timeoutMs: 600_000 })
    if (ensured.code !== 0) throw new Error(`ensurepip failed: ${ensured.stderr.trim() || ensured.stdout.trim()}`)
  }
  const command = `${shellQuote(python.path)} -m pip install -U ipykernel`
  const installed = await runCommand(runner, python.path, ['-m', 'pip', 'install', '-U', 'ipykernel'], { cwd, timeoutMs: 600_000 })
  if (installed.code !== 0) throw new Error(`${command}\n${installed.stderr.trim() || installed.stdout.trim()}`)
  const verified = await describePython(runner, python.path, python.source)
  if (!verified.hasIpykernel) throw new Error(`ipykernel installation did not verify: ${installed.stderr.trim()}`)
  return { python: verified, command }
}

export async function createWorkspaceVenv(
  runner: ProcessSpawner,
  selected: PythonEnvironment,
  notebookDir: string,
  rootPath: string
): Promise<{ python: PythonEnvironment; path: string; command: string }> {
  const root = resolve(rootPath)
  const notebook = resolve(notebookDir)
  const relativeToRoot = relative(root, notebook)
  const workspaceRoot = relativeToRoot === '' || (relativeToRoot !== '..' && !relativeToRoot.startsWith(`..${sep}`) && !isAbsolute(relativeToRoot)) ? root : notebook
  const venvDir = join(workspaceRoot, '.venv')
  const venvPython = process.platform === 'win32' ? join(venvDir, 'Scripts', 'python.exe') : join(venvDir, 'bin', 'python')
  const commandParts: string[] = []
  if (!existsSync(venvPython)) {
    const created = await runCommand(runner, selected.path, ['-m', 'venv', venvDir], { cwd: workspaceRoot, timeoutMs: 120_000 })
    if (created.code !== 0) throw new Error(`virtual environment creation failed: ${created.stderr.trim() || created.stdout.trim()}`)
    commandParts.push(`${shellQuote(selected.path)} -m venv ${shellQuote(venvDir)}`)
  }
  const candidate = await describePython(runner, venvPython, 'venv')
  if (!candidate.hasIpykernel) {
    const installed = await installIpykernel(runner, candidate, workspaceRoot)
    commandParts.push(installed.command)
    return { python: installed.python, path: venvDir, command: commandParts.join(' && ') }
  }
  return { python: candidate, path: venvDir, command: commandParts.join(' && ') }
}
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}
