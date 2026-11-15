import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { captureCells, discoverCaptureTargets, ensureHandoffTerminalContext, fixtureViewInput, hostingToolFor, openSurfaceTool, selectCaptureTargets, targetSlotSelector, waitForStateShown } from './capture'
import { goldenFor } from './goldens'
import { seedRows, type SceneRuntime } from './shell-scenes'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { UiModel, UiSlotEntry, UiToolEntry } from '@quirky/protocol'
import type { CaptureTarget } from './contracts'

const slot = (id: string, plugin: string, title = id): UiSlotEntry => ({
  id, plugin, title, kind: id.slice(0, id.indexOf(':')) as UiSlotEntry['kind'],
  module: `/plugins/${plugin}/dist/ui.js`, order: 10
})

function model(): UiModel {
  return {
    sidebarSections: [slot('sidebar-section:acme.worktrees/list', 'acme.worktrees')],
    statusBars: [slot('status-bar:acme.status/summary', 'acme.status')],
    activityItems: [slot('activity-item:acme.inbox/items', 'acme.inbox')],
    panels: [slot('panel:acme.git/changes', 'acme.git')],
    settingsSections: [slot('settings-section:acme.settings/accounts', 'acme.settings')],
    views: [slot('view:acme.editor/document', 'acme.editor')],
    overlays: [slot('overlay:acme.editor/quick-open', 'acme.editor')],
    commands: [],
    keybindings: [],
    settings: [],
    menuItems: [],
    themes: [],
    theme: { chosen: 'default', active: 'default' },
    modules: {}
  } as UiModel
}

describe('UI capture inventory', () => {
  test('discovers all seven contribution slot kinds and the host surfaces', () => {
    const targets = discoverCaptureTargets(model())

    expect(new Set(targets.map((target) => target.kind))).toEqual(new Set([
      'host', 'view', 'panel', 'sidebar-section', 'activity-item', 'status-bar', 'overlay', 'settings-section'
    ]))
    expect(targets.filter((target) => target.kind === 'host').map((target) => target.id)).toEqual([
      'host:shell', 'host:scoped', 'host:popups', 'host:settings', 'host:palette'
    ])
    expect(targets.map((target) => target.id)).toContain('settings-section:acme.settings/accounts')
  })

  test('matches an overridden contribution by its logical surface namespace', () => {
    const inventory = model()
    inventory.views.push(slot('view:quirky.session/worktree', 'quirky.terminal'))
    const targets = discoverCaptureTargets(inventory)

    expect(targets.find((target) => target.id === 'view:quirky.session/worktree')).toMatchObject({ plugin: 'quirky.session' })
    expect(selectCaptureTargets(targets, ['quirky.session']).map((target) => target.id)).toContain('view:quirky.session/worktree')
  })

  test('matches exact contribution IDs and exact plugin IDs without partial matches', () => {
    const targets = discoverCaptureTargets(model())
    const byContribution = selectCaptureTargets(targets, ['view:acme.editor/document'])
    const byPlugin = selectCaptureTargets(targets, ['acme.editor'])

    expect(byContribution.map((target) => target.id)).toEqual(['view:acme.editor/document'])
    expect(byPlugin.map((target) => target.id)).toEqual([
      'view:acme.editor/document', 'overlay:acme.editor/quick-open'
    ])
    expect(() => selectCaptureTargets(targets, ['acme'])).toThrow(/unknown.*selector/i)
  })

  test('rejects empty and unknown selectors instead of returning an empty success', () => {
    const targets = discoverCaptureTargets(model())

    expect(() => selectCaptureTargets(targets, [''])).toThrow(/empty.*selector/i)
    expect(() => selectCaptureTargets(targets, ['   '])).toThrow(/empty.*selector/i)
    expect(() => selectCaptureTargets(targets, ['host:missing'])).toThrow(/unknown.*selector/i)
    expect(() => selectCaptureTargets(targets, ['acme.editor', 'missing.plugin'])).toThrow(/unknown.*selector/i)
  })

  test('rejects duplicate target IDs before constructing a coverage matrix', () => {
    const duplicate = model()
    duplicate.views = [slot('host:shell', 'acme.editor') as UiModel['views'][number]]

    expect(() => discoverCaptureTargets(duplicate)).toThrow(/duplicate.*target ID/i)
  })

  test('creates exactly one dark and light coverage cell per selected target', () => {
    const targets: CaptureTarget[] = [
      { id: 'host:shell', plugin: null, title: 'Quirky', kind: 'host' },
      { id: 'panel:acme.git/changes', plugin: 'acme.git', title: 'Changes', kind: 'panel' }
    ]
    const cells = captureCells(targets)

    expect(cells).toHaveLength(4)
    expect(cells).toEqual([
      { targetId: 'host:shell', theme: 'dark' },
      { targetId: 'panel:acme.git/changes', theme: 'dark' },
      { targetId: 'host:shell', theme: 'light' },
      { targetId: 'panel:acme.git/changes', theme: 'light' }
    ])
    expect(new Set(cells.map(({ targetId, theme }) => `${targetId}\0${theme}`)).size).toBe(cells.length)
  })
})

describe('host composite targets', () => {
  test('host:shell, host:scoped and host:popups are listed and each maps to its own golden', () => {
    const hosts = discoverCaptureTargets(model()).filter((target) => target.kind === 'host')

    expect(hosts.map((target) => target.id)).toEqual(expect.arrayContaining(['host:shell', 'host:scoped', 'host:popups']))
    for (const [id, kind] of [['host:shell', 'shell'], ['host:scoped', 'scoped'], ['host:popups', 'popups']] as const) {
      expect(goldenFor(id, 'dark')).toEndWith(`golden-${kind}-dark.png`)
      expect(goldenFor(id, 'light')).toEndWith(`golden-${kind}-light.png`)
    }
  })
})

const tool = (id: string, contributionId: string | null, aliases: string[] = [contributionId ?? id]): UiToolEntry => ({
  id, title: id, icon: 'pulse', hue: 'slate', defaultSlot: 'left-top', contributionId, aliases
})

function toolModel(): UiModel {
  return {
    ...model(),
    tools: [
      tool('sidebar-section:acme.worktrees/list', 'sidebar-section:acme.worktrees/list'),
      tool('sidebar-section:acme.tasks/list', 'view:acme.tasks/page', ['sidebar-section:acme.tasks/list', 'view:acme.tasks/page']),
      tool('panel:acme.git/changes', 'panel:acme.git/changes', ['panel:acme.git/changes', 'activity-item:acme.git/source-control'])
    ]
  } as UiModel
}

const target = (id: string, plugin: string, kind: CaptureTarget['kind']): CaptureTarget => ({ id, plugin, title: id, kind })

describe('capture target DOM selectors', () => {
  test('uses mounted portal roots for feedback and floating overlays', () => {
    expect(targetSlotSelector(target('overlay:quirky.feedback/mode', 'quirky.feedback', 'overlay'))).toBe('[data-quirky-feedback]')
    expect(targetSlotSelector(target('overlay:quirky.terminal/floating', 'quirky.terminal', 'overlay'))).toBe('[data-floating-panel]')
  })

  test('uses plugin mount attributes for non-portal targets', () => {
    expect(targetSlotSelector(target('overlay:quirky.handoff/dialog', 'quirky.handoff', 'overlay')))
      .toBe('[data-plugin-overlay="overlay:quirky.handoff/dialog"]')
    expect(targetSlotSelector(target('view:quirky.accounts/session-accessory', 'quirky.accounts', 'view')))
      .toBe('[data-plugin-slot="view:quirky.accounts/session-accessory"]')
  })
})

function fakeRuntime(state: () => unknown) {
  const calls: Array<{ method: string; params: unknown }> = []
  const runtime = {
    model: toolModel(),
    options: { timeoutMs: 400 },
    client: {
      async callAny(method: string, params?: Record<string, unknown>) {
        calls.push({ method, params })
        return method === 'ui.state' ? state() : {}
      },
      close() {}
    }
  }
  return { runtime, calls }
}

describe('opening the tool that hosts a target', () => {
  test('a sidebar section is hosted by the tool that lists it as its body or an alias', () => {
    const m = toolModel()

    expect(hostingToolFor(m, target('sidebar-section:acme.worktrees/list', 'acme.worktrees', 'sidebar-section'))).toBe('sidebar-section:acme.worktrees/list')
    expect(hostingToolFor(m, target('sidebar-section:acme.tasks/list', 'acme.tasks', 'sidebar-section'))).toBe('sidebar-section:acme.tasks/list')
    expect(hostingToolFor(m, target('activity-item:acme.git/source-control', 'acme.git', 'activity-item'))).toBe('panel:acme.git/changes')
  })

  test('a status bar item needs no tool', () => {
    expect(hostingToolFor(toolModel(), target('status-bar:acme.status/summary', 'acme.status', 'status-bar'))).toBeNull()
  })

  test('a sidebar section with no hosting tool is reported instead of waited for', () => {
    expect(() => hostingToolFor(toolModel(), target('sidebar-section:acme.ghost/none', 'acme.ghost', 'sidebar-section'))).toThrow(/no tool hosts/i)
  })

  test('a sidebar-section target opens its tool and is shown without waiting out the timeout', async () => {
    const section = target('sidebar-section:acme.worktrees/list', 'acme.worktrees', 'sidebar-section')
    const { runtime, calls } = fakeRuntime(() => ({ slots: [{ id: section.id, shown: calls.some((call) => call.method === 'ui.tool.open') }] }))
    const started = Date.now()

    await openSurfaceTool(runtime as never, section)
    await waitForStateShown(runtime as never, section)

    expect(calls.find((call) => call.method === 'ui.tool.open')?.params).toEqual({ id: 'sidebar-section:acme.worktrees/list' })
    expect(Date.now() - started).toBeLessThan(300)
  })

  test('a section whose tool shows a different body fails at once instead of waiting for a state that cannot come', async () => {
    const tasks = target('sidebar-section:acme.tasks/list', 'acme.tasks', 'sidebar-section')
    const { runtime, calls } = fakeRuntime(() => ({ slots: [] }))

    await expect(openSurfaceTool(runtime as never, tasks)).rejects.toThrow(/view:acme\.tasks\/page/)
    expect(calls.map((call) => call.method)).not.toContain('ui.tool.open')
  })

  test('a status-bar target opens no tool', async () => {
    const status = target('status-bar:acme.status/summary', 'acme.status', 'status-bar')
    const { runtime, calls } = fakeRuntime(() => ({ slots: [{ id: status.id, shown: true }] }))

    await openSurfaceTool(runtime as never, status)
    await waitForStateShown(runtime as never, status)

    expect(calls.map((call) => call.method)).not.toContain('ui.tool.open')
  })
})

describe('review fixtures', () => {
  test('the git diff view opens in review mode', () => {
    const fixtures = { primaryWorktree: { id: 'wt-1' }, repo: { id: 'repo-1' } } as Parameters<typeof fixtureViewInput>[0]
    const input = fixtureViewInput(fixtures, { id: 'view:quirky.git/diff', plugin: 'quirky.git', kind: 'view', title: 'Diff' } as CaptureTarget, null, null)
    expect(input).toMatchObject({ worktree: 'wt-1', mode: 'review' })
    expect(input).not.toHaveProperty('path')
    expect(input).not.toHaveProperty('source')
  })

  test('the accounts accessory view receives its terminal session and pane fixture', () => {
    const fixtures = { primaryWorktree: { id: 'wt-1' }, repo: { id: 'repo-1' } } as Parameters<typeof fixtureViewInput>[0]
    const terminalFixture = { sessionId: 'session-1', tabId: 'tab-1', paneId: 'pane-1' }
    const input = fixtureViewInput(
      fixtures,
      { id: 'view:quirky.accounts/session-accessory', plugin: 'quirky.accounts', kind: 'view', title: 'Session' } as CaptureTarget,
      null,
      terminalFixture
    )
    expect(input).toMatchObject({ sessionId: 'session-1', paneId: 'pane-1' })
  })

  test('structured and worktree session views receive fixtures of the matching kind', () => {
    const fixtures = { primaryWorktree: { id: 'wt-1' }, repo: { id: 'repo-1' } } as Parameters<typeof fixtureViewInput>[0]
    const terminalFixture = { sessionId: 'shell-1', tabId: 'tab-1', paneId: 'pane-1' }
    const structured = fixtureViewInput(
      fixtures,
      { id: 'view:quirky.session/structured', plugin: 'quirky.session', kind: 'view', title: 'Structured session' } as CaptureTarget,
      null,
      terminalFixture,
      'structured-1'
    )
    const worktree = fixtureViewInput(
      fixtures,
      { id: 'view:quirky.session/worktree', plugin: 'quirky.session', kind: 'view', title: 'Worktree sessions' } as CaptureTarget,
      null,
      terminalFixture,
      'structured-1'
    )
    expect(structured).toMatchObject({ session: 'structured-1' })
    expect(structured).not.toHaveProperty('sessionId')
    expect(worktree).toMatchObject({ session: 'shell-1', sessionId: 'shell-1', paneId: 'pane-1' })
  })

  test.each(['ready', 'unsupported'])('Handoff seeds scrollback with a POSIX shell whose integration is %s', async (shellState) => {
    let output: string[] = []
    const runtime = {
      terminalFixture: { sessionId: 'shell-1', tabId: 'tab-1', paneId: 'pane-1' },
      options: { timeoutMs: 1_000 },
      client: {
        async callAny(method: string, params: Record<string, unknown> = {}) {
          if (method === 'quirky.terminal/history') {
            return { lines: output.slice(0, Math.max(0, output.length - 24)), cursor: null }
          }
          if (method === 'quirky.terminal/snapshot') return { shellState, rows: 24 }
          if (method === 'quirky.terminal/write') {
            const command = Bun.spawnSync(['/bin/sh', '-c', String(params.data)], {
              env: { PATH: '/usr/bin:/bin', QUIRKY_HOME: process.env.QUIRKY_HOME! }
            })
            expect(command.exitCode).toBe(0)
            output = command.stdout.toString().trim().split('\n')
            return { ok: true }
          }
          throw new Error(`unexpected RPC ${method}`)
        }
      }
    } as unknown as Parameters<typeof ensureHandoffTerminalContext>[0]

    await ensureHandoffTerminalContext(runtime)
    expect(output.length).toBeGreaterThan(24)
    expect(new Set(output)).toEqual(new Set(['UI review handoff fixture']))
  })

  test('seeding marks two changed files reviewed and leaves one of them changed since review', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ui-review-seed-'))
    try {
      const marks: Array<Record<string, unknown>> = []
      const contentAtMark = new Map<string, string>()
      const runtime = {
        client: {
          async callAny(method: string, params: Record<string, unknown> = {}) {
            if (method === 'quirky.git/setReviewMark') {
              marks.push(params)
              contentAtMark.set(String(params.path), readFileSync(join(root, String(params.path)), 'utf8'))
            }
            return {}
          }
        },
        options: { timeoutMs: 1000 }
      } as unknown as SceneRuntime
      await seedRows(runtime, { id: 'wt-1', path: root, repoId: 'repo-1' })
      const reviewed = marks.filter((mark) => mark.reviewed === true)
      expect(reviewed).toHaveLength(2)
      expect(reviewed.every((mark) => mark.worktree === 'wt-1')).toBe(true)
      const paths = reviewed.map((mark) => String(mark.path))
      const changed = paths.filter((path) => readFileSync(join(root, path), 'utf8') !== contentAtMark.get(path))
      expect(paths.sort()).toEqual(['src/app.ts', 'src/review-note.ts'])
      expect(changed).toEqual(['src/review-note.ts'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

test('captureApplication owns runtime assets across its build and verification lifecycle', async () => {
  const home = mkdtempSync(join(tmpdir(), 'capture-lifecycle-harness-'))
  const repoRoot = resolve(import.meta.dir, '../..')
  const harnessPath = join(home, 'capture.lifecycle.mocked.test.ts')
  const harness = String.raw`
import { expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

type Fixture = { base: string; repoRoot: string; outputDir: string; scopeHome: string; canonicalHome: string }
type CaptureOptions = {
  repoRoot: string
  outputDir: string
  only: string[]
  skipBuild: boolean
  browserExecutable?: string
  themes?: readonly ('dark' | 'light')[]
  timeoutMs: number
  signal?: AbortSignal
}
type SavedCell = {
  targetId: string
  theme: string
  status: string
  image: { path: string } | null
  error?: string
}
type SavedProgress = { commit: string; targets: Array<{ id: string }>; captures: SavedCell[]; failures: string[] }
type AssetRoots = { repoRoot: string; uiDir: string; pluginsDir: string; ownedRoot: string | null }
type RuntimePreparation = { repoRoot: string; home: string; skipBuild: boolean; signal?: AbortSignal }
type FixtureHome = {
  home: string
  repoPath: string
  projects: unknown[]
  worktreesRoot: string
  files: Record<string, string>
  tasks: Record<string, unknown>
  cleanup(): void
}
type FakeChild = {
  stdout: ReadableStream<Uint8Array>
  stderr: ReadableStream<Uint8Array>
  exited: Promise<number>
  readonly exitCode: number | null
  kill(signal: string): void
}
type VerificationRecord = {
  port: number
  progressExists: boolean
  progress: SavedProgress | null
  pageGotoCount: number
  ownedRoot: string | null
}
type LifecycleState = {
  base: string
  repoRoot: string
  outputDir: string
  allocatedHome: string
  canonicalHome: string
  scopeHome: string
  token: string
  runtime: { port: number; token: string; hookToken: string }
  events: string[]
  sentinels: Array<{ path: string; bytes: Uint8Array; ino: number; mtimeMs: number }>
  skipBuild: boolean
  failBuild: boolean
  failStartup: boolean
  abortController: AbortController | null
  abortDuringBuild: boolean
  failVerificationAt: number | null
  cleanupFailure: boolean
  verificationMessage: string | (() => string) | undefined
  pageGotoCount: number
  verificationRecords: VerificationRecord[]
  buildEnvironments: Array<Record<string, string>>
  daemonEnvironments: Array<Record<string, string>>
  buildCommands: Array<{ command: string[]; cwd: string }>
  daemonChild: FakeChild | null
  activeTheme: string
  prepareOptions: RuntimePreparation
  assets: AssetRoots
  baseEnvironment: Record<string, string>
  originalEnvironment: Record<string, string>
  runtimeEnvironment: Record<string, string>
  client?: { callAny(method: string, params?: Record<string, unknown>): Promise<unknown>; close(): void }
}

const repoRoot = __REPO_ROOT__
const modulePath = (...parts: string[]) => join(repoRoot, ...parts)
let current: LifecycleState

function stream(text = '') {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (text) controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    }
  })
}

function childProcess(options: { stdout?: string; stderr?: string; status?: number; alive?: boolean; kind?: string }): FakeChild {
  let code: number | null = options.alive ? null : (options.status ?? 0)
  const completion = Promise.withResolvers<number>()
  const exited = options.alive ? completion.promise : Promise.resolve(code!)
  const child: FakeChild = {
    stdout: stream(options.stdout),
    stderr: stream(options.stderr),
    exited,
    get exitCode() { return code },
    kill(signal: string) {
      current.events.push((options.kind ?? 'child') + ':kill:' + signal)
      if (code === null) {
        code = 143
        completion.resolve(143)
      }
    }
  }
  if (options.kind === 'build' && options.alive) {
    void exited.then(() => current.events.push('build:settled'))
  }
  return child
}

function fixture(label: string, settings: Record<string, unknown> = {}): Fixture {
  const base = mkdtempSync(join(process.env.QUIRKY_HOME!, 'capture-' + label + '-'))
  const repo = join(base, 'checkout')
  const output = join(base, 'output')
  const canonicalHome = join(base, 'scope-canonical')
  const allocatedHome = join(base, 'scope-allocated')
  mkdirSync(join(repo, 'packages/ui/dist'), { recursive: true })
  mkdirSync(join(repo, 'plugins/acme.fixture/dist'), { recursive: true })
  mkdirSync(output, { recursive: true })
  mkdirSync(canonicalHome, { recursive: true })
  symlinkSync(canonicalHome, allocatedHome, 'dir')
  writeFileSync(join(repo, 'packages/ui/dist/main.js'), 'checkout-shell-sentinel')
  writeFileSync(join(repo, 'plugins/acme.fixture/manifest.json'), '{"name":"acme.fixture"}')
  writeFileSync(join(repo, 'plugins/acme.fixture/dist/ui.js'), 'checkout-plugin-sentinel')
  const sentinelPaths = [
    join(repo, 'packages/ui/dist/main.js'),
    join(repo, 'plugins/acme.fixture/manifest.json'),
    join(repo, 'plugins/acme.fixture/dist/ui.js')
  ]
  const sentinels = sentinelPaths.map((path) => ({
    path,
    bytes: readFileSync(path),
    ino: statSync(path).ino,
    mtimeMs: statSync(path).mtimeMs
  }))
  const controller = settings.abortController instanceof AbortController ? settings.abortController : null
  const failVerificationAt = typeof settings.failVerificationAt === 'number' ? settings.failVerificationAt : null
  const verificationMessage = typeof settings.verificationMessage === 'string' || typeof settings.verificationMessage === 'function'
    ? settings.verificationMessage as string | (() => string)
    : undefined
  current = {
    base,
    repoRoot: repo,
    outputDir: output,
    allocatedHome,
    canonicalHome,
    scopeHome: allocatedHome,
    token: 'lifecycle-token-' + label,
    runtime: { port: 43125, token: 'lifecycle-token-' + label, hookToken: 'hook-token-' + label },
    events: [],
    sentinels,
    skipBuild: settings.skipBuild === true,
    failBuild: settings.failBuild === true,
    failStartup: settings.failStartup === true,
    abortController: controller,
    abortDuringBuild: settings.abortDuringBuild === true,
    failVerificationAt,
    cleanupFailure: settings.cleanupFailure === true,
    verificationMessage,
    pageGotoCount: 0,
    verificationRecords: [],
    buildEnvironments: [],
    daemonEnvironments: [],
    buildCommands: [],
    daemonChild: null,
    activeTheme: 'dark',
    prepareOptions: { repoRoot: repo, home: allocatedHome, skipBuild: settings.skipBuild === true },
    assets: { repoRoot: repo, uiDir: join(repo, 'packages/ui/dist'), pluginsDir: join(repo, 'plugins'), ownedRoot: null },
    baseEnvironment: {},
    originalEnvironment: {},
    runtimeEnvironment: {}
  }
  return { base, repoRoot: repo, outputDir: output, scopeHome: allocatedHome, canonicalHome }
}

function assertCheckoutSentinelsUnchanged() {
  for (const original of current.sentinels) {
    expect(readFileSync(original.path)).toEqual(original.bytes)
    expect(statSync(original.path).ino).toBe(original.ino)
    expect(statSync(original.path).mtimeMs).toBe(original.mtimeMs)
  }
}

function assertCapturedEvidence(saved: SavedProgress) {
  expect(saved.captures).toHaveLength(2)
  expect(saved.captures.every((item) => item.status === 'captured' && item.image !== null)).toBe(true)
  for (const capture of saved.captures) expect(existsSync(capture.image!.path)).toBe(true)
}

function assertCleanupOrder() {
  const order = ['browser-server:close', 'browser:close', 'rpc:daemon.stop', 'client:close', 'scope:cleanup', 'fixtures:cleanup']
  for (let index = 0; index < order.length - 1; index += 1) {
    expect(current.events.indexOf(order[index])).toBeLessThan(current.events.indexOf(order[index + 1]))
  }
}

function progress(): SavedProgress | null {
  const path = join(current.outputDir, 'capture-progress.json')
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as SavedProgress : null
}

async function rejected(options: CaptureOptions): Promise<string> {
  try {
    await captureApplication(options)
  } catch (error) {
    if (error instanceof Error) return error.message
    throw error
  }
  throw new Error('capture unexpectedly succeeded')
}

function optionsFor(fixtureValue: Fixture, extra: Partial<CaptureOptions> = {}): CaptureOptions {
  return {
    repoRoot: fixtureValue.repoRoot,
    outputDir: fixtureValue.outputDir,
    only: ['host:shell'],
    skipBuild: current.skipBuild,
    browserExecutable: process.execPath,
    themes: ['dark', 'light'],
    timeoutMs: 2_000,
    signal: current.abortController?.signal,
    ...extra
  }
}


type FakeLocator = {
  first(): FakeLocator
  waitFor(...args: unknown[]): Promise<void>
  count(): Promise<number>
  isVisible(): Promise<boolean>
  click(...args: unknown[]): Promise<void>
  fill(...args: unknown[]): Promise<void>
  scrollIntoViewIfNeeded(...args: unknown[]): Promise<void>
  getByRole(...args: unknown[]): FakeLocator
  getByText(...args: unknown[]): FakeLocator
  filter(...args: unknown[]): FakeLocator
  evaluate(...args: unknown[]): Promise<unknown>
}
type FakePage = {
  on(...args: unknown[]): void
  setDefaultTimeout(...args: unknown[]): void
  setDefaultNavigationTimeout(...args: unknown[]): void
  locator(selector?: string): FakeLocator
  getByRole(...args: unknown[]): FakeLocator
  getByLabel(...args: unknown[]): FakeLocator
  keyboard: { press(...args: unknown[]): Promise<void> }
  goto(...args: unknown[]): Promise<void>
  waitForFunction(...args: unknown[]): Promise<boolean>
  evaluate(...args: unknown[]): Promise<string>
  screenshot(options: { path: string }): Promise<Uint8Array>
  isClosed(): boolean
  context(): FakeContext
}
type FakeContext = { browser(): FakeBrowser; newPage(): Promise<FakePage> }
type FakeBrowser = {
  isConnected(): boolean
  close(): Promise<void>
  newContext(): Promise<FakeContext>
}

mock.module('playwright', () => ({
  chromium: {
    executablePath: () => process.execPath,
    async launchServer() {
      current.events.push('browser-server:launch')
      return {
        process: () => ({ pid: undefined }),
        wsEndpoint: () => 'ws://127.0.0.1:9000',
        async close() { current.events.push('browser-server:close') }
      }
    },
    async connect() {
      current.events.push('browser:connect')
      let context: FakeContext
      const browser: FakeBrowser = {
        isConnected: () => true,
        async close() { current.events.push('browser:close') },
        async newContext() { return context }
      }
      const locator = (_selector = ''): FakeLocator => {
        const item: FakeLocator = {
          first: () => item,
          async waitFor() {},
          async count() { return 0 },
          async isVisible() { return false },
          async click() {},
          async fill() {},
          async scrollIntoViewIfNeeded() {},
          getByRole: () => locator(),
          getByText: () => locator(),
          filter: () => item,
          async evaluate() {
            return { text: 'visible shell fixture', rect: { width: 100, height: 100 }, visible: true }
          }
        }
        return item
      }
      const page: FakePage = {
        on() {},
        setDefaultTimeout() {},
        setDefaultNavigationTimeout() {},
        locator,
        getByRole: () => locator(),
        getByLabel: () => locator(),
        keyboard: { async press() {} },
        async goto() {
          current.pageGotoCount += 1
          current.events.push('renderer:navigate')
        },
        async waitForFunction() { return true },
        async evaluate() { return current.activeTheme === 'light' ? '#eeeeee' : '#111111' },
        async screenshot(options) {
          const bytes = new Uint8Array([1, 2, 3, 4])
          writeFileSync(options.path, bytes)
          return bytes
        },
        isClosed: () => false,
        context: () => context
      }
      context = {
        browser: () => browser,
        async newPage() { return page }
      }
      return browser
    }
  }
}))

mock.module(modulePath('scripts/test-support/process-scope.ts'), () => ({
  createProcessScope() {
    const home = current.scopeHome
    return {
      home,
      track() {},
      spawn(command: string[], spawnOptions: { cwd: string; env: Record<string, string> }) {
        const joined = command.join(' ')
        if (joined.includes('/packages/ui/build.ts')) {
          current.events.push('build:spawn')
          current.buildCommands.push({ command, cwd: spawnOptions.cwd })
          current.buildEnvironments.push(spawnOptions.env)
          if (current.abortDuringBuild) {
            const child = childProcess({ alive: true, kind: 'build' })
            const controller = current.abortController
            if (controller) queueMicrotask(() => controller.abort(new Error(
              'caller cancelled at ' + current.scopeHome + ' token=' + current.runtime.token
            )))
            return child
          }
          return childProcess({
            stderr: current.failBuild ? 'fixture build failed' : '',
            status: current.failBuild ? 1 : 0,
            kind: 'build'
          })
        }
        if (command[0] === 'git') {
          current.events.push('commit:read')
          return childProcess({ stdout: '0123456789abcdef0123456789abcdef01234567\n', kind: 'git' })
        }
        if (joined.includes('/packages/daemon/src/main.ts')) {
          current.events.push('daemon:spawn')
          current.daemonEnvironments.push(spawnOptions.env)
          const child = childProcess({ status: current.failStartup ? 1 : 0, alive: !current.failStartup, kind: 'daemon' })
          current.daemonChild = child
          return child
        }
        throw new Error('unexpected owned command: ' + joined)
      },
      async cleanup() {
        current.events.push('scope:cleanup')
        if (current.daemonChild?.exitCode === null) current.daemonChild.kill('SIGTERM')
        rmSync(current.scopeHome, { recursive: true, force: true })
        rmSync(current.canonicalHome, { recursive: true, force: true })
        current.events.push('scope:removed')
        if (current.cleanupFailure) {
          throw new Error('cleanup failed at ' + current.scopeHome + ' ' + current.canonicalHome +
            ' token=' + current.runtime.token)
        }
      }
    }
  }
}))

mock.module('@quirky/protocol/node', () => ({
  async connectDaemon() {
    current.events.push('client:connect')
    const client = {
      async callAny(method: string, params?: Record<string, unknown>) {
        current.events.push('rpc:' + method)
        if (method === 'status.get') return { home: current.scopeHome }
        if (method === 'ui.contributions') return {
          views: [], panels: [], sidebarSections: [], activityItems: [], statusBars: [],
          overlays: [], settingsSections: [], modules: {}
        }
        if (method === 'theme.list') return {
          themes: [
            { id: 'dark', title: 'Dark', plugin: null, appearance: 'dark', colors: { bg: '#111111' } },
            { id: 'light', title: 'Light', plugin: null, appearance: 'light', colors: { bg: '#eeeeee' } }
          ],
          chosen: current.activeTheme,
          active: current.activeTheme
        }
        if (method === 'theme.set') {
          current.activeTheme = String(params?.id ?? 'dark')
          return { chosen: current.activeTheme, active: current.activeTheme }
        }
        if (method === 'ui.state') return { windows: [{ id: 'capture-window' }], slots: [] }
        return {}
      },
      close() { current.events.push('client:close') }
    }
    current.client = client
    return client
  },
  async isDaemonAlive() { return true },
  readRuntime() { return current.runtime }
}))

mock.module(modulePath('scripts/ui-review/fixtures.ts'), () => ({
  createIsolatedRuntimeEnvironment(home: string, settings: { repoRoot: string; uiDir: string }) {
    current.events.push('environment:base')
    current.baseEnvironment = {
      PATH: '/usr/bin:/bin',
      HOME: home,
      QUIRKY_HOME: home,
      QUIRKY_UI_DIR: settings.uiDir,
      QUIRKY_BUILTIN_PLUGINS_DIR: join(settings.repoRoot, 'plugins')
    }
    return current.baseEnvironment
  },
  async prepareCaptureFixtureHome(home: string) {
    current.events.push('fixtures:prepare')
    return {
      home,
      repoPath: join(home, 'fixture-repo'),
      projects: [],
      worktreesRoot: join(home, 'worktrees'),
      files: {},
      tasks: {},
      cleanup() { current.events.push('fixtures:cleanup') }
    }
  },
  async registerCaptureFixtures(_client: unknown, prepared: FixtureHome) {
    current.events.push('fixtures:register')
    return {
      ...prepared,
      repo: { id: 'repo' },
      primaryWorktree: { id: 'worktree', path: prepared.repoPath, repoId: 'repo', name: 'fixture' },
      worktrees: []
    }
  },
  async seedWorktreeStatuses() { current.events.push('fixtures:seed') },
  async createCaptureTerminalFixture() { return null },
  async openFixtureEditorBuffer() { return null }
}))

mock.module(modulePath('scripts/ui-review/shell-scenes.ts'), () => ({
  async clearScene() {},
  newSceneState: () => ({}),
  async populateShell() {},
  async raiseNeedsYouToast() {},
  async scopeToProject() {},
  async showPopupsTogether() {}
}))

mock.module(modulePath('scripts/ui-review/goldens.ts'), () => ({
  DEVICE_SCALE_FACTOR: 2,
  SCREENSHOT_SIZE: { width: 2_800, height: 1_760 },
  VIEWPORT: { width: 1_400, height: 880 },
  loadGoldenReferences: () => ({}),
  pngDimensions: () => ({ width: 2_800, height: 1_760 }),
  referenceFor: (_references: unknown, targetId: string, theme: string) => ({
    path: '/fixture/golden-' + encodeURIComponent(targetId) + '-' + theme + '.png',
    sha256: 'a'.repeat(64)
  })
}))

mock.module(modulePath('scripts/ui-review/runtime-assets.ts'), () => ({
  async prepareRuntimeAssets(options: { repoRoot: string; home: string; skipBuild: boolean; signal?: AbortSignal }) {
    current.events.push('assets:prepare')
    current.prepareOptions = options
    const ownedRoot = options.skipBuild ? null : join(options.home, 'capture-assets')
    const uiDir = options.skipBuild ? join(options.repoRoot, 'packages/ui/dist') : join(ownedRoot!, 'ui')
    const pluginsDir = options.skipBuild ? join(options.repoRoot, 'plugins') : join(ownedRoot!, 'plugins')
    if (ownedRoot) {
      mkdirSync(uiDir, { recursive: true })
      mkdirSync(pluginsDir, { recursive: true })
    }
    current.assets = { repoRoot: options.repoRoot, uiDir, pluginsDir, ownedRoot }
    return current.assets
  },
  runtimeAssetEnvironment(base: Record<string, string>, assets: AssetRoots) {
    current.events.push('assets:environment')
    current.originalEnvironment = base
    current.runtimeEnvironment = {
      ...base,
      QUIRKY_UI_OUT: assets.uiDir,
      QUIRKY_UI_DIR: assets.uiDir,
      QUIRKY_PLUGINS_DIR: assets.pluginsDir,
      QUIRKY_BUILTIN_PLUGINS_DIR: assets.pluginsDir
    }
    return current.runtimeEnvironment
  },
  snapshotRuntimeAssets() {
    current.events.push('assets:snapshot')
    return new Map([['/main.js', { path: '/main.js', size: 1, sha256: 'a'.repeat(64) }]])
  },
  async verifyRuntimeAssets(assets: AssetRoots, _snapshot: unknown, _model: unknown, options: { port: number }) {
    current.events.push('assets:verify:' + (current.verificationRecords.length + 1))
    const saved = progress()
    current.verificationRecords.push({
      port: options.port,
      progressExists: saved !== null,
      progress: saved,
      pageGotoCount: current.pageGotoCount,
      ownedRoot: assets.ownedRoot
    })
    if (current.failVerificationAt === current.verificationRecords.length) {
      const message = typeof current.verificationMessage === 'function'
        ? current.verificationMessage()
        : (current.verificationMessage ?? 'runtime assets: changed /main.js')
      throw new Error(message)
    }
  }
}))

const { captureApplication } = await import(modulePath('scripts/ui-review/capture.ts'))

test('capture lifecycle preserves output and evidence around runtime asset failures', async () => {
  const run = async (
    label: string,
    settings: Record<string, unknown>,
    check: (fixtureValue: Fixture, failureMessage: string) => Promise<void>
  ) => {
    const value = fixture(label, settings)
    try {
      const failureMessage = await rejected(optionsFor(value))
      await check(value, failureMessage)
    } finally {
      rmSync(value.base, { recursive: true, force: true })
    }
  }

  await run('default', {
    failVerificationAt: 1,
    verificationMessage: () => 'runtime assets: changed at ' + current.scopeHome + ' ' + current.canonicalHome +
      ' runtime token value ' + current.runtime.token + ' hook token value ' + current.runtime.hookToken +
      ' token=' + current.runtime.token + ' http://127.0.0.1:' + current.runtime.port + '/?token=' + current.runtime.token
  }, async (value, failureMessage) => {
    expect(current.prepareOptions).toMatchObject({ repoRoot: value.repoRoot, home: current.scopeHome, skipBuild: false })
    expect(current.assets).toEqual({
      repoRoot: value.repoRoot,
      uiDir: join(current.scopeHome, 'capture-assets/ui'),
      pluginsDir: join(current.scopeHome, 'capture-assets/plugins'),
      ownedRoot: join(current.scopeHome, 'capture-assets')
    })
    expect(current.buildCommands).toHaveLength(1)
    expect(current.buildCommands[0].cwd).toBe(value.repoRoot)
    expect(current.buildEnvironments).toHaveLength(1)
    expect(current.buildEnvironments[0].QUIRKY_UI_OUT).toBe(current.assets.uiDir)
    expect(current.buildEnvironments[0].QUIRKY_UI_DIR).toBe(current.assets.uiDir)
    expect(current.buildEnvironments[0].QUIRKY_PLUGINS_DIR).toBe(current.assets.pluginsDir)
    expect(current.buildEnvironments[0].QUIRKY_BUILTIN_PLUGINS_DIR).toBe(current.assets.pluginsDir)
    expect(current.daemonEnvironments).toHaveLength(1)
    expect(current.daemonEnvironments[0]).toBe(current.buildEnvironments[0])
    expect(current.events.indexOf('build:spawn')).toBeLessThan(current.events.indexOf('assets:snapshot'))
    expect(current.events.indexOf('assets:snapshot')).toBeLessThan(current.events.indexOf('daemon:spawn'))
    expect(current.verificationRecords).toHaveLength(1)
    expect(current.verificationRecords[0].progressExists).toBe(true)
    expect(current.verificationRecords[0].pageGotoCount).toBe(0)
    expect(current.pageGotoCount).toBe(0)
    const saved = progress()!
    expect(saved.commit).toBe('0123456789abcdef0123456789abcdef01234567')
    expect(saved.targets.map((item) => item.id)).toContain('host:shell')
    expect(saved.captures.map((item) => item.theme).sort()).toEqual(['dark', 'light'])
    expect(saved.captures.every((item) =>
      item.status === 'failed' && item.image === null && typeof item.error === 'string' && item.error.includes('runtime assets')
    )).toBe(true)
    expect(readFileSync(join(value.outputDir, 'theme-selection.json'), 'utf8')).toContain('"dark"')
    expect(readFileSync(join(value.outputDir, 'theme-selection.json'), 'utf8')).toContain('"light"')
    expect(saved.failures.some((item) => /runtime assets/.test(item))).toBe(true)
    expect(failureMessage).toContain('runtime assets')
    for (const secret of [current.scopeHome, current.canonicalHome, current.runtime.token, current.runtime.hookToken]) {
      expect(failureMessage).not.toContain(secret)
      expect(saved.failures.join('\\n')).not.toContain(secret)
    }
    assertCleanupOrder()
    expect(existsSync(current.assets.ownedRoot)).toBe(false)
    expect(existsSync(current.scopeHome)).toBe(false)
    expect(existsSync(current.canonicalHome)).toBe(false)
    assertCheckoutSentinelsUnchanged()
  })

  await run('skip-build', { skipBuild: true, failVerificationAt: 1 }, async (value) => {
    expect(current.prepareOptions).toMatchObject({ repoRoot: value.repoRoot, home: current.scopeHome, skipBuild: true })
    expect(current.assets).toEqual({
      repoRoot: value.repoRoot,
      uiDir: join(value.repoRoot, 'packages/ui/dist'),
      pluginsDir: join(value.repoRoot, 'plugins'),
      ownedRoot: null
    })
    expect(current.buildCommands).toHaveLength(0)
    expect(current.daemonEnvironments[0].QUIRKY_UI_OUT).toBe(join(value.repoRoot, 'packages/ui/dist'))
    expect(current.daemonEnvironments[0].QUIRKY_UI_DIR).toBe(join(value.repoRoot, 'packages/ui/dist'))
    expect(current.daemonEnvironments[0].QUIRKY_PLUGINS_DIR).toBe(join(value.repoRoot, 'plugins'))
    expect(current.daemonEnvironments[0].QUIRKY_BUILTIN_PLUGINS_DIR).toBe(join(value.repoRoot, 'plugins'))
    expect(current.events.indexOf('assets:snapshot')).toBeLessThan(current.events.indexOf('daemon:spawn'))
    expect(current.originalEnvironment.QUIRKY_UI_DIR).toBe(join(value.repoRoot, 'packages/ui/dist'))
    expect(current.originalEnvironment.QUIRKY_BUILTIN_PLUGINS_DIR).toBe(join(value.repoRoot, 'plugins'))
    expect(existsSync(current.scopeHome)).toBe(false)
    assertCheckoutSentinelsUnchanged()
  })

  await run('build-failure', { failBuild: true }, async (value, failureMessage) => {
    expect(failureMessage).toMatch(/build.*failed/i)
    expect(current.buildCommands).toHaveLength(1)
    expect(current.daemonEnvironments).toHaveLength(0)
    expect(current.verificationRecords).toHaveLength(0)
    expect(progress()).toBeNull()
    expect(current.events).toContain('scope:cleanup')
    expect(existsSync(current.assets.ownedRoot)).toBe(false)
    expect(existsSync(current.scopeHome)).toBe(false)
    assertCheckoutSentinelsUnchanged()
  })

  await run('daemon-start-failure', { skipBuild: true, failStartup: true }, async (_value, failureMessage) => {
    expect(failureMessage).toMatch(/daemon exited before startup|daemon did not become ready/i)
    expect(current.buildCommands).toHaveLength(0)
    expect(current.daemonEnvironments).toHaveLength(1)
    expect(current.verificationRecords).toHaveLength(0)
    expect(progress()).toBeNull()
    expect(current.events).toContain('scope:cleanup')
    expect(current.events).toContain('fixtures:cleanup')
    assertCheckoutSentinelsUnchanged()
  })

  const abortController = new AbortController()
  await run('abort-during-build', { abortDuringBuild: true, abortController }, async (_value, failureMessage) => {
    expect(failureMessage).toMatch(/caller cancelled/)
    expect(failureMessage).not.toContain(current.scopeHome)
    expect(failureMessage).not.toContain(current.runtime.token)
    expect(current.buildCommands).toHaveLength(1)
    expect(current.events).toContain('build:kill:SIGTERM')
    expect(current.events.indexOf('build:settled')).toBeLessThan(current.events.indexOf('scope:cleanup'))
    expect(current.events).toContain('scope:cleanup')
    expect(current.events).not.toContain('daemon:spawn')
    expect(existsSync(current.assets.ownedRoot)).toBe(false)
    expect(progress()).toBeNull()
  })

  await run('final-verification-failure', {
    failVerificationAt: 2,
    verificationMessage: 'runtime assets: served bytes differ /plugins/acme.fixture/dist/ui.js'
  }, async (value, failureMessage) => {
    expect(failureMessage).toContain('runtime assets: served bytes differ /plugins/acme.fixture/dist/ui.js')
    expect(current.verificationRecords).toHaveLength(2)
    expect(current.verificationRecords[0].pageGotoCount).toBe(0)
    expect(current.verificationRecords[1].pageGotoCount).toBe(1)
    const finalProgress = current.verificationRecords[1].progress!
    assertCapturedEvidence(finalProgress)
    const saved = progress()!
    expect(saved.commit).toBe('0123456789abcdef0123456789abcdef01234567')
    assertCapturedEvidence(saved)
    expect(saved.failures.some((item) => item.includes('runtime assets: served bytes differ'))).toBe(true)
    assertCleanupOrder()
    expect(existsSync(current.assets.ownedRoot)).toBe(false)
    expect(existsSync(join(value.repoRoot, 'packages/ui/dist/main.js'))).toBe(true)
    assertCheckoutSentinelsUnchanged()
  })

  await run('cleanup-failure', { cleanupFailure: true }, async (_value, failureMessage) => {
    expect(failureMessage).toContain('cleanup failed')
    const saved = progress()!
    assertCapturedEvidence(saved)
    expect(saved.failures.some((item) => item.includes('cleanup failed'))).toBe(true)
    assertCleanupOrder()
    expect(existsSync(current.assets.ownedRoot)).toBe(false)
    assertCheckoutSentinelsUnchanged()
  })
})
`
  writeFileSync(harnessPath, harness.replace('__REPO_ROOT__', JSON.stringify(repoRoot)))
  try {
    const child = Bun.spawn([process.execPath, 'test', harnessPath], {
      cwd: repoRoot,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: home,
        TMPDIR: home,
        QUIRKY_HOME: home
      },
      stdout: 'pipe',
      stderr: 'pipe'
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited
    ])
    expect(code, `isolated capture lifecycle harness failed\n${stdout}\n${stderr}`).toBe(0)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}, 120_000)
