import type { PluginCaller, PluginContext, UiLayout, Worktree } from '@quirky/protocol'
import { CHECKS_PANEL, CREATE_VIEW, REVIEW_VIEW, SETTINGS_VIEW, type CreationDefaults, type JsonRecord, type ReviewsEnv, type ReviewsState } from './contracts'

export function record(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

const defaults = (): CreationDefaults => ({ draft: false, useTemplate: false, generateDetailsOnOpen: false, openAfterCreate: false })
const ownViews = new Set([REVIEW_VIEW, CREATE_VIEW, SETTINGS_VIEW])

function initialState(): ReviewsState {
  return {
    revision: 0, previousView: null,
    detail: { target: null, tab: 'conversation', generation: 0, loading: false, error: null, review: null, details: null, checks: null, comments: null, files: null, audience: 'all', grouping: 'grouped', expandedChecks: [], checksCollapsed: false, queuedComments: [], selectedFile: null, diffMode: 'inline', collapsedFiles: [], fileFilter: '', fileTreeVisible: true, commentDraft: '', bodyDraft: null, pending: [], fetchedAt: 0 },
    checks: { worktree: null, generation: 0, loading: false, error: null, lookup: null, eligibility: null, review: null, checks: null, comments: null, conflicts: null, audience: 'all', grouping: 'grouped', expandedChecks: [], checksCollapsed: false, queuedComments: [], commentDraft: '', titleDraft: null, height: 360, fetchedAt: 0, agentDialog: null },
    creation: { worktree: null, generation: 0, loading: false, error: null, eligibility: null, title: '', body: '', base: '', head: '', draft: false, useTemplate: false, bases: [], generating: false, requestId: null, submitting: false, generated: false, result: null, defaults: defaults() },
    settings: { worktree: null, generation: 0, loading: false, error: null, diagnostics: null, accounts: null, configuration: null, budget: null, fetchedAt: 0 },
    defaults: defaults(), repoDefaults: {}, botOverrides: [], links: {}, suppressed: {}
  }
}

function readDefaults(value: unknown, fallback: CreationDefaults): CreationDefaults {
  if (!record(value)) return fallback
  return {
    draft: typeof value.draft === 'boolean' ? value.draft : fallback.draft,
    useTemplate: typeof value.useTemplate === 'boolean' ? value.useTemplate : fallback.useTemplate,
    generateDetailsOnOpen: typeof value.generateDetailsOnOpen === 'boolean' ? value.generateDetailsOnOpen : fallback.generateDetailsOnOpen,
    openAfterCreate: typeof value.openAfterCreate === 'boolean' ? value.openAfterCreate : fallback.openAfterCreate
  }
}

function restoreDurable(state: ReviewsState, value: unknown): void {
  if (!record(value)) throw new Error('Invalid persisted review preferences')
  state.defaults = readDefaults(value.defaults, defaults())
  if (record(value.repoDefaults)) for (const [id, config] of Object.entries(value.repoDefaults)) {
    if (!record(config)) continue
    const partial: Partial<CreationDefaults> = {}
    for (const key of ['draft', 'useTemplate', 'generateDetailsOnOpen', 'openAfterCreate'] as const) if (typeof config[key] === 'boolean') partial[key] = config[key]
    state.repoDefaults[id] = partial
  }
  if (Array.isArray(value.botOverrides)) state.botOverrides = value.botOverrides.filter((login): login is string => typeof login === 'string' && login.length > 0 && login.length <= 256).slice(0, 500)
  for (const key of ['links', 'suppressed'] as const) {
    if (!record(value[key])) continue
    for (const [id, link] of Object.entries(value[key])) {
      if (!record(link) || typeof link.number !== 'number' || !Number.isSafeInteger(link.number) || link.number < 1 || typeof link.url !== 'string') continue
      try { if (!['https:', 'http:'].includes(new URL(link.url).protocol)) continue } catch { continue }
      state[key][id] = { number: link.number, url: link.url }
    }
  }
}

function worktree(value: unknown): value is Worktree {
  return record(value) && typeof value.id === 'string' && typeof value.repoId === 'string' && typeof value.path === 'string' && (value.kind === 'git' || value.kind === 'folder')
}

function previousView(value: unknown): UiLayout['view'] {
  if (!record(value) || !record(value.layout)) return null
  const view = value.layout.view
  if (!record(view) || typeof view.id !== 'string' || ownViews.has(view.id)) return null
  return { id: view.id, ...(view.input !== undefined ? { input: view.input } : {}) }
}

export type ActiveReviewsEnv = ReviewsEnv & { dispose(): Promise<void> }

export function createReviewsEnv(context: PluginContext): ActiveReviewsEnv {
  const store = context.openStore(['CREATE TABLE IF NOT EXISTS review_preferences (id INTEGER PRIMARY KEY CHECK(id = 1), value TEXT NOT NULL)'])
  const state = initialState()
  const stored = store.get<{ value: string }>('SELECT value FROM review_preferences WHERE id = 1')
  if (stored) {
    try { restoreDurable(state, JSON.parse(stored.value)) } catch (error) {
      throw context.error('conflict', `Cannot load review preferences: ${error instanceof Error ? error.message : 'invalid data'}`)
    }
  }
  const disposers: (() => void | Promise<void>)[] = []
  let disposed = false
  let saved = JSON.stringify({ defaults: state.defaults, repoDefaults: state.repoDefaults, botOverrides: state.botOverrides, links: state.links, suppressed: state.suppressed })
  const env: ActiveReviewsEnv = {
    context,
    read: () => state,
    update(change) {
      if (disposed) throw context.error('conflict', 'The reviews plugin is inactive.')
      change(state)
      state.revision += 1
      const durable = JSON.stringify({ defaults: state.defaults, repoDefaults: state.repoDefaults, botOverrides: state.botOverrides, links: state.links, suppressed: state.suppressed })
      if (durable !== saved) {
        store.run('INSERT INTO review_preferences(id, value) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value', durable)
        saved = durable
      }
      context.emit('changed', { revision: state.revision })
      return state
    },
    async resolve(params: JsonRecord, caller: PluginCaller) {
      const selector = params.worktree ?? 'current'
      if (typeof selector !== 'string' || selector.length === 0 || selector.length > 4096) throw env.invalid('invalid_worktree', 'Select a registered workspace.')
      const value = await context.call('quirky.worktree/resolve', { selector, ...(caller.role === 'plugin' ? {} : { ...(caller.cwd ? { cwd: caller.cwd } : {}), ...(caller.worktreeId ? { worktreeId: caller.worktreeId } : {}) }) })
      if (!worktree(value)) throw context.error('not-found', 'The registered workspace is unavailable.')
      return value
    },
    invalid(reason, message) {
      return Object.assign(context.error('invalid-params', message), { data: { reason } })
    },
    call: (method, params) => context.call(method, params),
    async openView(id, input) {
      const raw = await context.call('ui.state')
      if (!record(raw) || !record(raw.layout) || !record(raw.layout.view) || !ownViews.has(String(raw.layout.view.id))) {
        const prior = previousView(raw)
        env.update((next) => { next.previousView = prior })
      }
      await context.call('ui.view.open', { id, ...(input ? { input } : {}) })
    },
    async closeView() {
      const prior = state.previousView
      if (prior) await context.call('ui.view.open', { id: prior.id, ...(prior.input !== undefined ? { input: prior.input } : {}) })
      else await context.call('ui.view.close')
    },
    windowCommand: (id, args) => context.call('ui.command.run', { id, args }),
    onDispose(callback) { disposers.push(callback) },
    async dispose() {
      if (disposed) return
      disposed = true
      const failures: unknown[] = []
      for (const stop of disposers.splice(0).reverse()) try { await stop() } catch (error) { failures.push(error) }
      if (failures.length) throw new AggregateError(failures, 'Reviews cleanup failed')
    }
  }
  return env
}

function reviewLinkWorktree(env: ReviewsEnv, value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 4096) {
    throw env.invalid('invalid_worktree', 'Select a registered review workspace.')
  }
  return value
}

async function resolveReviewLinkWorktree(env: ReviewsEnv, explicit: unknown): Promise<string> {
  if (explicit !== undefined) return reviewLinkWorktree(env, explicit)

  const currentUi = await env.call('ui.state')
  if (!record(currentUi) || !record(currentUi.layout)) {
    throw env.invalid('missing_worktree', 'Open a Review or Checks workspace before opening its link.')
  }

  const state = env.read()
  const layout = currentUi.layout
  let detailWorktree: string | null = null
  let checksWorktree: string | null = null
  if (record(layout.view) && layout.view.id === REVIEW_VIEW) {
    detailWorktree = reviewLinkWorktree(env, state.detail.target?.worktree)
  }
  if (layout.panel === CHECKS_PANEL) {
    checksWorktree = reviewLinkWorktree(env, state.checks.worktree)
  }

  if (detailWorktree === null && checksWorktree === null) {
    throw env.invalid('missing_worktree', 'Open a Review or Checks workspace before opening its link.')
  }
  if (detailWorktree !== null && checksWorktree !== null && detailWorktree !== checksWorktree) {
    throw env.invalid('ambiguous_worktree', 'Review and Checks are open for different workspaces; choose the link source workspace.')
  }
  return detailWorktree ?? checksWorktree!
}

export const parentMethods = (env: ReviewsEnv) => ({
  state: () => env.read(),
  close: async () => { await env.closeView(); return env.read() },
  showChecks: async () => { await env.call('ui.panel.open', { id: CHECKS_PANEL }); return env.read() },
  openLink: async (params: JsonRecord) => {
    if (typeof params.url !== 'string' || params.url.length > 8192) throw env.invalid('invalid_url', 'An HTTP(S) review URL is required.')
    let parsed: URL
    try { parsed = new URL(params.url) } catch { throw env.invalid('invalid_url', 'An HTTP(S) review URL is required.') }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw env.invalid('invalid_url', 'An HTTP(S) review URL without credentials is required.')
    const worktree = await resolveReviewLinkWorktree(env, params.worktree)
    return env.windowCommand('command:quirky.reviews/open-link', { url: parsed.href, worktree, invert: params.invert === true })
  },
  copyText: async (params: JsonRecord) => {
    if (typeof params.text !== 'string' || params.text.length > 1_048_576) throw env.invalid('invalid_text', 'Clipboard text is missing or too large.')
    return env.windowCommand('command:quirky.reviews/copy-text', { text: params.text })
  }
})
