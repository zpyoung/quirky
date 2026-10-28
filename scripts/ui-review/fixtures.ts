import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export const FIXTURE_THEME_PLUGIN_ID = 'ui-review.fixture'

const FIXTURE_LIGHT_COLORS = {
  bg: '#ffffff',
  'bg-raised': '#f4f5f7',
  'bg-hover': '#e7e9ef',
  'bg-active': '#e7e9ef',
  border: '#e3e5ea',
  text: '#1b1d22',
  muted: '#80868f',
  accent: '#5b6cff',
  amber: '#c98a0b',
  green: '#1f9d63',
  grey: '#80868f',
  dim: '#80868f',
  danger: '#d6455d',
  'terminal-background': '#ffffff',
  'terminal-foreground': '#1b1d22',
  'terminal-cursor': '#1b1d22'
} as const

const FIXTURE_FILES = {
  source: 'src/app.ts',
  markdown: 'docs/review-notes.md',
  notebook: 'notebooks/summary.ipynb',
  svg: 'assets/fixture-diagram.svg',
  csv: 'data/metrics.csv'
} as const

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

export type PreparedCaptureFixtureHome = {
  home: string
  repoPath: string
  worktreesRoot: string
  themePluginDir: string
  files: Record<keyof typeof FIXTURE_FILES, string>
  cleanup(): void
}

export type FixtureRpcClient = {
  callAny(method: string, params?: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<unknown>
}

export type RegisteredCaptureFixtures = PreparedCaptureFixtureHome & {
  repo: { id: string }
  primaryWorktree: { id: string; path: string; repoId: string; name: string }
  worktrees: Array<{ id: string; path: string; repoId: string; name: string; isMain: boolean }>
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

function fixtureThemeManifest(): string {
  return JSON.stringify({
    id: FIXTURE_THEME_PLUGIN_ID,
    name: 'UI Screenshot Review Fixture',
    version: '0.0.0',
    description: 'An isolated light appearance used only when no built-in light theme is available.',
    contributes: {
      theme: [{
        id: 'light',
        title: 'Quirky Light',
        appearance: 'light',
        colors: FIXTURE_LIGHT_COLORS
      }]
    }
  }, null, 2) + '\n'
}

/** Creates a real local Git repository and a data-only public theme contribution under the disposable app home. */
export async function prepareCaptureFixtureHome(
  home: string,
  options: { timeoutMs: number; signal?: AbortSignal; env?: Record<string, string> }
): Promise<PreparedCaptureFixtureHome> {
  const root = resolve(home)
  const env = options.env ?? createIsolatedRuntimeEnvironment(root)
  const repoPath = join(root, 'projects', 'ui-review-fixture')
  const worktreesRoot = join(root, 'worktrees')
  const themePluginDir = join(root, 'plugins', FIXTURE_THEME_PLUGIN_ID)
  const createdPaths = [repoPath, worktreesRoot, themePluginDir]
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
    mkdirSync(themePluginDir, { recursive: true, mode: 0o700 })
    writeFile(themePluginDir, 'quirky-plugin.json', fixtureThemeManifest())
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

    writeFile(repoPath, FIXTURE_FILES.source, CHANGED_SOURCE)
    writeFile(repoPath, 'src/review-note.ts', 'export const reviewNote = "untracked fixture asset"\n')
    return { home: root, repoPath, worktreesRoot, themePluginDir, files, cleanup }
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
    const added = record(await callRpc(client, 'quirky.repo/add', { path: prepared.repoPath }, options))
    const repoId = requiredString(added.id, 'quirky.repo/add')
    const listed = await callRpc(client, 'quirky.worktree/list', { repo: repoId }, options)
    if (!Array.isArray(listed)) throw new Error('quirky.worktree/list did not return a worktree list')
    const primary = listed.map(record).find((entry) => entry.path === prepared.repoPath || entry.isMain === true)
    if (!primary) throw new Error('the fixture repository has no registered primary worktree')
    const primaryWorktree = {
      id: requiredString(primary.id, 'primary worktree'),
      path: requiredString(primary.path, 'primary worktree path'),
      repoId,
      name: typeof primary.name === 'string' ? primary.name : 'ui-review-fixture'
    }

    const created: Array<{ id: string; path: string; repoId: string; name: string; isMain: boolean }> = [
      { ...primaryWorktree, isMain: true }
    ]
    for (const name of ['ui-review-ready', 'ui-review-notes']) {
      const result = record(await callRpc(client, 'quirky.worktree/create', {
        repo: repoId,
        name,
        setup: 'skip',
        noParent: true,
        activate: false
      }, options))
      const worktree = record(result.worktree)
      created.push({
        id: requiredString(worktree.id, `worktree ${name}`),
        path: requiredString(worktree.path, `worktree ${name} path`),
        repoId,
        name: typeof worktree.name === 'string' ? worktree.name : name,
        isMain: false
      })
    }
    return { ...prepared, repo: { id: repoId }, primaryWorktree, worktrees: created }
  } catch (error) {
    prepared.cleanup()
    throw errorInHome(error, prepared.home)
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

