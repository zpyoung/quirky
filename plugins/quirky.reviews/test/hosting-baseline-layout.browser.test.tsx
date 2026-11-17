import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { browserExecutable } from '../../../scripts/test-support/browser'
import type { ReviewsState } from '../src/contracts'

const ROOT = resolve(import.meta.dir, '../../..')
const MODULES = join(ROOT, 'plugins/quirky.reviews/node_modules')
const WORKTREE = '/fixture/hosting-worktree'
const DEFAULTS = { draft: false, useTemplate: false, generateDetailsOnOpen: false, openAfterCreate: false }
const PROVIDERS = ['github', 'gitlab'] as const
const THEMES = ['dark', 'light'] as const
const VIEWPORTS = [
  { width: 1000, height: 900 },
  { width: 320, height: 600 },
] as const
const UI_CONTROL = 'command:quirky.reviews/ui-control'
const CSS_IMPORT = /@import\s+(?:url\(\s*)?(?:"([^"]+)"|'([^']+)'|([^\s);]+))\s*\)?([^;]*);/g

const BROWSER_IMPORTS: Record<string, string> = {
  react: join(MODULES, 'react/index.js'),
  'react/jsx-runtime': join(MODULES, 'react/jsx-runtime.js'),
  'react/jsx-dev-runtime': join(MODULES, 'react/jsx-dev-runtime.js'),
  'react-dom': join(MODULES, 'react-dom/index.js'),
  'react-dom/client': join(MODULES, 'react-dom/client.js'),
  '@quirky/ui': join(ROOT, 'packages/ui/src/design-system/index.ts'),
  '@quirky/protocol': join(ROOT, 'packages/protocol/src/index.ts'),
}
const browserDependencyResolver: Bun.BunPlugin = {
  name: 'reviews-hosting-browser-dependencies',
  setup(builder) {
    builder.onResolve(
      { filter: /^(?:react|react\/jsx-runtime|react\/jsx-dev-runtime|react-dom|react-dom\/client|@quirky\/ui|@quirky\/protocol)$/ },
      ({ path }) => ({ path: BROWSER_IMPORTS[path] }),
    )
    builder.onResolve({ filter: /^\.{1,2}\// }, ({ path, importer }) => {
      if (!importer || /\.[^/]+$/.test(path)) return
      const base = resolve(dirname(importer), path)
      for (const extension of ['.tsx', '.ts', '.jsx', '.js', '.json']) {
        const candidate = `${base}${extension}`
        if (existsSync(candidate)) return { path: candidate }
      }
      return
    })
  },
}

type Provider = (typeof PROVIDERS)[number]
type BrowserCall = { method: string; params: Record<string, unknown> }
type BrowserControl = {
  surface: string
  slot: string
  target: string
  generation: number
  actions: Array<{ action: string; enabled: boolean }>
}
type HostingFixture = {
  calls: BrowserCall[]
  readonly refreshes: number
  clearCalls(): void
  setNextRefresh(mode: 'success' | 'pending' | 'reject'): void
  resolvePendingRefresh(): void
  rejectPendingRefresh(): void
  hostingControl(): BrowserControl | null
  unmount(): void
}

declare global {
  interface Window {
    mountHostingFixture(provider: Provider, state: ReviewsState): void
    __hostingFixture: HostingFixture
  }
}

let browser: Browser | null = null
let browserBundle = ''
let productionCss = ''

function diagnosticsFor(provider: Provider, host: string) {
  if (provider === 'github') {
    return {
      provider: 'github',
      ghAvailable: true,
      activeAccount: null,
      accounts: [],
      envTokenInProcess: false,
      missingScopes: [],
      requiredScopes: ['repo'],
      hasKeyringFallback: false,
      requiredHost: host,
      requiredHostAuthenticated: true,
    }
  }
  return {
    provider: 'gitlab',
    tokenSource: 'env',
    glabAvailable: true,
    tokenRejected: false,
    activeAccount: { host, user: 'fixture-user' },
    accounts: [{ host, user: 'fixture-user', source: 'env', active: true, scopes: ['api'] }],
    envTokenInProcess: true,
    missingScopes: [],
    requiredScopes: ['api'],
    hasKeyringFallback: false,
    requiredHost: host,
    requiredHostAuthenticated: true,
  }
}

function stateFor(provider: Provider): ReviewsState {
  const now = 1_800_000_000_000
  const repository = provider === 'github'
    ? { host: 'github.example.test', owner: 'fixture-group', repo: 'fixture-project' }
    : { host: 'gitlab.example.test', owner: 'fixture-group', repo: 'fixture-project' }
  const settings = {
    worktree: WORKTREE,
    generation: 1,
    loading: false,
    error: null,
    provider,
    repository,
    diagnostics: diagnosticsFor(provider, repository.host),
    accounts: { requiredHost: repository.host, accounts: [] },
    configuration: { account: null },
    budget: {
      core: { limit: 5000, remaining: 4000, resetAt: now + 3_600_000 },
      search: { limit: 30, remaining: 20, resetAt: now + 3_600_000 },
      graphql: { limit: 5000, remaining: 3000, resetAt: now + 3_600_000 },
      fetchedAt: now,
    },
    fetchedAt: now,
  }
  return {
    revision: 1,
    previousView: null,
    detail: {
      target: null,
      tab: 'conversation',
      generation: 1,
      loading: false,
      error: null,
      review: null,
      details: null,
      checks: null,
      comments: null,
      files: null,
      audience: 'all',
      grouping: 'grouped',
      expandedChecks: [],
      queuedComments: [],
      checksCollapsed: false,
      selectedFile: null,
      diffMode: 'inline',
      collapsedFiles: [],
      fileFilter: '',
      fileTreeVisible: true,
      commentDraft: '',
      bodyDraft: null,
      pending: [],
      fetchedAt: now,
    },
    checks: {
      worktree: WORKTREE,
      generation: 1,
      loading: false,
      error: null,
      lookup: null,
      eligibility: null,
      review: null,
      checks: null,
      comments: null,
      conflicts: null,
      audience: 'all',
      grouping: 'grouped',
      expandedChecks: [],
      queuedComments: [],
      checksCollapsed: false,
      commentDraft: '',
      titleDraft: null,
      height: 320,
      fetchedAt: now,
      agentDialog: null,
    },
    creation: {
      worktree: WORKTREE,
      generation: 1,
      loading: false,
      error: null,
      eligibility: { eligible: true, confirmedAt: now, stackSupported: false },
      title: 'Fixture title',
      body: 'Fixture body',
      base: 'main',
      head: 'fixture-branch',
      draft: false,
      useTemplate: false,
      bases: ['main'],
      generating: false,
      requestId: null,
      submitting: false,
      generated: false,
      result: null,
      defaults: DEFAULTS,
    },
    settings,
    defaults: DEFAULTS,
    repoDefaults: {},
    botOverrides: [],
    links: {},
    suppressed: {},
  }
}

function browserEntry(): string {
  const hostingSettings = join(ROOT, 'plugins/quirky.reviews/src/create/HostingSettings.tsx')
  const controlModule = join(ROOT, 'plugins/quirky.reviews/src/checks/data.ts')
  return `
    import { createElement as h } from 'react'
    import { createRoot } from 'react-dom/client'
    import { HostingSettings } from ${JSON.stringify(hostingSettings)}
    import { listReviewsUiControls, REVIEWS_UI_CONTROL, runReviewsUiControl } from ${JSON.stringify(controlModule)}

    const WORKTREE = ${JSON.stringify(WORKTREE)}
    const SETTINGS_VIEW = 'view:quirky.reviews/settings'
    const clone = (value) => JSON.parse(JSON.stringify(value))

    window.mountHostingFixture = (provider, state) => {
      const calls = []
      const provided = new Map()
      let refreshCount = 0
      let nextRefresh = 'success'
      let resolvePending = null
      let rejectPending = null
      const context = {
        pluginId: 'quirky.reviews',
        provide(id, implementation) { provided.set(id, implementation) },
        async call(method, params = {}) {
          calls.push({ method, params: clone(params) })
          if (method === 'quirky.worktree/list') {
            return [{ kind: 'git', id: WORKTREE, name: 'Fixture worktree', path: WORKTREE, branch: 'fixture-branch' }]
          }
          if (method === 'quirky.reviews/creationDefaults') {
            return params.scope === 'repository'
              ? { defaults: state.defaults, repoId: 'fixture-group/fixture-project', overrides: {} }
              : { defaults: state.defaults }
          }
          if (method === 'quirky.reviews/hostingSettingsRefresh') {
            const mode = nextRefresh
            nextRefresh = 'success'
            if (mode === 'pending') {
              return await new Promise((resolve, reject) => {
                resolvePending = resolve
                rejectPending = reject
              })
            }
            if (mode === 'reject') throw new Error('fixture provider failed')
            return { worktree: params.worktree, refreshed: true, stale: false, fetchedAt: 1 }
          }
          if (method === 'ui.window.self') return { connId: 73 }
          if (method === 'ui.window.command.run') {
            if (params.connId !== 73 || params.id !== REVIEWS_UI_CONTROL) throw new Error('Unexpected exact-window control route.')
            const handler = provided.get(REVIEWS_UI_CONTROL)
            if (typeof handler !== 'function') throw new Error('The production Reviews UI-control handler was not registered.')
            return { result: await handler(params.args) }
          }
          throw new Error('Unexpected local HostingSettings call: ' + method)
        },
        getLayout() {
          return { worktree: WORKTREE, view: { id: 'view:fixture' }, panel: null, sidebar: false, focus: 'view' }
        },
        onLayout() { return () => {} },
        onConnection() { return () => {} },
        subscribe() { return () => {} },
        getSetting() { return undefined },
        toast() {},
        log() {},
        async executeCommand() {},
      }
      context.provide(REVIEWS_UI_CONTROL, (input) => runReviewsUiControl(context, input))
      const root = createRoot(document.getElementById('root'))
      root.render(h(HostingSettings, {
        context,
        state,
        snapshot: 0,
        async refresh() { refreshCount += 1 },
      }))
      window.__hostingFixture = {
        calls,
        get refreshes() { return refreshCount },
        clearCalls() { calls.splice(0, calls.length) },
        setNextRefresh(mode) { nextRefresh = mode },
        resolvePendingRefresh() {
          if (!resolvePending) throw new Error('No pending provider refresh is waiting.')
          const resolve = resolvePending
          resolvePending = null
          rejectPending = null
          resolve({ worktree: WORKTREE, refreshed: true, stale: false, fetchedAt: 2 })
        },
        rejectPendingRefresh() {
          if (!rejectPending) throw new Error('No pending provider refresh is waiting.')
          const reject = rejectPending
          resolvePending = null
          rejectPending = null
          reject(new Error('fixture provider failed'))
        },
        hostingControl() {
          return listReviewsUiControls(context, SETTINGS_VIEW).find((control) => control.slot === 'settings-hosting') ?? null
        },
        unmount() { root.unmount() },
      }
    }
  `
}

function inlineStylesheet(path: string, active = new Set<string>()): string {
  const absolute = resolve(path)
  if (active.has(absolute)) throw new Error(`Cyclic stylesheet import: ${absolute}`)
  active.add(absolute)
  const source = readFileSync(absolute, 'utf8')
  const expanded = source.replace(CSS_IMPORT, (statement, doubleQuoted: string | undefined, singleQuoted: string | undefined, bare: string | undefined, suffix: string) => {
    const importedPath = doubleQuoted ?? singleQuoted ?? bare
    if (!importedPath || /^(?:[a-z]+:|\/\/)/i.test(importedPath)) return statement
    const imported = inlineStylesheet(resolve(dirname(absolute), importedPath), active)
    const media = suffix.trim()
    return media ? `@media ${media} {\n${imported}\n}` : imported
  })
  active.delete(absolute)
  return expanded
}

async function buildBrowserBundle(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'reviews-hosting-layout-'))
  try {
    const entrypoint = join(directory, 'browser-entry.tsx')
    await writeFile(entrypoint, browserEntry())
    const result = await Bun.build({
      entrypoints: [entrypoint],
      target: 'browser',
      format: 'iife',
      plugins: [browserDependencyResolver],
      define: { 'process.env.NODE_ENV': '"production"' },
    })
    if (!result.success) throw new Error(result.logs.map((log) => log.message).join('\n'))
    const output = result.outputs[0]
    if (!output) throw new Error('The HostingSettings browser bundle was empty.')
    return await output.text()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function loadFixture(provider: Provider, theme: (typeof THEMES)[number], viewport: (typeof VIEWPORTS)[number]): Promise<Page> {
  if (!browser) throw new Error('The HostingSettings browser has not launched.')
  const page = await browser.newPage({ viewport })
  await page.setContent(`<!doctype html><html data-theme="${theme}"><head><meta charset="utf-8"><style>${productionCss}</style></head><body><div id="root"></div></body></html>`)
  await page.addScriptTag({ content: browserBundle })
  await page.evaluate(({ provider: nextProvider, state }) => window.mountHostingFixture(nextProvider, state), {
    provider,
    state: stateFor(provider),
  })
  await waitForReady(page, provider)
  return page
}

async function waitForReady(page: Page, provider: Provider): Promise<void> {
  const buttonLabel = provider === 'github' ? 'Re-check GitHub' : 'Re-check GitLab'
  await page.getByRole('button', { name: buttonLabel, exact: true }).waitFor({ state: 'visible' })
  await page.waitForFunction(({ buttonLabel, worktree }) => {
    const fixture = window.__hostingFixture
    const button = [...document.querySelectorAll('button')].find((node) => node.textContent?.trim() === buttonLabel)
    const workspace = document.querySelector('section[aria-label="Workspace"]')
    const providers = document.querySelector('section[aria-label="Review providers"]')
    const defaults = document.querySelector('section[aria-label="Hosted-review creation defaults"]')
    return fixture !== undefined
      && fixture.hostingControl() !== null
      && fixture.calls.some((call) => call.method === 'quirky.worktree/list')
      && fixture.calls.some((call) => call.method === 'quirky.reviews/creationDefaults' && call.params.scope === 'global')
      && fixture.calls.some((call) => call.method === 'quirky.reviews/creationDefaults' && call.params.scope === 'repository')
      && fixture.calls.some((call) => call.method === 'quirky.reviews/hostingSettingsRefresh')
      && fixture.refreshes >= 1
      && document.querySelector<HTMLSelectElement>('#settings-worktree')?.value === worktree
      && workspace?.getAttribute('aria-busy') === 'false'
      && providers?.getAttribute('aria-busy') === 'false'
      && defaults?.getAttribute('aria-busy') === 'false'
      && button !== undefined
      && button.disabled === false
  }, { buttonLabel, worktree: WORKTREE })
}

async function disposeFixture(page: Page): Promise<void> {
  await page.evaluate(() => window.__hostingFixture?.unmount())
  await page.close()
}

async function controlCalls(page: Page): Promise<BrowserCall[]> {
  return page.evaluate(() => window.__hostingFixture.calls.map((call) => ({ method: call.method, params: call.params })))
}

async function expectRecheckDelivery(page: Page, provider: Provider, pending = false): Promise<void> {
  const control = await page.evaluate(() => window.__hostingFixture.hostingControl())
  expect(control).not.toBeNull()
  if (!control) throw new Error('The mounted HostingSettings control was not registered.')
  const buttonLabel = pending ? 'Re-checking…' : provider === 'github' ? 'Re-check GitHub' : 'Re-check GitLab'
  const calls = await controlCalls(page)
  expect(calls).toEqual([
    { method: 'ui.window.self', params: {} },
    {
      method: 'ui.window.command.run',
      params: {
        connId: 73,
        id: UI_CONTROL,
        args: { target: control.target, generation: control.generation, action: 'provider-recheck' },
      },
    },
    { method: 'quirky.reviews/hostingSettingsRefresh', params: { worktree: WORKTREE, forceBudget: true } },
  ])
  expect(calls.filter((call) => call.method === 'ui.window.command.run')).toHaveLength(1)
  expect(calls.filter((call) => call.method === 'quirky.reviews/hostingSettingsRefresh')).toHaveLength(1)
  expect(await page.getByRole('button', { name: buttonLabel, exact: true }).count()).toBe(1)
}


beforeAll(async () => {
  browserBundle = await buildBrowserBundle()
  productionCss = [
    inlineStylesheet(join(ROOT, 'packages/ui/src/styles.css')),
    inlineStylesheet(join(ROOT, 'packages/ui/src/shell/chrome.css')),
  ].join('\n')
  browser = await chromium.launch({
    executablePath: browserExecutable(),
    headless: true,
    args: process.platform === 'linux' ? ['--no-sandbox'] : [],
  })
}, 60_000)

afterAll(async () => {
  await browser?.close()
}, 60_000)

for (const provider of PROVIDERS) {
  for (const theme of THEMES) {
    for (const viewport of VIEWPORTS) {
      test(`${provider} provider action layout in ${theme} at ${viewport.width}×${viewport.height}`, async () => {
        const page = await loadFixture(provider, theme, viewport)
        try {
          const label = provider === 'github' ? 'Re-check GitHub' : 'Re-check GitLab'
          const geometry = await page.getByRole('button', { name: label, exact: true }).evaluate((element) => {
            const row = element.parentElement
            const card = element.closest('article')
            if (!row || !card) throw new Error('The provider action is missing its row or provider card.')
            const buttonRect = element.getBoundingClientRect()
            const rowRect = row.getBoundingClientRect()
            const cardRect = card.getBoundingClientRect()
            return {
              tagName: element.tagName,
              rowClass: row.className,
              buttonWidth: buttonRect.width,
              buttonLeft: buttonRect.left,
              buttonRight: buttonRect.right,
              rowWidth: rowRect.width,
              rowLeft: rowRect.left,
              rowRight: rowRect.right,
              cardWidth: cardRect.width,
            }
          })
          expect(geometry.tagName).toBe('BUTTON')
          expect(geometry.buttonWidth).toBeGreaterThan(0)
          expect(geometry.buttonWidth).toBeLessThan(geometry.rowWidth)
          expect(geometry.rowClass.split(/\s+/)).toContain('ui-cluster')
          expect(Math.abs(geometry.rowWidth - geometry.cardWidth)).toBeLessThanOrEqual(1)
          expect(geometry.buttonLeft).toBeGreaterThanOrEqual(geometry.rowLeft - 1)
          expect(geometry.buttonRight).toBeLessThanOrEqual(geometry.rowRight + 1)

          const padding = await page.locator('#settings-worktree').evaluate((element) => {
            const style = getComputedStyle(element)
            return [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft]
          })
          expect(padding).toEqual(['6px', '8px', '6px', '8px'])

          if (provider === 'gitlab') {
            expect(await page.locator('section[aria-label="GitLab account binding"] .ui-notice-line').allTextContents())
              .toContain('Account binding is unavailable for GitLab.')
            expect(await page.locator('section[aria-label="GitLab API budget"] .ui-notice-line').allTextContents())
              .toContain('API budget is unavailable for GitLab.')
          }
        } finally {
          await disposeFixture(page)
        }
      }, 60_000)
    }
  }
}

for (const provider of PROVIDERS) {
  test(`${provider} provider re-check uses the registered target/generation and preserves success, pending, and rejection delivery`, async () => {
    const page = await loadFixture(provider, 'dark', VIEWPORTS[0])
    const label = provider === 'github' ? 'Re-check GitHub' : 'Re-check GitLab'
    const button = page.getByRole('button', { name: label, exact: true })
    try {
      const run = async (mode: 'success' | 'pending' | 'reject') => {
        const beforeRefreshes = await page.evaluate(() => window.__hostingFixture.refreshes)
        await page.evaluate((nextMode) => {
          window.__hostingFixture.clearCalls()
          window.__hostingFixture.setNextRefresh(nextMode)
        }, mode)
        await button.click()
        if (mode === 'pending') {
          await page.waitForFunction(() => {
            const control = [...document.querySelectorAll('button')].find((node) => node.textContent?.trim() === 'Re-checking…')
            return control !== undefined && control.disabled && control.textContent?.trim() === 'Re-checking…'
          })
          await expectRecheckDelivery(page, provider, true)
          await page.getByRole('button', { name: 'Re-checking…', exact: true }).evaluate((element) => (element as HTMLButtonElement).click())
          expect(await controlCalls(page)).toHaveLength(3)
          expect(await page.evaluate(() => window.__hostingFixture.refreshes)).toBe(beforeRefreshes)
          await page.evaluate(() => window.__hostingFixture.resolvePendingRefresh())
        }

        if (mode === 'reject') {
          await page.getByText('fixture provider failed', { exact: true }).waitFor({ state: 'visible' })
        }
        await page.waitForFunction(({ buttonLabel, expectedRefreshes, rejected }) => {
          const button = [...document.querySelectorAll('button')].find((node) => node.textContent?.trim() === buttonLabel)
          const hasError = [...document.querySelectorAll('.ui-inline-error')]
            .some((node) => node.textContent?.includes('fixture provider failed'))
          return button !== undefined
            && !button.disabled
            && button.textContent?.trim() === buttonLabel
            && window.__hostingFixture.refreshes === expectedRefreshes
            && (rejected ? hasError : !hasError)
        }, { buttonLabel: label, expectedRefreshes: beforeRefreshes + 1, rejected: mode === 'reject' })
        await expectRecheckDelivery(page, provider)
      }

      await run('success')
      await run('pending')
      await run('reject')
    } finally {
      await disposeFixture(page)
    }
  }, 60_000)
}

