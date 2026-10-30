import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { HOOK_PATH_PREFIX, HOOK_TOKEN_HEADER } from '@quirky/protocol'

const FIXTURE_FILES = {
  source: 'src/app.ts',
  markdown: 'docs/review-notes.md',
  notebook: 'notebooks/summary.ipynb',
  svg: 'assets/fixture-diagram.svg',
  csv: 'data/metrics.csv'
} as const

/** The status dots the shell draws for a worktree; `idle` is a worktree with no agent session. */
export type FixtureStatus = 'working' | 'needs-you' | 'failing' | 'done' | 'idle'

export const PRIMARY_PROJECT = 'ui-review-fixture'

/** Three projects, with worktrees spread across them so every status dot appears. */
const PROJECT_WORKTREES: ReadonlyArray<{ project: string; worktrees: ReadonlyArray<{ name: string | null; status: FixtureStatus }> }> = [
  { project: PRIMARY_PROJECT, worktrees: [
    { name: null, status: 'idle' },
    { name: 'ui-review-ready', status: 'working' },
    { name: 'ui-review-notes', status: 'needs-you' }
  ] },
  { project: 'harbor-api', worktrees: [
    { name: null, status: 'idle' },
    { name: 'retry-queue', status: 'failing' }
  ] },
  { project: 'ledger-web', worktrees: [
    { name: null, status: 'idle' },
    { name: 'export-csv', status: 'done' }
  ] }
]

const HOOK_PROMPT = { hook_event_name: 'UserPromptSubmit', prompt: 'Review the fixture change' }
const HOOK_SEQUENCES: Record<Exclude<FixtureStatus, 'idle'>, { hooks: Array<Record<string, unknown>>; display: string }> = {
  working: { hooks: [HOOK_PROMPT], display: 'working' },
  'needs-you': {
    hooks: [HOOK_PROMPT, { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'git push origin main' } }],
    display: 'waiting'
  },
  failing: { hooks: [HOOK_PROMPT, { hook_event_name: 'StopFailure' }], display: 'failed' },
  done: { hooks: [HOOK_PROMPT, { hook_event_name: 'Stop', last_assistant_message: 'Finished the review.' }], display: 'done' }
}

const INITIAL_SOURCE = [
  'export function greeting(name: string): string {',
  '  return `Hello, ${name}.`',
  '}',
  ''
].join('\n')

const CHANGED_SOURCE = [
  'export function greeting(name: string): string {',
  '  return `Welcome to the UI review, ${name}.`',
  '}',
  '',
  'export const captureState = "fixture-backed"',
  ''
].join('\n')

const SAMPLE_MARKDOWN = [
  '# UI review fixture',
  '',
  'A real local worktree with a tracked source edit and editor-ready sample assets.',
  '',
  '## Checklist',
  '',
  '- [x] Repository registered through the public API',
  '- [x] Two isolated Git worktrees created without setup hooks',
  '- [ ] Review the source change'
].join('\n') + '\n'

const SAMPLE_NOTEBOOK = JSON.stringify({
  cells: [
    { cell_type: 'markdown', metadata: {}, source: ['# Fixture notebook\n', 'The editor can render this sample asset.'] },
    { cell_type: 'code', execution_count: null, metadata: {}, outputs: [], source: ['values = [2, 3, 5, 8]\n', 'sum(values)'] }
  ],
  metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' } },
  nbformat: 4,
  nbformat_minor: 5
}, null, 2) + '\n'

const SAMPLE_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="320" viewBox="0 0 640 320">',
  '  <rect width="640" height="320" rx="18" fill="#f4f5f7"/>',
  '  <rect x="42" y="64" width="210" height="180" rx="12" fill="#ffffff" stroke="#e3e5ea"/>',
  '  <rect x="388" y="64" width="210" height="180" rx="12" fill="#ffffff" stroke="#e3e5ea"/>',
  '  <path d="M252 154h136" stroke="#5b6cff" stroke-width="8" stroke-linecap="round"/>',
  '  <path d="m364 128 28 26-28 26" fill="none" stroke="#5b6cff" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>',
  '  <text x="147" y="165" text-anchor="middle" font-family="sans-serif" font-size="22" fill="#1b1d22">Repository</text>',
  '  <text x="493" y="165" text-anchor="middle" font-family="sans-serif" font-size="22" fill="#1b1d22">Worktrees</text>',
  '</svg>',
  ''
].join('\n')

export type IsolatedRuntimeEnvironmentOptions = {
  repoRoot?: string
  uiDir?: string
}

/** A deliberately small environment: no inherited credentials, home pointers, or Git overrides. */
export function createIsolatedRuntimeEnvironment(
  home: string,
  options: IsolatedRuntimeEnvironmentOptions = {}
): Record<string, string> {
  const root = resolve(home)
  const env: Record<string, string> = {
    PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: root,
    TMPDIR: join(root, 'tmp'),
    TMP: join(root, 'tmp'),
    TEMP: join(root, 'tmp'),
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_CACHE_HOME: join(root, 'cache'),
    XDG_STATE_HOME: join(root, 'state'),
    XDG_RUNTIME_DIR: join(root, 'runtime'),
    QUIRKY_HOME: root,
    SHELL: '/bin/sh',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_COUNT: '0',
    GIT_CONFIG_PARAMETERS: '',
    GIT_TERMINAL_PROMPT: '0',
    TZ: 'UTC'
  }
  for (const key of ['LANG', 'LC_ALL', 'LC_CTYPE']) {
    const value = process.env[key]
    if (value) env[key] = value
  }
  if (options.repoRoot) {
    const repoRoot = resolve(options.repoRoot)
    env.QUIRKY_BUILTIN_PLUGINS_DIR = join(repoRoot, 'plugins')
    env.QUIRKY_UI_DIR = resolve(options.uiDir ?? join(repoRoot, 'packages/ui/dist'))
    env.QUIRKY_CLI_ENTRY = join(repoRoot, 'packages/cli/src/main.ts')
  }
  return env
}

export type FixtureProject = { name: string; path: string }

export type PreparedCaptureFixtureHome = {
  home: string
  repoPath: string
  /** Every project, the primary one first; its path is `repoPath`. */
  projects: FixtureProject[]
  worktreesRoot: string
  files: Record<keyof typeof FIXTURE_FILES, string>
  cleanup(): void
}

export type FixtureRpcClient = {
  callAny(method: string, params?: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<unknown>
}

export type FixtureWorktree = { id: string; path: string; repoId: string; name: string; isMain: boolean; status: FixtureStatus }

export type RegisteredCaptureFixtures = PreparedCaptureFixtureHome & {
  repo: { id: string }
  primaryWorktree: { id: string; path: string; repoId: string; name: string }
  worktrees: FixtureWorktree[]
}

export type EditorFixtureBuffer = { id: string; tabId: string | null; mode: 'source' | 'rich' | 'preview'; path: string; contentRevision: number }

export type FixtureOptions = { timeoutMs: number; signal?: AbortSignal }

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorInHome(error: unknown, home: string): Error {
  return new Error(errorMessage(error).replaceAll(home, '<isolated-home>'))
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason
  return reason instanceof Error ? reason : new Error(typeof reason === 'string' ? reason : 'capture was aborted')
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal)
}

function bounded<T>(promise: Promise<T>, timeoutMs: number, signal: AbortSignal | undefined, label: string): Promise<T> {
  checkAbort(signal)
  const { promise: boundedPromise, resolve, reject } = Promise.withResolvers<T>()
  let settled = false
  let timer: ReturnType<typeof setTimeout>
  const finish = (error: unknown, value?: T) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    if (error !== undefined) reject(error)
    else resolve(value as T)
  }
  const onAbort = () => finish(abortError(signal!))
  timer = setTimeout(() => finish(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs)
  signal?.addEventListener('abort', onAbort, { once: true })
  promise.then((value) => finish(undefined, value), (error) => finish(error))
  return boundedPromise
}

async function runGit(args: string[], cwd: string, env: Record<string, string>, timeoutMs: number, signal?: AbortSignal): Promise<string> {
  checkAbort(signal)
  const child = Bun.spawn(['git', ...args], {
    cwd,
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe'
  })
  const stdoutText = new Response(child.stdout).text()
  const stderrText = new Response(child.stderr).text()
  try {
    const status = await bounded(child.exited, timeoutMs, signal, `git ${args[0] ?? 'command'}`)
    const [stdout, stderr] = await Promise.all([stdoutText, stderrText])
    if (status !== 0) throw new Error(`git ${args[0] ?? 'command'} failed (${status}): ${stderr.trim() || stdout.trim() || 'no details'}`)
    return stdout.trim()
  } catch (error) {
    child.kill('SIGTERM')
    await Promise.race([child.exited, Bun.sleep(250)])
    if (child.exitCode === null) child.kill('SIGKILL')
    await Promise.allSettled([stdoutText, stderrText])
    throw error
  }
}

function writeFile(root: string, relativePath: string, content: string): void {
  const path = join(root, relativePath)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, content, { mode: 0o600 })
}

/** Creates a real local Git repository under the disposable app home. */
export async function prepareCaptureFixtureHome(
  home: string,
  options: { timeoutMs: number; signal?: AbortSignal; env?: Record<string, string> }
): Promise<PreparedCaptureFixtureHome> {
  const root = resolve(home)
  const env = options.env ?? createIsolatedRuntimeEnvironment(root)
  const repoPath = join(root, 'projects', PRIMARY_PROJECT)
  const projects: FixtureProject[] = PROJECT_WORKTREES.map(({ project }) => ({
    name: project,
    path: project === PRIMARY_PROJECT ? repoPath : join(root, 'projects', project)
  }))
  const worktreesRoot = join(root, 'worktrees')
  const createdPaths = [...projects.map((project) => project.path), worktreesRoot]
  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    for (const path of createdPaths) rmSync(path, { recursive: true, force: true })
  }
  const files = Object.fromEntries(
    Object.entries(FIXTURE_FILES).map(([key, relativePath]) => [key, join(repoPath, relativePath)])
  ) as Record<keyof typeof FIXTURE_FILES, string>

  for (const path of createdPaths) {
    if (existsSync(path)) throw new Error(`capture fixture path already exists: ${path.replaceAll(root, '<isolated-home>')}`)
  }

  try {
    for (const directory of [root, join(root, 'tmp'), join(root, 'config'), join(root, 'data'), join(root, 'cache'), join(root, 'state'), join(root, 'runtime'), join(root, 'providers')]) {
      mkdirSync(directory, { recursive: true, mode: 0o700 })
    }
    mkdirSync(join(root, 'projects'), { recursive: true, mode: 0o700 })
    mkdirSync(worktreesRoot, { recursive: true, mode: 0o700 })
    writeFile(repoPath, 'README.md', '# UI screenshot fixture\n\nA disposable local project for renderer capture.\n')
    writeFile(repoPath, FIXTURE_FILES.source, INITIAL_SOURCE)
    writeFile(repoPath, FIXTURE_FILES.markdown, SAMPLE_MARKDOWN)
    writeFile(repoPath, FIXTURE_FILES.notebook, SAMPLE_NOTEBOOK)
    writeFile(repoPath, FIXTURE_FILES.svg, SAMPLE_SVG)
    writeFile(repoPath, FIXTURE_FILES.csv, 'day,commits,files\nMonday,3,5\nTuesday,5,8\nWednesday,2,4\n')
    writeFile(repoPath, 'src/format.ts', 'export const formatLabel = (value: string) => value.trim()\n')

    await runGit(['init', '--initial-branch=main', repoPath], root, env, options.timeoutMs, options.signal)
    await runGit(['-C', repoPath, 'config', 'user.name', 'UI Screenshot Fixture'], root, env, options.timeoutMs, options.signal)
    await runGit(['-C', repoPath, 'config', 'user.email', 'ui-review-fixture@localhost'], root, env, options.timeoutMs, options.signal)
    await runGit(['-C', repoPath, 'add', '--all'], root, env, options.timeoutMs, options.signal)
    await runGit(['-C', repoPath, 'commit', '-m', 'Seed UI screenshot fixture'], root, env, options.timeoutMs, options.signal)

    for (const project of projects.filter((candidate) => candidate.path !== repoPath)) {
      writeFile(project.path, 'README.md', `# ${project.name}\n\nA second disposable project for renderer capture.\n`)
      writeFile(project.path, 'src/index.ts', `export const project = ${JSON.stringify(project.name)}\n`)
      await runGit(['init', '--initial-branch=main', project.path], root, env, options.timeoutMs, options.signal)
      await runGit(['-C', project.path, 'config', 'user.name', 'UI Screenshot Fixture'], root, env, options.timeoutMs, options.signal)
      await runGit(['-C', project.path, 'config', 'user.email', 'ui-review-fixture@localhost'], root, env, options.timeoutMs, options.signal)
      await runGit(['-C', project.path, 'add', '--all'], root, env, options.timeoutMs, options.signal)
      await runGit(['-C', project.path, 'commit', '-m', `Seed ${project.name}`], root, env, options.timeoutMs, options.signal)
    }

    writeFile(repoPath, FIXTURE_FILES.source, CHANGED_SOURCE)
    writeFile(repoPath, 'src/review-note.ts', 'export const reviewNote = "untracked fixture asset"\n')
    return { home: root, repoPath, projects, worktreesRoot, files, cleanup }
  } catch (error) {
    cleanup()
    throw errorInHome(error, root)
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} did not return an ID`)
  return value
}

async function callRpc(
  client: FixtureRpcClient,
  method: string,
  params: Record<string, unknown>,
  options: FixtureOptions
): Promise<unknown> {
  checkAbort(options.signal)
  return await bounded(
    client.callAny(method, params, { timeoutMs: options.timeoutMs }),
    options.timeoutMs,
    options.signal,
    method
  )
}

/** Registers the real repository and worktrees through their public APIs. */
export async function registerCaptureFixtures(
  client: FixtureRpcClient,
  prepared: PreparedCaptureFixtureHome,
  options: FixtureOptions
): Promise<RegisteredCaptureFixtures> {
  try {
    await callRpc(client, 'setting.set', {
      id: 'setting:quirky.worktree/worktreesRoot',
      value: prepared.worktreesRoot
    }, options)
    await callRpc(client, 'setting.set', {
      id: 'setting:quirky.worktree/branchPrefix',
      value: 'none'
    }, options)
    const worktrees: FixtureWorktree[] = []
    let primaryRepoId = ''
    let primaryWorktree: RegisteredCaptureFixtures['primaryWorktree'] | undefined
    for (const plan of PROJECT_WORKTREES) {
      const project = prepared.projects.find((candidate) => candidate.name === plan.project)!
      const added = record(await callRpc(client, 'quirky.repo/add', { path: project.path }, options))
      const repoId = requiredString(added.id, 'quirky.repo/add')
      const listed = await callRpc(client, 'quirky.worktree/list', { repo: repoId }, options)
      if (!Array.isArray(listed)) throw new Error('quirky.worktree/list did not return a worktree list')
      const main = listed.map(record).find((entry) => entry.path === project.path || entry.isMain === true)
      if (!main) throw new Error(`the fixture repository ${project.name} has no registered primary worktree`)
      const mainWorktree = {
        id: requiredString(main.id, 'primary worktree'),
        path: requiredString(main.path, 'primary worktree path'),
        repoId,
        name: typeof main.name === 'string' ? main.name : project.name
      }
      if (plan.project === PRIMARY_PROJECT) {
        primaryRepoId = repoId
        primaryWorktree = mainWorktree
      }
      for (const entry of plan.worktrees) {
        if (entry.name === null) {
          worktrees.push({ ...mainWorktree, isMain: true, status: entry.status })
          continue
        }
        const result = record(await callRpc(client, 'quirky.worktree/create', {
          repo: repoId,
          name: entry.name,
          setup: 'skip',
          noParent: true,
          activate: false
        }, options))
        const worktree = record(result.worktree)
        worktrees.push({
          id: requiredString(worktree.id, `worktree ${entry.name}`),
          path: requiredString(worktree.path, `worktree ${entry.name} path`),
          repoId,
          name: typeof worktree.name === 'string' ? worktree.name : entry.name,
          isMain: false,
          status: entry.status
        })
      }
    }
    if (!primaryWorktree) throw new Error('the primary fixture project was not registered')
    return { ...prepared, repo: { id: primaryRepoId }, primaryWorktree, worktrees }
  } catch (error) {
    prepared.cleanup()
    throw errorInHome(error, prepared.home)
  }
}
export type HookEndpoint = { port: number; hookToken: string }
export type SeedStatusOptions = FixtureOptions & { fetch?: (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number }> }

/**
 * Gives each non-idle fixture worktree one shell session and posts the agent hooks that put its row
 * in the wanted status, then waits until the daemon reports every wanted status.
 */
export async function seedWorktreeStatuses(
  client: FixtureRpcClient,
  fixtures: RegisteredCaptureFixtures,
  endpoint: HookEndpoint,
  options: SeedStatusOptions
): Promise<void> {
  const send = options.fetch ?? ((url, init) => fetch(url, init))
  const expected = new Map<string, string>()
  try {
    for (const worktree of fixtures.worktrees) {
      if (worktree.status === 'idle') continue
      const sequence = HOOK_SEQUENCES[worktree.status]
      const opened = record(await callRpc(client, 'quirky.terminal/newTab', {
        workspace: worktree.id,
        cwd: worktree.path,
        agent: 'shell',
        title: `${worktree.name} agent`,
        activate: false
      }, options))
      const sessionId = requiredString(opened.session, 'quirky.terminal/newTab')
      for (const payload of sequence.hooks) {
        checkAbort(options.signal)
        const response = await bounded(send(`http://127.0.0.1:${endpoint.port}${HOOK_PATH_PREFIX}claude?session=${encodeURIComponent(sessionId)}`, {
          method: 'POST',
          headers: { [HOOK_TOKEN_HEADER]: endpoint.hookToken, 'content-type': 'application/json' },
          body: JSON.stringify(payload)
        }), options.timeoutMs, options.signal, 'agent hook delivery')
        if (!response.ok) throw new Error(`agent hook was rejected with status ${response.status}`)
      }
      expected.set(sessionId, sequence.display)
    }

    const deadline = Date.now() + options.timeoutMs
    for (;;) {
      checkAbort(options.signal)
      const rows = await callRpc(client, 'quirky.agent-status/list', {}, options)
      const shown = new Map(Array.isArray(rows) ? rows.map(record).map((row) => [row.sessionId, row.display] as const) : [])
      if ([...expected].every(([sessionId, display]) => shown.get(sessionId) === display)) return
      if (Date.now() > deadline) throw new Error('agent status rows did not reach the fixture statuses')
      await Bun.sleep(100)
    }
  } catch (error) {
    throw errorInHome(error, fixtures.home)
  }
}

export type CaptureTerminalFixture = { sessionId: string; tabId: string; paneId: string }

/** Starts one real interactive shell only for selected terminal-facing UI surfaces; it runs no command. */
export async function createCaptureTerminalFixture(
  client: FixtureRpcClient,
  fixtures: RegisteredCaptureFixtures,
  options: FixtureOptions
): Promise<CaptureTerminalFixture> {
  const result = record(await callRpc(client, 'quirky.terminal/newTab', {
    workspace: fixtures.primaryWorktree.id,
    cwd: fixtures.primaryWorktree.path,
    agent: 'shell',
    title: 'UI Review Fixture Shell',
    activate: true
  }, options))
  return {
    sessionId: requiredString(result.session, 'quirky.terminal/newTab'),
    tabId: requiredString(result.tab, 'quirky.terminal/newTab tab'),
    paneId: requiredString(result.pane, 'quirky.terminal/newTab pane')
  }
}

/** Opens the changed fixture source through the real editor API for document-view captures. */
export async function openFixtureEditorBuffer(
  client: FixtureRpcClient,
  fixtures: RegisteredCaptureFixtures,
  options: FixtureOptions
): Promise<EditorFixtureBuffer> {
  try {
    const buffer = record(await callRpc(client, 'quirky.editor/open', {
      worktree: fixtures.primaryWorktree.id,
      path: FIXTURE_FILES.source,
      mode: 'source',
      focus: false,
      pinned: true
    }, options))
    if (typeof buffer.contentRevision !== 'number' || !Number.isSafeInteger(buffer.contentRevision)) {
      throw new Error('quirky.editor/open did not return a content revision')
    }
    return {
      id: requiredString(buffer.id, 'quirky.editor/open'),
      tabId: typeof buffer.tabId === 'string' ? buffer.tabId : null,
      mode: buffer.mode === 'rich' || buffer.mode === 'preview' ? buffer.mode : 'source',
      path: fixtures.files.source,
      contentRevision: buffer.contentRevision
    }
  } catch (error) {
    throw errorInHome(error, fixtures.home)
  }
}

