import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { browserExecutable } from '../../../scripts/test-support/browser'

const ROOT = resolve(import.meta.dir, '../../..')
const ACCOUNT_MODULES = join(ROOT, 'plugins/quirky.accounts/node_modules')
const BROWSER_IMPORTS: Record<string, string> = {
  react: join(ACCOUNT_MODULES, 'react/index.js'),
  'react/jsx-runtime': join(ACCOUNT_MODULES, 'react/jsx-runtime.js'),
  'react/jsx-dev-runtime': join(ACCOUNT_MODULES, 'react/jsx-dev-runtime.js'),
  'react-dom': join(ACCOUNT_MODULES, 'react-dom/index.js'),
  'react-dom/client': join(ACCOUNT_MODULES, 'react-dom/client.js'),
  '@quirky/ui': join(ROOT, 'packages/ui/src/design-system/index.ts'),
  '@quirky/protocol': join(ROOT, 'packages/protocol/src/index.ts'),
}
const THEMES = ['dark', 'light'] as const
const VIEWPORTS = [{ width: 1000, height: 900 }, { width: 320, height: 600 }] as const
const VISIBLE_PROVIDER_IDS = [
  'claude', 'codex', 'gemini', 'antigravity', 'opencode-go', 'kimi', 'minimax', 'grok', 'cursor', 'zcode',
]
const ACCOUNTS_PROVIDER_IDS = VISIBLE_PROVIDER_IDS.map((provider) => `accounts-provider-usage-${provider}`)

type FixtureMode = 'usage' | 'settings' | 'usage-settings' | 'accessory' | 'switch'
type FixtureOptions = {
  section?: 'appearance' | 'gemini'
  direction?: 'used' | 'remaining'
  hidden?: boolean
  density?: 'normal' | 'icons'
  visibleProviders?: string[]
  claudeSwitchPolicy?: 'ask' | 'always' | 'never'
  skipCodexResetConfirm?: boolean
  staleSessions?: Array<{
    sessionId: string
    provider: 'claude' | 'codex'
    accountId: string | null
    accountLabel: string
    selectedId: string | null
    selectedLabel: string
    busy: boolean
    queued: boolean
    kept: boolean
    error: string | null
    selectionRevision: number
  }>
  remote?: boolean
  failAction?: 'keep' | 'restart'
  holdAction?: boolean
  rejectUiState?: boolean
  rejectPreferences?: boolean
  rejectSetting?: boolean
  holdSetting?: boolean
  initialSetting?: boolean
  resetFailures?: number
}
type RecordedCall = { method: string; params: Record<string, unknown> }
type RecordedCommand = { id: string; args: unknown }
type BrowserSnapshot = {
  accounts: { preferences: Record<string, unknown>; staleSessions: Array<Record<string, unknown>>; revision: number } | null
  usage: unknown
  ui: { open: boolean; provider: string | null; expanded: string | null; settingsSection: string | null }
  scope: { kind: string }
}
type BrowserFixtureApi = {
  mount(mode: FixtureMode, options?: FixtureOptions): void
  render(mode: FixtureMode): void
  calls(): RecordedCall[]
  commands(): RecordedCommand[]
  toasts(): unknown[][]
  snapshot(): BrowserSnapshot
  setting(): boolean
  clearCalls(): void
  resolveAction(): void
  resolveSetting(): void
}
type WindowWithFixture = Window & { accountsBaseline: BrowserFixtureApi }

type CheckboxGeometry = {
  id: string
  found: boolean
  layoutInline: boolean
  nativeCheckbox: boolean
  hiddenLabel: boolean
  visibleLabel: string
  accessibleName: string | null
  describedBy: string | null
  inputSize: [number, number]
  labelGap: number
  firstLineCenterDelta: number
  hasHelp: boolean
  helpAlignment: number | null
  helpBelowLabel: boolean | null
  withinViewport: boolean
}

let browser: Browser | null = null
let browserBundle = ''
let productionCss = ''
let tempDirectory = ''
const pageErrors = new WeakMap<Page, string[]>()

function browserEntry(): string {
  const usageModule = join(ROOT, 'plugins/quirky.accounts/src/window/Usage.tsx')
  const settingsModule = join(ROOT, 'plugins/quirky.accounts/src/window/AccountsSettings.tsx')
  const modelModule = join(ROOT, 'plugins/quirky.accounts/src/window/model.ts')
  return `
    import { createRoot } from 'react-dom/client'
    import { AccountsUiStore } from ${JSON.stringify(modelModule)}
    import { AccountsSettings } from ${JSON.stringify(settingsModule)}
    import { AccountSwitchDialog, SessionAccessory, StatusBarUsage } from ${JSON.stringify(usageModule)}

    const DEFAULT_PROVIDERS = ['claude', 'codex', 'gemini', 'antigravity', 'opencode-go', 'kimi', 'minimax', 'grok', 'cursor', 'zcode']
    const GATED_PROVIDERS = ['claude', 'codex', 'gemini', 'antigravity', 'kimi', 'grok', 'zcode']
    const session = (provider, sessionId, selectionRevision) => ({
      sessionId, provider, accountId: null,
      accountLabel: provider === 'codex' ? 'Old Codex account' : 'Old Claude account',
      selectedId: null, selectedLabel: 'System default', busy: false, queued: false, kept: false,
      error: null, selectionRevision,
    })
    const makeUsage = () => ({
      providers: ['claude', 'codex', 'grok', 'cursor'].map((provider, index) => ({
        provider, accountId: null, status: 'ok', error: null, updatedAt: 1,
        session: { usedPercent: 24 + index * 13, windowMinutes: 300, resetsAt: null, resetDescription: null },
        weekly: null,
        ...(provider === 'codex' ? { rateLimitResetCredits: {
          availableCount: 1,
          expectedScope: { accountId: null, accountRevision: 31, offerRevision: 'fake-codex-offer-v1' },
        } } : {}),
      })),
      inactive: {}, updatedAt: 1,
    })

    let config = {}
    let currentAccount
    let currentUsage
    let currentUi
    let currentScope
    let store
    let savedSetting = false
    let recordedCalls = []
    let recordedCommands = []
    let recordedToasts = []
    let roots = []
    let heldActionResolve = null
    let heldSettingResolve = null
    let actionWasHeld = false
    let settingWasHeld = false
    let resetFailuresRemaining = 0

    const makeAccountState = (mode, options) => ({
      accounts: [],
      active: { claude: null, codex: null },
      systemDefault: {
        claude: { label: 'System default', email: null, hasAuth: true, authKind: 'oauth' },
        codex: { label: 'System default', email: null, hasAuth: true, authKind: 'oauth' },
      },
      pendingLogin: null,
      staleSessions: options.staleSessions ?? (mode === 'switch'
        ? [session('claude', 'claude-session-1', 41)]
        : mode === 'accessory' ? [session('codex', 'codex-session-1', 41)] : []),
      configWarnings: [],
      preferences: {
        mode: 'compact', direction: options.direction ?? 'used', hidden: options.hidden ?? false,
        visibleProviders: options.visibleProviders ?? ['claude', 'codex', 'grok', 'cursor'],
        density: options.density ?? 'normal', claudeSwitchPolicy: options.claudeSwitchPolicy ?? 'ask',
        skipCodexResetConfirm: options.skipCodexResetConfirm ?? false,
      },
      revision: 31,
    })

    const actionResult = (method, params) => {
      const ids = Array.isArray(params.sessions) ? params.sessions : []
      const selectionRevision = params.selectionRevision
      currentAccount = {
        ...currentAccount,
        staleSessions: currentAccount.staleSessions.map((item) => ids.includes(item.sessionId) && item.selectionRevision === selectionRevision
          ? { ...item, ...(method === 'quirky.accounts/keep' ? { kept: true } : { queued: true }) }
          : item),
      }
      return currentAccount
    }

    const context = {
      call: async (method, params = {}) => {
        recordedCalls.push({ method, params: JSON.parse(JSON.stringify(params)) })
        if (method === 'ui.window.self') return { connId: 7 }
        if (method === 'quirky.accounts/setUiState') {
          if (config.rejectUiState) throw new Error('fixture rejected UI state')
          currentUi = { ...currentUi, ...params }
          return currentUi
        }
        if (method === 'quirky.accounts/setPreferences') {
          if (config.rejectPreferences) throw new Error('fixture rejected preferences')
          currentAccount = { ...currentAccount, preferences: { ...currentAccount.preferences, ...params } }
          return currentAccount
        }
        if (method === 'setting.set') {
          if (config.holdSetting && !settingWasHeld) {
            settingWasHeld = true
            const { promise, resolve } = Promise.withResolvers()
            heldSettingResolve = resolve
            await promise
          }
          if (config.rejectSetting) throw new Error('fixture rejected setting')
          savedSetting = params.value === true
          return undefined
        }
        if (method === 'quirky.accounts/keep' || method === 'quirky.accounts/restart') {
          const action = method.endsWith('/keep') ? 'keep' : 'restart'
          if (config.failAction === action) throw new Error('fixture rejected session action')
          if (config.holdAction && !actionWasHeld) {
            actionWasHeld = true
            const gate = Promise.withResolvers()
            heldActionResolve = () => gate.resolve(actionResult(method, params))
            return await gate.promise
          }
          return actionResult(method, params)
        }
        if (method === 'quirky.accounts/consumeResetCredit') {
          if (resetFailuresRemaining > 0) {
            resetFailuresRemaining -= 1
            throw new Error('fixture rejected reset request')
          }
          return { outcome: 'reset', state: currentUsage }
        }
        if (method === 'quirky.accounts/usage' || method === 'quirky.accounts/refresh') return currentUsage
        if (method === 'quirky.accounts/list') return currentAccount
        throw new Error('Unexpected local fixture RPC: ' + method)
      },
      executeCommand: async (id, args) => { recordedCommands.push({ id, args }) },
      getSetting: () => savedSetting,
      subscribe: () => () => {},
      toast: (...args) => { recordedToasts.push(args) },
      openView: () => {},
      closeView: () => {},
    }

    const unmountRoots = () => {
      for (const root of roots) root.unmount()
      roots = []
    }
    const renderRoot = (id, component) => {
      const node = document.getElementById(id)
      if (!node) throw new Error('Missing fixture mount: ' + id)
      const root = createRoot(node)
      roots.push(root)
      root.render(component)
    }
    const render = (mode) => {
      unmountRoots()
      if (mode === 'usage' || mode === 'usage-settings') {
        renderRoot('usage-mount', <StatusBarUsage store={store} />)
      }
      if (mode === 'settings' || mode === 'usage-settings') {
        renderRoot('settings-mount', <AccountsSettings context={context} store={store} />)
      }
      if (mode === 'accessory') {
        renderRoot('fixture-mount', <SessionAccessory store={store} input={{ sessionId: config.sessionId ?? 'codex-session-1' }} />)
      }
      if (mode === 'switch') renderRoot('fixture-mount', <AccountSwitchDialog store={store} />)
    }

    window.accountsBaseline = {
      mount(mode, options = {}) {
        unmountRoots()
        if (store) store.stop()
        config = options
        recordedCalls = []
        recordedCommands = []
        recordedToasts = []
        heldActionResolve = null
        heldSettingResolve = null
        actionWasHeld = false
        settingWasHeld = false
        resetFailuresRemaining = options.resetFailures ?? 0
        savedSetting = options.initialSetting ?? false
        currentAccount = makeAccountState(mode, options)
        currentUsage = makeUsage()
        currentUi = {
          open: mode === 'usage' && options.provider === 'codex' || mode === 'usage' && options.open === true,
          provider: mode === 'usage' ? options.provider ?? null : null,
          expanded: null,
          settingsSection: options.section ?? 'appearance',
        }
        currentScope = options.remote
          ? { kind: 'remote', mirrorId: 'fixture-remote', owner: null, workspace: null, hostName: 'Fixture remote', status: 'ready', error: null }
          : { kind: 'local', worktreeId: null }
        store = new AccountsUiStore(context)
        Object.assign(store.getSnapshot(), {
          scope: currentScope,
          accounts: currentAccount,
          usage: currentUsage,
          ui: currentUi,
          credentials: [],
          login: null,
          loginStarting: false,
          loginCancelling: false,
          agentDetection: { status: 'ready', installedProviders: GATED_PROVIDERS },
          loading: false,
          refreshing: false,
          error: null,
        })
        render(mode)
      },
      render,
      calls: () => recordedCalls,
      commands: () => recordedCommands,
      toasts: () => recordedToasts,
      snapshot: () => store.getSnapshot(),
      setting: () => savedSetting,
      clearCalls: () => { recordedCalls = []; recordedCommands = []; recordedToasts = [] },
      resolveAction: () => { const resolve = heldActionResolve; heldActionResolve = null; resolve?.() },
      resolveSetting: () => { const resolve = heldSettingResolve; heldSettingResolve = null; resolve?.() },
    }
  `
}

beforeAll(async () => {
  tempDirectory = await mkdtemp(join(tmpdir(), 'accounts-baseline-layout-'))
  const entrypoint = join(tempDirectory, 'browser-entry.tsx')
  await writeFile(entrypoint, browserEntry())
  const dependencyResolver = {
    name: 'accounts-baseline-browser-dependencies',
    setup(builder: { onResolve(options: { filter: RegExp }, callback: (args: { path: string; importer: string }) => { path: string } | undefined): void }) {
      builder.onResolve(
        { filter: /^\.\.?\// },
        ({ path, importer }) => ({ path: Bun.resolveSync(path, dirname(importer)) }),
      )
      builder.onResolve(
        { filter: /^(?:react|react\/jsx-runtime|react\/jsx-dev-runtime|react-dom|react-dom\/client|@quirky\/ui|@quirky\/protocol)$/ },
        ({ path }) => ({ path: BROWSER_IMPORTS[path] }),
      )
    },
  }
  const browserBuild = await Bun.build({
    entrypoints: [entrypoint],
    target: 'browser',
    format: 'iife',
    plugins: [dependencyResolver],
    define: { 'process.env.NODE_ENV': '"production"' },
  })
  if (!browserBuild.success) throw new Error(browserBuild.logs.map((log) => log.message).join('\n'))
  browserBundle = await browserBuild.outputs[0]!.text()

  const cssBuild = await Bun.build({
    entrypoints: [
      join(ROOT, 'packages/ui/src/styles.css'),
      join(ROOT, 'packages/ui/src/shell/chrome.css'),
    ],
    outdir: join(tempDirectory, 'css'),
    target: 'browser',
    minify: false,
  })
  if (!cssBuild.success) throw new Error(cssBuild.logs.map((log) => log.message).join('\n'))
  productionCss = (await Promise.all(cssBuild.outputs.filter((output) => output.path.endsWith('.css')).map((output) => output.text()))).join('\n')

  browser = await chromium.launch({
    executablePath: browserExecutable(),
    headless: true,
    args: process.platform === 'linux' ? ['--no-sandbox'] : [],
  })
})

afterAll(async () => {
  await browser?.close()
  if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true })
})

async function pageFor(width = 1000, height = 900, theme: 'dark' | 'light' = 'dark'): Promise<Page> {
  if (!browser) throw new Error('Browser fixture was not initialized')
  const page = await browser.newPage({ viewport: { width, height } })
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  pageErrors.set(page, errors)
  const html = `<!doctype html><html data-theme="${theme}"><head><style>${productionCss}</style><style>
    html, body { height: 100%; margin: 0; }
    body { min-width: 0; }
    .baseline-app { display: flex; flex-direction: column; height: 100vh; min-width: 0; overflow: hidden; }
    .baseline-main { flex: 1 1 auto; min-height: 0; min-width: 0; overflow: auto; }
    #fixture-mount { min-width: 0; }
  </style></head><body>
    <div id="fixture-mount"></div>
    <div class="baseline-app"><main class="baseline-main"><div id="settings-mount"></div></main>
      <footer class="shell-statusbar" aria-label="Status bar">
        <div class="shell-statusbar__start" aria-hidden="true"></div>
        <div class="shell-statusbar__values" aria-label="Workspace status">
          <section class="plugin-slot plugin-status-bar-slot"><div id="usage-mount" class="plugin-slot-body accounts-mount-root accounts-mount-root--bar"></div></section>
        </div>
      </footer>
    </div>
  </body></html>`
  await page.route('http://localhost/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: html }))
  await page.goto('http://localhost/accounts-baseline-layout')
  await page.addScriptTag({ content: browserBundle })
  return page
}
function expectNoPageErrors(page: Page): void {
  expect(pageErrors.get(page)).toEqual([])
}

async function mount(page: Page, mode: FixtureMode, options: FixtureOptions = {}): Promise<void> {
  await page.evaluate(({ mode, options }) => (window as WindowWithFixture).accountsBaseline.mount(mode, options), { mode, options })
}

async function setMatrixCase(page: Page, theme: 'dark' | 'light', viewport: typeof VIEWPORTS[number]): Promise<void> {
  await page.setViewportSize(viewport)
  await page.evaluate((value) => { document.documentElement.dataset.theme = value }, theme)
}

function fixture(page: Page): Promise<{ calls: RecordedCall[]; commands: RecordedCommand[]; toasts: unknown[][]; snapshot: BrowserSnapshot }> {
  return page.evaluate(() => {
    const api = (window as WindowWithFixture).accountsBaseline
    return { calls: api.calls(), commands: api.commands(), toasts: api.toasts(), snapshot: api.snapshot() }
  })
}

async function checkboxGeometry(page: Page, ids: string[]): Promise<CheckboxGeometry[]> {
  return page.evaluate((inputIds) => inputIds.map((id): CheckboxGeometry => {
    const input = document.getElementById(id) as HTMLInputElement | null
    const row = input?.closest<HTMLElement>('.ui-form-row') ?? null
    const label = row?.querySelector<HTMLElement>('.ui-form-row__label') ?? null
    if (!input || !row || !label) return {
      id, found: false, layoutInline: false, nativeCheckbox: false, hiddenLabel: false,
      visibleLabel: '', accessibleName: null, describedBy: null, inputSize: [0, 0], labelGap: Number.NaN,
      firstLineCenterDelta: Number.NaN, hasHelp: false, helpAlignment: null, helpBelowLabel: null, withinViewport: false,
    }
    const inputRect = input.getBoundingClientRect()
    const labelRect = label.getBoundingClientRect()
    const lineRange = document.createRange()
    lineRange.selectNodeContents(label)
    const firstLine = lineRange.getClientRects()[0] ?? labelRect
    const help = row.querySelector<HTMLElement>('.ui-help-text')
    const helpRect = help?.getBoundingClientRect()
    const rowRect = row.getBoundingClientRect()
    return {
      id,
      found: true,
      layoutInline: row.classList.contains('ui-form-row--inline'),
      nativeCheckbox: input.type === 'checkbox' && input.closest('.ui-checkbox') !== null,
      hiddenLabel: row.querySelector('.ui-checkbox__text') === null,
      visibleLabel: label.textContent?.trim() ?? '',
      accessibleName: input.getAttribute('aria-label'),
      describedBy: input.getAttribute('aria-describedby'),
      inputSize: [inputRect.width, inputRect.height],
      labelGap: labelRect.left - inputRect.right,
      firstLineCenterDelta: inputRect.top + inputRect.height / 2 - (firstLine.top + firstLine.height / 2),
      hasHelp: Boolean(help),
      helpAlignment: helpRect ? helpRect.left - labelRect.left : null,
      helpBelowLabel: helpRect ? helpRect.top >= labelRect.bottom - 0.5 : null,
      withinViewport: rowRect.left >= -1 && rowRect.right <= window.innerWidth + 1 && labelRect.left >= -1 && labelRect.right <= window.innerWidth + 1 && inputRect.left >= -1 && inputRect.right <= window.innerWidth + 1 && (!helpRect || helpRect.left >= -1 && helpRect.right <= window.innerWidth + 1),
    }
  }), ids)
}

function expectInlineCheckbox(row: CheckboxGeometry, help = false): void {
  expect(row.found).toBe(true)
  expect(row.layoutInline).toBe(true)
  expect(row.nativeCheckbox).toBe(true)
  expect(row.hiddenLabel).toBe(true)
  expect(row.accessibleName).toBe(row.visibleLabel)
  expect(row.inputSize).toEqual([14, 14])
  expect(row.labelGap).toBeCloseTo(8, 1)
  expect(Math.abs(row.firstLineCenterDelta)).toBeLessThanOrEqual(1)
  expect(row.withinViewport).toBe(true)
  if (help) {
    expect(row.hasHelp).toBe(true)
    expect(row.helpAlignment).toBeCloseTo(0, 1)
    expect(row.helpBelowLabel).toBe(true)
  }
}

async function waitForCalls(page: Page, method: string, count: number): Promise<void> {
  await page.waitForFunction(({ method, count }) => (window as WindowWithFixture).accountsBaseline.calls().filter((call) => call.method === method).length >= count, { method, count })
}
async function waitForUsageHighlight(page: Page, state: 'hover' | 'open'): Promise<void> {
  await page.waitForFunction((expected) => {
    const trigger = document.querySelector<HTMLButtonElement>('.usage-trigger')
    if (!trigger) return false
    if (expected === 'hover' ? !trigger.matches(':hover') : trigger.getAttribute('aria-expanded') !== 'true') return false
    const tokenColor = (name: string) => {
      const sample = document.createElement('span')
      sample.style.color = `var(${name})`
      document.body.append(sample)
      const color = getComputedStyle(sample).color
      sample.remove()
      return color
    }
    const style = getComputedStyle(trigger)
    const directionColor = getComputedStyle(trigger.querySelector('small')!).color
    const text = tokenColor('--ui-text')
    return style.backgroundColor === tokenColor('--ui-selected') && style.color === text && directionColor === text
  }, state)
}

const STALE_CODEX = {
  sessionId: 'codex-session-1', provider: 'codex' as const, accountId: null,
  accountLabel: 'Old Codex account', selectedId: null, selectedLabel: 'System default',
  busy: false, queued: false, kept: false, error: null, selectionRevision: 41,
}
const STALE_CLAUDE_A = {
  sessionId: 'claude-session-a', provider: 'claude' as const, accountId: null,
  accountLabel: 'Old Claude account', selectedId: null, selectedLabel: 'System default',
  busy: false, queued: false, kept: false, error: null, selectionRevision: 41,
}
const STALE_CLAUDE_B = { ...STALE_CLAUDE_A, sessionId: 'claude-session-b', selectionRevision: 42 }


test('Usage keeps host status-bar anatomy, content, keyboard behavior, and provider actions', async () => {
  const page = await pageFor()
  try {
    for (const theme of THEMES) {
      for (const viewport of VIEWPORTS) {
        await setMatrixCase(page, theme, viewport)
        await mount(page, 'usage')
        const trigger = page.getByRole('button', { name: 'Open Usage', exact: true })
        await trigger.waitFor()
        await page.mouse.move(0, 0)
        const idle = await trigger.evaluate((element) => {
          const style = getComputedStyle(element)
          const direction = element.querySelector('small')!
          const directionStyle = getComputedStyle(direction)
          const rect = element.getBoundingClientRect()
          const tokenColor = (name: string) => {
            const sample = document.createElement('span')
            sample.style.color = `var(${name})`
            document.body.append(sample)
            const color = getComputedStyle(sample).color
            sample.remove()
            return color
          }
          return {
            text: element.textContent?.replace(/\s+/g, ' ').trim(),
            name: element.getAttribute('aria-label'),
            expanded: element.getAttribute('aria-expanded'),
            background: style.backgroundColor,
            border: style.borderTopWidth,
            height: rect.height,
            padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft],
            gap: style.columnGap,
            fontSize: style.fontSize,
            fontWeight: style.fontWeight,
            color: style.color,
            directionFontSize: directionStyle.fontSize,
            directionFontWeight: directionStyle.fontWeight,
            directionColor: directionStyle.color,
            directionShrink: directionStyle.flexShrink,
            muted: tokenColor('--ui-muted'),
          }
        })
        expect(idle.text).toBe('Usage Used')
        expect(idle.name).toBe('Open Usage')
        expect(idle.expanded).toBe('false')
        expect(idle.background).toBe('rgba(0, 0, 0, 0)')
        expect(idle.border).toBe('0px')
        expect(idle.height).toBe(22)
        expect(idle.padding).toEqual(['0px', '6px', '0px', '6px'])
        expect(idle.gap).toBe('6px')
        expect(idle.fontSize).toBe('11px')
        expect(idle.fontWeight).toBe('400')
        expect(idle.color).toBe(idle.muted)
        expect(idle.directionFontSize).toBe(idle.fontSize)
        expect(idle.directionFontWeight).toBe(idle.fontWeight)
        expect(idle.directionColor).toBe(idle.color)
        expect(idle.directionShrink).toBe('0')

        await trigger.hover()
        await waitForUsageHighlight(page, 'hover')
        const hover = await trigger.evaluate((element) => {
          const tokenColor = (name: string) => {
            const sample = document.createElement('span')
            sample.style.color = `var(${name})`
            document.body.append(sample)
            const color = getComputedStyle(sample).color
            sample.remove()
            return color
          }
          const style = getComputedStyle(element)
          return {
            background: style.backgroundColor,
            color: style.color,
            directionColor: getComputedStyle(element.querySelector('small')!).color,
            selected: tokenColor('--ui-selected'),
            text: tokenColor('--ui-text'),
          }
        })
        expect(hover.background).toBe(hover.selected)
        expect(hover.color).toBe(hover.text)
        expect(hover.directionColor).toBe(hover.text)

        await page.keyboard.press('Tab')
        const focus = await trigger.evaluate((element) => {
          const style = getComputedStyle(element)
          const rect = element.getBoundingClientRect()
          const row = element.closest('.shell-statusbar')!.getBoundingClientRect()
          const width = parseFloat(style.outlineWidth)
          const offset = parseFloat(style.outlineOffset)
          const extent = Math.max(0, width + offset)
          const sample = document.createElement('span')
          sample.style.color = 'var(--ui-accent)'
          document.body.append(sample)
          const accent = getComputedStyle(sample).color
          sample.remove()
          return {
            visible: element.matches(':focus-visible'),
            style: style.outlineStyle,
            width,
            offset,
            color: style.outlineColor,
            accent,
            insideRow: [rect.left - extent - row.left, rect.top - extent - row.top, row.right - rect.right - extent, row.bottom - rect.bottom - extent].every((clearance) => clearance >= -0.5),
          }
        })
        expect(focus.visible).toBe(true)
        expect(focus.style).toBe('solid')
        expect(focus.width).toBeGreaterThan(0)
        expect(focus.offset).toBeLessThan(0)
        expect(focus.color).toBe(focus.accent)
        expect(focus.insideRow).toBe(true)

        await page.mouse.move(0, 0)
        await trigger.click()
        await page.waitForFunction(() => (window as WindowWithFixture).accountsBaseline.snapshot().ui.open)
        await waitForUsageHighlight(page, 'open')
        const open = await trigger.evaluate((element) => {
          const style = getComputedStyle(element)
          const direction = getComputedStyle(element.querySelector('small')!)
          const tokenColor = (name: string) => {
            const sample = document.createElement('span')
            sample.style.color = `var(${name})`
            document.body.append(sample)
            const color = getComputedStyle(sample).color
            sample.remove()
            return color
          }
          return { background: style.backgroundColor, color: style.color, directionColor: direction.color, selected: tokenColor('--ui-selected'), text: tokenColor('--ui-text') }
        })
        expect(open.background).toBe(open.selected)
        expect(open.color).toBe(open.text)
        expect(open.directionColor).toBe(open.text)
        await page.keyboard.press('Escape')
        await page.waitForFunction(() => !(window as WindowWithFixture).accountsBaseline.snapshot().ui.open)
        expect(await trigger.evaluate((element) => document.activeElement === element)).toBe(true)
      }
    }

    await setMatrixCase(page, 'dark', { width: 1000, height: 900 })
    await mount(page, 'usage')
    const trigger = page.getByRole('button', { name: 'Open Usage', exact: true })
    await trigger.waitFor()
    await page.evaluate(() => (window as WindowWithFixture).accountsBaseline.clearCalls())
    await trigger.click()
    await page.waitForFunction(() => (window as WindowWithFixture).accountsBaseline.snapshot().ui.open)
    expect((await fixture(page)).calls).toEqual([{ method: 'quirky.accounts/setUiState', params: { open: true } }])
    await trigger.click()
    await page.waitForFunction(() => !(window as WindowWithFixture).accountsBaseline.snapshot().ui.open)
    await trigger.focus()
    await trigger.press('Enter')
    await page.waitForFunction(() => (window as WindowWithFixture).accountsBaseline.snapshot().ui.open)
    await trigger.press('Space')
    await page.waitForFunction(() => !(window as WindowWithFixture).accountsBaseline.snapshot().ui.open)
    expect((await fixture(page)).calls.filter((call) => call.method === 'quirky.accounts/setUiState')).toEqual([
      { method: 'quirky.accounts/setUiState', params: { open: true } },
      { method: 'quirky.accounts/setUiState', params: { open: false } },
      { method: 'quirky.accounts/setUiState', params: { open: true } },
      { method: 'quirky.accounts/setUiState', params: { open: false } },
    ])

    await trigger.click()
    await page.waitForFunction(() => (window as WindowWithFixture).accountsBaseline.snapshot().ui.open)
    await page.getByRole('tab', { name: 'Remaining', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('.usage-trigger')?.textContent?.includes('Remaining'))
    expect((await fixture(page)).calls).toContainEqual({ method: 'quirky.accounts/setPreferences', params: { direction: 'remaining' } })
    expect(await trigger.textContent()).toContain('Usage Remaining')
    await page.keyboard.press('Escape')

    await mount(page, 'usage-settings')
    await page.waitForSelector('.usage-chips [data-provider]')
    const chipWidths = await page.evaluate(() => {
      const widths = (selector: string) => Array.from(document.querySelectorAll<HTMLElement>(selector)).map((item) => item.getBoundingClientRect().width)
      return { rendered: widths('.usage-chips [data-provider]'), measured: widths('.usage-measure [data-provider]') }
    })
    expect(chipWidths.rendered.length).toBeGreaterThan(0)
    expect(chipWidths.measured).toEqual(chipWidths.rendered)
    const usageRefresh = page.locator('.usage-status-bar .usage-refresh')
    await usageRefresh.click()
    await page.waitForFunction(() => (window as WindowWithFixture).accountsBaseline.commands().length === 1)
    expect((await fixture(page)).commands).toEqual([{ id: 'command:quirky.accounts/refresh', args: { connId: 7 } }])

    await page.locator('.settings-content .ui-form-row__label').filter({ hasText: 'Hide usage from the status bar' }).click()
    await waitForCalls(page, 'quirky.accounts/setPreferences', 1)
    expect((await fixture(page)).calls.at(-1)).toEqual({ method: 'quirky.accounts/setPreferences', params: { hidden: true } })
    await page.waitForFunction(() => document.querySelector('.usage-trigger') === null)
    await page.locator('.settings-content .ui-form-row__label').filter({ hasText: 'Hide usage from the status bar' }).click()
    await waitForCalls(page, 'quirky.accounts/setPreferences', 2)
    await page.waitForSelector('.usage-trigger')
    await page.locator('.usage-status-bar').dispatchEvent('contextmenu')
    const visibilityMenu = page.getByRole('menu', { name: 'Usage visibility' })
    await visibilityMenu.waitFor()
    const rawCodexToggle = visibilityMenu.locator('input[type="checkbox"][aria-label="Codex Usage"]')
    expect(await rawCodexToggle.evaluate((element) => element.classList.contains('ui-checkbox__input'))).toBe(false)
    await rawCodexToggle.click()
    await waitForCalls(page, 'quirky.accounts/setPreferences', 3)
    expect((await fixture(page)).calls.at(-1)).toEqual({ method: 'quirky.accounts/setPreferences', params: { visibleProviders: ['claude', 'grok', 'cursor'] } })

    await page.setViewportSize({ width: 320, height: 600 })
    await page.waitForSelector('.usage-chips button[aria-label$="providers"]')
    const narrowFit = await page.locator('.usage-chips').evaluate((element) => ({ width: element.clientWidth, scrollWidth: element.scrollWidth }))
    expect(narrowFit.scrollWidth).toBeLessThanOrEqual(narrowFit.width)

    await mount(page, 'usage', { rejectUiState: true })
    const rejectedTrigger = page.getByRole('button', { name: 'Open Usage', exact: true })
    await rejectedTrigger.waitFor()
    await rejectedTrigger.click()
    await page.waitForFunction(() => (window as WindowWithFixture).accountsBaseline.toasts().length === 1)
    expect(await rejectedTrigger.getAttribute('aria-expanded')).toBe('false')
    expect((await fixture(page)).snapshot.ui.open).toBe(false)
    expect((await fixture(page)).calls).toEqual([{ method: 'quirky.accounts/setUiState', params: { open: true } }])
    expectNoPageErrors(page)
  } finally {
    await page.close()
  }
}, 120_000)


test('the Codex session accessory keeps its provider heading and revision-pinned actions', async () => {
  const page = await pageFor()
  try {
    for (const theme of THEMES) {
      for (const viewport of VIEWPORTS) {
        await setMatrixCase(page, theme, viewport)
        await mount(page, 'accessory')
        const card = page.locator('.session-accessory')
        await card.waitFor()
        const details = await card.evaluate((element) => {
          const title = element.querySelector<HTMLElement>('.ui-section-header__title')!
          const titleStyle = getComputedStyle(title)
          const cardStyle = getComputedStyle(element)
          const paragraph = element.querySelector('p')!
          const actions = Array.from(element.querySelectorAll<HTMLButtonElement>('.details-actions button'))
          const tokenColor = (name: string) => {
            const sample = document.createElement('span')
            sample.style.color = `var(${name})`
            document.body.append(sample)
            const color = getComputedStyle(sample).color
            sample.remove()
            return color
          }
          return {
            title: title.textContent,
            titleColor: titleStyle.color,
            expectedText: tokenColor('--ui-text'),
            titleFontSize: titleStyle.fontSize,
            titleTransform: titleStyle.textTransform,
            titleLetterSpacing: titleStyle.letterSpacing,
            paragraph: paragraph.textContent,
            paragraphWithin: paragraph.getBoundingClientRect().right <= window.innerWidth + 1,
            borderWidth: cardStyle.borderTopWidth,
            borderStyle: cardStyle.borderTopStyle,
            borderColor: cardStyle.borderTopColor,
            expectedBorder: tokenColor('--ui-border'),
            actionLabels: actions.map((button) => button.textContent?.trim()),
            actionDisabled: actions.map((button) => button.disabled),
            actionClasses: actions.map((button) => button.className),
            actionColors: actions.map((button) => getComputedStyle(button).color),
          }
        })
        expect(details.title).toBe('Codex account switched')
        expect(details.titleColor).toBe(details.expectedText)
        expect(details.titleFontSize).toBe('15px')
        expect(details.titleTransform).toBe('none')
        expect(details.titleLetterSpacing).toBe('normal')
        expect(details.paragraph).toBe('Codex is still signed in as Old Codex account. Restart this session to use System default. It stays on the previous account until you do.')
        expect(details.paragraphWithin).toBe(true)
        expect(details.borderWidth).toBe('1px')
        expect(details.borderStyle).toBe('solid')
        expect(details.borderColor).toBe(details.expectedBorder)
        expect(details.actionLabels).toEqual(['Keep old account', 'Restart'])
        expect(details.actionDisabled).toEqual([false, false])
        expect(details.actionClasses.every((className) => !className.includes('ui-button--primary'))).toBe(true)
        expect(details.actionColors).toEqual([details.expectedText, details.expectedText])
      }
    }

    await setMatrixCase(page, 'dark', { width: 1000, height: 900 })
    await mount(page, 'accessory', { staleSessions: [STALE_CODEX] })
    await page.getByRole('button', { name: 'Keep old account', exact: true }).click()
    await waitForCalls(page, 'quirky.accounts/keep', 1)
    expect((await fixture(page)).calls.filter((call) => call.method === 'quirky.accounts/keep')).toEqual([{
      method: 'quirky.accounts/keep', params: { sessions: ['codex-session-1'], selectionRevision: 41 },
    }])
    await page.getByText('Kept on Old Codex account.').waitFor()

    await mount(page, 'accessory', { staleSessions: [STALE_CODEX] })
    await page.getByRole('button', { name: 'Restart', exact: true }).click()
    await waitForCalls(page, 'quirky.accounts/restart', 1)
    expect((await fixture(page)).calls.filter((call) => call.method === 'quirky.accounts/restart')).toEqual([{
      method: 'quirky.accounts/restart', params: { sessions: ['codex-session-1'], selectionRevision: 41 },
    }])

    await mount(page, 'accessory', { staleSessions: [STALE_CODEX], failAction: 'restart' })
    await page.getByRole('button', { name: 'Restart', exact: true }).click()
    await page.getByText('Could not confirm restarting this session. Refresh account state before trying again.').waitFor()
    expect(await page.locator('.session-accessory').count()).toBe(1)
    expect((await fixture(page)).calls.filter((call) => call.method === 'quirky.accounts/restart')).toEqual([{
      method: 'quirky.accounts/restart', params: { sessions: ['codex-session-1'], selectionRevision: 41 },
    }])

    await mount(page, 'accessory', { staleSessions: [STALE_CODEX], remote: true })
    expect(await page.locator('.session-accessory').count()).toBe(0)
    await mount(page, 'accessory', { staleSessions: [] })
    expect(await page.locator('.session-accessory').count()).toBe(0)
    expect(await page.locator('#fixture-mount').textContent()).toBe('')
    expectNoPageErrors(page)
  } finally {
    await page.close()
  }
}, 120_000)


test('Accounts boolean rows use inline native composition and preserve preference and Gemini routes', async () => {
  const page = await pageFor()
  try {
    for (const theme of THEMES) {
      for (const viewport of VIEWPORTS) {
        await setMatrixCase(page, theme, viewport)
        await mount(page, 'settings', { section: 'appearance', visibleProviders: ['claude'] })
        await page.waitForSelector('#accounts-hide-status')
        const appearanceIds = ['accounts-hide-status', 'accounts-icon-density', ...ACCOUNTS_PROVIDER_IDS]
        const appearance = await checkboxGeometry(page, appearanceIds)
        expect(appearance.map((row) => row.id)).toEqual(appearanceIds)
        for (const row of appearance) expectInlineCheckbox(row)
        expect(await page.locator('.settings-content input[type="checkbox"]').count()).toBe(appearanceIds.length)
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

        await mount(page, 'settings', { section: 'gemini' })
        await page.waitForSelector('#gemini-cli-oauth-enabled')
        expectInlineCheckbox((await checkboxGeometry(page, ['gemini-cli-oauth-enabled']))[0]!)

        await mount(page, 'switch', { staleSessions: [STALE_CLAUDE_A] })
        const switchCheckbox = page.locator('#switch-dialog-dont-ask')
        await switchCheckbox.waitFor()
        const switchGeometry = (await checkboxGeometry(page, ['switch-dialog-dont-ask']))[0]!
        expectInlineCheckbox(switchGeometry, true)
        expect(switchGeometry.describedBy).toBe('switch-dialog-dont-ask-help')
        expect(await page.locator('#switch-dialog-dont-ask-help').count()).toBe(1)

        await mount(page, 'usage', { provider: 'codex', open: true })
        await page.getByRole('button', { name: 'Reset Codex limits' }).click()
        const resetDialog = page.getByRole('dialog', { name: 'Reset Codex limits confirmation' })
        await resetDialog.waitFor()
        const resetGeometry = (await checkboxGeometry(page, ['codex-reset-dont-ask']))[0]!
        expectInlineCheckbox(resetGeometry)
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      }
    }

    await setMatrixCase(page, 'dark', { width: 320, height: 600 })
    await mount(page, 'settings', { section: 'appearance', visibleProviders: ['claude'] })
    await page.locator('.settings-content .ui-form-row__label').filter({ hasText: 'Hide usage from the status bar' }).click()
    await waitForCalls(page, 'quirky.accounts/setPreferences', 1)
    expect((await fixture(page)).calls).toEqual([{ method: 'quirky.accounts/setPreferences', params: { hidden: true } }])
    expect((await fixture(page)).snapshot.accounts?.preferences.hidden).toBe(true)

    await page.locator('#accounts-icon-density').focus()
    await page.keyboard.press('Space')
    await waitForCalls(page, 'quirky.accounts/setPreferences', 2)
    expect((await fixture(page)).calls.at(-1)).toEqual({ method: 'quirky.accounts/setPreferences', params: { density: 'icons' } })
    expect((await fixture(page)).snapshot.accounts?.preferences.density).toBe('icons')

    await page.locator('.settings-content .ui-form-row__label').filter({ hasText: 'Codex Usage' }).click()
    await waitForCalls(page, 'quirky.accounts/setPreferences', 3)
    expect((await fixture(page)).calls.at(-1)).toEqual({ method: 'quirky.accounts/setPreferences', params: { visibleProviders: ['claude', 'codex'] } })
    expect((await fixture(page)).snapshot.accounts?.preferences.visibleProviders).toEqual(['claude', 'codex'])

    await mount(page, 'settings', { section: 'appearance', rejectPreferences: true, visibleProviders: ['claude'] })
    await page.locator('.settings-content .ui-form-row__label').filter({ hasText: 'Hide usage from the status bar' }).click()
    await page.waitForFunction(() => (window as WindowWithFixture).accountsBaseline.toasts().length === 1)
    expect((await fixture(page)).snapshot.accounts?.preferences.hidden).toBe(false)
    expect(await page.locator('#accounts-hide-status').isChecked()).toBe(false)
    expect((await fixture(page)).calls).toEqual([{ method: 'quirky.accounts/setPreferences', params: { hidden: true } }])

    await mount(page, 'settings', { section: 'gemini', holdSetting: true })
    const gemini = page.locator('#gemini-cli-oauth-enabled')
    await page.locator('.settings-content .ui-form-row__label').filter({ hasText: 'Allow Gemini CLI OAuth credential refresh' }).click()
    await waitForCalls(page, 'setting.set', 1)
    expect(await gemini.isDisabled()).toBe(true)
    expect(await gemini.isChecked()).toBe(false)
    await page.evaluate(() => (window as WindowWithFixture).accountsBaseline.resolveSetting())
    await page.waitForFunction(() => !(document.querySelector<HTMLInputElement>('#gemini-cli-oauth-enabled')?.disabled ?? true) && document.querySelector<HTMLInputElement>('#gemini-cli-oauth-enabled')?.checked === true)
    expect((await fixture(page)).calls.filter((call) => call.method === 'setting.set')).toEqual([{
      method: 'setting.set', params: { id: 'setting:quirky.accounts/gemini-cli-oauth-enabled', value: true },
    }])

    await mount(page, 'settings', { section: 'gemini', rejectSetting: true })
    await page.locator('.settings-content .ui-form-row__label').filter({ hasText: 'Allow Gemini CLI OAuth credential refresh' }).click()
    await page.waitForFunction(() => (window as WindowWithFixture).accountsBaseline.toasts().length === 1)
    expect(await page.locator('#gemini-cli-oauth-enabled').isChecked()).toBe(false)
    expect((await fixture(page)).calls).toEqual([{
      method: 'setting.set', params: { id: 'setting:quirky.accounts/gemini-cli-oauth-enabled', value: true },
    }])
    expectNoPageErrors(page)
  } finally {
    await page.close()
  }
}, 120_000)


test('switch dialog keeps its choice transient, groups pinned revisions, and locks pending actions', async () => {
  const page = await pageFor(320, 600)
  try {
    await mount(page, 'switch', { staleSessions: [STALE_CLAUDE_A, STALE_CLAUDE_B], holdAction: true })
    const checkbox = page.locator('#switch-dialog-dont-ask')
    const label = page.locator('.switch-dialog-content .ui-form-row__label')
    await label.click()
    expect(await checkbox.isChecked()).toBe(true)
    expect((await fixture(page)).calls).toEqual([])

    await page.getByRole('button', { name: 'Restart 2 sessions', exact: true }).click()
    await waitForCalls(page, 'quirky.accounts/restart', 1)
    let current = await fixture(page)
    expect(current.calls[0]).toEqual({ method: 'quirky.accounts/setPreferences', params: { claudeSwitchPolicy: 'always' } })
    expect(current.calls.filter((call) => call.method === 'quirky.accounts/restart')).toEqual([{
      method: 'quirky.accounts/restart', params: { sessions: ['claude-session-a'], selectionRevision: 41 },
    }])
    expect(await checkbox.isDisabled()).toBe(true)
    expect(await checkbox.isChecked()).toBe(true)
    expect(await page.getByRole('button', { name: 'Restart 2 sessions', exact: true }).isDisabled()).toBe(true)
    await page.evaluate(() => (window as WindowWithFixture).accountsBaseline.resolveAction())
    await waitForCalls(page, 'quirky.accounts/restart', 2)
    await page.waitForFunction(() => document.querySelector('.accounts-switch-dialog-root') === null)
    current = await fixture(page)
    expect(current.calls.filter((call) => call.method === 'quirky.accounts/restart')).toEqual([
      { method: 'quirky.accounts/restart', params: { sessions: ['claude-session-a'], selectionRevision: 41 } },
      { method: 'quirky.accounts/restart', params: { sessions: ['claude-session-b'], selectionRevision: 42 } },
    ])
    expect(current.calls.filter((call) => call.method === 'quirky.accounts/setPreferences')).toEqual([
      { method: 'quirky.accounts/setPreferences', params: { claudeSwitchPolicy: 'always' } },
    ])

    await mount(page, 'switch', { staleSessions: [STALE_CLAUDE_A], failAction: 'restart' })
    const failedCheckbox = page.locator('#switch-dialog-dont-ask')
    await page.locator('.switch-dialog-content .ui-form-row__label').click()
    expect(await failedCheckbox.isChecked()).toBe(true)
    expect((await fixture(page)).calls).toEqual([])
    await page.locator('.ui-dialog__actions').getByRole('button', { name: 'Restart session', exact: true }).click()
    await page.getByText('Could not confirm restarting the Claude sessions. Refresh account state before trying again.').waitFor()
    expect(await page.locator('.accounts-switch-dialog-root').count()).toBe(1)
    expect(await page.locator('.stale-row').count()).toBe(1)
    expect(await failedCheckbox.isChecked()).toBe(true)
    expect(await failedCheckbox.isDisabled()).toBe(false)
    expect((await fixture(page)).calls).toEqual([
      { method: 'quirky.accounts/setPreferences', params: { claudeSwitchPolicy: 'always' } },
      { method: 'quirky.accounts/restart', params: { sessions: ['claude-session-a'], selectionRevision: 41 } },
    ])
    expectNoPageErrors(page)
  } finally {
    await page.close()
  }
}, 60_000)


test('the fake Codex reset offer keeps confirmation, remembered state, and request identity', async () => {
  const page = await pageFor(320, 600)
  try {
    await mount(page, 'usage', { provider: 'codex', open: true, resetFailures: 1 })
    await page.getByRole('button', { name: 'Reset Codex limits' }).click()
    const dialog = page.getByRole('dialog', { name: 'Reset Codex limits confirmation' })
    await dialog.waitFor()
    const checkbox = dialog.locator('#codex-reset-dont-ask')
    expect(await checkbox.isChecked()).toBe(false)
    expect(await checkbox.isDisabled()).toBe(false)
    await dialog.locator('.ui-form-row__label').click()
    expect(await checkbox.isChecked()).toBe(true)
    expect((await fixture(page)).calls).toEqual([])

    await dialog.getByRole('button', { name: 'Reset now', exact: true }).click()
    await waitForCalls(page, 'quirky.accounts/consumeResetCredit', 1)
    await page.getByText('The reset could not be confirmed. Retry uses the same request ID and displayed account scope.').waitFor()
    expect(await checkbox.isChecked()).toBe(true)
    expect(await checkbox.isDisabled()).toBe(true)
    let current = await fixture(page)
    expect(current.calls.filter((call) => call.method === 'quirky.accounts/setPreferences')).toEqual([
      { method: 'quirky.accounts/setPreferences', params: { skipCodexResetConfirm: true } },
    ])
    const resetCalls = current.calls.filter((call) => call.method === 'quirky.accounts/consumeResetCredit')
    expect(resetCalls).toHaveLength(1)
    const firstRequest = resetCalls[0]!.params
    expect(firstRequest.expectedScope).toEqual({ accountId: null, accountRevision: 31, offerRevision: 'fake-codex-offer-v1' })
    expect(firstRequest.yes).toBe(true)
    expect(typeof firstRequest.idempotencyKey).toBe('string')
    expect((firstRequest.idempotencyKey as string).length).toBeGreaterThan(0)

    await dialog.getByRole('button', { name: 'Retry reset', exact: true }).click()
    await waitForCalls(page, 'quirky.accounts/consumeResetCredit', 2)
    await page.getByText('Codex limits were reset.').waitFor()
    current = await fixture(page)
    const retries = current.calls.filter((call) => call.method === 'quirky.accounts/consumeResetCredit')
    expect(retries).toHaveLength(2)
    expect(retries[1]!.params.idempotencyKey).toBe(firstRequest.idempotencyKey)
    expect(retries[1]!.params.expectedScope).toEqual(firstRequest.expectedScope)
    expect(await page.getByRole('dialog', { name: 'Reset Codex limits confirmation' }).count()).toBe(0)
    expect(current.calls.filter((call) => call.method === 'quirky.accounts/setPreferences')).toEqual([
      { method: 'quirky.accounts/setPreferences', params: { skipCodexResetConfirm: true } },
      { method: 'quirky.accounts/setPreferences', params: { skipCodexResetConfirm: true } },
    ])
    expectNoPageErrors(page)
  } finally {
    await page.close()
  }
}, 60_000)
