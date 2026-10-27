import { spawn } from 'node:child_process'
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

function appendBounded(current: string, chunk: string): string {
  const combined = current + chunk
  return combined.length > MAX_SETUP_OUTPUT ? combined.slice(-MAX_SETUP_OUTPUT) : combined
}

export async function runCommand(command: string, args: string[], options: { cwd: string; timeoutMs: number }): Promise<CommandResult> {
  const { promise, resolve: resolveResult, reject } = Promise.withResolvers<CommandResult>()
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true
  })
  let stdout = ''
  let stderr = ''
  let settled = false
  const timer = setTimeout(() => {
    terminate(child)
    if (!settled) {
      settled = true
      reject(new Error(`command timed out after ${options.timeoutMs} ms`))
    }
  }, options.timeoutMs)
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => { stdout = appendBounded(stdout, chunk) })
  child.stderr?.on('data', (chunk: string) => { stderr = appendBounded(stderr, chunk) })
  child.once('error', (failure) => {
    clearTimeout(timer)
    if (!settled) {
      settled = true
      reject(failure)
    }
  })
  child.once('close', (code) => {
    clearTimeout(timer)
    if (!settled) {
      settled = true
      resolveResult({ code, stdout, stderr })
    }
  })
  return promise
}

function terminate(child: ReturnType<typeof spawn>): void {
  const pid = child.pid
  if (!pid) return
  try {
    if (process.platform !== 'win32') process.kill(-pid, 'SIGTERM')
    else child.kill('SIGTERM')
  } catch {
    try { child.kill('SIGTERM') } catch { /* already gone */ }
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
  let canonical: string
  try {
    canonical = realpathSync(path)
  } catch {
    return
  }
  if (seen.has(canonical)) return
  seen.add(canonical)
  candidates.push({ path: canonical, name, source })
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

export async function describePython(path: string, source: PythonEnvironment['source'] = 'selected'): Promise<PythonEnvironment> {
  if (!path.trim()) throw new Error('Python executable path is required')
  const executable = isAbsolute(path) ? resolve(path) : path
  if (isAbsolute(executable) && !isExecutable(executable)) throw new Error(`Python is not executable: ${path}`)
  const result = await runCommand(executable, ['-c', PROBE_CODE], { cwd: process.cwd(), timeoutMs: 10_000 })
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
  return {
    path: canonical,
    name: basename(canonical),
    version: info.version,
    source,
    hasIpykernel: info.ipykernel,
    hasPip: info.pip,
    externallyManaged: info.externallyManaged
  }
}

export async function describeCandidates(candidates: PythonCandidate[]): Promise<PythonEnvironment[]> {
  const result: PythonEnvironment[] = []
  for (const candidate of candidates) {
    try {
      result.push(await describePython(candidate.path, candidate.source))
    } catch {
      // A candidate can disappear between discovery and probe; omit only that unusable interpreter.
    }
  }
  return result
}

export async function installIpykernel(python: PythonEnvironment, cwd: string): Promise<{ python: PythonEnvironment; command: string }> {
  if (python.externallyManaged) throw new Error('This Python is externally managed; create a workspace virtual environment instead.')
  if (!python.hasPip) {
    const ensured = await runCommand(python.path, ['-m', 'ensurepip'], { cwd, timeoutMs: 600_000 })
    if (ensured.code !== 0) throw new Error(`ensurepip failed: ${ensured.stderr.trim() || ensured.stdout.trim()}`)
  }
  const command = `${shellQuote(python.path)} -m pip install -U ipykernel`
  const installed = await runCommand(python.path, ['-m', 'pip', 'install', '-U', 'ipykernel'], { cwd, timeoutMs: 600_000 })
  if (installed.code !== 0) throw new Error(`${command}\n${installed.stderr.trim() || installed.stdout.trim()}`)
  const verified = await describePython(python.path, python.source)
  if (!verified.hasIpykernel) throw new Error(`ipykernel installation did not verify: ${installed.stderr.trim()}`)
  return { python: verified, command }
}

export async function createWorkspaceVenv(
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
    const created = await runCommand(selected.path, ['-m', 'venv', venvDir], { cwd: workspaceRoot, timeoutMs: 120_000 })
    if (created.code !== 0) throw new Error(`virtual environment creation failed: ${created.stderr.trim() || created.stdout.trim()}`)
    commandParts.push(`${shellQuote(selected.path)} -m venv ${shellQuote(venvDir)}`)
  }
  const candidate = await describePython(venvPython, 'venv')
  if (!candidate.hasIpykernel) {
    const installed = await installIpykernel(candidate, workspaceRoot)
    commandParts.push(installed.command)
    return { python: installed.python, path: venvDir, command: commandParts.join(' && ') }
  }
  return { python: candidate, path: venvDir, command: commandParts.join(' && ') }
}
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}
