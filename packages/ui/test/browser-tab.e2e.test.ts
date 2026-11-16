import { createHash } from 'node:crypto'
import {
  closeSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { expect, test } from 'bun:test'
import { connectDaemon, isDaemonAlive, readRuntime, type RuntimeInfo } from '@quirky/protocol/node'
import type { QuirkyClient } from '@quirky/protocol'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { createIsolatedRuntimeEnvironment } from '../../../scripts/ui-review/fixtures'
import { createProcessScope, type ProcessScope } from '../../../scripts/test-support/process-scope'
import { browserExecutable } from '../../../scripts/test-support/browser'

const REPO_ROOT = realpathSync(resolve(import.meta.dir, '../../..'))
const BUILD_TIMEOUT_MS = 180_000
const DAEMON_TIMEOUT_MS = 30_000
const UI_TIMEOUT_MS = 30_000
const TERMINAL_ECHO = 'G8_BROWSER_ECHO'
const WATCH_FIXTURE = 'G8_BROWSER_WATCH_FIXTURE'


type BuildEnvironment = {
  HOME: string
  QUIRKY_HOME: string
  QUIRKY_UI_OUT: string
  QUIRKY_PLUGINS_DIR: string
  QUIRKY_BUILTIN_PLUGINS_DIR: string
  [key: string]: string
}

type BuildPlan = {
  root: string
  uiOut: string
  pluginsDir: string
  pluginIds: string[]
  dependencyLink: string | null
}

type Builder = (plan: BuildPlan, env: BuildEnvironment) => Promise<void>
type TreeSnapshot = { path: string; entries: { name: string; kind: string; sha256?: string; target?: string }[] }
type LocalWatchSite = { port: number | undefined; stop(force?: boolean): void }


type OwnedFixture = {
  root: string
  home: string
  uiOut: string
  pluginsDir: string
  env: BuildEnvironment
  scope: ProcessScope
  daemon: Bun.Subprocess<'ignore', number, number> | null
  client: QuirkyClient | null
  browser: Browser | null
  context: BrowserContext | null
  pages: Page[]
  pageErrors: string[]
  requests: string[]
  ownedPids: number[]
  ptyHostPid: number | null
  site: LocalWatchSite | null
  trackedProcesses: Bun.Subprocess[]
  prepareBuildTree(): void
  build(builder?: Builder): Promise<BuildPlan>
  startDaemon(executablePath: string): Promise<void>
  launchBrowser(executablePath: string): Promise<Page>
  cleanup(): Promise<CleanupProof>
}

type CleanupProof = {
  pagesClosed: boolean
  browserDisconnected: boolean
  clientClosed: boolean
  daemonStopped: boolean
  ownedProcessesStopped: boolean
  processScopeCleaned: boolean
  temporaryDirectoryRemoved: boolean
  closedPageCount: number
  pageCount: number
}

type LifecycleResult<T> = {
  root: string
  value: T | undefined
  error: unknown
  cleanup: CleanupProof
  pageErrors: string[]
}
type OwnedAssetMarkers = { ui: string; plugin: string; pluginModulePath: string }
type WatchPixel = { width: number; height: number; r: number; g: number; b: number }
type RealBrowserProof = { project: string; pages: number; watch: WatchPixel; screenshots: string[] }

class InjectedLifecycleFailure extends Error {
  constructor(readonly stage: 'setup' | 'build' | 'flow') {
    super(`injected ${stage} failure`)
    this.name = 'InjectedLifecycleFailure'
  }
}

function isWithin(root: string, path: string): boolean {
  const fromRoot = relative(root, path)
  return fromRoot === '' || (fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot))
}


function assertOwnedPath(root: string, path: string, label: string, options: { allowMissingLeaf?: boolean; directory?: boolean } = {}): void {
  const absolute = resolve(path)
  if (!isWithin(root, absolute) || absolute === root) throw new Error(`${label} must stay below the owned build root`)
  const pathParts = relative(root, absolute).split(sep).filter(Boolean)
  let current = root
  for (let index = 0; index < pathParts.length; index++) {
    current = join(current, pathParts[index]!)
    let entry
    try {
      entry = lstatSync(current)
    } catch (error) {
      if (options.allowMissingLeaf && index === pathParts.length - 1) break
      throw new Error(`${label} has a missing canonical parent: ${current}: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (entry.isSymbolicLink()) throw new Error(`${label} must not pass through a symlink: ${current}`)
    if (index < pathParts.length - 1 && !entry.isDirectory()) throw new Error(`${label} has a non-directory parent: ${current}`)
    if (index === pathParts.length - 1 && options.directory && !entry.isDirectory()) throw new Error(`${label} must be a real directory: ${current}`)
  }
  const existingParent = options.allowMissingLeaf && !existsSync(absolute) ? dirnameOf(absolute) : absolute
  const canonical = realpathSync(existingParent)
  if (!isWithin(root, canonical)) throw new Error(`${label} resolves outside the owned build root`)
}

function dirnameOf(path: string): string {
  const index = path.lastIndexOf(sep)
  return index <= 0 ? sep : path.slice(0, index)
}

function assertBuildPreflight(rootInput: string, repoRoot: string, env: BuildEnvironment): BuildPlan {
  const root = realpathSync(rootInput)
  if (resolve(rootInput) !== root) throw new Error('the owned build root is not canonical')
  if (!env.QUIRKY_UI_OUT || !env.QUIRKY_PLUGINS_DIR || !env.QUIRKY_BUILTIN_PLUGINS_DIR) {
    throw new Error('UI build requires explicit owned UI and plugin roots')
  }
  const uiOut = resolve(env.QUIRKY_UI_OUT)
  const pluginsDir = resolve(env.QUIRKY_PLUGINS_DIR)
  const builtinPluginsDir = resolve(env.QUIRKY_BUILTIN_PLUGINS_DIR)
  if (pluginsDir !== builtinPluginsDir) throw new Error('builder and daemon plugin roots must be identical')
  assertOwnedPath(root, uiOut, 'UI output', { directory: true })
  assertOwnedPath(root, pluginsDir, 'copied plugin root', { directory: true })

  const dependencyLink = join(pluginsDir, 'node_modules')
  if (existsSync(dependencyLink) || (() => { try { lstatSync(dependencyLink); return true } catch { return false } })()) {
    const link = lstatSync(dependencyLink)
    const expected = realpathSync(join(repoRoot, 'node_modules'))
    if (!link.isSymbolicLink() || realpathSync(dependencyLink) !== expected) {
      throw new Error('the only plugin-root symlink allowed is the dependency-resolution link to repository node_modules')
    }
  }

  const pluginIds: string[] = []
  for (const entry of readdirSync(pluginsDir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const pluginDirectory = join(pluginsDir, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`plugin input ${entry.name} must be a copied real directory`)
    if (!entry.isDirectory()) continue
    assertOwnedPath(root, pluginDirectory, `plugin input ${entry.name}`, { directory: true })
    assertStagedWorkspaceDependencyLinks(root, repoRoot, pluginDirectory)
    const uiSource = join(pluginDirectory, 'src', 'ui.tsx')
    if (!existsSync(uiSource)) continue
    assertOwnedPath(root, uiSource, `plugin UI source ${entry.name}`)
    if (!lstatSync(uiSource).isFile()) throw new Error(`plugin UI source ${entry.name} must be a regular file`)
    const output = join(pluginDirectory, 'dist')
    if (existsSync(output) || (() => { try { lstatSync(output); return true } catch { return false } })()) {
      assertOwnedPath(root, output, `plugin output ${entry.name}`, { directory: true })
    } else {
      assertOwnedPath(root, pluginDirectory, `plugin output parent ${entry.name}`, { directory: true })
    }
    pluginIds.push(entry.name)
  }
  return { root, uiOut, pluginsDir, pluginIds, dependencyLink: existsSync(dependencyLink) ? dependencyLink : null }
}

async function safelyBuild(
  root: string,
  repoRoot: string,
  env: BuildEnvironment,
  builder: Builder
): Promise<BuildPlan> {
  const plan = assertBuildPreflight(root, repoRoot, env)
  await builder(plan, env)
  return plan
}

function copyPluginInputs(sourceRoot: string, destinationRoot: string): void {
  mkdirSync(destinationRoot, { recursive: true, mode: 0o700 })
  for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
    if (entry.name === 'dist' || entry.name === 'node_modules') continue
    const source = join(sourceRoot, entry.name)
    const destination = join(destinationRoot, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`refusing to copy plugin symlink ${entry.name}`)
    cpSync(source, destination, {
      recursive: true,
      filter(candidate) {
        const parts = relative(source, candidate).split(sep)
        if (parts.includes('dist') || parts.includes('node_modules')) return false
        if (lstatSync(candidate).isSymbolicLink()) throw new Error(`refusing to copy plugin input symlink ${relative(source, candidate)}`)
        return true
      }
    })
  }
}
function workspaceDependencyTarget(path: string, roots: readonly string[]): string | null {
  const target = realpathSync(path)
  return roots.some((root) => isWithin(root, target)) ? target : null
}

function stageWorkspaceDependencyLinks(sourcePlugins: string, stagedPlugins: string, repoRoot: string): void {
  const workspaceRoots = [realpathSync(join(repoRoot, 'packages')), realpathSync(join(repoRoot, 'plugins')), realpathSync(join(repoRoot, 'node_modules'))]
  for (const plugin of readdirSync(sourcePlugins, { withFileTypes: true })) {
    if (!plugin.isDirectory() || plugin.isSymbolicLink()) continue
    const sourceModules = join(sourcePlugins, plugin.name, 'node_modules')
    if (!existsSync(sourceModules)) continue
    const stagedModules = join(stagedPlugins, plugin.name, 'node_modules')
    const linkWorkspacePackage = (sourcePackage: string, stagedPackage: string) => {
      const target = workspaceDependencyTarget(sourcePackage, workspaceRoots)
      if (!target) return
      if (!statSync(target).isDirectory()) throw new Error(`workspace dependency is not a directory: ${sourcePackage}`)
      mkdirSync(dirnameOf(stagedPackage), { recursive: true, mode: 0o700 })
      symlinkSync(target, stagedPackage, 'dir')
    }
    for (const dependency of readdirSync(sourceModules, { withFileTypes: true })) {
      const sourcePath = join(sourceModules, dependency.name)
      if (dependency.name.startsWith('@')) {
        if (!statSync(sourcePath).isDirectory()) continue
        for (const packageEntry of readdirSync(sourcePath, { withFileTypes: true })) {
          linkWorkspacePackage(join(sourcePath, packageEntry.name), join(stagedModules, dependency.name, packageEntry.name))
        }
      } else {
        linkWorkspacePackage(sourcePath, join(stagedModules, dependency.name))
      }
    }
  }
}

function assertStagedWorkspaceDependencyLinks(root: string, repoRoot: string, pluginDirectory: string): void {
  const nodeModules = join(pluginDirectory, 'node_modules')
  if (!existsSync(nodeModules)) return
  assertOwnedPath(root, nodeModules, 'staged plugin dependency directory', { directory: true })
  const workspaceRoots = [realpathSync(join(repoRoot, 'packages')), realpathSync(join(repoRoot, 'plugins')), realpathSync(join(repoRoot, 'node_modules'))]
  const checkLink = (path: string) => {
    if (!lstatSync(path).isSymbolicLink()) throw new Error(`workspace dependency must be a resolution link: ${path}`)
    const target = realpathSync(path)
    if (!workspaceRoots.some((workspaceRoot) => isWithin(workspaceRoot, target)) || !statSync(target).isDirectory()) {
      throw new Error(`workspace dependency link escapes source packages: ${path}`)
    }
  }
  for (const dependency of readdirSync(nodeModules, { withFileTypes: true })) {
    const path = join(nodeModules, dependency.name)
    if (dependency.name.startsWith('@')) {
      if (dependency.isSymbolicLink() || !dependency.isDirectory()) throw new Error(`workspace scope must be a real directory: ${path}`)
      assertOwnedPath(root, path, 'staged workspace dependency scope', { directory: true })
      for (const packageEntry of readdirSync(path)) checkLink(join(path, packageEntry))
    } else {
      checkLink(path)
    }
  }
}


function runSync(command: string[], cwd: string, env: Record<string, string>): { code: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(command, { cwd, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  return { code: result.exitCode ?? 1, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
}

async function runScoped(
  scope: ProcessScope,
  command: string[],
  options: { cwd: string; env: Record<string, string>; timeoutMs: number }
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = scope.spawn(command, {
    cwd: options.cwd,
    env: options.env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe'
  })
  const stdout = new Response(child.stdout).text()
  const stderr = new Response(child.stderr).text()
  const timeoutResult = Promise.withResolvers<{ timedOut: true }>()
  // A real process deadline keeps a stalled builder or CLI from stranding the owned test scope.
  const timer = setTimeout(() => timeoutResult.resolve({ timedOut: true }), options.timeoutMs)
  const outcome = await Promise.race([
    child.exited.then((code) => ({ timedOut: false as const, code })),
    timeoutResult.promise
  ])
  clearTimeout(timer)
  if (outcome.timedOut) {
    try { child.kill('SIGKILL') } catch { /* the child may have exited at the deadline */ }
    await child.exited
    await Promise.all([stdout, stderr])
    throw new Error(`owned process timed out after ${options.timeoutMs}ms: ${command[0]}`)
  }
  const [out, err] = await Promise.all([stdout, stderr])
  return { code: outcome.code, stdout: out, stderr: err }
}

function checkoutOutputPaths(repoRoot: string): string[] {
  const plugins = join(repoRoot, 'plugins')
  const paths = [join(repoRoot, 'packages', 'ui', 'dist')]
  for (const entry of readdirSync(plugins, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    paths.push(join(plugins, entry.name, 'dist'))
  }
  return paths
}

function hashTree(path: string): TreeSnapshot {
  const entries: { name: string; kind: string; sha256?: string; target?: string }[] = []
  const visit = (current: string, name: string): void => {
    let stat
    try {
      stat = lstatSync(current)
    } catch {
      if (name === '.') entries.push({ name: '.', kind: 'missing' })
      return
    }
    if (stat.isSymbolicLink()) {
      entries.push({ name, kind: 'symlink', target: readlinkSync(current) })
      return
    }
    if (stat.isDirectory()) {
      entries.push({ name, kind: 'directory' })
      for (const child of readdirSync(current).sort(codePointCompare)) {
        visit(join(current, child), name === '.' ? child : `${name}/${child}`)
      }
      return
    }
    if (stat.isFile()) {
      entries.push({ name, kind: 'file', sha256: createHash('sha256').update(readFileSync(current)).digest('hex') })
      return
    }
    entries.push({ name, kind: 'other' })
  }
  visit(path, '.')
  return { path, entries }
}


function codePointCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function checkoutOutputSnapshot(repoRoot: string): TreeSnapshot[] {
  return checkoutOutputPaths(repoRoot).map(hashTree)
}

function checkoutGitStatus(repoRoot: string): string {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: tmpdir(),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0'
  }
  const result = runSync(['git', 'status', '--short', '--untracked-files=all'], repoRoot, env)
  if (result.code !== 0) throw new Error(`could not capture checkout git status: ${result.stderr.trim()}`)
  return result.stdout
}
function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch (error) {
    return !processGone(error)
  }
  const result = Bun.spawnSync(['ps', '-p', String(pid), '-o', 'stat='], { stdout: 'pipe', stderr: 'ignore' })
  if (result.exitCode !== 0) return true
  const state = result.stdout.toString().trim()
  if (state === '') {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return !processGone(error)
    }
  }
  return !state.startsWith('Z')
}

function processGone(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH'
}
function subprocessFinished(child: Bun.Subprocess): boolean {
  return child.exitCode !== null || child.signalCode !== null
}


function createOwnedFixture(): OwnedFixture {
  const allocated = mkdtempSync(join(tmpdir(), 'quirky-browser-tab-'))
  const root = realpathSync(allocated)
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true, mode: 0o700 })
  let scope: ProcessScope
  try {
    scope = createProcessScope(home)
  } catch (error) {
    rmSync(root, { recursive: true, force: true })
    throw error
  }
  const env = createIsolatedRuntimeEnvironment(home) as BuildEnvironment
  env.SHELL = '/bin/bash'
  env.GIT_CONFIG_GLOBAL = '/dev/null'
  env.GIT_CONFIG_SYSTEM = '/dev/null'
  env.GIT_CONFIG_NOSYSTEM = '1'
  env.GIT_CONFIG_COUNT = '0'
  env.GIT_CONFIG_PARAMETERS = ''
  env.GIT_TERMINAL_PROMPT = '0'
  env.GIT_OPTIONAL_LOCKS = '0'
  const uiOut = join(root, 'ui')
  const pluginsDir = join(root, 'plugins')
  let clientClosed = false
  const fixture: OwnedFixture = {
    root,
    home,
    uiOut,
    pluginsDir,
    env,
    scope,
    daemon: null,
    client: null,
    browser: null,
    context: null,
    pages: [],
    pageErrors: [],
    requests: [],
    ownedPids: [],
    ptyHostPid: null,
    site: null,
    trackedProcesses: [],

    prepareBuildTree() {
      for (const directory of [
        home,
        env.TMPDIR,
        env.XDG_CONFIG_HOME,
        env.XDG_DATA_HOME,
        env.XDG_CACHE_HOME,
        env.XDG_STATE_HOME,
        env.XDG_RUNTIME_DIR,
        uiOut
      ]) mkdirSync(directory, { recursive: true, mode: 0o700 })
      copyPluginInputs(join(REPO_ROOT, 'plugins'), pluginsDir)
      stageWorkspaceDependencyLinks(join(REPO_ROOT, 'plugins'), pluginsDir, REPO_ROOT)
      symlinkSync(realpathSync(join(REPO_ROOT, 'node_modules')), join(pluginsDir, 'node_modules'), 'dir')
      env.QUIRKY_HOME = home
      env.QUIRKY_UI_OUT = uiOut
      env.QUIRKY_PLUGINS_DIR = pluginsDir
      env.QUIRKY_BUILTIN_PLUGINS_DIR = pluginsDir
    },
    async build(builder = async (_plan, buildEnv) => {
      const result = await runScoped(scope, [process.execPath, 'packages/ui/build.ts'], {
        cwd: REPO_ROOT,
        env: buildEnv,
        timeoutMs: BUILD_TIMEOUT_MS
      })
      if (result.code !== 0) {
        throw new Error(`owned UI build exited ${result.code}: ${result.stderr.slice(-6000)}${result.stdout.slice(-2000)}`)
      }
    }) {
      return safelyBuild(root, REPO_ROOT, env, builder)
    },
    async startDaemon(executablePath) {
      env.QUIRKY_BROWSER_CHROME = executablePath
      const daemonEnv: BuildEnvironment = {
        ...env,
        QUIRKY_HOME: home,
        QUIRKY_UI_DIR: uiOut,
        QUIRKY_PLUGINS_DIR: pluginsDir,
        QUIRKY_BUILTIN_PLUGINS_DIR: pluginsDir,
        QUIRKY_BROWSER_CHROME: executablePath,
        SHELL: '/bin/bash'
      }
      if (daemonEnv.QUIRKY_BROWSER_CHROME !== executablePath) throw new Error('daemon and UI must use the same Chrome executable')
      const logPath = join(root, 'daemon.log')
      const logFd = openSync(logPath, 'a')
      try {
        const daemon = scope.spawn([process.execPath, 'packages/daemon/src/main.ts'], {
          cwd: REPO_ROOT,
          env: daemonEnv,
          stdin: 'ignore',
          stdout: logFd,
          stderr: logFd
        })
        fixture.daemon = daemon
        fixture.ownedPids.push(daemon.pid)
      } finally {
        closeSync(logFd)
      }
      const deadline = Date.now() + DAEMON_TIMEOUT_MS
      let runtime: RuntimeInfo | null = null
      const daemon = fixture.daemon
      if (!daemon) throw new Error('owned daemon process was not retained')
      while (Date.now() < deadline) {
        runtime = readRuntime(home)
        if (runtime && await isDaemonAlive(runtime, 250)) break
        if (daemon.exitCode !== null) {
          throw new Error(`owned daemon exited before ready: ${readFileSync(logPath, 'utf8').slice(-6000)}`)
        }
        // Poll the runtime file because daemon readiness has no in-process event for this child.
        await Bun.sleep(50)
      }
      if (!runtime || !(await isDaemonAlive(runtime, 250))) {
        throw new Error(`owned daemon did not become healthy: ${existsSync(logPath) ? readFileSync(logPath, 'utf8').slice(-6000) : 'no daemon log'}`)
      }
      const client = await connectDaemon({ home, role: 'cli', name: 'browser-tab-e2e', autostart: false })
      fixture.client = client
      const status = asRecord(await client.callAny('status.get', {}, { timeoutMs: 10_000 }))
      const ptyHost = asRecord(status.ptyHost)
      if (typeof ptyHost.pid !== 'number' || !Number.isSafeInteger(ptyHost.pid) || ptyHost.pid <= 0) {
        throw new Error('real daemon did not report its owned PTY host PID')
      }
      fixture.ptyHostPid = ptyHost.pid
      scope.track(ptyHost.pid)
      fixture.ownedPids.push(ptyHost.pid)
      await client.callAny('setting.set', {
        id: 'setting:quirky.agent-status/hooks', value: false
      }, { timeoutMs: 10_000 })
    },
    async launchBrowser(executablePath) {
      const browser = await chromium.launch({
        headless: true,
        executablePath,
        env: { ...env, ...scope.env, QUIRKY_HOME: home }
      })
      fixture.browser = browser
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
      fixture.context = context
      context.on('page', (page) => trackPage(fixture, page))
      await context.route('**/*', async (route) => {
        const requestUrl = route.request().url()
        let parsed: URL
        try {
          parsed = new URL(requestUrl)
        } catch {
          await route.abort().catch(() => undefined)
          return
        }
        if (parsed.protocol === 'data:' || parsed.protocol === 'blob:' || parsed.protocol === 'about:' ||
          parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') {
          await route.continue()
          return
        }
        await route.abort().catch(() => undefined)
      })
      const page = await context.newPage()
      trackPage(fixture, page)
      return page
    },
    async cleanup() {
      const pageCount = fixture.pages.length
      for (const page of fixture.pages) {
        if (!page.isClosed()) await page.close({ runBeforeUnload: false }).catch(() => undefined)
      }
      await fixture.context?.close().catch(() => undefined)
      await fixture.browser?.close().catch(() => undefined)
      try {
        fixture.client?.close()
        clientClosed = true
      } catch {
        clientClosed = false
      }
      fixture.client = null
      if (fixture.daemon && !subprocessFinished(fixture.daemon)) {
        try { fixture.daemon.kill('SIGTERM') } catch { /* scope cleanup below is the final owner */ }
      }
      let processScopeCleaned = true
      try {
        await scope.cleanup()
      } catch {
        processScopeCleaned = false
        scope.killNow()
      }
      await Promise.all(fixture.trackedProcesses.map((child) => child.exited))
      if (fixture.daemon) await fixture.daemon.exited
      try { fixture.site?.stop(true) } catch { /* the owned listener may already be closed */ }
      const pagesClosed = fixture.pages.every((page) => page.isClosed())
      const browserDisconnected = fixture.browser === null || !fixture.browser.isConnected()
      const daemonStopped = fixture.daemon === null ||
        (subprocessFinished(fixture.daemon) && !processIsRunning(fixture.daemon.pid))
      const ownedProcessesStopped = fixture.trackedProcesses.every((child) =>
        subprocessFinished(child) && !processIsRunning(child.pid)
      ) && fixture.ownedPids.every((pid) => !processIsRunning(pid))
      rmSync(root, { recursive: true, force: true })
      return {
        pagesClosed,
        browserDisconnected,
        clientClosed,
        daemonStopped,
        processScopeCleaned,
        ownedProcessesStopped,
        temporaryDirectoryRemoved: !existsSync(root),
        closedPageCount: fixture.pages.filter((page) => page.isClosed()).length,
        pageCount
      }
    }
  }
  return fixture
}

function trackPage(fixture: OwnedFixture, page: Page): void {
  if (fixture.pages.includes(page)) return
  fixture.pages.push(page)
  page.on('pageerror', (error) => fixture.pageErrors.push(error.message))
  page.on('request', (request) => fixture.requests.push(request.url()))
}

async function ownedLifecycle<T>(run: (fixture: OwnedFixture) => Promise<T>): Promise<LifecycleResult<T>> {
  const fixture = createOwnedFixture()
  let value: T | undefined
  let error: unknown = null
  try {
    value = await run(fixture)
  } catch (caught) {
    error = caught
    if (!(caught instanceof InjectedLifecycleFailure)) {
      for (const page of fixture.pages) {
        if (!page.isClosed()) console.error('browser proof failure surface:', await page.locator('body').innerText().catch(() => 'page unavailable'))
      }
    }
  }
  const cleanup = await fixture.cleanup()
  return { root: fixture.root, value, error, cleanup, pageErrors: [...fixture.pageErrors] }
}

function assertCleanup(proof: CleanupProof): void {
  expect(proof.pagesClosed).toBe(true)
  expect(proof.browserDisconnected).toBe(true)
  expect(proof.clientClosed).toBe(true)
  expect(proof.daemonStopped).toBe(true)
  expect(proof.ownedProcessesStopped).toBe(true)
  expect(proof.processScopeCleaned).toBe(true)
  expect(proof.temporaryDirectoryRemoved).toBe(true)
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

async function waitFor<T>(read: () => Promise<T> | T, accept: (value: T) => boolean, message: string, timeoutMs = UI_TIMEOUT_MS): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last: T | undefined
  while (Date.now() < deadline) {
    last = await read()
    if (accept(last)) return last
    // These owned UI/process observations have no event stream, so poll their exact state predicate.
    await Bun.sleep(50)
  }
  throw new Error(`timed out waiting for ${message}${last === undefined ? '' : `; last value: ${JSON.stringify(last).slice(0, 500)}`}`)
}

function runGitFixture(args: string[], env: BuildEnvironment): void {
  const result = runSync(['git', ...args], REPO_ROOT, env)
  if (result.code !== 0) throw new Error(`local Git fixture command failed (${args.join(' ')}): ${result.stderr.trim()}`)
}

function createGitProject(fixture: OwnedFixture): string {
  const project = join(fixture.home, 'G8_BROWSER_PROJECT')
  mkdirSync(project, { recursive: true, mode: 0o700 })
  writeFileSync(join(project, 'README.md'), '# G8 browser test fixture\n\nCreated only inside the owned browser-test home.\n', { mode: 0o600 })
  runGitFixture(['init', '--initial-branch=main', project], fixture.env)
  runGitFixture(['-C', project, 'config', 'user.name', 'G8 Browser Fixture'], fixture.env)
  runGitFixture(['-C', project, 'config', 'user.email', 'browser-fixture@localhost'], fixture.env)
  runGitFixture(['-C', project, 'add', '--all'], fixture.env)
  runGitFixture(['-C', project, 'commit', '-m', 'Seed browser fixture'], fixture.env)
  return project
}

function servedFile(root: string, relativePath: string): string {
  const candidate = resolve(root, relativePath)
  if (!isWithin(root, candidate)) throw new Error('served URL escaped its owned output root')
  const canonical = realpathSync(candidate)
  if (!isWithin(realpathSync(root), canonical)) throw new Error('served file resolves outside its owned output root')
  return canonical
}

function ownedArtifactHash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function stampOwnedBuildArtifacts(fixture: OwnedFixture): OwnedAssetMarkers {
  const marker = `G8_BROWSER_OWNED_${basename(fixture.root)}`
  const indexPath = join(fixture.uiOut, 'index.html')
  const pluginModulePath = join(fixture.pluginsDir, 'quirky.worktree', 'dist', 'ui.js')
  assertOwnedPath(fixture.root, indexPath, 'owned UI index')
  assertOwnedPath(fixture.root, pluginModulePath, 'owned worktree UI module')
  const index = readFileSync(indexPath, 'utf8')
  if (!/<\/body\s*>/i.test(index)) throw new Error('owned UI index has no closing body element')
  const ui = `${marker}_INDEX`
  writeFileSync(indexPath, index.replace(/<\/body\s*>/i, `<!-- ${ui} -->$&`))
  const plugin = `${marker}_PLUGIN`
  writeFileSync(pluginModulePath, `${readFileSync(pluginModulePath, 'utf8')}\n/* ${plugin} */\n`)
  return { ui, plugin, pluginModulePath: realpathSync(pluginModulePath) }
}

function assertServedIndexMatchesOwnedArtifact(owned: string, served: string, marker: string): void {
  const bodyEnd = /<\/body\s*>/i.exec(owned)
  if (!bodyEnd) throw new Error('owned UI index has no body boundary')
  const before = owned.slice(0, bodyEnd.index)
  const after = owned.slice(bodyEnd.index)
  if (!served.startsWith(before) || !served.endsWith(after) || !served.includes(marker)) {
    throw new Error('daemon did not serve the owned UI index artifact')
  }
  const injected = served.slice(before.length, served.length - after.length)
  if (injected !== '' && !injected.includes('<link rel="modulepreload"')) {
    throw new Error('served UI index differs from the owned artifact beyond module preload insertion')
  }
}

async function fetchOwnedArtifact(url: string, path: string, label: string): Promise<Buffer> {
  const response = await fetch(url)
  expect(response.status).toBe(200)
  const served = Buffer.from(await response.arrayBuffer())
  const owned = readFileSync(path)
  if (ownedArtifactHash(served) !== ownedArtifactHash(owned)) throw new Error(`served ${label} differs from its owned build artifact`)
  return served
}

async function assertServedBuildAssets(
  fixture: OwnedFixture,
  url: string,
  markers: OwnedAssetMarkers
): Promise<{ origin: string; vendorUrl: string }> {
  const parsed = new URL(url)
  const origin = parsed.origin
  const indexResponse = await fetch(`${origin}/`)
  expect(indexResponse.status).toBe(200)
  const html = await indexResponse.text()
  const ownedIndex = readFileSync(servedFile(fixture.uiOut, 'index.html'), 'utf8')
  assertServedIndexMatchesOwnedArtifact(ownedIndex, html, markers.ui)
  const mapMatch = html.match(/<script\s+type="importmap">([\s\S]*?)<\/script>/i)
  if (!mapMatch?.[1]) throw new Error('served UI index has no import map')
  const importMap = JSON.parse(mapMatch[1]) as { imports?: Record<string, string> }
  const reactEntry = importMap.imports?.react
  if (typeof reactEntry !== 'string') throw new Error('served UI import map has no React vendor module')
  const vendorUrl = new URL(reactEntry, `${origin}/`).href
  const vendorPath = new URL(vendorUrl).pathname.replace(/^\//, '')
  await fetchOwnedArtifact(vendorUrl, servedFile(fixture.uiOut, vendorPath), 'vendor module')
  await fetchOwnedArtifact(new URL('./main.js', `${origin}/`).href, servedFile(fixture.uiOut, 'main.js'), 'main module')
  return { origin, vendorUrl }
}

async function waitForApp(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const app = document.querySelector('.app')
    return app !== null && app.querySelector('.banner') === null
  }, undefined, { timeout: UI_TIMEOUT_MS })
}

async function waitForWorkspaceRow(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: `Open ${name}`, exact: true }).waitFor({ state: 'visible', timeout: UI_TIMEOUT_MS })
}

async function addProjectThroughBrowserUi(page: Page, projectPath: string): Promise<void> {
  await page.getByRole('button', { name: 'Add project', exact: true }).first().click()
  const addDialog = page.getByRole('dialog', { name: 'Add project' })
  await addDialog.waitFor({ state: 'visible' })
  const pathField = addDialog.getByLabel('Path', { exact: true })
  await pathField.fill(dirnameOf(projectPath))
  await addDialog.getByRole('button', { name: 'Browse', exact: true }).click()
  const folderDialog = page.getByRole('dialog').filter({ hasText: /Choose project folder|Choose folder/i })
  await folderDialog.waitFor({ state: 'visible' })
  console.info('browser folder picker screenshots:', (await screenshotProof(page)).join(', '))
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ colorScheme: 'light' })
  const folderPath = folderDialog.getByLabel('Folder path', { exact: true })
  await folderDialog.getByRole('button', { name: `Open ${basename(projectPath)}`, exact: true }).click()
  await waitFor(() => folderPath.inputValue(), (value) => value === projectPath, 'folder picker navigation to the fixture project')
  await folderDialog.getByRole('button', { name: 'Select this folder', exact: true }).click()
  await folderDialog.getByRole('button', { name: 'Choose folder', exact: true }).click()
  await waitFor(async () => await pathField.inputValue(), (value) => value === projectPath, 'the selected project path to return to Add project')
  await addDialog.getByRole('button', { name: 'Add', exact: true }).click()
  await addDialog.waitFor({ state: 'hidden', timeout: UI_TIMEOUT_MS })
}

function dashboardLauncher(page: Page) {
  return page.locator('[data-tool-panel="sidebar-section:quirky.agent-status/dashboard"]').getByRole('button', { name: /^Agent Dashboard/ })
}

async function openRealAuxiliaryTab(fixture: OwnedFixture, page: Page, injectNull: boolean): Promise<Page> {
  const context = fixture.context
  const client = fixture.client
  if (!context || !client) throw new Error('browser fixture is not connected')
  const dashboardButton = dashboardLauncher(page)
  if (!await dashboardButton.isVisible()) {
    await page.locator('.tool-shell__tool-button[aria-label="Agent Dashboard"]').click()
  }
  await dashboardButton.waitFor({ state: 'visible', timeout: UI_TIMEOUT_MS })
  if (injectNull) {
    await page.evaluate(() => {
      const nativeOpen = window.open.bind(window)
      let blockFirst = true
      window.open = ((...args: Parameters<typeof window.open>) => {
        if (blockFirst) {
          blockFirst = false
          return null
        }
        return nativeOpen(...args)
      }) as typeof window.open
    })
  }
  const previousPages = context.pages().length
  await dashboardButton.click()
  if (injectNull) {
    const prompt = page.getByRole('dialog', { name: 'Open tab' })
    await prompt.waitFor({ state: 'visible', timeout: UI_TIMEOUT_MS })
    expect((await prompt.textContent())?.toLowerCase().includes('blocked')).toBe(true)
    console.info('browser popup recovery screenshots:', (await screenshotProof(page)).join(', '))
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.emulateMedia({ colorScheme: 'light' })
    await prompt.getByRole('button', { name: 'Open tab', exact: true }).click()
  } else {
    const promptState = await waitFor(async () => ({
      pageCount: context.pages().length,
      promptVisible: await page.getByRole('dialog', { name: 'Open tab' }).isVisible().catch(() => false)
    }), (state) => state.pageCount > previousPages || state.promptVisible, 'an attached auxiliary page or popup prompt')
    if (promptState.promptVisible) {
      await page.getByRole('dialog', { name: 'Open tab' }).getByRole('button', { name: 'Open tab', exact: true }).click()
    }
  }
  const possibleChild = await waitFor(async () => context.pages().find((candidate) => candidate !== page && !candidate.isClosed()), (candidate) => candidate !== undefined, 'the browser-owned auxiliary page')
  if (!possibleChild) throw new Error('the browser did not create an auxiliary page')
  const child = possibleChild
  await child.waitForFunction(() => new URL(location.href).searchParams.has('quirkyWindowId'), undefined, { timeout: UI_TIMEOUT_MS })
  await waitForApp(child)
  await child.getByRole('button', { name: 'Pop out', exact: true }).waitFor({ state: 'visible', timeout: UI_TIMEOUT_MS })
  expect(child.url().startsWith(new URL(page.url()).origin)).toBe(true)
  const route = new URL(child.url()).searchParams
  const windowId = route.get('quirkyWindowId')
  const ownerText = route.get('quirkyOwnerShellConnId')
  const requestedView = 'view:quirky.agent-status/dashboard'
  if (!windowId || !ownerText || !/^[1-9]\d*$/.test(ownerText) || route.get('quirkyView') !== requestedView) {
    throw new Error('auxiliary tab did not attach the requested owner-bound Dashboard route')
  }
  const ownerConnId = Number(ownerText)
  if (!Number.isSafeInteger(ownerConnId)) throw new Error('auxiliary tab route has an invalid owner connection')
  const attached = await waitFor(async () => {
    const windows = await client.callAny('desktop.window.list', {}, { timeoutMs: 10_000 })
    return Array.isArray(windows)
      ? windows.map(asRecord).find((window) => window.windowId === windowId && window.attached === true)
      : undefined
  }, (window) => window !== undefined, 'the exact owner-bound auxiliary route to attach')
  if (!attached) throw new Error('auxiliary tab did not attach to the daemon')
  const owner = asRecord(attached.ownerShell)
  if (owner.connId !== ownerConnId || attached.view !== requestedView) {
    throw new Error('attached auxiliary route does not match its exact owner and requested Dashboard')
  }
  return child
}

async function waitForTerminalOutput(page: Page): Promise<void> {
  const terminal = page.locator('.xterm-screen').last()
  await terminal.waitFor({ state: 'visible', timeout: UI_TIMEOUT_MS })
  const input = page.locator('.xterm-helper-textarea').last()
  await input.click()
  await page.keyboard.type("printf 'G8_BROWSER_ECHO\\n'")
  await page.keyboard.press('Enter')
  await page.waitForFunction((marker) => {
    const rows = [...document.querySelectorAll('.xterm-rows > div')]
    return rows.some((row) => row.textContent?.trim() === marker)
  }, TERMINAL_ECHO, { timeout: UI_TIMEOUT_MS })
}

function startLocalWatchSite(fixture: OwnedFixture): string {
  const site = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch() {
      return new Response(`<!doctype html><html><head><meta charset="utf-8"><title>${WATCH_FIXTURE}</title><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#12d94a;color:#07120a;font:700 32px sans-serif}main{box-sizing:border-box;width:100%;height:100%;display:grid;place-items:center}section{padding:36px;background:#fff;border:10px solid #073b17;border-radius:24px}</style></head><body><main><section>${WATCH_FIXTURE}</section></main></body></html>`, {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }
      })
    }
  })
  const port = site.port
  if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0) {
    site.stop(true)
    throw new Error('owned Watch fixture did not bind a loopback port')
  }
  fixture.site = site
  return `http://127.0.0.1:${port}/fixture`
}

async function assertWatchFrame(page: Page, fixture: OwnedFixture, worktreeId: string, siteUrl: string): Promise<void> {
  const client = fixture.client
  if (!client) throw new Error('browser fixture has no daemon client')
  const opened = asRecord(await client.callAny('quirky.browser/paneOpen', {
    worktree: `id:${worktreeId}`,
    url: siteUrl,
    mode: 'watch'
  }, { timeoutMs: 60_000 }))
  const watchImage = page.locator('.qbp-watch-image').last()
  await watchImage.waitFor({ state: 'visible', timeout: 60_000 })
  await page.waitForFunction((marker) => {
    const image = document.querySelector<HTMLImageElement>('.qbp-watch-image')
    return image !== null && image.complete && image.naturalWidth > 0 && image.naturalHeight > 0 && image.alt.includes(marker)
  }, WATCH_FIXTURE, { timeout: 60_000 })
  const pixel = await watchImage.evaluate((image: HTMLImageElement) => {
    const canvas = document.createElement('canvas')
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    const context = canvas.getContext('2d')
    if (!context || canvas.width === 0 || canvas.height === 0) return null
    context.drawImage(image, 0, 0)
    const x = Math.max(1, Math.floor(canvas.width * 0.05))
    const y = Math.max(1, Math.floor(canvas.height * 0.05))
    const value = context.getImageData(x, y, 1, 1).data
    return { width: canvas.width, height: canvas.height, r: value[0], g: value[1], b: value[2], src: image.currentSrc }
  })
  expect(pixel).not.toBeNull()
  expect(pixel!.width).toBeGreaterThan(0)
  expect(pixel!.height).toBeGreaterThan(0)
  expect(pixel!.src.startsWith('data:image/')).toBe(true)
  expect(pixel!.g).toBeGreaterThan(150)
  expect(pixel!.r).toBeLessThan(100)
  const state = asRecord(await client.callAny('quirky.browser/paneState', { worktree: `id:${worktreeId}` }, { timeoutMs: 10_000 }))
  const tabs = Array.isArray(state.tabs) ? state.tabs.map(asRecord) : []
  expect(tabs.some((tab) => tab.id === opened.id && tab.mode === 'watch' && tab.url === siteUrl)).toBe(true)
}

async function screenshotProof(page: Page): Promise<string[]> {
  const directory = mkdtempSync(join(tmpdir(), `g8-2-browser-proof-${process.pid}-`))
  const captures: string[] = []
  for (const variant of [
    { name: 'desktop-light', width: 1440, height: 900, colorScheme: 'light' as const },
    { name: 'mobile-light', width: 390, height: 844, colorScheme: 'light' as const },
    { name: 'desktop-dark', width: 1440, height: 900, colorScheme: 'dark' as const },
    { name: 'mobile-dark', width: 390, height: 844, colorScheme: 'dark' as const }
  ]) {
    await page.setViewportSize({ width: variant.width, height: variant.height })
    await page.emulateMedia({ colorScheme: variant.colorScheme })
    await page.evaluate(() => {
      const { promise, resolve } = Promise.withResolvers<void>()
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      return promise
    })
    const path = join(directory, `${variant.name}.png`)
    await page.screenshot({ path, animations: 'disabled' })
    captures.push(path)
  }
  return captures
}

function scopedChromiumProcesses(scopeToken: string): { pid: number; command: string }[] {
  const result = Bun.spawnSync(['ps', '-A', '-o', 'pid=,command='], { stdout: 'pipe', stderr: 'ignore' })
  if (result.exitCode !== 0) return []
  const found: { pid: number; command: string }[] = []
  for (const line of result.stdout.toString().split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(.+)$/)
    if (!match) continue
    const pid = Number(match[1])
    const command = match[2]!
    if (!command.includes('--remote-debugging-port=') || !command.includes('--user-data-dir=')) continue
    let environment = ''
    try {
      if (process.platform === 'linux') environment = readFileSync(`/proc/${pid}/environ`).toString('utf8')
      else environment = Bun.spawnSync(['ps', 'eww', '-p', String(pid), '-o', 'command='], { stdout: 'pipe', stderr: 'ignore' }).stdout.toString()
    } catch {
      continue
    }
    if (environment.includes(`QUIRKY_TEST_SCOPE=${scopeToken}`)) found.push({ pid, command })
  }
  return found
}

function buildLayout(root: string, uiOut: string, pluginsDir: string): BuildEnvironment {
  const env = createIsolatedRuntimeEnvironment(join(root, 'home')) as BuildEnvironment
  env.QUIRKY_HOME = join(root, 'home')
  env.QUIRKY_UI_OUT = uiOut
  env.QUIRKY_PLUGINS_DIR = pluginsDir
  env.QUIRKY_BUILTIN_PLUGINS_DIR = pluginsDir
  return env
}

function createMinimalBuildLayout(): { root: string; plugins: string; ui: string; env: BuildEnvironment; cleanup(): void } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'quirky-build-preflight-')))
  const plugins = join(root, 'plugins')
  const ui = join(root, 'ui')
  mkdirSync(ui)
  mkdirSync(join(plugins, 'quirky.worktree', 'src'), { recursive: true })
  mkdirSync(join(plugins, 'quirky.worktree', 'dist'), { recursive: true })
  writeFileSync(join(plugins, 'quirky.worktree', 'src', 'ui.tsx'), 'export {}\n')
  return { root, plugins, ui, env: buildLayout(root, ui, plugins), cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

async function expectBuilderNotCalled(root: string, env: BuildEnvironment): Promise<void> {
  let calls = 0
  let failure: unknown = null
  try {
    await safelyBuild(root, REPO_ROOT, env, async () => { calls++ })
  } catch (error) {
    failure = error
  }
  expect(failure).toBeInstanceOf(Error)
  expect(calls).toBe(0)
}


test('build preflight rejects checkout roots and escaping plugin/output links before invoking a builder', async () => {
  const checkoutUi = createMinimalBuildLayout()
  try {
    await expectBuilderNotCalled(checkoutUi.root, {
      ...checkoutUi.env,
      QUIRKY_UI_OUT: join(REPO_ROOT, 'packages/ui/dist')
    })
    await expectBuilderNotCalled(checkoutUi.root, {
      ...checkoutUi.env,
      QUIRKY_PLUGINS_DIR: join(REPO_ROOT, 'plugins'),
      QUIRKY_BUILTIN_PLUGINS_DIR: join(REPO_ROOT, 'plugins')
    })
    rmSync(checkoutUi.ui, { recursive: true, force: true })
    symlinkSync(join(REPO_ROOT, 'packages/ui/dist'), checkoutUi.ui, 'dir')
    await expectBuilderNotCalled(checkoutUi.root, checkoutUi.env)
  } finally {
    checkoutUi.cleanup()
  }

  const pluginLink = createMinimalBuildLayout()
  try {
    rmSync(join(pluginLink.plugins, 'quirky.worktree'), { recursive: true, force: true })
    symlinkSync(join(REPO_ROOT, 'plugins/quirky.worktree'), join(pluginLink.plugins, 'quirky.worktree'), 'dir')
    await expectBuilderNotCalled(pluginLink.root, pluginLink.env)
  } finally {
    pluginLink.cleanup()
  }

  const outputLink = createMinimalBuildLayout()
  try {
    rmSync(join(outputLink.plugins, 'quirky.worktree', 'dist'), { recursive: true, force: true })
    symlinkSync(join(REPO_ROOT, 'plugins/quirky.worktree/dist'), join(outputLink.plugins, 'quirky.worktree', 'dist'), 'dir')
    await expectBuilderNotCalled(outputLink.root, outputLink.env)
  } finally {
    outputLink.cleanup()
  }
})

test('owned fixture lifecycle removes its root after setup and build failures', async () => {
  const statusBefore = checkoutGitStatus(REPO_ROOT)
  const outputsBefore = checkoutOutputSnapshot(REPO_ROOT)
  const setup = await ownedLifecycle(async () => { throw new InjectedLifecycleFailure('setup') })
  expect(setup.error).toBeInstanceOf(InjectedLifecycleFailure)
  expect((setup.error as InjectedLifecycleFailure).stage).toBe('setup')
  assertCleanup(setup.cleanup)
  expect(existsSync(setup.root)).toBe(false)

  let builderCalls = 0
  const build = await ownedLifecycle(async (fixture) => {
    fixture.prepareBuildTree()
    await fixture.build(async () => {
      builderCalls++
      const child = fixture.scope.spawn([process.execPath, '-e', 'setInterval(() => {}, 60000)'], {
        cwd: REPO_ROOT,
        env: fixture.env,
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'ignore'
      })
      fixture.trackedProcesses.push(child)
      throw new InjectedLifecycleFailure('build')
    })
  })
  expect(build.error).toBeInstanceOf(InjectedLifecycleFailure)
  expect((build.error as InjectedLifecycleFailure).stage).toBe('build')
  expect(builderCalls).toBe(1)
  assertCleanup(build.cleanup)
  expect(existsSync(build.root)).toBe(false)
  expect(checkoutGitStatus(REPO_ROOT)).toBe(statusBefore)
  expect(checkoutOutputSnapshot(REPO_ROOT)).toEqual(outputsBefore)
})

async function realBrowserScenario(injectFlowFailureAfterAcquisition: boolean): Promise<void> {
  const executablePath = browserExecutable()
  const beforeStatus = checkoutGitStatus(REPO_ROOT)
  const beforeOutputs = checkoutOutputSnapshot(REPO_ROOT)
  let proof: RealBrowserProof | undefined
  const outcome = await ownedLifecycle(async (fixture) => {
    fixture.prepareBuildTree()
    const plan = await fixture.build()
    expect(plan.root).toBe(realpathSync(fixture.root))
    expect(plan.uiOut).toBe(fixture.uiOut)
    expect(plan.pluginsDir).toBe(fixture.pluginsDir)
    expect(plan.pluginIds.length).toBeGreaterThan(0)
    const markers = stampOwnedBuildArtifacts(fixture)

    await fixture.startDaemon(executablePath)
    if (!fixture.client || !fixture.daemon) throw new Error('owned daemon startup did not return a client and process')
    const client = fixture.client

    const project = createGitProject(fixture)
    const cli = await runScoped(fixture.scope, [process.execPath, 'packages/cli/src/main.ts', 'ui', 'url'], {
      cwd: REPO_ROOT,
      env: { ...fixture.env, QUIRKY_HOME: fixture.home },
      timeoutMs: 15_000
    })
    if (cli.code !== 0) throw new Error(`real CLI ui url failed (${cli.code}): ${cli.stderr.trim()}`)
    const cliUrl = cli.stdout
    const runtime = readRuntime(fixture.home)
    if (!runtime) throw new Error('owned daemon did not publish runtime metadata')
    const expectedUrl = `http://127.0.0.1:${runtime.port}/#token=${encodeURIComponent(runtime.token)}\n`
    if (cliUrl !== expectedUrl) throw new Error('real CLI ui url did not return the exact authenticated loopback address')
    const assets = await assertServedBuildAssets(fixture, cliUrl, markers)

    const executableFromDaemon = fixture.env.QUIRKY_BROWSER_CHROME
    if (executableFromDaemon !== executablePath) throw new Error('UI and daemon did not resolve the exact same Chrome executable')
    await client.callAny('setting.set', { id: 'setting:quirky.terminal/gpu-acceleration', value: 'off' }, { timeoutMs: 10_000 })
    const page = await fixture.launchBrowser(executablePath)
    await page.goto(cliUrl, { waitUntil: 'domcontentloaded', timeout: UI_TIMEOUT_MS })
    await waitForApp(page)
    expect(await page.evaluate(() => '__quirkyDesktopHost' in window)).toBe(false)

    const projectPath = project
    await addProjectThroughBrowserUi(page, projectPath)
    const repositories = await client.callAny('quirky.repo/list', {}, { timeoutMs: 10_000 })
    expect(Array.isArray(repositories)).toBe(true)
    expect((repositories as Record<string, unknown>[]).some((repo) => repo.path === projectPath)).toBe(true)
    const worktrees = await client.callAny('quirky.worktree/list', {}, { timeoutMs: 10_000 })
    expect(Array.isArray(worktrees)).toBe(true)
    const worktree = (worktrees as Record<string, unknown>[]).find((candidate) => candidate.path === projectPath)
    if (!worktree || typeof worktree.id !== 'string' || typeof worktree.name !== 'string') throw new Error('Browse/Add did not register the exact fixture project worktree')
    await waitForWorkspaceRow(page, worktree.name)
    await page.getByRole('button', { name: `Open ${worktree.name}`, exact: true }).click()
    await waitForTerminalOutput(page)

    await client.callAny('setting.set', { id: 'setting:quirky.agent-status/dashboard-enabled', value: true }, { timeoutMs: 10_000 })
    await client.callAny('setting.set', { id: 'setting:quirky.agent-status/dashboard-open-as', value: 'pop-out' }, { timeoutMs: 10_000 })
    await page.getByRole('button', { name: /^Agent Dashboard/ }).waitFor({ state: 'visible', timeout: UI_TIMEOUT_MS })
    const mainUrlBeforeAux = page.url()
    const firstAux = await openRealAuxiliaryTab(fixture, page, false)
    expect(firstAux.isClosed()).toBe(false)
    expect(page.url()).toBe(mainUrlBeforeAux)
    await dashboardLauncher(page).click()
    await waitFor(() => firstAux.isClosed(), (closed) => closed, 'the first owner-bound auxiliary tab to close')

    const secondAux = await openRealAuxiliaryTab(fixture, page, true)
    expect(secondAux.isClosed()).toBe(false)
    expect(page.url()).toBe(mainUrlBeforeAux)
    await dashboardLauncher(page).click()
    await waitFor(() => secondAux.isClosed(), (closed) => closed, 'the retry-created auxiliary tab to close')

    const watchUrl = startLocalWatchSite(fixture)
    await assertWatchFrame(page, fixture, worktree.id, watchUrl)
    expect(fixture.pageErrors).toEqual([])
    expect(fixture.requests.some((request) => request.startsWith(`${assets.origin}/plugins/quirky.worktree/`))).toBe(true)
    expect(fixture.requests.some((request) => request.startsWith(`${assets.origin}/plugins/quirky.terminal/`))).toBe(true)
    expect(fixture.requests.some((request) => request.startsWith(`${assets.origin}/plugins/quirky.browser/`))).toBe(true)

    const usedPluginUrls = [...new Set(fixture.requests.filter((request) => {
      try { return new URL(request).origin === assets.origin && new URL(request).pathname.startsWith('/plugins/') } catch { return false }
    }))]
    let ownedPluginModuleServed = false
    for (const moduleUrl of usedPluginUrls) {
      const parsed = new URL(moduleUrl)
      const relativePath = decodeURIComponent(parsed.pathname.slice('/plugins/'.length))
      const localPath = servedFile(fixture.pluginsDir, relativePath)
      const response = await fetch(moduleUrl)
      expect(response.status).toBe(200)
      const served = Buffer.from(await response.arrayBuffer())
      if (ownedArtifactHash(served) !== ownedArtifactHash(readFileSync(localPath))) {
        throw new Error(`served plugin module differs from its owned artifact: ${relativePath}`)
      }
      if (localPath === markers.pluginModulePath) {
        if (!served.toString('utf8').includes(markers.plugin)) throw new Error('daemon did not serve the copied worktree module')
        ownedPluginModuleServed = true
      }
    }
    if (!ownedPluginModuleServed) throw new Error('the copied worktree UI module was not requested and verified')
    expect(usedPluginUrls.length).toBeGreaterThan(0)

    const watchImage = page.locator('.qbp-watch-image').last()
    const watchPixel = await watchImage.evaluate((image: HTMLImageElement) => {
      const canvas = document.createElement('canvas')
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      const context = canvas.getContext('2d')
      if (!context) return { width: 0, height: 0, r: 0, g: 0, b: 0 }
      context.drawImage(image, 0, 0)
      const pixel = context.getImageData(Math.max(1, Math.floor(canvas.width * 0.05)), Math.max(1, Math.floor(canvas.height * 0.05)), 1, 1).data
      return { width: canvas.width, height: canvas.height, r: pixel[0]!, g: pixel[1]!, b: pixel[2]! }
    })
    const screenshots = await screenshotProof(page)
    expect(screenshots).toHaveLength(4)
    expect(watchPixel.g).toBeGreaterThan(150)
    expect(watchPixel.r).toBeLessThan(100)
    expect(fixture.pageErrors).toEqual([])

    const scopeToken = fixture.scope.env.QUIRKY_TEST_SCOPE
    const browserProcesses = await waitFor(
      () => scopedChromiumProcesses(scopeToken),
      (rows) => rows.some((row) => row.command.includes('--user-data-dir=')),
      'the Watch Chromium process owned by this fixture',
      10_000
    )
    for (const row of browserProcesses) {
      fixture.scope.track(row.pid)
      fixture.ownedPids.push(row.pid)
    }
    expect(browserProcesses.some((row) => row.command.includes('--user-data-dir='))).toBe(true)
    if (!fixture.ptyHostPid) throw new Error('real PTY host was not tracked')

    const gitStatusBeforeCleanup = checkoutGitStatus(REPO_ROOT)
    const outputHashBeforeCleanup = checkoutOutputSnapshot(REPO_ROOT)
    expect(gitStatusBeforeCleanup).toBe(beforeStatus)
    expect(outputHashBeforeCleanup).toEqual(beforeOutputs)
    proof = {
      project: projectPath,
      pages: fixture.pages.length,
      watch: watchPixel,
      screenshots
    }
    if (injectFlowFailureAfterAcquisition) throw new InjectedLifecycleFailure('flow')
    if (!proof) throw new Error('real browser flow produced no cleanup proof')
    return proof
  })
  const afterStatus = checkoutGitStatus(REPO_ROOT)
  const afterOutputs = checkoutOutputSnapshot(REPO_ROOT)
  expect(afterStatus).toBe(beforeStatus)
  expect(afterOutputs).toEqual(beforeOutputs)

  if (injectFlowFailureAfterAcquisition) {
    expect(outcome.error).toBeInstanceOf(InjectedLifecycleFailure)
    expect((outcome.error as InjectedLifecycleFailure).stage).toBe('flow')
  } else {
    expect(outcome.error).toBeNull()
    if (!outcome.value) throw new Error('successful owned lifecycle returned no browser proof')
    proof = outcome.value
  }
  if (!proof) throw new Error('real browser flow proof was not retained')
  expect(outcome.pageErrors).toEqual([])
  expect(proof.pages).toBeGreaterThanOrEqual(3)
  expect(proof.watch.g).toBeGreaterThan(150)
  expect(proof.watch.r).toBeLessThan(100)
  expect(proof.screenshots.every(existsSync)).toBe(true)
  assertCleanup(outcome.cleanup)
  expect(existsSync(outcome.root)).toBe(false)

  const hash = createHash('sha256').update(JSON.stringify(afterOutputs)).digest('hex')
  console.info(`browser-tab owned cleanup: pages ${outcome.cleanup.closedPageCount}/${outcome.cleanup.pageCount}, daemon stopped=${outcome.cleanup.daemonStopped}, client closed=${outcome.cleanup.clientClosed}, process scope cleaned=${outcome.cleanup.processScopeCleaned}, owned PIDs stopped=${outcome.cleanup.ownedProcessesStopped}, fixture removed=${outcome.cleanup.temporaryDirectoryRemoved}; checkout status unchanged; UI/plugin output manifest SHA-256 ${hash}; screenshots ${proof!.screenshots.join(', ')}`)
}

test('real browser proof cleans successful and injected-flow lifecycles', async () => {
  await realBrowserScenario(false)
  await realBrowserScenario(true)
}, 600_000)
