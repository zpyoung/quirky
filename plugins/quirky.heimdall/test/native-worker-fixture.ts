import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { QuirkyClient, type Repo, type Worktree } from '@quirky/protocol'
import { isDaemonAlive, readRuntime, rpcUrl, type RuntimeInfo } from '@quirky/protocol/node'
import { daemonUrl } from '../../../apps/desktop/src/bun/page'
import { createProcessScope, type ProcessScope } from '../../../scripts/test-support/process-scope'
import { createCodexAppServerFixture } from '../../quirky.structured/test/fakes/codex-app-server'
import { fixtureId, installControlFixture } from './control-fixture'
import type { WatcherDetail } from '../src/control-contracts'

const NATIVE_PLUGIN_ROOTS = ['quirky.heimdall', 'quirky.structured'] as const
const STARTUP_TIMEOUT_MS = 45_000
const WORKER_READY_TIMEOUT_MS = 90_000
const PROVIDER_READY_TIMEOUT_MS = 15_000
const COMMAND_TIMEOUT_MS = 30_000
const QUESTION_TIMEOUT_MS = 90_000

export type EnrolledQuestionWorker = {
  watcherId: string
  dispatchId: string
  sessionId: string
  processIncarnation: string
  messageId: string
}

export type NativeQuestionEvidence = {
  providerPid: number
  sessionId: string | null
  sessionTokenPresent: boolean
  cliPid: number | null
  code: number | null
  stdout: string
  stderr: string
  spawnError?: string
}

export type NativeControlFixture = {
  root: string
  home: string
  userHome: string
  client: QuirkyClient
  daemon: Bun.Subprocess<'ignore', 'pipe', 'pipe'>
  scope: ProcessScope
  runtime: RuntimeInfo
  uiUrl: string
  evidencePaths: {
    trigger: string
    questionSend: string
    providerPid: string
    providerLog: string
    providerEnvironmentLog: string
  }
  enrollQuestionWorker(): Promise<EnrolledQuestionWorker>
  readQuestionEvidence(): Promise<NativeQuestionEvidence>
  runCli(args: string[]): Promise<{ stdout: string; stderr: string; code: number }>
  cleanup(): Promise<void>
}

type CommandOutput = { stdout: string; stderr: string; code: number }
type ReadyObservation<T> = { ready: true; value: T; observed: string } | { ready: false; observed: string }
type AttachedWorker = {
  detail: WatcherDetail
  dispatchId: string
  sessionId: string
  processIncarnation: string
}

function privateEnvironment(userHome: string, quirkyHome: string, builtinDir: string, path: string, tempDir: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (typeof value === 'string') env[key] = value
  for (const key of Object.keys(env)) {
    if (/^(?:ANTHROPIC|AWS|AZURE|CLAUDE|CODEX|CURSOR|DROID|GEMINI|GOOGLE|GROK|OPENAI|OPENCODE|OPENROUTER|XAI)_/.test(key) ||
        /^(?:http|https|all|no)_proxy$/i.test(key) ||
        /^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+|PARAMETERS)$/.test(key)) delete env[key]
  }
  for (const key of [
    'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX', 'GIT_CEILING_DIRECTORIES',
    'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL',
    'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GITHUB_TOKEN', 'GITLAB_TOKEN',
    'QUIRKY_SESSION_ID', 'QUIRKY_SESSION_TOKEN', 'QUIRKY_WORKTREE_ID', 'SSH_AUTH_SOCK', 'SSH_AGENT_PID',
    'GIT_ASKPASS', 'GIT_SSH', 'GIT_SSH_COMMAND'
  ]) delete env[key]
  Object.assign(env, {
    HOME: userHome,
    QUIRKY_HOME: quirkyHome,
    QUIRKY_BUILTIN_PLUGINS_DIR: builtinDir,
    PATH: path,
    SHELL: '/bin/zsh',
    TMPDIR: tempDir,
    XDG_CACHE_HOME: join(userHome, '.cache'),
    XDG_CONFIG_HOME: join(userHome, '.config'),
    XDG_DATA_HOME: join(userHome, '.local', 'share'),
    XDG_RUNTIME_DIR: tempDir,
    XDG_STATE_HOME: join(userHome, '.local', 'state'),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_TERMINAL_PROMPT: '0'
  })
  return env
}

async function runOwnedProcess(
  scope: ProcessScope,
  command: string[],
  options: { cwd: string; env: Record<string, string>; timeoutMs: number; label: string }
): Promise<CommandOutput> {
  const child = scope.spawn(command, {
    cwd: options.cwd,
    env: options.env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe'
  })
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    child.kill('SIGKILL')
  }, options.timeoutMs)
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited
    ])
    if (timedOut) {
      throw new Error(`${options.label} exceeded ${options.timeoutMs}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`)
    }
    return { stdout, stderr, code }
  } finally {
    clearTimeout(timeout)
  }
}

async function requireCommandSuccess(
  scope: ProcessScope,
  command: string[],
  options: { cwd: string; env: Record<string, string>; timeoutMs: number; label: string }
): Promise<CommandOutput> {
  const result = await runOwnedProcess(scope, command, options)
  if (result.code !== 0) {
    throw new Error(`${options.label} exited ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
  }
  return result
}

async function waitForReady<T>(
  description: string,
  timeoutMs: number,
  observe: () => Promise<ReadyObservation<NoInfer<T>>>
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let lastObservation = 'no state observed'
  for (;;) {
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) break
    const timeout = Promise.withResolvers<ReadyObservation<NoInfer<T>>>()
    const timer = setTimeout(() => timeout.resolve({
      ready: false,
      observed: `the ${description} state query did not return before its deadline`
    }), remainingMs)
    const current = await Promise.race([observe(), timeout.promise]).finally(() => clearTimeout(timer))
    lastObservation = current.observed
    if (current.ready) {
      if (Date.now() <= deadline) return current.value
      lastObservation = `ready state observed after deadline: ${current.observed}`
      break
    }
    const delayMs = deadline - Date.now()
    if (delayMs <= 0) break
    await Bun.sleep(Math.min(50, delayMs))
  }
  throw new Error(`Timed out waiting for ${description}; last observed state: ${lastObservation}`)
}

function assertRecord(value: unknown, description: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${description} returned a non-object response`)
  }
  return value as Record<string, unknown>
}

function installQuestionInstrumentation(options: {
  executable: string
  triggerPath: string
  resultPath: string
  providerPidPath: string
  bunPath: string
  cliEntry: string
}): void {
  const source = `
const nativeQuestionTrigger = ${JSON.stringify(options.triggerPath)};
const nativeQuestionResult = ${JSON.stringify(options.resultPath)};
const nativeProviderPid = ${JSON.stringify(options.providerPidPath)};
const nativeQuestionBun = ${JSON.stringify(options.bunPath)};
const nativeQuestionCli = ${JSON.stringify(options.cliEntry)};
let nativeQuestionStarted = false;
const nativeSendQuestion = () => {
  if (nativeQuestionStarted || !fs.existsSync(nativeQuestionTrigger)) return;
  nativeQuestionStarted = true;
  nativeQuestionWatcher.close();
  const child = spawn(nativeQuestionBun, [nativeQuestionCli, 'orchestration', 'send', '--type', 'question', '--subject', 'Fixture', '--body', 'Continue?', '--json'], {
    cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  let recorded = false;
  const record = (code, spawnError) => {
    if (recorded) return;
    recorded = true;
    const temporaryResult = nativeQuestionResult + '.tmp';
    fs.writeFileSync(temporaryResult, JSON.stringify({
      providerPid: process.pid,
      sessionId: process.env.QUIRKY_SESSION_ID ?? null,
      sessionTokenPresent: typeof process.env.QUIRKY_SESSION_TOKEN === 'string' && process.env.QUIRKY_SESSION_TOKEN.length > 0,
      cliPid: child.pid ?? null,
      code, stdout, stderr,
      ...(spawnError ? { spawnError: String(spawnError) } : {})
    }), { mode: 0o600 });
    fs.renameSync(temporaryResult, nativeQuestionResult);
  };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.once('error', error => record(null, error));
  child.once('close', code => record(code, null));
};
const nativeQuestionWatcher = fs.watch(${JSON.stringify(dirname(options.triggerPath))}, { persistent: false }, (_event, filename) => {
  if (!filename || String(filename) === ${JSON.stringify(basename(options.triggerPath))}) nativeSendQuestion();
});
fs.writeFileSync(nativeProviderPid, String(process.pid), { mode: 0o600 });
`
  appendFileSync(options.executable, source)
}

export async function startNativeControlFixture(): Promise<NativeControlFixture> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'heimdall-native-worker-')))
  const home = join(root, 'quirky-home')
  const userHome = join(root, 'private-home')
  const tempDir = join(root, 'tmp')
  const builtinDir = join(root, 'builtins')
  const providerBin = join(root, 'provider-bin')
  const providerHome = join(root, 'native-provider')
  const triggerPath = join(root, 'send-worker-question')
  const questionSendPath = join(root, 'worker-question-cli.json')
  const providerPidPath = join(root, 'native-provider.pid')
  const repoRoot = resolve(import.meta.dir, '../../..')
  const pluginRoot = resolve(import.meta.dir, '../../')
  const daemonEntry = join(repoRoot, 'packages/daemon/src/main.ts')
  const cliEntry = join(repoRoot, 'packages/cli/src/main.ts')
  const processExecutable = process.execPath
  const nodeExecutable = Bun.which('node')
  const gitExecutable = Bun.which('git')
  if (!nodeExecutable || !gitExecutable) {
    rmSync(root, { recursive: true, force: true })
    throw new Error('native worker fixture requires installed node and git executables')
  }

  const path = `${providerBin}:/usr/bin:/bin:/usr/sbin:/sbin`
  const loginProfile = `export PATH='${path}'\n`

  let scope: ProcessScope | undefined
  let daemon: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined
  let client: QuirkyClient | undefined
  let cleanupPromise: Promise<void> | undefined
  let daemonStdout = ''
  let daemonStderr = ''
  let stdoutCaptured: Promise<void> = Promise.resolve()
  let stderrCaptured: Promise<void> = Promise.resolve()
  const cleanup = (): Promise<void> => {
    if (cleanupPromise) return cleanupPromise
    cleanupPromise = (async () => {
      const failures: unknown[] = []
      const attempt = async (action: () => void | Promise<void>) => {
        try {
          await action()
        } catch (error) {
          failures.push(error)
        }
      }
      await attempt(() => client?.close())
      if (daemon && daemon.exitCode === null) {
        await attempt(async () => {
          daemon!.kill('SIGTERM')
          const exited = Promise.withResolvers<void>()
          const timer = setTimeout(exited.resolve, 5_000)
          try {
            await Promise.race([daemon!.exited.then(() => {}), exited.promise])
          } finally {
            clearTimeout(timer)
          }
        })
      }
      if (scope) await attempt(() => scope!.cleanup())
      await attempt(async () => { await Promise.all([stdoutCaptured, stderrCaptured]) })
      await attempt(() => rmSync(root, { recursive: true, force: true }))
      if (failures.length) throw new AggregateError(failures, 'native worker fixture cleanup failed')
    })()
    return cleanupPromise
  }

  const linkedPlugins = new Set<string>()
  const linkPlugin = (id: string): void => {
    if (linkedPlugins.has(id)) return
    const dir = join(pluginRoot, id)
    const manifest: unknown = JSON.parse(readFileSync(join(dir, 'quirky-plugin.json'), 'utf8'))
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
      throw new Error(`Invalid plugin manifest for ${id}`)
    }
    linkedPlugins.add(id)
    symlinkSync(dir, join(builtinDir, id))
    if ('dependencies' in manifest) {
      if (!Array.isArray(manifest.dependencies)) throw new Error(`Invalid dependencies in ${id}`)
      const dependencies: unknown[] = manifest.dependencies
      for (const dependency of dependencies) {
        if (typeof dependency !== 'string') throw new Error(`Invalid dependency in ${id}`)
        linkPlugin(dependency)
      }
    }
  }
  try {
    mkdirSync(userHome, { recursive: true, mode: 0o700 })
    mkdirSync(tempDir, { recursive: true, mode: 0o700 })
    mkdirSync(builtinDir, { recursive: true, mode: 0o700 })
    mkdirSync(providerBin, { recursive: true, mode: 0o700 })
    writeFileSync(join(userHome, '.zprofile'), loginProfile, { mode: 0o600 })
    writeFileSync(join(userHome, '.bash_profile'), loginProfile, { mode: 0o600 })
    for (const id of NATIVE_PLUGIN_ROOTS) linkPlugin(id)
    installControlFixture(builtinDir)
    scope = createProcessScope(home)

    const codex = createCodexAppServerFixture(providerHome)
    installQuestionInstrumentation({
      executable: codex.executable,
      triggerPath,
      resultPath: questionSendPath,
      providerPidPath,
      bunPath: processExecutable,
      cliEntry
    })
    symlinkSync(codex.executable, join(providerBin, 'codex'))
    symlinkSync(nodeExecutable, join(providerBin, 'node'))

    const env = privateEnvironment(userHome, home, builtinDir, path, tempDir)
    daemon = scope.spawn([processExecutable, daemonEntry], {
      cwd: repoRoot,
      env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe'
    })
    stdoutCaptured = new Response(daemon.stdout).text().then(text => { daemonStdout += text })
    stderrCaptured = new Response(daemon.stderr).text().then(text => { daemonStderr += text })
    const runtime = await waitForReady<RuntimeInfo>('isolated quirkyd runtime', STARTUP_TIMEOUT_MS, async (): Promise<ReadyObservation<RuntimeInfo>> => {
      if (daemon!.exitCode !== null) {
        await Promise.all([stdoutCaptured, stderrCaptured])
        throw new Error(`isolated quirkyd exited ${daemon!.exitCode}\nstdout:\n${daemonStdout}\nstderr:\n${daemonStderr}`)
      }
      const info = readRuntime(home)
      if (info && await isDaemonAlive(info, 300)) {
        return { ready: true, value: info, observed: `healthy daemon pid=${info.pid} port=${info.port}` }
      }
      return {
        ready: false,
        observed: info ? `runtime pid=${info.pid} was not answering health checks` : 'runtime.json has not been published'
      }
    })
    let connection: { client: QuirkyClient } | { error: unknown } | undefined
    void QuirkyClient.connect(rpcUrl(runtime), { role: 'cli', name: 'heimdall-native-worker-acceptance' }).then(
      connected => {
        if (cleanupPromise) connected.close()
        else connection = { client: connected }
      },
      error => { connection = { error } }
    )
    client = await waitForReady<QuirkyClient>('daemon RPC client connection', 15_000, async (): Promise<ReadyObservation<QuirkyClient>> => {
      if (!connection) return { ready: false, observed: `WebSocket handshake to healthy daemon pid=${runtime.pid} is pending` }
      if ('error' in connection) throw connection.error
      return { ready: true, value: connection.client, observed: `RPC client connected to daemon pid=${runtime.pid}` }
    })
    const pluginInfos = await client.call('plugin.list', {})
    const requiredPlugins = [fixtureId, 'quirky.heimdall', 'quirky.orchestration', 'quirky.structured'].map(id => {
      const plugin = pluginInfos.find(candidate => candidate.id === id)
      return {
        id,
        state: plugin?.state ?? 'missing',
        diagnostics: plugin?.diagnostics ?? []
      }
    })
    const unavailablePlugins = requiredPlugins.filter(plugin =>
      plugin.state === 'missing' || plugin.state === 'failed' || plugin.state === 'disabled' || plugin.state === 'invalid'
    )
    if (unavailablePlugins.length > 0) {
      throw new Error(`real daemon cannot use required built-in plugin(s) ${unavailablePlugins.map(plugin => plugin.id).join(', ')}; public plugin.list diagnostics: ${JSON.stringify(requiredPlugins)}`)
    }

    let enrollPromise: Promise<EnrolledQuestionWorker> | undefined
    const runCli = (args: string[]) => runOwnedProcess(scope!, [processExecutable, cliEntry, ...args], {
      cwd: repoRoot,
      env,
      timeoutMs: COMMAND_TIMEOUT_MS,
      label: `actual CLI ${args.join(' ')}`
    })

    const enrollQuestionWorker = (): Promise<EnrolledQuestionWorker> => {
      if (enrollPromise) return enrollPromise
      const pending = (async () => {
        const repositoryPath = join(root, 'native-repository')
        const worktreesRoot = join(root, 'worktrees')
        const specPath = join(repositoryPath, 'actual.md')
        mkdirSync(repositoryPath, { recursive: true, mode: 0o700 })
        mkdirSync(worktreesRoot, { recursive: true, mode: 0o700 })
        await requireCommandSuccess(scope!, [gitExecutable, 'init', '-q'], {
          cwd: repositoryPath, env, timeoutMs: COMMAND_TIMEOUT_MS, label: 'git init'
        })
        await requireCommandSuccess(scope!, [gitExecutable, 'config', 'user.name', 'Native Worker Fixture'], {
          cwd: repositoryPath, env, timeoutMs: COMMAND_TIMEOUT_MS, label: 'git config user.name'
        })
        await requireCommandSuccess(scope!, [gitExecutable, 'config', 'user.email', 'native-worker-fixture@example.invalid'], {
          cwd: repositoryPath, env, timeoutMs: COMMAND_TIMEOUT_MS, label: 'git config user.email'
        })
        await requireCommandSuccess(scope!, [gitExecutable, 'config', 'commit.gpgsign', 'false'], {
          cwd: repositoryPath, env, timeoutMs: COMMAND_TIMEOUT_MS, label: 'git config commit.gpgsign'
        })
        writeFileSync(specPath, '# Native worker acceptance task\nKeep this structured provider turn live. [hold]\n', { mode: 0o600 })
        await requireCommandSuccess(scope!, [gitExecutable, 'add', 'actual.md'], {
          cwd: repositoryPath, env, timeoutMs: COMMAND_TIMEOUT_MS, label: 'git add actual.md'
        })
        await requireCommandSuccess(scope!, [gitExecutable, 'commit', '-q', '-m', 'Add native worker task specification'], {
          cwd: repositoryPath, env, timeoutMs: COMMAND_TIMEOUT_MS, label: 'git commit initial repository state'
        })
        await requireCommandSuccess(scope!, [gitExecutable, 'branch', '-M', 'main'], {
          cwd: repositoryPath, env, timeoutMs: COMMAND_TIMEOUT_MS, label: 'git branch -M main'
        })

        await client!.callAny('setting.set', { id: 'setting:quirky.worktree/worktreesRoot', value: worktreesRoot })
        const repo = assertRecord(await client!.callAny('quirky.repo/add', { path: repositoryPath }), 'quirky.repo/add') as unknown as Repo
        if (typeof repo.id !== 'string' || repo.path !== repositoryPath) throw new Error('quirky.repo/add did not return the isolated Git repository')
        const worktrees = await client!.callAny('quirky.worktree/list', { repo: repo.id }) as Worktree[]
        const mainWorktrees = worktrees.filter(worktree => worktree.repoId === repo.id && worktree.isMain && resolve(worktree.path) === repositoryPath)
        if (mainWorktrees.length !== 1 || typeof mainWorktrees[0]?.id !== 'string') {
          throw new Error(`quirky.worktree/list did not return exactly one actual main worktree: ${JSON.stringify(worktrees)}`)
        }
        const mainwt = mainWorktrees[0]
        const workerRequest = {
          spec: specPath,
          worktree: `id:${mainwt.id}`,
          agent: 'codex',
          mode: 'structured' as const
        }
        const enrollment = assertRecord(await client!.callAny('quirky.heimdall/enroll', {
          kind: 'objective',
          kindPayload: {
            workspace: 'native-worker',
            objectiveText: 'Keep the actual structured worker available for operator controls.',
            repoId: repo.id,
            worktreeId: mainwt.id,
            maxConcurrency: 1,
            mode: 'worker',
            workerRequest
          },
          capabilities: { 'fixture.write': 'on' }
        }), 'quirky.heimdall/enroll')
        if (enrollment.kind !== 'enrolled') throw new Error(`worker fixture enrollment was not accepted: ${JSON.stringify(enrollment)}`)
        const enrollmentData = assertRecord(enrollment.enrollment, 'quirky.heimdall/enroll enrollment')
        if (typeof enrollmentData.watcherId !== 'string') throw new Error('worker fixture enrollment omitted watcherId')
        const watcherId = enrollmentData.watcherId

        const attached = await waitForReady<AttachedWorker>(`live structured worker attachment for ${watcherId}`, WORKER_READY_TIMEOUT_MS, async (): Promise<ReadyObservation<AttachedWorker>> => {
          const detail = await client!.callAny('quirky.heimdall/detail', { target: { watcherId } }) as WatcherDetail | null
          if (!detail) return { ready: false, observed: 'public detail returned null before worker attachment' }
          const worker = detail.workers.find(candidate =>
            candidate.state === 'live' &&
            typeof candidate.identity.sessionId === 'string' &&
            typeof candidate.identity.processIncarnation === 'string'
          )
          if (worker) {
            const sessionId = worker.identity.sessionId
            const processIncarnation = worker.identity.processIncarnation
            if (typeof sessionId === 'string' && typeof processIncarnation === 'string') {
              return {
                ready: true,
                value: {
                  detail,
                  dispatchId: worker.identity.dispatchId,
                  sessionId,
                  processIncarnation
                },
                observed: `attached live dispatch=${worker.identity.dispatchId} session=${sessionId} incarnation=${processIncarnation}`
              }
            }
          }
          return { ready: false, observed: JSON.stringify({ status: detail.status, enrollment: detail.enrollment, workers: detail.workers }) }
        })
        if (attached.detail.enrollment.worktreeId !== mainwt.id || attached.detail.enrollment.repoId !== repo.id) {
          throw new Error(`Heimdall detail does not identify the actual private repo/worktree: ${JSON.stringify(attached.detail.enrollment)}`)
        }
        await waitForReady<number>(`attached provider process for ${attached.dispatchId}`, PROVIDER_READY_TIMEOUT_MS, async (): Promise<ReadyObservation<number>> => {
          const detail = await client!.callAny('quirky.heimdall/detail', { target: { watcherId } }) as WatcherDetail | null
          if (!detail) return { ready: false, observed: 'public detail returned null while waiting for provider process' }
          const live = detail.workers.some(candidate =>
            candidate.state === 'live' &&
            candidate.identity.dispatchId === attached.dispatchId &&
            candidate.identity.sessionId === attached.sessionId &&
            candidate.identity.processIncarnation === attached.processIncarnation
          )
          const pidText = existsSync(providerPidPath) ? readFileSync(providerPidPath, 'utf8').trim() : ''
          const providerPid = Number(pidText)
          if (live && Number.isSafeInteger(providerPid) && providerPid > 0) {
            return { ready: true, value: providerPid, observed: `live dispatch=${attached.dispatchId} provider pid=${providerPid}` }
          }
          return { ready: false, observed: JSON.stringify({ live, providerPid: pidText || null, status: detail.status }) }
        })

        writeFileSync(triggerPath, 'send the question from the attached worker\n', { mode: 0o600 })
        const asked = await waitForReady<string>(`worker question and parked watcher for ${watcherId}`, QUESTION_TIMEOUT_MS, async (): Promise<ReadyObservation<string>> => {
          const detail = await client!.callAny('quirky.heimdall/detail', { target: { watcherId } }) as WatcherDetail | null
          if (!detail) return { ready: false, observed: 'public detail returned null while waiting for worker question' }
          if (existsSync(questionSendPath)) {
            const evidence = JSON.parse(readFileSync(questionSendPath, 'utf8')) as NativeQuestionEvidence
            if (evidence.code !== 0) {
              throw new Error(`actual worker orchestration send CLI exited ${evidence.code}\nstdout:\n${evidence.stdout}\nstderr:\n${evidence.stderr}${evidence.spawnError ? `\nspawn error: ${evidence.spawnError}` : ''}`)
            }
          }
          const worker = detail.workers.find(candidate =>
            candidate.identity.dispatchId === attached.dispatchId &&
            candidate.identity.sessionId === attached.sessionId &&
            candidate.identity.processIncarnation === attached.processIncarnation &&
            candidate.state === 'live'
          )
          const question = worker?.question
          if (existsSync(questionSendPath) && detail.status?.state === 'parked' && detail.enrollment.parkReason === 'worker-question' &&
              question && typeof question.messageId === 'string' && question.answered !== true && question.body === 'Continue?') {
            return {
              ready: true,
              value: question.messageId,
              observed: `parked on question=${question.messageId} from dispatch=${attached.dispatchId}`
            }
          }
          return { ready: false, observed: JSON.stringify({ status: detail.status, enrollment: detail.enrollment, workers: detail.workers, journal: detail.journal }) }
        })
        const evidence = JSON.parse(readFileSync(questionSendPath, 'utf8')) as NativeQuestionEvidence
        if (evidence.sessionId !== attached.sessionId || !evidence.sessionTokenPresent) {
          throw new Error(`worker question CLI did not inherit the attached worker lease identity: ${JSON.stringify({ sessionId: evidence.sessionId, sessionTokenPresent: evidence.sessionTokenPresent })}`)
        }
        return {
          watcherId,
          dispatchId: attached.dispatchId,
          sessionId: attached.sessionId,
          processIncarnation: attached.processIncarnation,
          messageId: asked
        }
      })()
      enrollPromise = pending
      return pending
    }

    return {
      root,
      home,
      userHome,
      client: client!,
      daemon: daemon!,
      scope: scope!,
      runtime,
      uiUrl: daemonUrl(runtime),
      evidencePaths: {
        trigger: triggerPath,
        questionSend: questionSendPath,
        providerPid: providerPidPath,
        providerLog: codex.logPath,
        providerEnvironmentLog: codex.environmentLogPath
      },
      enrollQuestionWorker,
      async readQuestionEvidence() {
        if (!existsSync(questionSendPath)) throw new Error(`worker question evidence does not exist: ${questionSendPath}`)
        return JSON.parse(readFileSync(questionSendPath, 'utf8')) as NativeQuestionEvidence
      },
      runCli,
      cleanup
    }
  } catch (error) {
    try {
      await cleanup()
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'native worker fixture setup failed and cleanup was incomplete', { cause: error })
    }
    throw error
  }
}
