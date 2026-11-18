import { createHash } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { chromium, type Locator, type Page } from 'playwright'
import * as captureModule from './capture'
import { captureCells, captureTargetCell, discoverCaptureTargets, ensureHandoffTerminalContext, fillBlockedCells, fixtureViewInput, hostingToolFor, inspectSurface, isolateCell, openSurfaceTool, selectCaptureTargets, targetSlotSelector, waitForOverlay, waitForStateShown, type CaptureRuntime } from './capture'
import { CAPTURE_BROWSER_CANDIDATES, captureBrowserExecutable } from './browser'
import { goldenFor, SCREENSHOT_SIZE } from './goldens'
import { PALETTE_SEARCH_LABEL } from '../../packages/ui/src/plugins/palette'
import { newSceneState, seedRows, type SceneRuntime } from './shell-scenes'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { UiModel, UiSlotEntry, UiToolEntry } from '@quirky/protocol'
import type { CaptureEvidence, CaptureTarget, CaptureTheme } from './contracts'
import { createIsolatedRuntimeEnvironment } from './fixtures'

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

    const declaration = target('sidebar-section:acme.mobile/navigation', 'acme.mobile', 'sidebar-section')
    const body = target('view:acme.mobile/page', 'acme.mobile', 'view')
    expect(() => selectCaptureTargets([body], [declaration.id], {
      declaredTargets: [declaration, body],
      toolAliases: [{ declaration, renderedTarget: body, toolId: declaration.id, reason: 'tool-navigation-alias' }]
    })).toThrow(`${declaration.id} is not mounted; tool ${declaration.id} renders ${body.id}`)
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
    sidebarSections: [...model().sidebarSections, slot('sidebar-section:acme.tasks/list', 'acme.tasks')],
    views: [...model().views, slot('view:acme.tasks/page', 'acme.tasks')],
    tools: [
      tool('sidebar-section:acme.worktrees/list', 'sidebar-section:acme.worktrees/list'),
      tool('sidebar-section:acme.tasks/list', 'view:acme.tasks/page', ['sidebar-section:acme.tasks/list', 'view:acme.tasks/page']),
      tool('panel:acme.git/changes', 'panel:acme.git/changes', ['panel:acme.git/changes', 'activity-item:acme.git/source-control'])
    ]
  } as UiModel
}

const target = (id: string, plugin: string, kind: CaptureTarget['kind']): CaptureTarget => ({ id, plugin, title: id, kind })
const dirtyCloseTarget = target('overlay:quirky.editor/close', 'quirky.editor', 'overlay')

function deferred<T>() {
  return Promise.withResolvers<T>()
}

type DirtyCloseHarnessSettings = {
  screenshotGate?: Promise<void>
  wrongPath?: boolean
  wrongTab?: boolean
  wrongCommandTarget?: boolean
  commandPresent?: boolean
  commandRefused?: boolean
  opensDialog?: boolean
  dialogTitle?: string
  dialogDocument?: string
  duplicateDialogs?: number
  missingControls?: readonly string[]
  disabledControls?: readonly string[]
  autoResolveExternalOnCancel?: boolean
  cancelFailure?: boolean
  cancelClickFailure?: boolean
  draftReplyFailure?: boolean
  draftRefusedBeforeApply?: boolean
  restoreFailure?: boolean
}

function buildDirtyCloseRuntime(settings: DirtyCloseHarnessSettings = {}) {
  const outputDir = mkdtempSync(join(tmpdir(), 'capture-editor-close-'))
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'capture-editor-fixture-'))
  const sourcePath = join(fixtureRoot, 'src', 'app.ts')
  mkdirSync(join(fixtureRoot, 'src'), { recursive: true })
  const originalContents = 'export const appFixture = true\n'
  writeFileSync(sourcePath, originalContents)
  const document = {
    id: 'buffer-app',
    tabId: 'tab-app',
    path: sourcePath,
    relativePath: 'src/app.ts',
    worktreeId: 'worktree-1',
    content: originalContents,
    contentRevision: 1,
    dirty: false
  }
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const draftContents: string[] = []
  const commandSelections: string[] = []
  const routeDecision = deferred<unknown>()
  const screenshotStarted = deferred<void>()
  let routeActive = false
  let externalCloseCommands = 0
  let viewOpenId = ''
  let paletteVisible = false
  let documentFocused = false
  let documentClosed = false
  let paletteQuery = ''
  let dialogVisible = false
  let screenshotCount = 0
  let currentTheme: CaptureTheme = 'dark'
  let closeRequest: { bufferId: string; tabId: string; dirty: boolean } | null = null
  let dialogTitle = settings.dialogTitle ?? 'Unsaved Changes'
  let dialogDocument = settings.dialogDocument ?? 'app.ts'
  const screenshotBytes = Buffer.alloc(24)
  screenshotBytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  screenshotBytes.writeUInt32BE(SCREENSHOT_SIZE.width, 16)
  screenshotBytes.writeUInt32BE(SCREENSHOT_SIZE.height, 20)
  const controls = ['Cancel', "Don't Save", 'Save']
  const invokeLocalClose = () => {
    if (!documentFocused) throw new Error('There is no active editor document to close.')
    paletteVisible = false
    if (settings.commandRefused) throw new Error('renderer refused command selection')
    closeRequest = {
      bufferId: settings.wrongCommandTarget ? 'buffer-other' : document.id,
      tabId: settings.wrongCommandTarget ? 'tab-other' : document.tabId,
      dirty: true
    }
    dialogVisible = settings.opensDialog !== false
  }
  const stateSnapshot = () => {
    const stateBuffer = {
      id: document.id,
      path: settings.wrongPath ? `${document.path}.other` : document.path,
      relativePath: settings.wrongPath ? 'src/other.ts' : document.relativePath,
      worktreeId: document.worktreeId,
      name: 'app.ts',
      tabId: document.tabId,
      mode: 'source',
      contentRevision: document.contentRevision,
      content: document.content,
      dirty: document.dirty
    }
    return {
      buffers: documentClosed ? [] : [stateBuffer],
      tabs: documentClosed ? [] : [{ tabId: settings.wrongTab ? 'tab-other' : document.tabId, bufferId: document.id, mode: 'edit' }],
      closeRequests: closeRequest ? [{ ...closeRequest }] : []
    }
  }
  const unsavedDialogCount = () => dialogVisible && dialogTitle === 'Unsaved Changes'
    ? 1 + (settings.duplicateDialogs ?? 0)
    : 0
  const count = (selector: string): number => {
    if (selector.includes('[role="dialog"]') && selector.includes('Command palette')) return paletteVisible ? 1 : 0
    if (selector.includes('[role="dialog"]') && selector.includes('Unsaved Changes')) return unsavedDialogCount()
    if (selector.includes('[role="textbox"]') && selector.includes(PALETTE_SEARCH_LABEL)) return paletteVisible ? 1 : 0
    if (selector.includes('[role="option"]')) {
      const matchesQuery = paletteQuery === 'Close Editor Tab'
      return paletteVisible && matchesQuery && settings.commandPresent !== false ? 1 : 0
    }
    if (selector.includes('[role="button"]')) {
      const label = controls.find((control) => selector.includes(control))
      if (!label || !dialogVisible || dialogTitle !== 'Unsaved Changes') return 0
      return settings.missingControls?.includes(label) ? 0 : 1
    }
    if (selector.includes('.qe-close-dialog')) return dialogVisible ? 1 : 0
    if (selector.includes('.ui-dialog__title') || selector.includes('.overlay-layer .ui-dialog-backdrop')) {
      return unsavedDialogCount() + (paletteVisible ? 1 : 0) + (dialogVisible && dialogTitle !== 'Unsaved Changes' ? 1 : 0)
    }
    if (selector.includes('[data-plugin-overlay="overlay:quirky.editor/close"]')) return dialogVisible ? 1 : 0
    if (selector.includes('[data-plugin-slot="view:quirky.editor/document"]')) {
      return viewOpenId === 'view:quirky.editor/document' ? 1 : 0
    }
    if (selector.includes('.tool-shell__stripe') || selector.includes('.shell-workspace')) return 1
    if (selector.includes('data-plugin-slot')) return 1
    if (selector.includes('.qe-quick-open') || selector.includes('.tasks-composer')) return 0
    return 0
  }
  const locator = (selector = '') => {
    const item = {
      first: () => item,
      locator: (child: string) => locator(`${selector} ${child}`),
      async waitFor(options: { state?: string } = {}) {
        const present = count(selector) > 0
        if (options.state === 'detached' ? present : !present) {
          throw new Error(`${selector || 'element'} ${options.state ?? 'visible'} condition was not met`)
        }
      },
      async count() {
        return count(selector)
      },
      async isVisible() {
        return count(selector) > 0
      },
      async isEnabled() {
        const label = controls.find((control) => selector.includes(control))
        return label !== undefined && dialogVisible && dialogTitle === 'Unsaved Changes' &&
          !settings.missingControls?.includes(label) && !settings.disabledControls?.includes(label)
      },
      async click() {
        if (selector.includes('.cm-content')) {
          documentFocused = true
          return
        }
        if (selector.includes('[role="button"]') && selector.includes('Cancel') && selector.includes('Unsaved Changes')) {
          if (settings.cancelClickFailure) throw new Error('renderer Cancel control failed')
          dialogVisible = false
          if (routeActive && settings.autoResolveExternalOnCancel !== false) {
            routeActive = false
            routeDecision.resolve({ closed: false })
          }
          return
        }
        if (selector.includes('[role="option"]') || selector.includes('text:Close Editor Tab')) {
          if (!paletteVisible || settings.commandPresent === false) throw new Error('Close Editor Tab is unavailable')
          commandSelections.push('Close Editor Tab')
          invokeLocalClose()
        }
      },
      async fill(value: string) {
        if (selector.includes('[role="textbox"]') && selector.includes(PALETTE_SEARCH_LABEL)) paletteQuery = value
      },
      async scrollIntoViewIfNeeded() {},
      getByRole: (role: string, options?: { name?: string }) => locator(`${selector} [role="${role}"] ${options?.name ?? ''}`),
      getByText: (text: string | RegExp) => locator(`${selector} text:${String(text)}`),
      filter: () => item,
      async evaluate() {
        return {
          text: dialogVisible ? `${dialogDocument} has unsaved changes. Do you want to save before closing?` : 'fixture document',
          error: '',
          busy: false,
          visible: true,
          content: true
        }
      },
      async innerText() {
        return dialogVisible ? `${dialogDocument} has unsaved changes. Do you want to save before closing?` : ''
      },
      async allTextContents() {
        if (!selector.includes('.ui-dialog__title')) return []
        return [
          ...(dialogVisible ? [dialogTitle, ...Array.from({ length: settings.duplicateDialogs ?? 0 }, () => 'Unsaved Changes')] : []),
          ...(paletteVisible ? ['Command palette'] : [])
        ]
      }
    }
    return item
  }
  const themes = [
    { id: 'dark', title: 'Dark', plugin: null, appearance: 'dark', colors: { bg: '#111111' } },
    { id: 'light', title: 'Light', plugin: null, appearance: 'light', colors: { bg: '#eeeeee' } }
  ]
  const client = {
    async callAny(method: string, params: Record<string, unknown> = {}) {
      calls.push({ method, params })
      if (method === 'ui.state') return {
        windows: [{ id: 'window-1' }],
        slots: viewOpenId ? [{ id: viewOpenId, shown: true }] : []
      }
      if (method === 'ui.view.open') {
        viewOpenId = String(params.id)
        return {}
      }
      if (method === 'ui.view.close') {
        viewOpenId = ''
        return {}
      }
      if (method === 'ui.palette.set') {
        paletteVisible = params.open === true
        return {}
      }
      if (method === 'theme.list') return { themes, chosen: currentTheme, active: currentTheme }
      if (method === 'theme.set') {
        currentTheme = String(params.id) as CaptureTheme
        return { chosen: currentTheme, active: currentTheme }
      }
      if (method === 'quirky.editor/state') return stateSnapshot()
      if (method === 'quirky.editor/draft') {
        const content = String(params.content)
        draftContents.push(content)
        if (settings.draftRefusedBeforeApply && content !== originalContents) throw new Error('fixture draft was refused')
        if (settings.restoreFailure && content === originalContents) throw new Error('fixture draft restoration failed')
        if (params.expectedRevision !== document.contentRevision) throw new Error('fixture editor revision changed')
        document.content = content
        document.dirty = content !== originalContents
        document.contentRevision += 1
        if (settings.draftReplyFailure && content !== originalContents) throw new Error('fixture draft reply was lost')
        return { dirty: document.dirty, contentRevision: document.contentRevision }
      }
      if (method === 'quirky.editor/close' && params.choice === 'cancel') {
        if (settings.cancelFailure) throw new Error('daemon Cancel request failed')
        if (!document.dirty) {
          documentClosed = true
          return { closed: true }
        }
        closeRequest = null
        dialogVisible = false
        return { closed: false }
      }
      if (method === 'ui.command.run' && params.id === 'command:quirky.editor/close') {
        externalCloseCommands += 1
        routeActive = true
        closeRequest = { bufferId: document.id, tabId: document.tabId, dirty: true }
        dialogVisible = true
        return routeDecision.promise
      }
      if (method === 'status.get') return { ok: true }
      return {}
    },
    close() {}
  }
  const page = {
    locator,
    getByRole: (role: string, options?: { name?: string }) => locator(`[role="${role}"] ${options?.name ?? ''}`),
    getByLabel: (label: string) => locator(`[aria-label="${label}"]`),
    keyboard: { async press() {} },
    async waitForFunction() { return true },
    async evaluate() { return currentTheme === 'light' ? '#eeeeee' : '#111111' },
    async screenshot(options: { path?: string }) {
      screenshotCount += 1
      if (screenshotCount === 1) {
        screenshotStarted.resolve()
        await settings.screenshotGate
      }
      if (options.path) writeFileSync(options.path, screenshotBytes)
      return new Uint8Array(screenshotBytes)
    },
    async reload() {},
    isClosed: () => false,
    context: () => ({ browser: () => ({ isConnected: () => true }) })
  }
  const image = { path: '/fixture/golden.png', sha256: 'a'.repeat(64) }
  const editorBuffer = {
    id: document.id,
    tabId: document.tabId,
    mode: 'source' as const,
    path: sourcePath,
    contentRevision: document.contentRevision
  }
  const modelWithEditor = {
    ...toolModel(),
    views: [
      ...toolModel().views,
      slot('view:quirky.editor/document', 'quirky.editor', 'Editor document')
    ]
  } as UiModel
  const runtime = {
    options: { timeoutMs: 1_000, overlayOpenMs: 20 },
    outputDir,
    client,
    page,
    model: modelWithEditor,
    themes: Object.fromEntries(themes.map((entry) => [entry.appearance, entry])),
    references: { shell: { dark: image, light: image }, plugin: { dark: image, light: image } },
    fixtures: {
      home: fixtureRoot,
      repo: { id: 'repo-1' },
      primaryWorktree: { id: 'worktree-1', path: fixtureRoot, repoId: 'repo-1', name: 'main' },
      worktrees: [],
      files: { source: sourcePath }
    },
    editorBuffer,
    terminalFixture: null,
    cellTerminalFixture: null,
    structuredSessionId: null,
    dirtyCloseFixture: null,
    cellAskFixture: null,
    ownedAskFixtures: new Map(),
    askAcquisitionUncertain: false,
    ownedTerminalFixtures: new Map(),
    terminalAcquisitionUncertain: false,
    cellTerminalWorktreeId: null,
    scene: newSceneState(),
    manifest: { failures: [], captures: [] },
    secrets: [],
    pageErrors: [],
    fixtureInputErrors: new Map()
  } as unknown as CaptureRuntime
  return {
    runtime,
    externalCloseCommands: () => externalCloseCommands,
    calls,
    makeDirty() {
      document.content = `${originalContents}\n// Unsaved review draft\n`
      document.dirty = true
      document.contentRevision += 1
      closeRequest = { bufferId: document.id, tabId: document.tabId, dirty: true }
      dialogVisible = true
    },
    draftContents,
    commandSelections,
    screenshotStarted: screenshotStarted.promise,
    expireRoutedCommand() {
      if (!routeActive) return
      routeActive = false
      routeDecision.reject(new Error('the window did not answer'))
    },
    snapshot() {
      return { ...document, closeRequests: closeRequest ? [{ ...closeRequest }] : [], dialogVisible }
    },
    capturePath(theme: CaptureTheme = 'dark') {
      return join(outputDir, 'captures', theme, `${encodeURIComponent(dirtyCloseTarget.id)}.png`)
    },
    cleanup() {
      rmSync(outputDir, { recursive: true, force: true })
      rmSync(fixtureRoot, { recursive: true, force: true })
    }
  }
}

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

type FakeCaptureRuntimeOptions = {
  overlayOpen?: boolean
  overlayOpenMs?: number
  overlayFailure?: string
  slotFailure?: string
  slotFailureTarget?: string
  readinessPending?: boolean
  readinessLateResult?: boolean
  slotEvaluateHangs?: boolean
  slotEvaluateError?: string
  slotDetails?: { busy: boolean; text: string; error?: string; visible?: boolean; content?: boolean }
  dialogs?: string[]
  dialogsAfterReload?: string[][]
  windows?: number
  stripeVisible?: boolean
  quickOpenVisible?: boolean
  escapeClosesQuickOpen?: boolean
  escapeSchedulesQuickOpenClose?: boolean
  composerVisible?: boolean
  escapeClosesComposer?: boolean
  askObservationFailure?: boolean
  rpcFailures?: Record<string, string>
}

function buildFakeCaptureRuntime(settings: FakeCaptureRuntimeOptions = {}) {
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = []
  const evaluateCalls = { value: 0 }
  const targetId = { value: '' }
  const terminalContext = { session: '', pane: '' }
  const terminalLines = new Map<string, string[]>()
  let activeAskId: string | null = null
  let askPending = false
  const askDrain = Promise.withResolvers<void>()
  let askSpec: unknown = null
  const outputDir = mkdtempSync(join(tmpdir(), 'capture-runtime-test-'))
  const theme: { value: CaptureTheme } = { value: 'dark' }
  const themes = [
    { id: 'dark', title: 'Dark', plugin: null, appearance: 'dark', colors: { bg: '#111111' } },
    { id: 'light', title: 'Light', plugin: null, appearance: 'light', colors: { bg: '#eeeeee' } }
  ]
  let dialogs = [...(settings.dialogs ?? [])]
  let quickOpenVisible = settings.quickOpenVisible ?? false
  let quickOpenDismissing = false
  let composerVisible = settings.composerVisible ?? false
  const composerTitle = 'Create workspace from issue'
  if (composerVisible) dialogs.push(composerTitle)
  let reloadCount = 0
  let terminalCount = 0

  const locator = (selector = '') => {
    const item = {
      first: () => item,
      locator: (child: string) => locator(`${selector} ${child}`),
      async evaluateHandle() {
        if (settings.askObservationFailure) throw new Error('Ask flash observer could not attach')
        return {
          async evaluate(callback: (state: { done: Promise<void>; sameRoot(): boolean; stop(): void }) => unknown) {
            return await callback({ done: askDrain.promise, sameRoot: () => true, stop() {} })
          },
          async dispose() {}
        }
      },
      async waitFor() {
        if (settings.overlayFailure && selector.includes('switch-dialog')) throw new Error(settings.overlayFailure)
        if (settings.slotFailure && selector.includes('data-plugin-slot') &&
          (!settings.slotFailureTarget || selector.includes(settings.slotFailureTarget))) throw new Error(settings.slotFailure)
        if (settings.stripeVisible === false && selector.includes('.tool-shell__stripe')) throw new Error('renderer stripe missing')
        if (settings.overlayOpen === false && selector === '.never-visible') return await new Promise<void>(() => {})
        if (selector.includes('overlay:quirky.tasks/workspace-composer') && composerVisible) throw new Error('Tasks composer remains open')
      },
      async count() {
        if (selector.includes('data-ask-card')) return askPending ? 1 : 0
        if (selector.includes('data-ask-result')) return 0
        if (selector.includes('.tasks-composer') || selector.includes('overlay:quirky.tasks/workspace-composer')) return composerVisible ? 1 : 0
        if (selector.includes('overlay:quirky.editor/quick-open')) return quickOpenVisible ? 1 : 0
        if (selector.includes('.qe-quick-open')) return quickOpenVisible ? 1 : 0
        if (selector.includes('.ui-dialog__title')) return dialogs.length
        if (selector.includes('.ui-dialog-backdrop')) return dialogs.length
        if (selector.includes('.tool-shell__stripe') || selector.includes('.shell-workspace')) return 1
        if (selector.includes('data-plugin-slot')) return 1
        return 0
      },
      async isVisible() {
        if (selector.includes('.tasks-composer') || selector.includes('overlay:quirky.tasks/workspace-composer')) return composerVisible
        if (selector.includes('overlay:quirky.editor/quick-open')) return quickOpenVisible
        if (selector.includes('.qe-quick-open')) return quickOpenVisible
        if (selector.includes('.ui-dialog-backdrop')) return dialogs.length > 0
        return selector.includes('.tool-shell__stripe') || selector.includes('.shell-workspace')
      },
      async click() {
        if (selector.includes('quick-open')) {
          if (quickOpenDismissing) throw new Error('dialog detached while clicking after Escape')
          quickOpenVisible = false
        }
      },
      async scrollIntoViewIfNeeded() {},
      getByRole: (role: string, options?: { name?: string }) => locator(`${selector} [role="${role}"] ${options?.name ?? ''}`),
      getByText: (text: string | RegExp) => locator(`${selector} ${String(text)}`),
      filter: () => item,
      async evaluate() {
        evaluateCalls.value += 1
        if (settings.slotEvaluateHangs) return await new Promise<never>(() => {})
        if (settings.slotEvaluateError) throw new Error(settings.slotEvaluateError)
        const details = settings.slotDetails ?? { busy: false, text: 'fixture content', error: '', visible: true, content: true }
        return { ...details, text: details.text, error: details.error ?? '', visible: details.visible ?? true, content: details.content ?? true }
      },
      async allTextContents() {
        return selector.includes('.ui-dialog__title') ? [...dialogs] : []
      }
    }
    return item
  }

  const client = {
    async callAny(method: string, params: Record<string, unknown> = {}) {
      calls.push({ method, params })
      const failure = settings.rpcFailures?.[method]
      if (failure) throw new Error(failure)
      if (method === 'ui.state') {
        const report = targetId.value === 'view:quirky.session/worktree'
          ? {
              worktree: 'worktree-1',
              active: terminalContext.session,
              focusedPane: terminalContext.pane,
              visibleSessions: terminalContext.session ? [terminalContext.session] : [],
              panes: [{ pane: terminalContext.pane, session: terminalContext.session }]
            }
          : targetId.value === 'panel:quirky.ask/questions'
            ? { pending: askPending && activeAskId ? [{ askId: activeAskId }] : [] }
            : undefined
        return {
          windows: Array.from({ length: settings.windows ?? 1 }, (_, index) => ({ id: `window-${index}` })),
          slots: targetId.value ? [{ id: targetId.value, shown: true, ...(report ? { report } : {}) }] : []
        }
      }
      if (method === 'ui.view.open' || method === 'ui.panel.open' || method === 'ui.tool.open') {
        targetId.value = String(params.id ?? '')
        const input = params.input && typeof params.input === 'object' ? params.input as Record<string, unknown> : {}
        terminalContext.session = String(input.session ?? input.sessionId ?? '')
        terminalContext.pane = String(input.pane ?? input.paneId ?? '')
      }
      if (method === 'ui.panel.close') {
        targetId.value = ''
        return {}
      }
      if (method === 'quirky.ask/create') {
        activeAskId = 'ask-created-1'
        askPending = true
        askSpec = params.spec
        return { askId: activeAskId }
      }
      if (method === 'quirky.ask/list') {
        if (!activeAskId || params.askId !== activeAskId || (params.pendingOnly === true && !askPending)) return []
        return [{
          id: activeAskId,
          spec: askSpec,
          envelope: { status: askPending ? 'pending' : 'declined' },
          queued: false,
          sessionId: null,
          worktreeId: null
        }]
      }
      if (method === 'quirky.ask/cancel') {
        askPending = false
        askDrain.resolve()
        return { ok: true }
      }
      if (method === 'theme.list') return { themes, chosen: theme.value, active: theme.value }
      if (method === 'theme.set') {
        theme.value = String(params.id) as CaptureTheme
        return { chosen: theme.value, active: theme.value }
      }
      if (method === 'quirky.terminal/newTab') {
        terminalCount += 1
        const session = `cell-session-${terminalCount}`
        terminalLines.set(session, [])
        return { session, tab: `cell-tab-${terminalCount}`, pane: `cell-pane-${terminalCount}` }
      }
      if (method === 'quirky.terminal/snapshot') return { shellState: 'ready', rows: 24 }
      if (method === 'quirky.terminal/history') return { lines: terminalLines.get(String(params.session)) ?? [] }
      if (method === 'quirky.terminal/write') {
        const lines = terminalLines.get(String(params.session)) ?? []
        lines.push('UI review terminal ready')
        terminalLines.set(String(params.session), lines)
        return { ok: true }
      }
      if (method === 'quirky.accounts/list') return {
        accounts: [{ id: `account-${String(params.provider)}`, provider: params.provider }]
      }
    },
    close() {}
  }
  const page = {
    locator,
    getByRole: (role: string, options?: { name?: string }) => locator(`[role="${role}"] ${options?.name ?? ''}`),
    getByLabel: (label: string) => locator(`[aria-label="${label}"]`),
    keyboard: {
      async press(key: string) {
        if (key === 'Escape' && settings.escapeSchedulesQuickOpenClose) quickOpenDismissing = true
        else if (key === 'Escape' && settings.escapeClosesQuickOpen !== false) quickOpenVisible = false
        if (key === 'Escape' && settings.escapeClosesComposer) {
          composerVisible = false
          dialogs = dialogs.filter((name) => name !== composerTitle)
        }
      }
    },
    async waitForFunction() {
      if (settings.readinessPending) return await new Promise<boolean>(() => {})
      return true
    },
    async evaluate(_fn?: unknown, selector?: unknown) {
      evaluateCalls.value += 1
      if (typeof selector === 'string' && selector.includes('overlay:quirky.tasks/workspace-composer')) {
        composerVisible = false
        dialogs = dialogs.filter((name) => name !== composerTitle)
        return
      }
      if (settings.readinessLateResult !== undefined) return settings.readinessLateResult
      return theme.value === 'light' ? '#eeeeee' : '#111111'
    },
    async screenshot() { return new Uint8Array([1, 2, 3, 4]) },
    async reload() {
      reloadCount += 1
      if (settings.dialogsAfterReload) dialogs = [...(settings.dialogsAfterReload[reloadCount - 1] ?? dialogs)]
    },
    isClosed: () => false,
    context: () => ({ browser: () => ({ isConnected: () => true }) })
  }
  const image = { path: '/fixture/golden.png', sha256: 'a'.repeat(64) }
  const runtime = {
    options: { timeoutMs: 40, overlayOpenMs: settings.overlayOpenMs ?? 30 },
    outputDir,
    client,
    page,
    model: toolModel(),
    themes: Object.fromEntries(themes.map((entry) => [entry.appearance, entry])),
    references: { shell: { dark: image, light: image }, plugin: { dark: image, light: image } },
    fixtures: {
      home: '/fixture/home',
      repo: { id: 'repo-1' },
      primaryWorktree: { id: 'worktree-1', path: '/fixture/project', repoId: 'repo-1', name: 'main' },
      worktrees: [{ id: 'ready-worktree', path: '/fixture/ready', repoId: 'repo-1', name: 'ui-review-ready', isMain: false, status: 'working' }]
    },
    editorBuffer: null,
    terminalFixture: { sessionId: 'shared-session', tabId: 'shared-tab', paneId: 'shared-pane' },
    cellTerminalFixture: null,
    structuredSessionId: null,
    dirtyCloseFixture: null,
    cellAskFixture: null,
    ownedAskFixtures: new Map(),
    askAcquisitionUncertain: false,
    ownedTerminalFixtures: new Map(),
    terminalAcquisitionUncertain: false,
    cellTerminalWorktreeId: null,
    scene: newSceneState(),
    manifest: { failures: [], captures: [] },
    secrets: [],
    pageErrors: [],
    fixtureInputErrors: new Map()
  } as unknown as CaptureRuntime
  return {
    runtime,
    calls,
    page,
    reloadCount: () => reloadCount,
    setAskFixture(fixture: { askId: string }) {
      activeAskId = fixture.askId
      askPending = true
    },
    cleanup: () => rmSync(outputDir, { recursive: true, force: true }),
    evaluateCount: () => evaluateCalls.value
  }
}

type ReadinessTimingEvidence = {
  sequence: number
  deadlineMs: number
  budgetMs: number
  phaseOffsetMs: number
  readyMs: number | null
  hostRejectedMs: number | null
  diagnosticLatencyMs: number | null
  hostMaxLagMs: number
  polls: number | null
  firstPollMs: number | null
  lastPollMs: number | null
  maxGapMs: number | null
  maxPollMs: number | null
  totalPollMs: number | null
  longTaskObserver: boolean | null
  longTaskCoverageFromMs: number | null
  longTasks: { count: number; totalMs: number; maxMs: number } | null
  lastFailed: string | null
  lateReady: boolean | null
  cleanup: 'proved' | `unproved: ${string}`
}

const captureExports = captureModule as unknown as Record<string, unknown>

function readinessCheck(): (arg: unknown) => boolean {
  const check = captureExports.contentReadiness
  expect(typeof check).toBe('function')
  if (typeof check !== 'function') throw new Error('contentReadiness export is unavailable')
  return check as (arg: unknown) => boolean
}

function readinessClose(): (token: string) => unknown {
  const close = captureExports.closeReadinessPhase
  expect(typeof close).toBe('function')
  if (typeof close !== 'function') throw new Error('closeReadinessPhase export is unavailable')
  return close as (token: string) => unknown
}

function readinessTiming(message: string): ReadinessTimingEvidence | null {
  const parse = captureExports.readinessTimingFromError
  expect(typeof parse).toBe('function')
  if (typeof parse !== 'function') throw new Error('readinessTimingFromError export is unavailable')
  return (parse as (value: string) => ReadinessTimingEvidence | null)(message)
}

function readinessObserverScript(): string {
  return `<script>
    window.__observerCounts = { constructed: 0, disconnected: 0 };
    const NativePerformanceObserver = window.PerformanceObserver;
    window.PerformanceObserver = class extends NativePerformanceObserver {
      constructor(callback) {
        super(callback);
        window.__observerCounts.constructed += 1;
      }
      disconnect() {
        window.__observerCounts.disconnected += 1;
        return super.disconnect();
      }
    };
  </script>`
}

function genericReadinessHtml(text = 'Loading fixture content', script = ''): string {
  return `<style>
    :root { --bg: #111111 }
    .plugin-slot-body { min-height: 120px; width: 600px; }
  </style>
  <div data-plugin-slot="view:acme.fixture/page" class="plugin-slot"><div class="plugin-slot-body"><span id="fixture-content">${text}</span></div></div>
  ${readinessObserverScript()}<script>${script}</script>`
}

function gitReadinessHtml(script = ''): string {
  return `<style>
    :root { --bg: #111111 }
    [data-review-body] { margin: 8px; }
    .cm-editor { width: 500px; height: 80px; border: 1px solid; }
    .cm-content, .cm-line { min-height: 20px; }
  </style>
  <div data-plugin-slot="view:quirky.git/diff" class="plugin-slot"><div class="plugin-slot-body">
    <section data-path="src/app.ts"><header>src/app.ts Reviewed</header>
      <div data-review-body hidden>Loading diff...</div></section>
    <section data-path="src/local-review-fixture.ts"><header>local-review-fixture.ts</header>
      <div data-review-body><div class="cm-editor"><div class="cm-content"><div class="cm-line"><span id="local-code"></span></div></div></div></div></section>
    <section data-path="src/review-note.ts"><header>review-note.ts</header><div data-review-body>
      <p class="git-review__since">Showing changes since you reviewed</p>
      <div class="cm-editor"><div class="cm-content"><div class="cm-line"><span>export const reviewedAt = 1</span></div></div></div>
    </div></section>
  </div></div>${readinessObserverScript()}<script>${script}</script>`
}

async function withReadinessPage<T>(run: (page: Page) => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'capture-readiness-phase-'))
  const environment = createIsolatedRuntimeEnvironment(home)
  mkdirSync(environment.TMPDIR!, { recursive: true })
  mkdirSync(environment.XDG_RUNTIME_DIR!, { recursive: true })
  const browser = await chromium.launch({
    executablePath: captureBrowserExecutable(),
    headless: true,
    env: environment
  })
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 880 }, deviceScaleFactor: 2 })
    return await run(page)
  } finally {
    await browser.close()
    rmSync(home, { recursive: true, force: true })
  }
}

function makeFakeRuntimeForPage(page: Page, timeoutMs = 3_000, options: FakeCaptureRuntimeOptions = {}) {
  const fake = buildFakeCaptureRuntime(options)
  fake.runtime.page = page
  fake.runtime.options.timeoutMs = timeoutMs
  return fake
}

type PageReadinessEntry = {
  state: 'open' | 'closed'
  sequence: number
  closedBy: string | null
  trace: { polls: number; lastFailed: string | null; startedAt: number }
}

type PageReadinessStore = { phases: Record<string, PageReadinessEntry> }

async function readinessEntries(page: Page): Promise<Array<{ token: string } & PageReadinessEntry>> {
  return await page.evaluate(() => {
    const pageWindow = window as unknown as { __quirkyCaptureReadiness?: PageReadinessStore }
    const store = pageWindow.__quirkyCaptureReadiness
    return Object.entries(store?.phases ?? {}).map(([token, entry]) => ({ token, ...entry }))
  })
}

async function observerCounts(page: Page): Promise<{ constructed: number; disconnected: number }> {
  return await page.evaluate(() => {
    const pageWindow = window as unknown as { __observerCounts?: { constructed: number; disconnected: number } }
    return pageWindow.__observerCounts ?? { constructed: 0, disconnected: 0 }
  })
}

test('discovers capture browsers in Playwright-first order with an actionable missing-browser error', () => {
  const candidates = [chromium.executablePath(), ...CAPTURE_BROWSER_CANDIDATES]
  for (const candidate of candidates) {
    const checked: string[] = []
    expect(captureBrowserExecutable((path) => {
      checked.push(path)
      return path === candidate
    })).toBe(candidate)
    expect(checked.at(-1)).toBe(candidate)
  }
  expect(() => captureBrowserExecutable(() => false)).toThrow([chromium.executablePath(), ...CAPTURE_BROWSER_CANDIDATES].join(', '))
})

test('fixture view inputs carry the selected worktree, transcript, loop, remote, and cell terminal identities', () => {
  const fixtures = {
    primaryWorktree: { id: 'worktree-1' },
    repo: { id: 'repo-1' },
    worktrees: [{ id: 'ready-worktree', name: 'ui-review-ready' }]
  } as Parameters<typeof fixtureViewInput>[0]
  const extra = {
    transcript: { sessionId: 'transcript-session', transcriptPath: '/fixture/transcript.jsonl' },
    loop: { loopId: 'loop-1' },
    remote: { mirrorId: 'remote_mirror', dispatchId: 'ctx_fixture', stop: async () => [] },
    cellTerminal: { sessionId: 'cell-session', tabId: 'cell-tab', paneId: 'cell-pane' },
    view: { sessionId: 'view-session', inlineViewId: 'view-inline', paneViewIds: ['view-pane-one', 'view-pane-two'] as [string, string] }
  }
  const input = (id: string, plugin: string, extraInput: Parameters<typeof fixtureViewInput>[5] = extra) => fixtureViewInput(
    fixtures,
    target(id, plugin, 'view'),
    null,
    null,
    null,
    extraInput
  )

  expect(input('view:quirky.reviews/create', 'quirky.reviews')).toMatchObject({ worktree: 'ready-worktree' })
  expect(input('view:quirky.reviews/create', 'quirky.reviews', {})).toMatchObject({ worktree: 'ready-worktree' })
  expect(input('view:quirky.session-info/transcript', 'quirky.session-info')).toMatchObject({ session: 'transcript-session' })
  expect(input('view:quirky.loops/loop', 'quirky.loops')).toMatchObject({ loopId: 'loop-1' })
  expect(input('view:quirky.orchestration/remote-worker-output', 'quirky.orchestration')).toEqual({ dispatchId: 'ctx_fixture' })
  expect(input('view:quirky.worktree/remote', 'quirky.worktree')).toMatchObject({ workspace: 'remote_mirror' })
  expect(input('view:quirky.accounts/session-accessory', 'quirky.accounts')).toMatchObject({
    session: 'cell-session', sessionId: 'cell-session', tabId: 'cell-tab', paneId: 'cell-pane'
  })
  expect(input('view:quirky.view/render', 'quirky.view')).toEqual({
    worktree: 'worktree-1', worktreeId: 'worktree-1', workspace: 'worktree-1', repo: 'repo-1', repoId: 'repo-1',
    viewId: 'view-inline'
  })
  expect(input('view:quirky.view/pane', 'quirky.view')).toEqual({
    worktree: 'worktree-1', worktreeId: 'worktree-1', workspace: 'worktree-1', repo: 'repo-1', repoId: 'repo-1',
    session: 'view-session'
  })
})

test('view fixture input requires a fixture for each quirky.view surface', () => {
  const fixtures = { primaryWorktree: { id: 'worktree-1' }, repo: { id: 'repo-1' } } as Parameters<typeof fixtureViewInput>[0]

  expect(() => fixtureViewInput(
    fixtures,
    target('view:quirky.view/render', 'quirky.view', 'view'),
    null,
    null,
    null,
    {}
  )).toThrow('a view fixture is required for the render view')
  expect(() => fixtureViewInput(
    fixtures,
    target('view:quirky.view/pane', 'quirky.view', 'view'),
    null,
    null,
    null,
    {}
  )).toThrow('a view fixture is required for the pane view')
})
test('view fixture setup failures fail their target cell instead of capturing an empty view', async () => {
  const fake = buildFakeCaptureRuntime()
  const render = target('view:quirky.view/render', 'quirky.view', 'view')
  const failure = 'view fixture input: provider startup timed out'
  fake.runtime.fixtureInputErrors = new Map([[render.id, failure]])
  fake.runtime.manifest.failures.push(failure)
  try {
    const { capture } = await captureTargetCell(fake.runtime, render, 'dark')
    expect(capture).toMatchObject({ status: 'failed', image: null, error: failure })
    expect(fake.calls.some((call) => call.method === 'ui.view.open' && call.params?.id === render.id)).toBe(false)
  } finally {
    fake.cleanup()
  }
})


describe('bounded overlay opening', () => {
  test('resolves as soon as the overlay is visible without awaiting its decision promise', async () => {
    const fake = buildFakeCaptureRuntime()
    let resolveTrigger!: () => void
    const trigger = new Promise<void>((resolve) => { resolveTrigger = resolve })
    let triggerSettled = false
    void trigger.then(() => { triggerSettled = true })
    try {
      await waitForOverlay(fake.runtime, fake.page.locator('.visible-overlay') as unknown as Locator, 'Editor close', trigger)
      expect(triggerSettled).toBe(false)
      resolveTrigger()
    } finally {
      fake.cleanup()
    }
  })

  test('rejects promptly when the overlay trigger is refused', async () => {
    const fake = buildFakeCaptureRuntime({ overlayOpen: false })
    try {
      const started = Date.now()
      await expect(waitForOverlay(fake.runtime, fake.page.locator('.never-visible') as unknown as Locator, 'command:close', Promise.reject(new Error('permission denied'))))
        .rejects.toThrow('trigger command:close was refused: permission denied')
      expect(Date.now() - started).toBeLessThan(1_000)
    } finally {
      fake.cleanup()
    }
  })

  test('reports visible dialogs when the overlay clock expires', async () => {
    const fake = buildFakeCaptureRuntime({ overlayOpen: false, overlayOpenMs: 20, dialogs: ['Unsaved Changes'] })
    try {
      await expect(waitForOverlay(fake.runtime, fake.page.locator('.never-visible') as unknown as Locator, 'Editor close'))
        .rejects.toThrow('Editor close did not draw within 20ms; visible dialogs: Unsaved Changes')
    } finally {
      fake.cleanup()
    }
  })
})

describe('cell isolation', () => {
  test('cleans the surface and cell terminal, then reloads a failed cell', async () => {
    const fake = buildFakeCaptureRuntime()
    fake.runtime.cellTerminalFixture = { sessionId: 'cell-session', tabId: 'cell-tab', paneId: 'cell-pane' }
    try {
      await expect(isolateCell(fake.runtime, target('view:acme.fixture/page', 'acme.fixture', 'view'), 'dark', true))
        .resolves.toEqual({ ready: true })
      expect(fake.calls.some((call) => call.method === 'quirky.terminal/closeTab' && call.params?.tab === 'cell-tab')).toBe(true)
      expect(fake.reloadCount()).toBe(1)
    } finally {
      fake.cleanup()
    }
  })

  test('charges cleanup errors to the cell without changing its evidence', async () => {
    const fake = buildFakeCaptureRuntime({ rpcFailures: { 'ui.palette.set': 'boom' } })
    const evidence = { targetId: 'view:acme.fixture/page', theme: 'dark', image: null, reference: { path: '/golden', sha256: 'a'.repeat(64) }, status: 'failed', error: 'original' } as CaptureEvidence
    fake.runtime.manifest.captures.push(evidence)
    try {
      await expect(isolateCell(fake.runtime, target(evidence.targetId, 'acme.fixture', 'view'), 'dark', false))
        .resolves.toEqual({ ready: true })
      expect(fake.runtime.manifest.failures).toContain('view:acme.fixture/page (dark) cleanup: boom')
      expect(fake.runtime.manifest.captures[0]).toBe(evidence)
    } finally {
      fake.cleanup()
    }
  })

  test('reports a passed cell that leaves a dialog open and reloads it away', async () => {
    const fake = buildFakeCaptureRuntime({ dialogs: ['Switch account'], dialogsAfterReload: [[]] })
    try {
      await expect(isolateCell(fake.runtime, target('view:acme.fixture/page', 'acme.fixture', 'view'), 'dark', false))
        .resolves.toEqual({ ready: true })
      expect(fake.runtime.manifest.failures).toContain('view:acme.fixture/page (dark) left a dialog open: Switch account')
      expect(fake.reloadCount()).toBe(1)
    } finally {
      fake.cleanup()
    }
  })

  test('blocks later cells when a dialog survives two renderer reloads', async () => {
    const fake = buildFakeCaptureRuntime({
      dialogs: ['Unsaved Changes'],
      dialogsAfterReload: [['Unsaved Changes'], ['Unsaved Changes']]
    })
    try {
      const result = await isolateCell(fake.runtime, target('overlay:acme.editor/close', 'acme.editor', 'overlay'), 'dark', true)
      expect(result).toEqual({ ready: false, blocker: 'overlay:acme.editor/close (dark): Unsaved Changes' })
      expect(fake.reloadCount()).toBe(2)
      expect(fake.runtime.manifest.failures).toContain(
        'overlay:acme.editor/close (dark) left a dialog that survived two renderer reloads: Unsaved Changes'
      )
    } finally {
      fake.cleanup()
    }
  })

  test('closes the Editor quick-open dialog during cell cleanup', async () => {
    const fake = buildFakeCaptureRuntime({ quickOpenVisible: true, escapeClosesQuickOpen: false })
    try {
      await isolateCell(fake.runtime, target('overlay:quirky.editor/quick-open', 'quirky.editor', 'overlay'), 'dark', false)
      expect(await fake.page.locator('.qe-quick-open').count()).toBe(0)
    } finally {
      fake.cleanup()
    }
  })

  test('dismisses quick-open once instead of racing Escape against its close button', async () => {
    const fake = buildFakeCaptureRuntime({ quickOpenVisible: true, escapeSchedulesQuickOpenClose: true })
    try {
      await isolateCell(fake.runtime, target('overlay:quirky.editor/quick-open', 'quirky.editor', 'overlay'), 'dark', false)
      expect(fake.runtime.manifest.failures).toEqual([])
      expect(await fake.page.locator('.qe-quick-open').count()).toBe(0)
    } finally {
      fake.cleanup()
    }
  })

  for (const escapeClosesComposer of [false, true]) {
    test(`Tasks composer leaves the next cell ready when Escape ${escapeClosesComposer ? 'closes it' : 'only clears its daemon request'}`, async () => {
      const fake = buildFakeCaptureRuntime({ composerVisible: true, escapeClosesComposer })
      try {
        const result = await isolateCell(fake.runtime, target('overlay:quirky.tasks/workspace-composer', 'quirky.tasks', 'overlay'), 'dark', false)
        expect(result).toEqual({ ready: true })
        expect(fake.runtime.manifest.failures).toEqual([])
        expect(await fake.page.locator('.overlay-layer .ui-dialog-backdrop').count()).toBe(0)
      } finally {
        fake.cleanup()
      }
    })
  }

  test('fills every later capture cell with the renderer-blocked reason', () => {
    const cells = [
      { targetId: 'host:shell', theme: 'dark' as const },
      { targetId: 'host:scoped', theme: 'dark' as const },
      { targetId: 'host:shell', theme: 'light' as const },
      { targetId: 'host:scoped', theme: 'light' as const }
    ]
    const image = { path: '/fixture/golden.png', sha256: 'a'.repeat(64) }
    const cellKey = (targetId: string, theme: CaptureTheme) => `${targetId}\u0000${theme}`
    const references = {
      shell: { dark: image, light: image },
      scoped: { dark: image, light: image },
      popups: { dark: image, light: image }
    } as never
    const results = new Map<string, CaptureEvidence>([[cellKey('host:shell', 'dark'), {
      targetId: 'host:shell', theme: 'dark', image, reference: image, status: 'captured'
    }]])

    fillBlockedCells(cells, cells[0], references, results, 'host:shell (dark): Unsaved Changes')

    expect(results.get(cellKey('host:scoped', 'dark'))).toMatchObject({
      status: 'failed', error: 'not attempted: renderer blocked by host:shell (dark): Unsaved Changes'
    })
    expect(results.get(cellKey('host:shell', 'light'))?.status).toBe('failed')
    expect(results.get(cellKey('host:scoped', 'light'))?.status).toBe('failed')
  })
})

test('Accounts prepares and closes each cell with its own terminal session', async () => {
  const fake = buildFakeCaptureRuntime({
    slotFailure: 'slot did not mount',
    slotFailureTarget: 'view:quirky.accounts/session-accessory',
    overlayFailure: 'switch dialog did not draw'
  })
  fake.runtime.model = {
    ...fake.runtime.model,
    views: [...fake.runtime.model.views, slot('view:quirky.session/worktree', 'quirky.session', 'Worktree sessions')]
  } as never
  try {
    await captureTargetCell(fake.runtime, target('view:quirky.accounts/session-accessory', 'quirky.accounts', 'view'), 'dark')
    await captureTargetCell(fake.runtime, target('overlay:quirky.accounts/switch-dialog', 'quirky.accounts', 'overlay'), 'dark')

    const sessions = fake.calls
      .filter((call) => call.method === 'quirky.accounts/prepare')
      .map((call) => call.params?.sessionId)
    expect(sessions).toHaveLength(2)
    expect(new Set(sessions).size).toBe(2)
    expect(sessions).not.toContain(fake.runtime.terminalFixture?.sessionId)
    const localOpens = fake.calls.filter((call) =>
      call.method === 'ui.view.open' && call.params?.id === 'view:quirky.session/worktree'
    )
    const preparations = fake.calls.filter((call) => call.method === 'quirky.accounts/prepare')
    expect(localOpens).toHaveLength(2)
    for (let index = 0; index < sessions.length; index += 1) {
      expect(localOpens[index].params).toMatchObject({
        input: { worktree: 'worktree-1', session: sessions[index], sessionId: sessions[index] }
      })
      expect(fake.calls.indexOf(localOpens[index])).toBeLessThan(fake.calls.indexOf(preparations[index]))
    }
    expect(fake.calls.filter((call) => call.method === 'quirky.terminal/closeTab')).toHaveLength(2)
  } finally {
    fake.cleanup()
  }
})

test('reports the slot state and null trace when content readiness times out', async () => {
  const text = 'Loading fixture content '.repeat(8)
  const fake = buildFakeCaptureRuntime({
    readinessPending: true,
    slotDetails: { busy: true, text }
  })
  try {
    const result = await captureTargetCell(fake.runtime, target('view:acme.fixture/page', 'acme.fixture', 'view'), 'dark')
    const error = result.capture.error!
    expect(error.startsWith(`slot view:acme.fixture/page content exceeded 40ms (busy: true, text: "${text.slice(0, 120)}"); timing={`)).toBe(true)
    const timing = readinessTiming(error)
    expect(timing).not.toBeNull()
    if (!timing) throw new Error('timeout did not include readiness timing')
    expect(timing).toMatchObject({
      deadlineMs: 40,
      polls: null,
      longTaskObserver: null,
      longTasks: null,
      lastFailed: null
    })
    expect(timing.cleanup.startsWith('unproved:')).toBe(true)
    expect(timing.hostMaxLagMs).toBeGreaterThanOrEqual(0)
  } finally {
    fake.cleanup()
  }
})

test('late readiness is diagnostic only and failed captures still take a diagnostic screenshot', async () => {
  const fake = buildFakeCaptureRuntime({
    readinessPending: true,
    readinessLateResult: true,
    slotDetails: { busy: false, text: 'fixture became ready too late', visible: true, content: true }
  })
  let screenshots = 0
  const originalScreenshot = fake.page.screenshot.bind(fake.page)
  fake.page.screenshot = async () => {
    screenshots += 1
    return await originalScreenshot()
  }
  try {
    const result = await captureTargetCell(fake.runtime, target('view:acme.fixture/page', 'acme.fixture', 'view'), 'dark')
    expect(result.capture.status).toBe('failed')
    expect(result.capture.error).toMatch(/content exceeded 40ms/)
    expect(readinessTiming(result.capture.error!)?.lateReady).toBe(true)
    expect(fake.evaluateCount()).toBeGreaterThan(0)
    expect(screenshots).toBeGreaterThan(0)
    expect(fake.runtime.manifest.failures.some((failure) =>
      failure.startsWith('view:acme.fixture/page (dark): slot view:acme.fixture/page content exceeded')
    )).toBe(true)
  } finally {
    fake.cleanup()
  }
})

test('Git admission requires rendered code in every expanded diff', async () => {
  const home = mkdtempSync(join(tmpdir(), 'capture-git-admission-'))
  try {
    const environment = createIsolatedRuntimeEnvironment(home)
    mkdirSync(environment.TMPDIR!, { recursive: true })
    mkdirSync(environment.XDG_RUNTIME_DIR!, { recursive: true })
    const browser = await chromium.launch({
      executablePath: captureBrowserExecutable(),
      headless: true,
      env: environment
    })
    try {
      const page = await browser.newPage({ viewport: { width: 1400, height: 880 }, deviceScaleFactor: 2 })
      const git = target('view:quirky.git/diff', 'quirky.git', 'view')
      const cases = [
        { name: 'folded loading remains admissible' },
        { name: 'transparent code leaves', transparentLeaves: true, expectedClause: 'git-code' },
        { name: 'empty expanded editor', empty: true, expectedClause: 'git-code' },
        { name: 'hidden expanded content', hidden: true, expectedClause: 'git-code' },
        { name: 'hidden code leaves', hiddenLeaves: true, expectedClause: 'git-code' },
        { name: 'marker outside the expanded code', misplaced: true, expectedClause: 'git-local-fixture' },
        { name: 'visible loading', loading: true, expectedClause: 'loading-leaf' },
        { name: 'visible progress', busy: true, expectedClause: 'busy' },
        { name: 'visible error', error: true }
      ]
      for (const fault of cases) {
        const fake = buildFakeCaptureRuntime()
        fake.runtime.page = page
        fake.runtime.options.timeoutMs = 5_000
        try {
          await page.setContent(`<style>
            :root { --bg: #111111 }
            [data-review-body] { margin: 8px; }
            .cm-editor { width: 500px; height: 80px; border: 1px solid; }
            .cm-content, .cm-line { min-height: 20px; }
            ${fault.hidden ? '.cm-content { visibility: hidden }' : ''}
            ${fault.hiddenLeaves ? '.cm-line span { visibility: hidden }' : ''}
            ${fault.transparentLeaves ? '.cm-line span { opacity: 0 }' : ''}
          </style>
          <div data-plugin-slot="${git.id}" class="plugin-slot"><div class="plugin-slot-body">
            <section data-path="src/app.ts"><header>src/app.ts Reviewed</header>
              <div data-review-body hidden>Loading diff...</div></section>
            <section data-path="src/local-review-fixture.ts"><header>${fault.misplaced ? 'export const localReviewFixture = true' : 'local-review-fixture.ts'}</header>
              <div data-review-body><div class="cm-editor"><div class="cm-content"><div class="cm-line"><span>${fault.misplaced ? 'export const unrelated = true' : 'export const localReviewFixture = true'}</span></div></div></div></div></section>
            <section data-path="src/review-note.ts"><header>review-note.ts</header><div data-review-body>
              <p class="git-review__since">Showing changes since you reviewed</p>
              ${fault.loading ? '<p>Loading diff...</p>' : ''}
              ${fault.busy ? '<p role="progressbar">Loading</p>' : ''}
              ${fault.error ? '<p role="alert">Error loading diff: fixture failure</p>' : ''}
              <div class="cm-editor"><div class="cm-content"><div class="cm-line"><span>${fault.empty ? '' : 'export const reviewedAt = "before the last edit"'}</span></div></div></div>
            </div></section>
          </div></div>`)
          if (fault.name === 'folded loading remains admissible') {
            fake.runtime.options.timeoutMs = 10_000
            const result = await captureTargetCell(fake.runtime, git, 'dark')
            expect(result.capture.status, result.capture.error).toBe('captured')
            expect(result.isolation).toEqual({ ready: true })
            const image = result.capture.image!
            expect(createHash('sha256').update(readFileSync(image.path)).digest('hex')).toBe(image.sha256)
          } else {
            await fake.runtime.client.callAny('ui.view.open', { id: git.id })
            const message = await inspectSurface(fake.runtime, git).then(
              () => '',
              (error) => String(error)
            )
            expect(message, fault.name).toMatch(/content exceeded|reported an error/)
            if (fault.expectedClause) {
              expect(readinessTiming(message)?.lastFailed, fault.name).toBe(fault.expectedClause)
            } else {
              expect(message, fault.name).toMatch(/reported an error/)
              expect(readinessTiming(message), fault.name).toBeNull()
            }
          }
        } finally { fake.cleanup() }
      }
    } finally { await browser.close() }
  } finally { rmSync(home, { recursive: true, force: true }) }
}, 120_000)

test('Git readiness captures on the poll handshake and closes its traced phase', async () => {
  await withReadinessPage(async (page) => {
    await page.setContent(gitReadinessHtml(`
      (() => {
        const fill = () => {
          const store = window.__quirkyCaptureReadiness;
          const phase = store && Object.values(store.phases).find(entry => entry.state === 'open');
          if (phase && phase.trace.polls >= 2) {
            document.querySelector('#local-code').textContent = 'export const localReviewFixture = true';
            return;
          }
          requestAnimationFrame(fill);
        };
        requestAnimationFrame(fill);
      })();
    `))
    const git = target('view:quirky.git/diff', 'quirky.git', 'view')
    const fake = makeFakeRuntimeForPage(page)
    try {
      const result = await captureTargetCell(fake.runtime, git, 'dark')
      expect(result.capture.status, result.capture.error).toBe('captured')
      const runtime = fake.runtime as CaptureRuntime & {
        lastReadiness?: { targetId: string; sequence: number; timing: ReadinessTimingEvidence }
      }
      expect(runtime.lastReadiness?.targetId).toBe('view:quirky.git/diff')
      const readiness = runtime.lastReadiness
      expect(readiness).toBeDefined()
      if (!readiness) throw new Error('successful capture omitted readiness timing')
      const timing = readiness.timing
      expect(timing.polls).toBeGreaterThanOrEqual(3)
      expect(timing.lastFailed).toBe('git-code')
      expect(timing.readyMs).not.toBeNull()
      expect(timing.readyMs!).toBeGreaterThanOrEqual(0)
      expect(timing.readyMs!).toBeLessThanOrEqual(timing.budgetMs)
      expect(timing.cleanup).toBe('proved')
      expect(timing.deadlineMs).toBe(3_000)
      const phase = (await readinessEntries(page)).find((entry) => entry.sequence === readiness.sequence)
      expect(phase).toMatchObject({ state: 'closed', closedBy: 'host' })
      const counts = await observerCounts(page)
      expect(counts.constructed - counts.disconnected).toBe(0)
    } finally {
      fake.cleanup()
    }
  })
}, 120_000)

test('host deadline timing separates a Git page long task', async () => {
  await withReadinessPage(async (page) => {
    await page.setContent(gitReadinessHtml(`
      (() => {
        let blocked = false;
        const blockAfterTwoPolls = () => {
          const store = window.__quirkyCaptureReadiness;
          const phase = store && Object.values(store.phases).find(entry => entry.state === 'open');
          if (!blocked && phase && phase.trace.polls >= 2) {
            blocked = true;
            const until = performance.now() + 4_000;
            while (performance.now() < until) {}
            return;
          }
          if (!blocked) requestAnimationFrame(blockAfterTwoPolls);
        };
        requestAnimationFrame(blockAfterTwoPolls);
      })();
    `))
    const git = target('view:quirky.git/diff', 'quirky.git', 'view')
    const fake = makeFakeRuntimeForPage(page)
    try {
      await fake.runtime.client.callAny('ui.view.open', { id: git.id })
      const message = await inspectSurface(fake.runtime, git).then(
        () => '',
        (error) => String(error)
      )
      expect(message.startsWith('Error: slot view:quirky.git/diff content exceeded 3000ms (busy: false, text: "')).toBe(true)
      const timing = readinessTiming(message)
      expect(timing).not.toBeNull()
      if (!timing) throw new Error('Git timeout omitted readiness timing')
      expect(timing.deadlineMs).toBe(3_000)
      expect(timing.hostRejectedMs).toBeGreaterThanOrEqual(timing.budgetMs)
      expect(timing.longTaskObserver).toBe(true)
      expect(timing.longTasks?.count).toBeGreaterThanOrEqual(1)
      expect(timing.longTasks?.maxMs).toBeGreaterThanOrEqual(3_900)
      expect(timing.lastFailed).toBe('git-code')
      expect(timing.longTaskCoverageFromMs).toBe(timing.firstPollMs)
    } finally {
      fake.cleanup()
    }
  })
}, 30_000)

test('Git timeout evidence preserves timing before the unchanged error cap', async () => {
  await withReadinessPage(async (page) => {
    const hidden = gitReadinessHtml().replace(
      '.cm-content, .cm-line { min-height: 20px; }',
      '.cm-content, .cm-line { min-height: 20px; } .cm-line span { visibility: hidden; }'
    )
    await page.setContent(hidden)
    const git = target('view:quirky.git/diff', 'quirky.git', 'view')
    const fake = makeFakeRuntimeForPage(page)
    fake.runtime.options.timeoutMs = 3_000
    try {
      const result = await captureTargetCell(fake.runtime, git, 'dark')
      const error = result.capture.error!
      expect(result.capture.status).toBe('failed')
      expect(error.length).toBe(2_000)
      expect(error.startsWith('slot view:quirky.git/diff content exceeded 3000ms')).toBe(true)
      const timingIndex = error.indexOf('; timing=')
      const requirementIndex = error.indexOf('; reviewed header and visible code')
      expect(timingIndex).toBeGreaterThanOrEqual(0)
      expect(requirementIndex).toBeGreaterThan(timingIndex)
      expect(readinessTiming(error)?.lastFailed).toBe('git-code')
    } finally {
      fake.cleanup()
    }
  })
}, 30_000)

test('long diagnostic errors are capped before formatting timing and sanitizedError keeps its cap', async () => {
  const fake = buildFakeCaptureRuntime({
    readinessPending: true,
    slotEvaluateError: 'diagnostic failure '.repeat(600),
    slotDetails: { busy: true, text: 'Loading fixture content' }
  })
  try {
    const result = await captureTargetCell(fake.runtime, target('view:acme.fixture/page', 'acme.fixture', 'view'), 'dark')
    const error = result.capture.error!
    expect(error.length).toBeLessThanOrEqual(2_000)
    expect(error.startsWith('slot view:acme.fixture/page content exceeded 40ms (diagnostics unavailable: ')).toBe(true)
    const diagnosticReason = error.slice(error.indexOf('diagnostics unavailable: ') + 'diagnostics unavailable: '.length, error.indexOf('); timing='))
    expect(diagnosticReason.length).toBeLessThanOrEqual(160)
    const timing = readinessTiming(error)
    expect(timing).not.toBeNull()
    expect(timing?.cleanup.startsWith('unproved: ')).toBe(true)
    expect(timing?.cleanup.slice('unproved: '.length).length).toBeLessThanOrEqual(160)
    const sanitizer = captureExports.sanitizedError
    expect(typeof sanitizer).toBe('function')
    if (typeof sanitizer !== 'function') throw new Error('sanitizedError export is unavailable')
    expect((sanitizer as (error: unknown, secrets: string[]) => string)(new Error('x'.repeat(3_000)), []).length).toBe(2_000)
  } finally {
    fake.cleanup()
  }
})

test('fake slot evaluation hangs are bounded and preserve timeout timing', async () => {
  const fake = buildFakeCaptureRuntime({
    readinessPending: true,
    slotEvaluateHangs: true,
    slotDetails: { busy: true, text: 'Loading fixture content' }
  })
  const startedAt = Date.now()
  try {
    const result = await captureTargetCell(fake.runtime, target('view:acme.fixture/page', 'acme.fixture', 'view'), 'dark')
    const error = result.capture.error!
    expect(Date.now() - startedAt).toBeLessThanOrEqual(12_000)
    expect(error.startsWith('slot view:acme.fixture/page content exceeded 40ms (diagnostics unavailable: ')).toBe(true)
    expect(error).toContain('; timing={')
    expect(readinessTiming(error)).not.toBeNull()
  } finally {
    fake.cleanup()
  }
}, 12_000)

test('an endless page cannot extend bounded timeout diagnostics', async () => {
  await withReadinessPage(async (page) => {
    await page.setContent(gitReadinessHtml(`
      (() => {
        const blockAfterTwoPolls = () => {
          const store = window.__quirkyCaptureReadiness;
          const phase = store && Object.values(store.phases).find(entry => entry.state === 'open');
          if (phase && phase.trace.polls >= 2) {
            while (true) {}
          }
          requestAnimationFrame(blockAfterTwoPolls);
        };
        requestAnimationFrame(blockAfterTwoPolls);
      })();
    `))
    const git = target('view:quirky.git/diff', 'quirky.git', 'view')
    const fake = makeFakeRuntimeForPage(page)
    try {
      await fake.runtime.client.callAny('ui.view.open', { id: git.id })
      const startedAt = Date.now()
      const message = await inspectSurface(fake.runtime, git).then(
        () => '',
        (error) => String(error)
      )
      expect(Date.now() - startedAt).toBeLessThanOrEqual(13_000)
      expect(message.startsWith('Error: slot view:quirky.git/diff content exceeded 3000ms (diagnostics unavailable: ')).toBe(true)
      const timing = readinessTiming(message)
      expect(timing).not.toBeNull()
      expect(timing?.cleanup.startsWith('unproved:')).toBe(true)
      expect(timing?.lateReady).toBeNull()
    } finally {
      fake.cleanup()
      if (!page.isClosed()) await page.close().catch(() => {})
    }
  })
}, 20_000)

test('page closure during readiness preserves the original Playwright error', async () => {
  await withReadinessPage(async (page) => {
    await page.setContent(genericReadinessHtml())
    const fixture = target('view:acme.fixture/page', 'acme.fixture', 'view')
    const fake = makeFakeRuntimeForPage(page)
    try {
      await fake.runtime.client.callAny('ui.view.open', { id: fixture.id })
      const startedAt = Date.now()
      const inspection = inspectSurface(fake.runtime, fixture).then(
        () => '',
        (failure) => String(failure)
      )
      await page.waitForFunction(() => {
        const pageWindow = window as unknown as { __quirkyCaptureReadiness?: PageReadinessStore }
        const phase = Object.values(pageWindow.__quirkyCaptureReadiness?.phases ?? {}).find((entry) => entry.state === 'open')
        return phase && phase.trace.polls > 0
      }, undefined, { timeout: 1_000 })
      // This delay is the real page-close timing under test; fake timers cannot close Chromium mid-protocol call.
      await Bun.sleep(500)
      await page.close()
      const error = await inspection
      expect(Date.now() - startedAt).toBeLessThan(6_000)
      expect(error).toMatch(/closed/i)
      expect(error).not.toMatch(/content exceeded/)
    } finally {
      fake.cleanup()
      if (!page.isClosed()) await page.close().catch(() => {})
    }
  })
}, 10_000)

test('abort does no host page evaluation and the orphaned phase closes only by successor', async () => {
  const controller = new AbortController()
  const abortReason = new Error('readiness phase cancelled')
  const fakeHolder: { cleanup?: () => void } = {}
  await withReadinessPage(async (page) => {
    const monitor = `
      (() => {
        let token = null;
        let lastPoll = -1;
        let lastChange = Date.now();
        setInterval(() => {
          const store = window.__quirkyCaptureReadiness;
          const entry = store && Object.entries(store.phases).find(([, phase]) => phase.state === 'open');
          if (!entry) return;
          const [currentToken, phase] = entry;
          const now = Date.now();
          if (currentToken !== token) {
            token = currentToken;
            lastPoll = phase.trace.polls;
            lastChange = now;
          } else if (phase.trace.polls !== lastPoll) {
            lastPoll = phase.trace.polls;
            lastChange = now;
          }
          if (now >= phase.trace.startedAt + 4_000 && now - lastChange >= 200) {
            window.__pollStableSnapshot = { token, state: phase.state, polls: phase.trace.polls };
          }
        }, 25);
      })();
    `
    await page.setContent(genericReadinessHtml('Loading fixture content', monitor))
    const fixture = target('view:acme.fixture/page', 'acme.fixture', 'view')
    const fake = makeFakeRuntimeForPage(page, 3_000)
    fakeHolder.cleanup = fake.cleanup
    fake.runtime.options.signal = controller.signal
    await fake.runtime.client.callAny('ui.view.open', { id: fixture.id })

    let monitoring = true
    let pageEvaluationsAfterAbort = 0
    let locatorEvaluationsAfterAbort = 0
    const originalPageEvaluate = page.evaluate.bind(page)
    Object.defineProperty(page, 'evaluate', {
      configurable: true,
      value: (...args: unknown[]) => {
        if (monitoring && controller.signal.aborted) pageEvaluationsAfterAbort += 1
        return Reflect.apply(originalPageEvaluate, page, args)
      }
    })
    const originalLocator = page.locator.bind(page)
    Object.defineProperty(page, 'locator', {
      configurable: true,
      value: (...args: unknown[]) => {
        const locator = Reflect.apply(originalLocator, page, args) as Locator
        const originalLocatorEvaluate = locator.evaluate.bind(locator)
        Object.defineProperty(locator, 'evaluate', {
          configurable: true,
          value: (...evaluateArgs: unknown[]) => {
            if (monitoring && controller.signal.aborted) locatorEvaluationsAfterAbort += 1
            return Reflect.apply(originalLocatorEvaluate, locator, evaluateArgs)
          }
        })
        return locator
      }
    })

    let abortTimer: ReturnType<typeof setTimeout> | undefined
    try {
      const inspection = inspectSurface(fake.runtime, fixture).then(
        () => null,
        (error) => error
      )
      const firstPoll = await page.waitForFunction(() => {
        const pageWindow = window as unknown as { __quirkyCaptureReadiness?: PageReadinessStore }
        const phase = Object.entries(pageWindow.__quirkyCaptureReadiness?.phases ?? {})
          .find(([, entry]) => entry.state === 'open' && entry.trace.polls > 0)
        return phase ? { token: phase[0], sequence: phase[1].sequence } : false
      }, undefined, { timeout: 1_000 })
      const phase = await firstPoll.jsonValue() as { token: string; sequence: number }
      // A real 200 ms abort is needed to observe the browser poller after its owner has stopped waiting.
      abortTimer = setTimeout(() => controller.abort(abortReason), 200)
      const result = await inspection
      clearTimeout(abortTimer)
      expect(result).toBe(abortReason)
      const stablePollsHandle = await page.waitForFunction(() => {
        const pageWindow = window as unknown as {
          __pollStableSnapshot?: { token: string; state: string; polls: number }
        }
        return pageWindow.__pollStableSnapshot ?? false
      }, undefined, { timeout: 5_000 })
      const stablePolls = await stablePollsHandle.jsonValue() as { token: string; state: string; polls: number }
      expect(stablePolls.token).toBe(phase.token)
      expect(stablePolls.state).toBe('open')
      expect(stablePolls.polls).toBeGreaterThan(0)
      expect(pageEvaluationsAfterAbort).toBe(0)
      expect(locatorEvaluationsAfterAbort).toBe(0)
      monitoring = false
      expect((await readinessEntries(page)).find((entry) => entry.token === phase.token)?.trace.polls)
        .toBe(stablePolls.polls)
      let counts = await observerCounts(page)
      expect(counts.constructed - counts.disconnected).toBe(1)

      const successor = {
        slotSelector: '[data-plugin-slot="view:acme.fixture/page"]',
        targetId: fixture.id,
        ask: null,
        terminal: null,
        phase: { token: 'abort-successor', sequence: phase.sequence + 1, startedAt: Date.now() }
      }
      expect(await page.evaluate(readinessCheck(), successor)).toBe(false)
      const phases = await readinessEntries(page)
      expect(phases.find((entry) => entry.token === phase.token)).toMatchObject({ state: 'closed', closedBy: 'successor' })
      expect(phases.find((entry) => entry.token === 'abort-successor')).toMatchObject({ state: 'open' })
      counts = await observerCounts(page)
      expect(counts.constructed - counts.disconnected).toBe(1)
      expect(await page.evaluate(readinessClose(), 'abort-successor')).toMatchObject({ observerDisconnected: true })
      counts = await observerCounts(page)
      expect(counts.constructed - counts.disconnected).toBe(0)
    } finally {
      clearTimeout(abortTimer)
      fakeHolder.cleanup?.()
    }
  })
}, 12_000)

test('contentReadiness returns booleans and traces failed clauses only for open phases', async () => {
  await withReadinessPage(async (page) => {
    await page.setContent(genericReadinessHtml())
    const check = readinessCheck()
    const selector = '[data-plugin-slot="view:acme.fixture/page"]'
    const untraced = { slotSelector: selector, targetId: 'view:acme.fixture/page', ask: null, terminal: null, phase: null }
    expect(await page.evaluate(check, untraced)).toBe(false)
    expect(await page.evaluate(() => Object.hasOwn(globalThis, '__quirkyCaptureReadiness'))).toBe(false)
    await page.locator('#fixture-content').evaluate((node) => { node.textContent = 'Ready fixture content' })
    expect(await page.evaluate(check, untraced)).toBe(true)
    expect(await page.evaluate(() => Object.hasOwn(globalThis, '__quirkyCaptureReadiness'))).toBe(false)

    await page.locator('#fixture-content').evaluate((node) => { node.textContent = 'Loading fixture content' })
    const arg = {
      ...untraced,
      phase: { token: 'boolean-only-phase', sequence: 10, startedAt: Date.now() }
    }
    const notReady = await page.evaluate(check, arg)
    expect(notReady).toBe(false)
    expect(typeof notReady).toBe('boolean')
    const failedTrace = (await readinessEntries(page)).find((entry) => entry.token === 'boolean-only-phase')
    expect(failedTrace?.trace.lastFailed).toBe('loading-leaf')
    await page.locator('#fixture-content').evaluate((node) => { node.textContent = 'Ready fixture content' })
    const ready = await page.evaluate(check, arg)
    expect(ready).toBe(true)
    expect(typeof ready).toBe('boolean')

    const closed = await page.evaluate(readinessClose(), 'boolean-only-phase')
    expect(closed).toMatchObject({ observerDisconnected: true })
    const before = (await readinessEntries(page)).find((entry) => entry.token === 'boolean-only-phase')
    const observersBeforeStalePoll = await observerCounts(page)
    const stale = await page.evaluate(check, arg)
    expect(stale).toBe(false)
    expect(typeof stale).toBe('boolean')
    const after = (await readinessEntries(page)).find((entry) => entry.token === 'boolean-only-phase')
    expect(after).toMatchObject({ state: before?.state, closedBy: before?.closedBy, trace: { polls: before?.trace.polls } })
    const observersAfterStalePoll = await observerCounts(page)
    expect(observersAfterStalePoll).toEqual(observersBeforeStalePoll)
    expect(observersAfterStalePoll.constructed - observersAfterStalePoll.disconnected).toBe(0)
  })
}, 15_000)

test('a successful phase tombstone rejects stale polls without observer work', async () => {
  await withReadinessPage(async (page) => {
    await page.setContent(genericReadinessHtml('Ready fixture content'))
    const fixture = target('view:acme.fixture/page', 'acme.fixture', 'view')
    const fake = makeFakeRuntimeForPage(page)
    try {
      await fake.runtime.client.callAny('ui.view.open', { id: fixture.id })
      await inspectSurface(fake.runtime, fixture)
      const runtime = fake.runtime as CaptureRuntime & {
        lastReadiness?: { targetId: string; sequence: number; timing: ReadinessTimingEvidence }
      }
      const readiness = runtime.lastReadiness
      expect(readiness?.targetId).toBe(fixture.id)
      expect(readiness).toBeDefined()
      if (!readiness) throw new Error('successful inspection omitted readiness timing')
      const entry = (await readinessEntries(page)).find((phase) => phase.sequence === readiness.sequence)
      expect(entry).toMatchObject({ state: 'closed', closedBy: 'host' })
      const before = await observerCounts(page)
      const check = readinessCheck()
      const stale = await page.evaluate(check, {
        slotSelector: '[data-plugin-slot="view:acme.fixture/page"]',
        targetId: fixture.id,
        ask: null,
        terminal: null,
        phase: { token: entry!.token, sequence: readiness.sequence, startedAt: entry!.trace.startedAt }
      })
      expect(stale).toBe(false)
      expect((await readinessEntries(page)).find((phase) => phase.token === entry!.token))
        .toMatchObject({ state: 'closed', closedBy: 'host', trace: { polls: entry!.trace.polls } })
      const after = await observerCounts(page)
      expect(after.constructed - after.disconnected).toBe(0)
      expect(after.constructed).toBe(before.constructed)
    } finally {
      fake.cleanup()
    }
  })
}, 15_000)

test('successor phases close only older entries and lower sequences become tombstones', async () => {
  await withReadinessPage(async (page) => {
    await page.setContent(genericReadinessHtml())
    const check = readinessCheck()
    const close = readinessClose()
    const selector = '[data-plugin-slot="view:acme.fixture/page"]'
    const makeArg = (token: string, sequence: number) => ({
      slotSelector: selector,
      targetId: 'view:acme.fixture/page',
      ask: null,
      terminal: null,
      phase: { token, sequence, startedAt: Date.now() }
    })

    expect(await page.evaluate(check, makeArg('phase-A', 20))).toBe(false)
    let counts = await observerCounts(page)
    expect(counts.constructed - counts.disconnected).toBe(1)
    expect(await page.evaluate(check, makeArg('phase-B', 21))).toBe(false)
    const afterSuccessor = await readinessEntries(page)
    const phaseA = afterSuccessor.find((entry) => entry.token === 'phase-A')
    const phaseB = afterSuccessor.find((entry) => entry.token === 'phase-B')
    expect(phaseA).toMatchObject({ state: 'closed', closedBy: 'successor' })
    expect(phaseB).toMatchObject({ state: 'open', sequence: 21 })
    counts = await observerCounts(page)
    expect(counts.constructed - counts.disconnected).toBe(1)

    const returnedA = await page.evaluate(close, 'phase-A')
    expect(returnedA).toMatchObject({ token: 'phase-A', observerDisconnected: true })
    const afterLateClose = (await readinessEntries(page)).find((entry) => entry.token === 'phase-B')
    expect(afterLateClose).toMatchObject({ state: 'open', sequence: phaseB?.sequence, trace: { polls: phaseB?.trace.polls } })

    expect(await page.evaluate(check, makeArg('phase-superseded', 19))).toBe(false)
    const superseded = (await readinessEntries(page)).find((entry) => entry.token === 'phase-superseded')
    expect(superseded).toMatchObject({ state: 'closed', sequence: 19, closedBy: 'superseded' })
    counts = await observerCounts(page)
    expect(counts.constructed - counts.disconnected).toBe(1)
    expect((await readinessEntries(page)).some((entry) => entry.token === 'phase-A')).toBe(true)

    expect(await page.evaluate(close, 'phase-B')).toMatchObject({ token: 'phase-B', observerDisconnected: true })
    const closedB = (await readinessEntries(page)).find((entry) => entry.token === 'phase-B')
    expect(closedB).toMatchObject({ state: 'closed', closedBy: 'host' })
    counts = await observerCounts(page)
    expect(counts.constructed - counts.disconnected).toBe(0)
  })
}, 15_000)

test('readiness timing resets at both entry points and sequences stay attributable', async () => {
  const blocked = buildFakeCaptureRuntime()
  const captureRuntime = blocked.runtime as CaptureRuntime & {
    lastReadiness?: { targetId: string; sequence: number; timing: ReadinessTimingEvidence }
  }
  try {
    captureRuntime.lastReadiness = { targetId: 'stale', sequence: 1, timing: {} as NonNullable<CaptureRuntime['lastReadiness']>['timing'] }
    blocked.runtime.ownedAskFixtures.set('unresolved', blocked.runtime.cellAskFixture!)
    await captureTargetCell(blocked.runtime, target('view:acme.fixture/page', 'acme.fixture', 'view'), 'dark')
    expect(captureRuntime.lastReadiness).toBeUndefined()
  } finally {
    blocked.cleanup()
  }

  await withReadinessPage(async (page) => {
    await page.setContent(genericReadinessHtml('Ready fixture content'))
    const failures: Record<string, string> = {}
    const fake = makeFakeRuntimeForPage(page, 3_000, { rpcFailures: failures })
    const runtime = fake.runtime as CaptureRuntime & {
      lastReadiness?: { targetId: string; sequence: number; timing: ReadinessTimingEvidence }
    }
    const fixture = target('view:acme.fixture/page', 'acme.fixture', 'view')
    try {
      await fake.runtime.client.callAny('ui.view.open', { id: fixture.id })
      await inspectSurface(fake.runtime, fixture)
      const first = runtime.lastReadiness
      expect(first).toBeDefined()
      if (!first) throw new Error('first phase timing was not recorded')
      const firstToken = (await readinessEntries(page)).find((entry) => entry.sequence === first.sequence)?.token

      await inspectSurface(fake.runtime, fixture)
      const second = runtime.lastReadiness
      expect(second).toBeDefined()
      if (!second) throw new Error('second phase timing was not recorded')
      const secondToken = (await readinessEntries(page)).find((entry) => entry.sequence === second.sequence)?.token
      expect(second.sequence).toBeGreaterThan(first.sequence)
      expect(secondToken).toBeDefined()
      expect(secondToken).not.toBe(firstToken)

      failures['ui.state'] = 'state unavailable'
      await expect(inspectSurface(fake.runtime, fixture)).rejects.toThrow('state unavailable')
      expect(runtime.lastReadiness).toBeUndefined()
    } finally {
      fake.cleanup()
    }
  })
}, 15_000)

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

  test('a canonical view body opens the sidebar tool instead of a center view', async () => {
    const body = target('view:acme.tasks/page', 'acme.tasks', 'view')
    const { runtime, calls } = fakeRuntime(() => ({ slots: [] }))

    await openSurfaceTool(runtime as never, body)

    expect(hostingToolFor(runtime.model, body)).toBe('sidebar-section:acme.tasks/list')
    expect(calls).toEqual([{ method: 'ui.tool.open', params: { id: 'sidebar-section:acme.tasks/list' } }])
    expect(hostingToolFor(runtime.model, target('view:acme.editor/document', 'acme.editor', 'view'))).toBeNull()
  })

  test('a shown body is not ready until its production tool is publicly open', async () => {
    const body = target('view:acme.tasks/page', 'acme.tasks', 'view')
    const { runtime } = fakeRuntime(() => ({ slots: [{ id: body.id, shown: true }], layout: { tools: { open: {} } } }))
    runtime.options.timeoutMs = 5
    await expect(waitForStateShown(runtime as never, body, 'sidebar-section:acme.tasks/list'))
      .rejects.toThrow('public UI state did not show view:acme.tasks/page in tool sidebar-section:acme.tasks/list')

    const opened = fakeRuntime(() => ({
      slots: [{ id: body.id, shown: true }],
      layout: { tools: { open: { 'left-top': 'sidebar-section:acme.tasks/list' } } }
    }))
    await waitForStateShown(opened.runtime as never, body, 'sidebar-section:acme.tasks/list')
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
  test('Ask-card view input contains only the current owned ask ID', () => {
    const fixtures = { primaryWorktree: { id: 'wt-1' }, repo: { id: 'repo-1' } } as Parameters<typeof fixtureViewInput>[0]
    const askTarget = { id: 'view:quirky.ask/card', plugin: 'quirky.ask', kind: 'view', title: 'Ask card' } as CaptureTarget
    const ask = { askId: 'ask-fixture-1', command: 'Bash: bun run build' }

    expect(fixtureViewInput(fixtures, askTarget, null, null, null, { ask } as never)).toEqual({ askId: 'ask-fixture-1' })
    expect(() => fixtureViewInput(fixtures, askTarget, null, null)).toThrow('an ask fixture is required')
  })

  test.each(['ready', 'unsupported'])('Handoff seeds scrollback with a POSIX shell whose integration is %s', async (shellState) => {
    let output: string[] = []
    const runtime = {
      terminalFixture: { sessionId: 'shared-shell', tabId: 'shared-tab', paneId: 'shared-pane' },
      cellTerminalFixture: { sessionId: 'shell-1', tabId: 'tab-1', paneId: 'pane-1' },
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
          if (options.path) writeFileSync(options.path, bytes)
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
          overlays: [], settingsSections: [], settings: [], modules: {}
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

const actualFixtures = await import(modulePath('scripts/ui-review/fixtures.ts'))

mock.module(modulePath('scripts/ui-review/fixtures.ts'), () => ({
  ...actualFixtures,
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
  async closeCaptureTerminalFixture() {},
  async createCaptureTerminalFixture() { return null },
  async createLoopFixture() { return { loopId: 'loop-fixture' } },
  async createTranscriptFixture() { return { sessionId: 'transcript-fixture', transcriptPath: '/fixture/transcript.jsonl' } },
  async openFixtureEditorBuffer() { return null },
  async prepareProviderExecutables() {}
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

describe('dirty Editor close ownership', () => {
  test('focuses the validated document before selecting the argument-free close command', async () => {
    const fake = buildDirtyCloseRuntime()
    try {
      const result = await captureTargetCell(fake.runtime, dirtyCloseTarget, 'dark')
      expect(result.capture.status, result.capture.error).toBe('captured')
      expect(fake.snapshot()).toMatchObject({ dirty: false, tabId: 'tab-app', dialogVisible: false })
    } finally { fake.cleanup() }
  })

  test('recognizes the same fixture document through a filesystem path alias', async () => {
    const fake = buildDirtyCloseRuntime()
    const buffer = fake.runtime.editorBuffer!
    const alias = `${buffer.path}.alias`
    symlinkSync(buffer.path, alias)
    buffer.path = alias
    try {
      const result = await captureTargetCell(fake.runtime, dirtyCloseTarget, 'dark')
      expect(result.capture.status, result.capture.error).toBe('captured')
      expect(result.isolation).toEqual({ ready: true })
      expect(fake.snapshot()).toMatchObject({ dirty: false, tabId: 'tab-app' })
    } finally { fake.cleanup() }
  })

  test('preserves a clean fixture tab when the draft is refused before applying', async () => {
    const fake = buildDirtyCloseRuntime({ draftRefusedBeforeApply: true })
    try {
      const result = await captureTargetCell(fake.runtime, dirtyCloseTarget, 'dark')
      const state = await fake.runtime.client.callAny('quirky.editor/state', { bufferId: 'buffer-app' }) as { buffers: unknown[]; tabs: unknown[] }
      expect(result.capture.status).toBe('failed')
      expect(result.isolation).toEqual({ ready: true })
      expect(state.buffers).toMatchObject([{ id: 'buffer-app', dirty: false }])
      expect(state.tabs).toMatchObject([{ bufferId: 'buffer-app', tabId: 'tab-app' }])
    } finally { fake.cleanup() }
  })

  test('keeps the unsaved-close decision in the renderer while a screenshot crosses the routed deadline', async () => {
    const screenshotGate = deferred<void>()
    const fake = buildDirtyCloseRuntime({ screenshotGate: screenshotGate.promise })
    const pendingCapture = captureTargetCell(fake.runtime, dirtyCloseTarget, 'dark')
    try {
      await fake.screenshotStarted
      fake.expireRoutedCommand()
      screenshotGate.resolve()
      const result = await pendingCapture

      expect(result.capture.status).toBe('captured')
      expect(result.capture.image).not.toBeNull()
      expect(fake.externalCloseCommands()).toBe(0)
      expect(fake.commandSelections).toEqual(['Close Editor Tab'])
      expect(fake.calls.some((call) => call.method === 'ui.command.run' &&
        call.params.id === 'command:quirky.editor/close')).toBe(false)
      expect(fake.snapshot()).toMatchObject({
        id: 'buffer-app',
        tabId: 'tab-app',
        dirty: false,
        closeRequests: [],
        dialogVisible: false
      })
      expect(fake.draftContents.at(-1)).toBe('export const appFixture = true\n')
      expect(result.isolation).toEqual({ ready: true })
    } finally {
      fake.expireRoutedCommand()
      screenshotGate.resolve()
      await pendingCapture.catch(() => undefined)
      fake.cleanup()
    }
  })

  for (const mismatch of [
    { name: 'the source path', settings: { wrongPath: true } },
    { name: 'the tab identity', settings: { wrongTab: true } }
  ]) {
    test(`refuses to dirty the fixture when Editor state identifies a different ${mismatch.name}`, async () => {
      const fake = buildDirtyCloseRuntime(mismatch.settings)
      try {
        const result = await captureTargetCell(fake.runtime, dirtyCloseTarget, 'dark')

        expect(result.capture.status).toBe('failed')
        expect(fake.draftContents).toEqual([])
        expect(fake.commandSelections).toEqual([])
        expect(fake.externalCloseCommands()).toBe(0)
        expect(fake.snapshot().dirty).toBe(false)
      } finally {
        fake.cleanup()
      }
    })
  }

  for (const [name, settings] of [
    ['missing palette command', { commandPresent: false }],
    ['refused palette command', { commandRefused: true }],
    ['missing Unsaved Changes dialog', { opensDialog: false }],
    ['wrong dialog title', { dialogTitle: 'Close Editor Tabs?' }],
    ['duplicate Unsaved Changes dialogs', { duplicateDialogs: 1 }],
    ['wrong fixture document in dialog', { dialogDocument: 'other.ts' }],
    ['wrong close request identity', { wrongCommandTarget: true }],
    ['missing Cancel control', { missingControls: ['Cancel'] }],
    ['disabled Don’t Save control', { disabledControls: ["Don't Save"] }],
    ['disabled Save control', { disabledControls: ['Save'] }]
  ] as const) {
    test(`rejects dirty-close evidence with ${name}`, async () => {
      const fake = buildDirtyCloseRuntime(settings)
      try {
        const result = await captureTargetCell(fake.runtime, dirtyCloseTarget, 'dark')

        expect(result.capture.status).toBe('failed')
        expect(result.capture.image).not.toBeNull()
        expect(fake.snapshot().dirty).toBe(false)
        const requests = fake.snapshot().closeRequests
        expect(requests.filter((request) => request.bufferId === 'buffer-app' || request.tabId === 'tab-app')).toEqual([])
        if ('wrongCommandTarget' in settings) {
          expect(requests).toEqual([{ bufferId: 'buffer-other', tabId: 'tab-other', dirty: true }])
          expect(fake.calls.some((call) => call.method === 'quirky.editor/close' && call.params.bufferId === 'buffer-other')).toBe(false)
        }
        expect(fake.snapshot().dialogVisible).toBe(false)
      } finally {
        fake.cleanup()
      }
    })
  }

  test('restores a draft whose first mutation applied but whose reply was lost', async () => {
    const fake = buildDirtyCloseRuntime({ draftReplyFailure: true })
    try {
      const result = await captureTargetCell(fake.runtime, dirtyCloseTarget, 'dark')

      expect(result.capture.status).toBe('failed')
      expect(fake.draftContents).toEqual([
        'export const appFixture = true\n\n// Unsaved review draft\n',
        'export const appFixture = true\n'
      ])
      expect(fake.snapshot()).toMatchObject({ dirty: false, closeRequests: [], dialogVisible: false })
    } finally {
      fake.cleanup()
    }
  })

  test('keeps aborted screenshot evidence failed while cleaning the renderer independently of the capture signal', async () => {
    const screenshotGate = deferred<void>()
    const controller = new AbortController()
    const fake = buildDirtyCloseRuntime({ screenshotGate: screenshotGate.promise })
    fake.runtime.options.signal = controller.signal
    const pendingCapture = captureTargetCell(fake.runtime, dirtyCloseTarget, 'dark')
    try {
      await fake.screenshotStarted
      controller.abort(new Error('controlled screenshot abort'))
      screenshotGate.resolve()
      const result = await pendingCapture

      expect(result.capture.status).toBe('failed')
      expect(result.capture.image).not.toBeNull()
      expect(result.isolation).toEqual({ ready: true })
      expect(fake.snapshot()).toMatchObject({ dirty: false, closeRequests: [], dialogVisible: false })
    } finally {
      screenshotGate.resolve()
      await pendingCapture.catch(() => undefined)
      fake.cleanup()
    }
  })

  test('attempts draft restoration and terminal isolation after Cancel fails under abort', async () => {
    const controller = new AbortController()
    controller.abort(new Error('capture aborted'))
    const fake = buildDirtyCloseRuntime({ cancelFailure: true, cancelClickFailure: true })
    fake.makeDirty()
    fake.runtime.options.signal = controller.signal
    Object.assign(fake.runtime, {
      dirtyCloseFixture: { bufferId: 'buffer-app', tabId: 'tab-app', originalContents: 'export const appFixture = true\n' },
      cellTerminalFixture: { sessionId: 'cell-session', tabId: 'cell-tab', paneId: 'cell-pane' }
    })
    try {
      await isolateCell(fake.runtime, dirtyCloseTarget, 'dark', true)

      expect(fake.draftContents).toContain('export const appFixture = true\n')
      expect(fake.calls.some((call) => call.method === 'quirky.terminal/closeTab' && call.params.tab === 'cell-tab')).toBe(true)
      expect(fake.runtime.cellTerminalFixture).toBeNull()
    } finally {
      fake.cleanup()
    }
  })

  test('preserves the screenshot and its hash when fixture restoration fails', async () => {
    const fake = buildDirtyCloseRuntime({ restoreFailure: true })
    try {
      const result = await captureTargetCell(fake.runtime, dirtyCloseTarget, 'dark')
      const image = result.capture.image

      expect(result.capture.status).toBe('failed')
      expect(image).not.toBeNull()
      expect(readFileSync(image!.path)).toHaveLength(24)
      expect(createHash('sha256').update(readFileSync(image!.path)).digest('hex')).toBe(image!.sha256)
    } finally {
      fake.cleanup()
    }
  })

  test('an aborted late screenshot cannot overwrite retained diagnostic image bytes', async () => {
    const gate = deferred<void>()
    const lateFinished = deferred<void>()
    const fake = buildDirtyCloseRuntime({ screenshotGate: gate.promise })
    const controller = new AbortController()
    fake.runtime.options.signal = controller.signal
    const screenshot = fake.runtime.page.screenshot.bind(fake.runtime.page)
    let calls = 0
    fake.runtime.page.screenshot = async (options = {}) => {
      const first = ++calls === 1
      try {
        const bytes = await screenshot(options)
        if (!first) return bytes
        const lateBytes = Buffer.concat([bytes, Buffer.from([1])])
        if (options.path) writeFileSync(options.path, lateBytes)
        return lateBytes
      } finally {
        if (first) lateFinished.resolve()
      }
    }
    const capturing = captureTargetCell(fake.runtime, dirtyCloseTarget, 'dark')
    try {
      await fake.screenshotStarted
      controller.abort(new Error('abort while imaging'))
      const result = await capturing
      expect(result.capture.status).toBe('failed')
      expect(result.capture.error).toContain('abort while imaging')
      expect(result.isolation).toEqual({ ready: true })
      const image = result.capture.image!
      const retained = readFileSync(image.path)
      gate.resolve()
      await lateFinished.promise
      expect(readFileSync(image.path)).toEqual(retained)
      expect(createHash('sha256').update(readFileSync(image.path)).digest('hex')).toBe(image.sha256)
      expect(fake.snapshot()).toMatchObject({ dirty: false, tabId: 'tab-app', dialogVisible: false })
    } finally {
      gate.resolve()
      await capturing.catch(() => undefined)
      await lateFinished.promise
      fake.cleanup()
    }
  })

  test('never overwrites image evidence that already exists for the cell', async () => {
    const fake = buildDirtyCloseRuntime()
    const path = fake.capturePath()
    const originalImage = Buffer.from('pre-existing diagnostic evidence')
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, originalImage)
    try {
      const result = await captureTargetCell(fake.runtime, dirtyCloseTarget, 'dark')

      expect(result.capture.status).toBe('failed')
      expect(result.capture.image?.path).toBe(path)
      expect(result.capture.image?.sha256).toBe(createHash('sha256').update(originalImage).digest('hex'))
      expect(existsSync(path)).toBe(true)
      expect(readFileSync(path)).toEqual(originalImage)
    } finally {
      fake.cleanup()
    }
  })
})

describe('cell-owned terminal and Ask isolation', () => {
  test('releases a cell terminal only after its owned tab closes', async () => {
    const fake = buildFakeCaptureRuntime()
    const terminal = { sessionId: 'cell-session', tabId: 'cell-tab', paneId: 'cell-pane' }
    const owned = fake.runtime.ownedTerminalFixtures
    owned.set(terminal.tabId, terminal)
    Object.assign(fake.runtime, { cellTerminalFixture: terminal, cellTerminalWorktreeId: 'worktree-1' })
    try {
      const result = await isolateCell(fake.runtime, target('view:acme.fixture/page', 'acme.fixture', 'view'), 'dark', false)

      expect(result).toEqual({ ready: true })
      expect(fake.calls.some((call) => call.method === 'quirky.terminal/closeTab' && call.params?.tab === terminal.tabId)).toBe(true)
      expect(owned.has(terminal.tabId)).toBe(false)
    } finally {
      fake.cleanup()
    }
  })

  test('retains a cell terminal owner when its close request fails', async () => {
    const fake = buildFakeCaptureRuntime({ rpcFailures: { 'quirky.terminal/closeTab': 'terminal close failed' } })
    const terminal = { sessionId: 'cell-session', tabId: 'cell-tab', paneId: 'cell-pane' }
    const owned = fake.runtime.ownedTerminalFixtures
    owned.set(terminal.tabId, terminal)
    Object.assign(fake.runtime, { cellTerminalFixture: terminal, cellTerminalWorktreeId: 'worktree-1' })
    try {
      const result = await isolateCell(fake.runtime, target('view:acme.fixture/page', 'acme.fixture', 'view'), 'dark', true)

      expect(result.ready).toBe(false)
      expect(owned.get(terminal.tabId)).toEqual(terminal)
      expect(fake.calls.some((call) => call.method === 'quirky.terminal/closeTab' && call.params?.tab === terminal.tabId)).toBe(true)
    } finally {
      fake.cleanup()
    }
  })

  test('releases an Ask owner only after cancellation and Questions-panel drain', async () => {
    const fake = buildFakeCaptureRuntime()
    const ask = { askId: 'ask-owned', command: 'Bash: bun run build' }
    fake.setAskFixture(ask)
    fake.runtime.ownedAskFixtures.set(ask.askId, ask)
    fake.runtime.cellAskFixture = ask
    try {
      const result = await isolateCell(fake.runtime, target('view:quirky.ask/card', 'quirky.ask', 'view'), 'dark', true)

      expect(result, fake.runtime.manifest.failures.join('\n')).toEqual({ ready: true })
      expect(fake.calls.some((call) => call.method === 'quirky.ask/cancel' && call.params?.askId === ask.askId)).toBe(true)
      expect(fake.calls.filter((call) => call.method === 'ui.panel.open' && call.params?.id === 'panel:quirky.ask/questions')).toHaveLength(2)
      expect(fake.runtime.ownedAskFixtures.has(ask.askId)).toBe(false)
      expect(fake.runtime.cellAskFixture).toBeNull()
    } finally {
      fake.cleanup()
    }
  })

  test('charges a transient cancellation failure but releases ownership after one proved recovery', async () => {
    const fake = buildFakeCaptureRuntime()
    const ask = { askId: 'ask-owned', command: 'Bash: bun run build' }
    fake.setAskFixture(ask)
    fake.runtime.ownedAskFixtures.set(ask.askId, ask)
    fake.runtime.cellAskFixture = ask
    const forward = fake.runtime.client.callAny.bind(fake.runtime.client)
    let attempts = 0
    fake.runtime.client.callAny = async (method, params, options) => {
      if (method === 'quirky.ask/cancel' && ++attempts === 1) throw new Error('first cancel reply was lost')
      return await forward(method, params, options)
    }
    try {
      const result = await isolateCell(fake.runtime, target('view:quirky.ask/card', 'quirky.ask', 'view'), 'dark', true)
      expect(result, fake.runtime.manifest.failures.join('\n')).toEqual({ ready: true })
      expect(attempts).toBe(2)
      expect(fake.runtime.ownedAskFixtures.has(ask.askId)).toBe(false)
      expect(fake.runtime.manifest.failures.some((failure) => failure.includes('first cancel reply was lost'))).toBe(true)
    } finally { fake.cleanup() }
  })

  test('blocks the next cell after unclosed cancellation while independently closing its terminal', async () => {
    const fake = buildFakeCaptureRuntime({ rpcFailures: { 'quirky.ask/cancel': 'cancel unavailable' } })
    const ask = { askId: 'ask-owned', command: 'Bash: bun run build' }
    const terminal = { sessionId: 'cell-session', tabId: 'cell-tab', paneId: 'cell-pane' }
    fake.setAskFixture(ask)
    fake.runtime.ownedAskFixtures.set(ask.askId, ask)
    fake.runtime.cellAskFixture = ask
    fake.runtime.ownedTerminalFixtures.set(terminal.tabId, terminal)
    fake.runtime.cellTerminalFixture = terminal
    try {
      const isolated = await isolateCell(fake.runtime, target('view:quirky.ask/card', 'quirky.ask', 'view'), 'dark', true)
      expect(isolated.ready).toBe(false)
      expect(fake.runtime.ownedAskFixtures.has(ask.askId)).toBe(true)
      expect(fake.runtime.ownedTerminalFixtures.size).toBe(0)
      expect(fake.reloadCount()).toBe(0)
      const next = await captureTargetCell(fake.runtime, target('view:acme.fixture/page', 'acme.fixture', 'view'), 'dark')
      expect(next.capture.status).toBe('failed')
      expect(next.isolation.ready).toBe(false)
    } finally { fake.cleanup() }
  })

  test('retains an Ask owner when its renderer drain cannot be observed and still closes terminals', async () => {
    const fake = buildFakeCaptureRuntime({ askObservationFailure: true })
    const ask = { askId: 'ask-owned', command: 'Bash: bun run build' }
    const terminal = { sessionId: 'cell-session', tabId: 'cell-tab', paneId: 'cell-pane' }
    fake.setAskFixture(ask)
    fake.runtime.ownedAskFixtures.set(ask.askId, ask)
    fake.runtime.cellAskFixture = ask
    fake.runtime.ownedTerminalFixtures.set(terminal.tabId, terminal)
    fake.runtime.cellTerminalFixture = terminal
    try {
      const result = await isolateCell(fake.runtime, target('view:quirky.ask/card', 'quirky.ask', 'view'), 'dark', true)

      expect(result.ready).toBe(false)
      expect(fake.runtime.ownedAskFixtures.get(ask.askId)).toEqual(ask)
      expect(fake.calls.some((call) => call.method === 'quirky.terminal/closeTab' && call.params?.tab === terminal.tabId)).toBe(true)
    } finally {
      fake.cleanup()
    }
  })
})
