import { readFileSync } from 'node:fs'
import { parseQuirkyYaml } from '../shared/quirky-yaml'
import { resolveRepoConfigPath } from '../shared/repo-config-paths'
import { resolveHookCommandSourcePolicy } from '../shared/hook-command-source-policy'
import { getEffectiveHooksFromConfig } from './effective-hook-config'
import { getSetupEnvVars } from './setup-hook-env-vars'
import { iterateLfScriptLines } from './setup-runner-script-text'
import { promptGuardShellEnv } from './git/runner'
import { dropIncoherentCondaActivationEnv } from './pty/conda-activation-env'
import type { HookRuntimeTarget } from './hook-runtime-target'
import type { QuirkyHooks } from '../shared/quirky-yaml-hook-types'
import type { Repo } from '../shared/repo-types'
import type { ProjectExecutionRuntimeResolution } from '../shared/project-execution-runtime'
import { spawn } from 'node:child_process'
import {
  forceTerminateProcessTree,
  signalProcessTree
} from '@quirky/process-host/process-tree-termination'
import { createOutputSink } from '@quirky/process-host/bounded-output-sink'

const HOOK_TIMEOUT = 120_000 // 2 minutes

type HookProcessOutcome = { success: boolean; output: string; exitCode?: number }

/**
 * Turn a finished process into a hook verdict.
 *
 * Why `timedOut` decides before `code` (#19334): a hook that traps SIGTERM and exits 0 reports a
 * zero exit for a run we cut off mid-archive. The exit code of something we stopped is not
 * evidence it finished, so a timeout withholds the code and the removal gate reads that as
 * `unverifiable` rather than as a pass.
 */
function classifyHookProcessResult(
  result: { code: number | null; stdout: string; stderr: string; timedOut: boolean },
  context: { hookName: string; cwd: string; timeoutMs: number }
): HookProcessOutcome {
  const streams = `${result.stdout}\n${result.stderr}`
  if (result.timedOut) {
    const message = `Hook timed out after ${context.timeoutMs}ms.`
    console.error(`[hooks] ${context.hookName} hook failed in ${context.cwd}:`, message)
    return { success: false, output: `${streams}\n${message}`.trim() }
  }
  if (result.code !== 0) {
    // `null` means signalled: there is no exit code, and saying "exit code null" reads as a
    // reporting glitch rather than the `unverifiable` verdict the gate is about to give it.
    const message =
      result.code === null
        ? 'Command was terminated without reporting an exit code.'
        : `Command failed with exit code ${result.code}.`
    console.error(`[hooks] ${context.hookName} hook failed in ${context.cwd}:`, message)
    return {
      success: false,
      output: `${streams}\n${message}`.trim(),
      ...(typeof result.code === 'number' ? { exitCode: result.code } : {})
    }
  }
  console.log(`[hooks] ${context.hookName} hook completed in ${context.cwd}`)
  return { success: true, output: streams.trim() }
}

const SIGTERM_GRACE_MS = 2_000

/**
 * `exec` capped output at 1 MiB and killed the hook on overflow; `spawn` has no cap at all, and a
 * hook flooding stdout for the full deadline can take the main process's heap with it. Truncation
 * is reported in the output rather than as a failure — a chatty hook that exits 0 did succeed, and
 * failing it for being chatty is the `exec` behaviour this is replacing.
 */
const HOOK_OUTPUT_LIMIT_BYTES = 10 * 1024 * 1024

function readSink(sink: ReturnType<typeof createOutputSink>): string {
  return sink.truncated()
    ? `${sink.text()}\n[output truncated at ${HOOK_OUTPUT_LIMIT_BYTES} bytes]`
    : sink.text()
}

/** A spawn failure: the process never started, so no exit was ever observed. */
function hookProcessError(
  error: Error,
  stdout: string,
  stderr: string,
  context: { hookName: string; cwd: string }
): HookProcessOutcome {
  const code = 'code' in error ? error.code : undefined
  console.error(`[hooks] ${context.hookName} hook failed in ${context.cwd}:`, error.message)
  return {
    success: false,
    output: `${stdout}\n${stderr}\n${error.message}`.trim(),
    ...(typeof code === 'number' ? { exitCode: code } : {})
  }
}

function getHookShell(): string | undefined {
  if (process.platform === 'win32') {
    return process.env.ComSpec || 'cmd.exe'
  }

  return '/bin/bash'
}

export { parseQuirkyYaml }

/**
 * Load hooks from quirky.yaml in the given repo root.
 */
export function loadHooks(repoPath: string): QuirkyHooks | null {
  const yamlPath = resolveRepoConfigPath(repoPath, 'yaml')
  if (!yamlPath) {
    return null
  }

  try {
    const content = readFileSync(yamlPath, 'utf-8')
    return parseQuirkyYaml(content)
  } catch {
    return null
  }
}

/**
 * Check whether an quirky.yaml exists for a repo.
 */
export function hasHooksFile(repoPath: string): boolean {
  return resolveRepoConfigPath(repoPath, 'yaml') !== null
}

// Why: detect unrecognised keys so the UI can suggest an update instead of showing a "could not be parsed" error.
const RECOGNIZED_QUIRKY_YAML_KEYS = new Set([
  'scripts',
  'setupAgentStartupPolicy',
  'issueCommand',
  'defaultTabs',
  'environmentRecipes',
  'worktree'
])

/** True when `quirky.yaml` has a top-level key this version of Quirky does not handle. */
export function hasUnrecognizedQuirkyYamlKeys(repoPath: string): boolean {
  try {
    const yamlPath = resolveRepoConfigPath(repoPath, 'yaml')
    if (!yamlPath) {
      return false
    }
    const content = readFileSync(yamlPath, 'utf-8')
    for (const line of iterateLfScriptLines(content)) {
      // Why: match bare `key:` at end-of-line too, since a mapping with a block value on the next line is valid YAML.
      const m = line.match(/^([A-Za-z][A-Za-z0-9_-]*):(\s|$)/)
      if (m != null && !RECOGNIZED_QUIRKY_YAML_KEYS.has(m[1])) {
        return true
      }
    }
    return false
  } catch {
    return false
  }
}

export function getEffectiveHooks(repo: Repo, worktreePath?: string): QuirkyHooks | null {
  const hooksRoot = worktreePath ?? repo.path
  return getEffectiveHooksFromConfig(repo, loadHooks(hooksRoot))
}

export function getSetupCommandSource(
  repo: Repo,
  worktreePath?: string
): { source: 'yaml' | 'local' | 'both'; command: string } | null {
  const hooksRoot = worktreePath ?? repo.path
  const yamlHooks = loadHooks(hooksRoot)
  const yamlSetup = yamlHooks?.scripts.setup?.trim()
  const localSetup = repo.hookSettings?.scripts.setup?.trim()
  const rawPolicy = repo.hookSettings?.commandSourcePolicy
  const policy = resolveHookCommandSourcePolicy(rawPolicy, {
    hasLocalScript: Boolean(localSetup)
  })

  if (policy === 'local-only') {
    return localSetup ? { source: 'local', command: localSetup } : null
  }

  if (policy === 'run-both' && yamlSetup && localSetup) {
    return { source: 'both', command: `${yamlSetup}\n${localSetup}` }
  }

  if (yamlSetup) {
    return { source: 'yaml', command: yamlSetup }
  }

  return null
}

/**
 * Run a named hook script in the given working directory.
 */
export function runHook(
  hookName: 'setup' | 'archive',
  cwd: string,
  repo: Repo,
  hooksPath?: string,
  _projectRuntime?: ProjectExecutionRuntimeResolution | HookRuntimeTarget,
  /** Deadline override. Production uses HOOK_TIMEOUT; tests use it to exercise the timeout path. */
  timeoutMs: number = HOOK_TIMEOUT
  // Why (#19334): an absent exitCode means no exit was ever observed. The archive-hook removal
  // gate reads that as `unverifiable` rather than folding it into a zero.
): Promise<{ success: boolean; output: string; exitCode?: number }> {
  const hooks = getEffectiveHooks(repo, hooksPath)
  const script = hooks?.scripts[hookName]

  if (!script) {
    return Promise.resolve({ success: true, output: '' })
  }

  const shellHookEnv: NodeJS.ProcessEnv = { ...process.env, ...getSetupEnvVars(repo, cwd) }
  dropIncoherentCondaActivationEnv(shellHookEnv)

  return new Promise<HookProcessOutcome>((resolve) => {
    // Why we own the deadline (#19334): Node's `exec({ timeout })` SIGTERMs the child and then
    // reports whatever it chose to do, so a hook that traps SIGTERM and exits 0 came back as a
    // PASS — a hook cut off mid-archive, indistinguishable from one that finished. Settle on the
    // deadline instead, and settle AT it, so a hook that traps and keeps running cannot hold a
    // removal open.
    let settled = false
    let deadline: NodeJS.Timeout | undefined
    const settle = (result: HookProcessOutcome): void => {
      if (settled) {
        return
      }
      settled = true
      if (deadline) {
        clearTimeout(deadline)
      }
      resolve(result)
    }
    // Why `spawn` and not `exec` (#19334 follow-up): `detached` is a spawn-only option — `exec`
    // accepts and ignores it, so the shell never became a group leader and the group signal below
    // had nothing to reach. Passing `shell` as a string keeps Node's own platform invocation, which
    // is what `exec` was being kept for: `cmd.exe /d /s /c` on Windows rather than a bare `-c`.
    const child = spawn(script, {
      cwd,
      shell: getHookShell(),
      // Why: hooks run unattended; block Git Credential Manager's interactive prompt while keeping cached auth (issue #7652).
      env: promptGuardShellEnv(shellHookEnv),
      stdio: ['ignore', 'pipe', 'pipe'],
      // Pinned, not left to Node's default, for the same reason `runProcess` pins it: a `cmd.exe`
      // hook otherwise flashes a console window and takes focus. Pre-existing — `exec` did not set
      // it either — but AGENTS.md asks for it pinned on every Windows spawn.
      windowsHide: true,
      // Make the shell a group leader so its children can be reached. Not on Windows, which has no
      // process groups in this sense and where `detached` means a new console instead.
      ...(process.platform === 'win32' ? {} : { detached: true })
    })
    const stdout = createOutputSink(HOOK_OUTPUT_LIMIT_BYTES)
    const stderr = createOutputSink(HOOK_OUTPUT_LIMIT_BYTES)
    child.stdout?.on('data', (chunk: Buffer | string) => stdout.write(chunk))
    child.stderr?.on('data', (chunk: Buffer | string) => stderr.write(chunk))
    // Why listeners that do nothing: an unhandled `error` on a stream is an uncaught exception, and
    // in the Electron main process that is the whole app. `exec` never covered this either — its
    // only `error` listener is on the child — so this is a pre-existing gap, closed the way
    // `runProcess` closes it. Losing output is not worth a crash; the exit code still gets through.
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      stream?.on('error', () => {})
    }
    child.on('error', (error) => {
      settle(hookProcessError(error, readSink(stdout), readSink(stderr), { hookName, cwd }))
    })
    child.on('close', (code, signal) => {
      settle(
        classifyHookProcessResult(
          // A signalled exit reports no code, which stays `unverifiable` rather than becoming a 0.
          {
            code: signal ? null : code,
            stdout: readSink(stdout),
            stderr: readSink(stderr),
            timedOut: false
          },
          { hookName, cwd, timeoutMs }
        )
      )
    })
    // Why guarded: a spawn failure can settle before the deadline is armed, and arming one on a
    // finished run would later signal a pid that is gone — and may by then belong to something else.
    if (!settled) {
      deadline = setTimeout(() => {
        settle(
          classifyHookProcessResult(
            // Keep what the hook printed: it is the only clue to why the removal gate says
            // `unverifiable`.
            { code: null, stdout: readSink(stdout), stderr: readSink(stderr), timedOut: true },
            { hookName, cwd, timeoutMs }
          )
        )
        // Quirky's own tree terminator: POSIX process groups, `taskkill /t /f` on Windows (where a
        // bare `child.kill` reaches only the shell and leaves its descendants running), and the
        // recycled-pid guard that hazard needs. SIGTERM first so a well-behaved hook can clean up.
        void signalProcessTree(child, 'SIGTERM')
        setTimeout(() => {
          void forceTerminateProcessTree(child)
        }, SIGTERM_GRACE_MS).unref?.()
      }, timeoutMs)
    }
  })
}
