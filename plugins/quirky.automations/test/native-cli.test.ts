import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createProcessScope, type ProcessScope } from '../../../scripts/test-support/process-scope'
import {
  createCodexAppServerFixture,
  isolatedProviderEnvironment,
  type CodexAppServerFixture,
  type CodexAppServerLogEntry
} from '../../quirky.structured/test/fakes/codex-app-server'
import { QuirkyClient } from '../../../packages/protocol/src/index'
import { rpcUrl, type RuntimeInfo } from '../../../packages/protocol/src/node/index'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const CLI_ENTRY = join(REPO_ROOT, 'packages/cli/src/main.ts')
const MODEL = 'gpt-5.5'
const EFFORT = 'high'

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function record(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) throw new Error(`${label} must be an object`)
  return value
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  return value
}

function stringField(value: unknown, key: string, label: string): string {
  const item = record(value, label)[key]
  if (typeof item !== 'string' || item.length === 0) throw new Error(`${label}.${key} must be a non-empty string`)
  return item
}

function numberField(value: unknown, key: string, label: string): number {
  const item = record(value, label)[key]
  if (typeof item !== 'number' || !Number.isFinite(item)) throw new Error(`${label}.${key} must be a finite number`)
  return item
}

function parseJson(text: string, label: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed
  } catch (error) {
    throw new Error(`${label} did not return JSON: ${text}`, { cause: error })
  }
}

function runtimeInfo(value: unknown): RuntimeInfo {
  const runtime = record(value, 'daemon runtime')
  if (runtime.socket !== undefined && typeof runtime.socket !== 'string') {
    throw new Error('daemon runtime.socket must be a string when present')
  }
  return {
    pid: numberField(runtime, 'pid', 'daemon runtime'),
    port: numberField(runtime, 'port', 'daemon runtime'),
    token: stringField(runtime, 'token', 'daemon runtime'),
    hookToken: stringField(runtime, 'hookToken', 'daemon runtime'),
    daemonVersion: stringField(runtime, 'daemonVersion', 'daemon runtime'),
    protocolVersion: numberField(runtime, 'protocolVersion', 'daemon runtime'),
    startedAt: numberField(runtime, 'startedAt', 'daemon runtime'),
    ...(typeof runtime.socket === 'string' ? { socket: runtime.socket } : {})
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function buildEnvironment(scope: ProcessScope, codexBin: string): Record<string, string> {
  const isolated = isolatedProviderEnvironment(scope.home)
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(isolated)) {
    if (typeof value === 'string') env[key] = value
  }

  for (const key of [
    'CODEX_HOME',
    'CLAUDE_CONFIG_DIR',
    'OPENAI_API_KEY',
    'CODEX_API_KEY',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'GITHUB_TOKEN',
    'GH_TOKEN',
    'SSH_AUTH_SOCK',
    'GIT_ASKPASS'
  ]) delete env[key]

  const nodeExecutable = Bun.which('node')
  if (!nodeExecutable) throw new Error('The existing Codex fixture requires node on PATH')
  const pathEntries = [codexBin, dirname(nodeExecutable), dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin']
  env.PATH = [...new Set(pathEntries)].join(':')
  env.HOME = scope.home
  env.QUIRKY_HOME = scope.home
  env.SHELL = '/bin/bash'
  env.NODE_ENV = 'test'
  env.QUIRKY_BUILTIN_PLUGINS_DIR = join(REPO_ROOT, 'plugins')
  return env
}

async function runProcess(
  scope: ProcessScope,
  env: Record<string, string>,
  command: string[],
  cwd: string,
  label: string,
  timeoutMs = 60_000
): Promise<string> {
  const child = scope.spawn(command, {
    cwd,
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe'
  })
  let timedOut = false
  // Real OS time is required: fake parent timers cannot advance daemon, CLI, scheduler, or subprocesses.
  const timer = setTimeout(() => {
    timedOut = true
    try {
      child.kill('SIGKILL')
    } catch {
      // The process scope remains responsible for any surviving descendants.
    }
  }, timeoutMs)

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited
    ])
    if (timedOut) throw new Error(`${label} timed out after ${timeoutMs}ms`)
    if (exitCode !== 0) throw new Error(`${label} exited ${exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`)
    return stdout.trim()
  } finally {
    clearTimeout(timer)
  }
}

async function runCliJson(
  scope: ProcessScope,
  env: Record<string, string>,
  args: string[],
  cwd: string,
  timeoutMs = 60_000
): Promise<unknown> {
  const output = await runProcess(scope, env, [process.execPath, CLI_ENTRY, ...args, '--json'], cwd, `quirky ${args.join(' ')}`, timeoutMs)
  return parseJson(output, `quirky ${args.join(' ')}`)
}

async function waitFor<T>(
  label: string,
  readValue: () => Promise<T>,
  matches: (value: T) => boolean,
  timeoutMs = 25_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let value: T
  while (Date.now() < deadline) {
    value = await readValue()
    if (matches(value)) return value
    // Poll with real time; fake timers cannot advance daemon API, CLI, or OS-process work.
    await Bun.sleep(100)
  }
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(value!)}`)
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const limit = 32_000
  let output = ''
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      output += decoder.decode(chunk.value, { stream: true })
      if (output.length > limit) output = output.slice(-limit)
    }
    output += decoder.decode()
    return output.length > limit ? output.slice(-limit) : output
  } finally {
    reader.releaseLock()
  }
}

async function latestRun(client: QuirkyClient, automationId: string): Promise<JsonRecord | null> {
  const result = record(
    await client.callAny('quirky.automations/runs', { automationId, limit: 100 }),
    'automation runs result'
  )
  const runs = array(result.runs, 'automation runs result.runs')
  const latest = runs[0]
  return latest === undefined ? null : record(latest, 'latest automation run')
}

test('real CLI and daemon automate native Codex runs, reuse, failures, scheduling, and workspace retention', async () => {
  const scope = createProcessScope()
  const home = scope.home
  let client: QuirkyClient | undefined
  let daemon: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined
  let daemonLogs: Promise<string>[] = []
  let failed = false

  try {
    const bin = join(home, 'bin')
    mkdirSync(bin)
    const fixture: CodexAppServerFixture = createCodexAppServerFixture(join(home, 'native'))
    symlinkSync(fixture.executable, join(bin, 'codex'))

    const env = buildEnvironment(scope, bin)
    writeFileSync(join(home, '.bash_profile'), `export PATH=${shellQuote(env.PATH)}\n`, { mode: 0o600 })

    daemon = scope.spawn([process.execPath, join(REPO_ROOT, 'packages/daemon/src/main.ts')], {
      cwd: REPO_ROOT,
      env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe'
    })
    daemonLogs = [drain(daemon.stdout), drain(daemon.stderr)]
    const runtimePath = join(home, 'runtime.json')
    const runtime = await waitFor(
      'daemon runtime',
      async () => existsSync(runtimePath) ? runtimeInfo(parseJson(readFileSync(runtimePath, 'utf8'), 'daemon runtime')) : null,
      (value): value is RuntimeInfo => value !== null
    )
    client = await QuirkyClient.connect(rpcUrl(runtime), { role: 'cli' })

    const projectLocation = join(home, 'projects')
    mkdirSync(projectLocation)
    const repo = record(
      await runCliJson(scope, env, ['repo', 'create', 'dispatch-smoke', '--location', projectLocation], home),
      'repo create result'
    )
    const repoId = stringField(repo, 'id', 'repo create result')
    const repoPath = stringField(repo, 'path', 'repo create result')
    writeFileSync(join(repoPath, 'README.md'), '# Dispatch smoke\n')
    await runProcess(scope, env, ['git', 'config', 'user.name', 'Dispatch smoke'], repoPath, 'git config user.name')
    await runProcess(scope, env, ['git', 'config', 'user.email', 'dispatch@example.invalid'], repoPath, 'git config user.email')
    await runProcess(scope, env, ['git', 'add', 'README.md'], repoPath, 'git add')
    await runProcess(scope, env, ['git', 'commit', '-m', 'initial'], repoPath, 'git commit')
    await runProcess(scope, env, ['git', 'branch', '-M', 'main'], repoPath, 'git branch main')

    const worktreeResult = record(
      await runCliJson(
        scope,
        env,
        ['worktree', 'create', '--repo', `id:${repoId}`, '--name', 'existing', '--base', 'main', '--no-parent', '--setup', 'skip'],
        repoPath
      ),
      'worktree create result'
    )
    const worktree = record(worktreeResult.worktree, 'worktree create result.worktree')
    const worktreeId = stringField(worktree, 'id', 'worktree create result.worktree')
    const worktreePath = stringField(worktree, 'path', 'worktree create result.worktree')

    const auto = record(
      await runCliJson(
        scope,
        env,
        [
          'automations', 'create',
          '--name', 'Manual reuse',
          '--prompt', 'first smoke turn',
          '--provider', 'codex',
          '--project', repoId,
          '--workspace', worktreeId,
          '--trigger', 'daily',
          '--disabled',
          '--reuse-session',
          '--model', MODEL,
          '--effort', EFFORT,
          '--precheck', 'false'
        ],
        repoPath
      ),
      'automation create result'
    )
    const autoId = stringField(auto, 'id', 'automation create result')
    expect(record(auto.owner, 'automation create result.owner').kind).toBe('local')

    const terminalBeforeResult = record(
      await client.callAny('quirky.terminal/workspace', { workspace: worktreeId }),
      'terminal workspace result before manual runs'
    )
    const terminalBefore = record(terminalBeforeResult.workspace, 'terminal workspace before manual runs')
    const terminalRootBefore = record(terminalBefore.root, 'terminal workspace root before manual runs')
    const uiBeforeResult = record(await client.callAny('ui.state', {}), 'UI state before manual runs')
    const uiLayoutBefore = record(uiBeforeResult.layout, 'UI layout before manual runs')

    const first = record(await runCliJson(scope, env, ['automations', 'run', autoId], repoPath), 'first manual run result')
    const firstRunId = stringField(first, 'id', 'first manual run result')
    const done = record(
      await waitFor(
        'manual completion',
        () => latestRun(client!, autoId),
        (value) => isRecord(value) && value.status === 'completed'
      ),
      'completed manual run'
    )
    const sessionId = stringField(done, 'sessionId', 'completed manual run')
    expect(stringField(done, 'id', 'completed manual run')).toBe(firstRunId)
    expect(done.sessionKind).toBe('structured')
    expect(record(done.outputSnapshot, 'completed manual run.outputSnapshot').content).toBe('Codex: first smoke turn')
    expect(done.precheckResult ?? null).toBeNull()
    const launchSettings = record(done.launchSettings, 'completed manual run.launchSettings')
    const launchOptions = record(launchSettings.options, 'completed manual run.launchSettings.options')
    expect(record(launchOptions.model, 'completed launch model').value).toBe(MODEL)
    expect(record(launchOptions.effort, 'completed launch effort').value).toBe(EFFORT)

    await runCliJson(scope, env, ['automations', 'edit', autoId, '--prompt', 'second smoke turn'], repoPath)
    const second = record(await runCliJson(scope, env, ['automations', 'run', autoId], repoPath), 'second manual run result')
    const secondRunId = stringField(second, 'id', 'second manual run result')
    const reused = record(
      await waitFor(
        'reused completion',
        () => latestRun(client!, autoId),
        (value) => isRecord(value) && value.id === secondRunId && value.status === 'completed'
      ),
      'completed reused run'
    )
    expect(stringField(reused, 'sessionId', 'completed reused run')).toBe(sessionId)
    expect(record(reused.outputSnapshot, 'completed reused run.outputSnapshot').content).toBe('Codex: second smoke turn')
    const usage = record(reused.usage, 'completed reused run.usage')
    expect(usage.status).toBe('unavailable')
    expect(usage.estimatedCostUsd).toBeNull()
    expect(usage.inputTokens).toBeUndefined()
    expect(usage.outputTokens).toBeUndefined()
    expect(usage.totalTokens).toBeUndefined()

    const session = record(await client.callAny('quirky.session/get', { session: sessionId }), 'reused session')
    expect(session.background).toBe(true)
    const terminalAfterResult = record(
      await client.callAny('quirky.terminal/workspace', { workspace: worktreeId }),
      'terminal workspace result after manual runs'
    )
    const terminalAfter = record(terminalAfterResult.workspace, 'terminal workspace after manual runs')
    expect(record(terminalAfter.root, 'terminal workspace root after manual runs')).toEqual(terminalRootBefore)
    const uiAfterResult = record(await client.callAny('ui.state', {}), 'UI state after manual runs')
    expect(record(uiAfterResult.layout, 'UI layout after manual runs')).toEqual(uiLayoutBefore)

    const turns = fixture.requests().filter((entry: CodexAppServerLogEntry) => entry.method === 'turn/start')
    expect(turns).toHaveLength(2)
    const firstTurnParams = record(turns[0]?.params, 'first native turn/start params')
    expect(firstTurnParams.model).toBe(MODEL)
    expect(firstTurnParams.effort).toBe(EFFORT)

    // The fixture deliberately reuses one provider thread ID; stop it after proving live reuse.
    await client.callAny('quirky.structured/stop', { session: sessionId })

    const failedAuto = record(
      await runCliJson(
        scope,
        env,
        [
          'automations', 'create',
          '--name', 'Failed native',
          '--prompt', '[failed]',
          '--provider', 'codex',
          '--project', repoId,
          '--workspace', worktreeId,
          '--trigger', 'daily',
          '--disabled'
        ],
        repoPath
      ),
      'failed automation create result'
    )
    const failedAutoId = stringField(failedAuto, 'id', 'failed automation create result')
    await runCliJson(scope, env, ['automations', 'run', failedAutoId], repoPath)
    const failedRun = record(
      await waitFor(
        'failed native evidence',
        () => latestRun(client!, failedAutoId),
        (value) => isRecord(value) && value.status === 'dispatch_failed'
      ),
      'failed native run'
    )
    expect(failedRun.status).toBe('dispatch_failed')

    const fresh = record(
      await runCliJson(
        scope,
        env,
        [
          'automations', 'create',
          '--name', 'New run',
          '--prompt', 'new workspace smoke',
          '--provider', 'codex',
          '--project', repoId,
          '--workspace-mode', 'new-per-run',
          '--base-branch', 'main',
          '--setup-decision', 'skip',
          '--trigger', 'daily',
          '--disabled'
        ],
        repoPath
      ),
      'fresh automation create result'
    )
    const freshId = stringField(fresh, 'id', 'fresh automation create result')
    await runCliJson(scope, env, ['automations', 'run', freshId], repoPath)
    const created = record(
      await waitFor(
        'new workspace completion',
        () => latestRun(client!, freshId),
        (value) => isRecord(value) && value.status === 'completed'
      ),
      'completed new-workspace run'
    )
    const createdWorkspaceId = stringField(created, 'workspaceId', 'completed new-workspace run')
    expect(createdWorkspaceId).not.toBe(worktreeId)
    const actualNew = record(
      await client.callAny('quirky.worktree/resolve', { selector: `id:${createdWorkspaceId}` }),
      'new workspace resolution'
    )
    expect(stringField(actualNew, 'name', 'new workspace resolution')).toMatch(/^auto-/)

    const scheduled = record(
      await runCliJson(
        scope,
        env,
        [
          'automations', 'create',
          '--name', 'Scheduled precheck',
          '--prompt', 'should not launch',
          '--provider', 'codex',
          '--project', repoId,
          '--workspace', worktreeId,
          '--trigger', '* * * * *',
          '--precheck', 'printf scheduled-check; exit 7'
        ],
        repoPath
      ),
      'scheduled automation create result'
    )
    const scheduledId = stringField(scheduled, 'id', 'scheduled automation create result')
    const skipped = record(
      await waitFor(
        'actual scheduler/precheck',
        () => latestRun(client!, scheduledId),
        (value) => isRecord(value) && value.status === 'skipped_precheck',
        85_000
      ),
      'skipped scheduled run'
    )
    expect(skipped.trigger).toBe('scheduled')
    const precheckResult = record(skipped.precheckResult, 'skipped scheduled run.precheckResult')
    expect(numberField(precheckResult, 'exitCode', 'scheduled precheck result')).toBe(7)
    expect(stringField(precheckResult, 'stdout', 'scheduled precheck result')).toContain('scheduled-check')

    await runCliJson(scope, env, ['automations', 'edit', scheduledId, '--disabled'], repoPath)
    const history = record(await runCliJson(scope, env, ['automations', 'runs', '--id', autoId], repoPath), 'automation run history')
    const historicalRuns = array(history.runs, 'automation run history.runs')
    expect(historicalRuns.some((value, index) =>
      stringField(value, 'id', `automation run history.runs[${index}]`) === firstRunId
    )).toBe(true)

    await runCliJson(scope, env, ['automations', 'remove', freshId, '--yes'], repoPath)
    const kept = record(
      await client.callAny('quirky.worktree/resolve', { selector: `id:${createdWorkspaceId}` }),
      'retained workspace resolution'
    )
    expect(stringField(kept, 'id', 'retained workspace resolution')).toBe(createdWorkspaceId)
  } catch (error) {
    failed = true
    throw error
  } finally {
    client?.close()
    await scope.cleanup()
    if (daemon) await daemon.exited
    const [stdout, stderr] = await Promise.all(daemonLogs)
    if (failed && (stdout.length > 0 || stderr.length > 0)) {
      console.error('daemon logs:', JSON.stringify({ stdout, stderr }))
    }
    expect(existsSync(home)).toBe(false)
  }
}, 150_000)
