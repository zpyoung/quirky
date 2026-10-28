import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { RpcErrorCode, type UiLayout, type UiPluginContext } from '@quirky/protocol'
import { activate } from '../src/ui'
import { detailGhSource } from './detail-fixture'
import { bootReviews } from './support'
import type { HostingTest } from '../../quirky.hosting/test/helpers'

type UiCommand = (input?: unknown) => unknown

type BrowserPane = {
  id: string
  worktreeId: string
  mode: string
  page: string | null
  url: string
  tabId?: string
}

type ExternalOpen = { target: string; reveal: boolean }
type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown }

const initialLayout: UiLayout = { view: null, panel: null, sidebar: true, focus: null }

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function settle<T>(operation: Promise<T>): Promise<Settled<T>> {
  try { return { ok: true, value: await operation } } catch (error) { return { ok: false, error } }
}

async function registerReviewWindow(host: HostingTest) {
  const window = await host.connect('ui')
  const commands = new Map<string, UiCommand>()
  const initial = await window.call('ui.state', {}) as { layout?: UiLayout }
  let layout = initial.layout ?? initialLayout

  const context = {
    provide(id: string, value: unknown) {
      if (typeof value === 'function') commands.set(id, value as UiCommand)
    },
    getLayout: () => layout,
    call(method: string, params: Record<string, unknown> = {}) {
      return window.callAny(method, params)
    }
  }

  activate(context as unknown as UiPluginContext)
  window.onEvent((event) => {
    if (event.type === 'ui.state.changed') layout = event.layout
    if (event.type !== 'ui.command.request') return
    const handler = commands.get(event.id)
    void (async () => {
      try {
        if (!handler) throw new Error(`No registered UI command for ${event.id}.`)
        const result = await handler(event.args)
        await window.call('ui.command.reply', { requestId: event.requestId, result })
      } catch (error) {
        await window.call('ui.command.reply', { requestId: event.requestId, error: { message: errorMessage(error) } })
      }
    })().catch(() => {})
  })
  await window.call('events.subscribe', {})

  return {
    async setBrowserSetting(name: 'openLinksInApp' | 'openLinksInAppModifierInverts', value: boolean) {
      await host.client.call('setting.set', { id: `setting:quirky.browser/${name}`, value })
    }
  }
}

function externalOpens(path: string): ExternalOpen[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as ExternalOpen)
}

test('review links use Browser routing, exact worktree context, and safe error boundaries', async () => {
  const externalRoot = mkdtempSync(join(tmpdir(), 'quirky-review-link-routing-'))
  const externalLog = join(externalRoot, 'external.jsonl')
  const priorOpenLog = process.env.QUIRKY_TEST_OPEN_LOG
  process.env.QUIRKY_TEST_OPEN_LOG = externalLog
  let host: HostingTest | undefined

  try {
    const reviews = await bootReviews(detailGhSource, { extraBuiltins: ['quirky.browser', 'quirky.editor'] })
    host = reviews
    await reviews.client.callAny('quirky.browser/preferencesState', {})
    const checksProjectPath = join(externalRoot, 'checks-worktree')
    mkdirSync(checksProjectPath)
    const checksProject = await reviews.client.callAny('quirky.repo/add', { path: checksProjectPath, folder: true }) as { id: string }
    const checksWorkspace = await reviews.client.callAny('quirky.worktree/create', { repo: checksProject.id, name: 'checks-target' }) as { worktree: { id: string } }
    const checksWorktree = checksWorkspace.worktree.id
    expect(checksWorktree).not.toBe(reviews.worktree)
    const window = await registerReviewWindow(reviews)
    const openReviewLink = (url: string, worktree?: string, invert = false) => reviews.client.callAny('quirky.reviews/openLink', {
      url,
      ...(worktree === undefined ? {} : { worktree }),
      ...(invert ? { invert: true } : {})
    })

    const appUrl = 'https://github.com/acme/quirky/pull/7'
    await window.setBrowserSetting('openLinksInApp', true)
    await window.setBrowserSetting('openLinksInAppModifierInverts', false)
    const appResult = await settle(openReviewLink(appUrl, reviews.worktree))
    expect(appResult.ok).toBe(true)

    const appState = await reviews.client.callAny('quirky.browser/paneState', {}) as { tabs: BrowserPane[] }
    const appPane = appState.tabs.find((pane) => pane.url === appUrl)
    expect(appPane).toMatchObject({ worktreeId: reviews.worktree, mode: 'native', page: null, url: appUrl })
    expect(appPane?.tabId).toEqual(expect.any(String))
    const appLayout = await reviews.client.call('ui.state', {})
    expect(appLayout).toMatchObject({
      layout: { view: { id: 'view:quirky.session/worktree', input: { worktree: `id:${reviews.worktree}` } } }
    })

    const externalUrl = 'https://github.com/acme/quirky/pull/8'
    const externalWithDefaultModifierPolicy = await settle(openReviewLink(externalUrl, reviews.worktree, true))
    expect(externalWithDefaultModifierPolicy.ok).toBe(true)
    expect(externalOpens(externalLog)).toContainEqual({ target: externalUrl, reveal: false })

    await window.setBrowserSetting('openLinksInApp', false)
    await window.setBrowserSetting('openLinksInAppModifierInverts', true)
    const invertedAppUrl = 'https://github.com/acme/quirky/pull/9'
    const invertedApp = await settle(openReviewLink(invertedAppUrl, reviews.worktree, true))
    expect(invertedApp.ok).toBe(true)
    const afterInvertedApp = await reviews.client.callAny('quirky.browser/paneState', {}) as { tabs: BrowserPane[] }
    expect(afterInvertedApp.tabs.find((pane) => pane.url === invertedAppUrl)).toMatchObject({ worktreeId: reviews.worktree, mode: 'native', page: null, url: invertedAppUrl })

    const configuredExternalUrl = 'https://github.com/acme/quirky/pull/10'
    const configuredExternal = await settle(openReviewLink(configuredExternalUrl, reviews.worktree))
    expect(configuredExternal.ok).toBe(true)
    expect(externalOpens(externalLog)).toContainEqual({ target: configuredExternalUrl, reveal: false })

    const beforeUnsafeState = await reviews.client.callAny('quirky.browser/paneState', {}) as { tabs: BrowserPane[] }
    const beforeUnsafeUrls = beforeUnsafeState.tabs.map((pane) => pane.url)
    const beforeUnsafeOpens = externalOpens(externalLog)
    const unsafe = await Promise.all([
      settle(openReviewLink('javascript:alert(1)', reviews.worktree)),
      settle(openReviewLink('https://user:secret@example.test/review', reviews.worktree)),
      settle(openReviewLink(`https://example.test/${'x'.repeat(8192)}`, reviews.worktree))
    ])
    expect(unsafe.every((result) => !result.ok)).toBe(true)
    expect(externalOpens(externalLog)).toEqual(beforeUnsafeOpens)
    const afterUnsafeState = await reviews.client.callAny('quirky.browser/paneState', {}) as { tabs: BrowserPane[] }
    expect(afterUnsafeState.tabs.map((pane) => pane.url)).toEqual(beforeUnsafeUrls)

    await window.setBrowserSetting('openLinksInApp', true)
    await window.setBrowserSetting('openLinksInAppModifierInverts', false)
    const openedDetail = await reviews.client.callAny('quirky.reviews/open', { worktree: reviews.worktree, number: 12 })
    expect(openedDetail).toMatchObject({ worktree: reviews.worktree, number: 12 })
    const inferredDetailUrl = 'https://github.com/acme/quirky/pull/12'
    const inferredDetail = await settle(openReviewLink(inferredDetailUrl))
    expect(inferredDetail.ok).toBe(true)
    const inferredDetailState = await reviews.client.callAny('quirky.browser/paneState', {}) as { tabs: BrowserPane[] }
    expect(inferredDetailState.tabs.find((pane) => pane.url === inferredDetailUrl)).toMatchObject({
      worktreeId: reviews.worktree, mode: 'native', page: null, url: inferredDetailUrl
    })

    await reviews.client.callAny('quirky.reviews/open', { worktree: reviews.worktree, number: 12 })
    const checksRefresh = await reviews.client.callAny('quirky.reviews/checksRefresh', { worktree: checksWorktree })
    expect(checksRefresh).toMatchObject({ ok: true, worktree: checksWorktree, kind: 'folder' })
    await reviews.client.callAny('quirky.reviews/showChecks', {})
    const activeReviews = await reviews.client.callAny('quirky.reviews/state', {}) as {
      detail: { target: { worktree: string } | null }
      checks: { worktree: string | null }
    }
    expect(activeReviews.detail.target?.worktree).toBe(reviews.worktree)
    expect(activeReviews.checks.worktree).toBe(checksWorktree)
    const beforeAmbiguousLayout = await reviews.client.call('ui.state', {}) as { layout: { view: unknown; panel: string | null } }
    expect(beforeAmbiguousLayout).toMatchObject({
      layout: { view: { id: 'view:quirky.reviews/review' }, panel: 'panel:quirky.reviews/checks' }
    })
    const beforeAmbiguousState = await reviews.client.callAny('quirky.browser/paneState', {}) as { tabs: BrowserPane[] }
    const beforeAmbiguousUrls = beforeAmbiguousState.tabs.map((pane) => pane.url)
    const beforeAmbiguousOpens = externalOpens(externalLog)
    const ambiguousUrl = 'https://github.com/acme/quirky/pull/13'
    const ambiguous = await settle(openReviewLink(ambiguousUrl))
    expect(ambiguous.ok).toBe(false)
    expect(ambiguous.ok ? null : ambiguous.error).toMatchObject({ code: RpcErrorCode.InvalidParams })
    const afterAmbiguousState = await reviews.client.callAny('quirky.browser/paneState', {}) as { tabs: BrowserPane[] }
    expect(afterAmbiguousState.tabs.map((pane) => pane.url)).toEqual(beforeAmbiguousUrls)
    expect(externalOpens(externalLog)).toEqual(beforeAmbiguousOpens)
    const afterAmbiguousLayout = await reviews.client.call('ui.state', {})
    expect(afterAmbiguousLayout).toMatchObject({
      layout: { view: beforeAmbiguousLayout.layout.view, panel: beforeAmbiguousLayout.layout.panel }
    })

    const explicitChecksUrl = 'https://github.com/acme/quirky/pull/14'
    const explicitChecks = await settle(openReviewLink(explicitChecksUrl, checksWorktree))
    expect(explicitChecks.ok).toBe(true)
    const explicitChecksState = await reviews.client.callAny('quirky.browser/paneState', {}) as { tabs: BrowserPane[] }
    const explicitChecksPane = explicitChecksState.tabs.find((pane) => pane.url === explicitChecksUrl)
    expect(explicitChecksPane).toMatchObject({
      worktreeId: checksWorktree, mode: 'native', page: null, url: explicitChecksUrl
    })
    expect(explicitChecksPane?.tabId).toEqual(expect.any(String))
    const explicitChecksLayout = await reviews.client.call('ui.state', {})
    expect(explicitChecksLayout).toMatchObject({
      layout: { view: { id: 'view:quirky.session/worktree', input: { worktree: `id:${checksWorktree}` } } }
    })

    const beforeFailureState = await reviews.client.callAny('quirky.browser/paneState', {}) as { tabs: BrowserPane[] }
    const beforeFailureUrls = beforeFailureState.tabs.map((pane) => pane.url)
    const beforeFailureLayout = await reviews.client.call('ui.state', {}) as { layout: { view: unknown; panel: string | null } }
    const beforeFailureOpens = externalOpens(externalLog)
    const missingWorktreeUrl = 'https://github.com/acme/quirky/pull/11'
    const browserFailure = await settle(openReviewLink(missingWorktreeUrl, 'id:missing-review-worktree'))
    expect(browserFailure.ok).toBe(false)
    expect(browserFailure.ok ? null : browserFailure.error).toMatchObject({ code: RpcErrorCode.Conflict })
    const afterFailureState = await reviews.client.callAny('quirky.browser/paneState', {}) as { tabs: BrowserPane[] }
    expect(afterFailureState.tabs.map((pane) => pane.url)).toEqual(beforeFailureUrls)
    expect(externalOpens(externalLog)).toEqual(beforeFailureOpens)
    const afterFailureLayout = await reviews.client.call('ui.state', {})
    expect(afterFailureLayout).toMatchObject({
      layout: { view: beforeFailureLayout.layout.view, panel: beforeFailureLayout.layout.panel }
    })
  } finally {
    try {
      if (host) await host.cleanup()
    } finally {
      if (priorOpenLog === undefined) delete process.env.QUIRKY_TEST_OPEN_LOG
      else process.env.QUIRKY_TEST_OPEN_LOG = priorOpenLog
      rmSync(externalRoot, { recursive: true, force: true })
    }
  }
}, 30_000)
