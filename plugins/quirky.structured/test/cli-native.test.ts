import { test, expect } from 'bun:test'
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createProcessScope, type ProcessScope } from '../../../scripts/test-support/process-scope'
import {
  createCodexAppServerFixture,
  isolatedProviderEnvironment,
  type CodexAppServerFixture,
  type CodexAppServerLogEntry
} from './fakes/codex-app-server'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const MODEL = 'gpt-5.5'
const EFFORT = 'high'
const PROMPT = 'summarize this repository'

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

function parseJson(text: string, label: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed
  } catch (error) {
    throw new Error(`${label} did not return JSON: ${text}`, { cause: error })
  }
}

function assertWithin(root: string, candidate: string, label: string): void {
  const relativePath = relative(realpathSync(root), realpathSync(candidate))
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`${label} escaped the disposable process home: ${candidate}`)
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
  timeoutMs = 30_000
): Promise<string> {
  const child = scope.spawn(command, {
    cwd,
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe'
  })
  let timedOut = false
  // Real CLI children need an OS-time watchdog; fake timers cannot terminate them.
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
  timeoutMs = 30_000
): Promise<unknown> {
  const cliEntry = join(REPO_ROOT, 'packages/cli/src/main.ts')
  const output = await runProcess(scope, env, [process.execPath, cliEntry, ...args, '--json'], cwd, `quirky ${args.join(' ')}`, timeoutMs)
  try {
    const parsed: unknown = JSON.parse(output)
    return parsed
  } catch (error) {
    throw new Error(`quirky ${args.join(' ')} did not return JSON: ${output}`, { cause: error })
  }
}

async function waitFor<T>(label: string, readValue: () => Promise<T>, matches: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const value = await readValue()
    if (matches(value)) return value
    // Polling uses separate real CLI processes whose event loops fake timers cannot advance.
    await Bun.sleep(100)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

test('real CLI Codex create applies catalog model and effort through the production runner', async () => {
  const scope = createProcessScope()
  try {
    const fixtureHome = join(scope.home, 'codex-fixture')
    const codexBin = join(scope.home, 'codex-bin')
    mkdirSync(codexBin, { recursive: true })
    const fixture: CodexAppServerFixture = createCodexAppServerFixture(fixtureHome)
    symlinkSync(fixture.executable, join(codexBin, 'codex'))

    const env = buildEnvironment(scope, codexBin)
    writeFileSync(join(scope.home, '.bash_profile'), `export PATH=${shellQuote(env.PATH)}\n`, { mode: 0o600 })

    const projectLocation = join(scope.home, 'projects')
    mkdirSync(projectLocation, { recursive: true })
    const repo = record(
      await runCliJson(scope, env, ['repo', 'create', 'codex-catalog-smoke', '--location', projectLocation], scope.home, 45_000),
      'repo create result'
    )
    const repoId = stringField(repo, 'id', 'repo create result')
    const repoPath = stringField(repo, 'path', 'repo create result')
    assertWithin(scope.home, repoPath, 'repository path')

    writeFileSync(join(repoPath, 'README.md'), '# Codex catalog smoke\n')
    await runProcess(scope, env, ['git', '-C', repoPath, 'config', 'user.name', 'Codex catalog smoke'], repoPath, 'git user.name')
    await runProcess(scope, env, ['git', '-C', repoPath, 'config', 'user.email', 'codex-smoke@example.invalid'], repoPath, 'git user.email')
    await runProcess(scope, env, ['git', '-C', repoPath, 'add', 'README.md'], repoPath, 'git add')
    await runProcess(scope, env, ['git', '-C', repoPath, 'commit', '-m', 'initial smoke repository'], repoPath, 'git commit')
    await runProcess(scope, env, ['git', '-C', repoPath, 'branch', '-M', 'main'], repoPath, 'git branch main')

    const worktreeResult = record(
      await runCliJson(
        scope,
        env,
        ['worktree', 'create', '--repo', `id:${repoId}`, '--name', 'catalog-smoke', '--base', 'main', '--no-parent', '--setup', 'skip'],
        repoPath
      ),
      'worktree create result'
    )
    const worktree = record(worktreeResult.worktree, 'worktree create result.worktree')
    const worktreeId = stringField(worktree, 'id', 'worktree create result.worktree')
    const worktreePath = stringField(worktree, 'path', 'worktree create result.worktree')
    assertWithin(scope.home, worktreePath, 'worktree path')

    const created = record(
      await runCliJson(
        scope,
        env,
        [
          'structured', 'create',
          '--worktree', `id:${worktreeId}`,
          '--agent', 'codex',
          '--prompt', PROMPT,
          '--model', MODEL,
          '--options', JSON.stringify({ effort: EFFORT })
        ],
        worktreePath,
        45_000
      ),
      'structured create result'
    )
    const sessionId = stringField(created, 'id', 'structured create result')
    expect(created.kind).toBe('structured')
    expect(created.agent).toBe('codex')
    expect(created.worktreeId).toBe(worktreeId)
    expect(created.cwd).toBe(worktreePath)

    const completedSession = await waitFor(
      'Codex turn completion',
      async () => runCliJson(scope, env, ['session', 'get', sessionId], worktreePath),
      (value) => isRecord(value) && value.status === 'done' && isRecord(value.providerSession) && value.providerSession.id === 'scripted-thread'
    )
    const session = record(completedSession, 'completed structured session')
    expect(session.kind).toBe('structured')
    expect(session.agent).toBe('codex')
    expect(session.worktreeId).toBe(worktreeId)
    expect(session.cwd).toBe(worktreePath)
    expect(stringField(session.providerSession, 'id', 'structured session providerSession')).toBe('scripted-thread')

    const launchSettings = record(session.launchSettings, 'structured session launchSettings')
    expect(launchSettings.agent).toBe('codex')
    const launchOptions = record(launchSettings.options, 'structured session launchSettings.options')
    expect(record(launchOptions.model, 'launchSettings.options.model').value).toBe(MODEL)
    expect(record(launchOptions.effort, 'launchSettings.options.effort').value).toBe(EFFORT)

    const messages = array(await runCliJson(scope, env, ['structured', 'messages', '--session', sessionId], worktreePath), 'structured messages')
      .map((entry, index) => record(entry, `structured messages[${index}]`))
    expect(messages.some((message) => message.role === 'assistant' && message.text === `Codex: ${PROMPT}`)).toBe(true)

    const turnStart = fixture.requests().find((entry: CodexAppServerLogEntry) => entry.method === 'turn/start')
    const turnParams = record(turnStart?.params, 'native turn/start params')
    expect(turnParams.model).toBe(MODEL)
    expect(turnParams.effort).toBe(EFFORT)
    expect(turnParams.input).toEqual([{ type: 'text', text: PROMPT }])
    await runCliJson(scope, env, ['structured', 'stop', '--session', sessionId], worktreePath)
    const stoppedSession = record(await runCliJson(scope, env, ['session', 'get', sessionId], worktreePath), 'stopped session')
    expect(stoppedSession.status).toBe('exited')

    const resumed = record(await runCliJson(scope, env, ['session', 'resume', sessionId], worktreePath, 45_000), 'session resume result')
    const resumedId = stringField(resumed, 'id', 'session resume result')
    expect(resumedId).not.toBe(sessionId)
    expect(resumed.resumedFrom).toBe(sessionId)
    expect(resumed.kind).toBe('structured')
    expect(resumed.agent).toBe('codex')
    expect(resumed.worktreeId).toBe(worktreeId)
    expect(resumed.cwd).toBe(worktreePath)
    expect(record(resumed.launchSettings, 'resumed session launchSettings')).toEqual(launchSettings)

    await runCliJson(scope, env, ['structured', 'send', '--session', resumedId, '--text', 'continue after public resume'], worktreePath, 45_000)
    const resumedCompleted = await waitFor(
      'resumed Codex turn completion',
      async () => runCliJson(scope, env, ['session', 'get', resumedId], worktreePath),
      (value) => isRecord(value) && value.status === 'done' && isRecord(value.providerSession) && value.providerSession.id === 'scripted-thread'
    )
    const resumedSession = record(resumedCompleted, 'completed resumed session')
    expect(resumedSession.id).toBe(resumedId)
    expect(resumedSession.resumedFrom).toBe(sessionId)
    expect(resumedSession.cwd).toBe(worktreePath)
    expect(resumedSession.worktreeId).toBe(worktreeId)
    expect(stringField(resumedSession.providerSession, 'id', 'resumed session providerSession')).toBe('scripted-thread')
    expect(record(resumedSession.launchSettings, 'resumed session launchSettings')).toEqual(launchSettings)

    const resumedRequests = fixture.requests()
    const threadResume = resumedRequests.find((entry: CodexAppServerLogEntry) => entry.method === 'thread/resume')
    expect(record(threadResume?.params, 'native thread/resume params').threadId).toBe('scripted-thread')
    const turnStarts = resumedRequests.filter((entry: CodexAppServerLogEntry) => entry.method === 'turn/start')
    const resumedTurn = record(turnStarts[turnStarts.length - 1]?.params, 'resumed native turn/start params')
    expect(resumedTurn.threadId).toBe('scripted-thread')
    expect(resumedTurn.model).toBe(MODEL)
    expect(resumedTurn.effort).toBe(EFFORT)
    expect(resumedTurn.input).toEqual([{ type: 'text', text: 'continue after public resume' }])
  } finally {
    await scope.cleanup()
  }
}, 60_000)
