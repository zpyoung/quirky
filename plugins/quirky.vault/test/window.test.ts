import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  FEATURE_MS,
  reportOf,
  runCommand,
  startFeatures,
  stopAll,
  typeInto,
  until,
  waitFor,
  type Features
} from '../../quirky.terminal/test/e2e-ui/features-support'
import type { PublicListResult, SearchStatus, SearchTipState } from '../src/types'

afterEach(stopAll)

const HISTORY_PANEL = 'panel:quirky.vault/history'
const SEARCH_SETTINGS_VIEW = 'view:quirky.vault/search-settings'

type HistoryReport = {
  query: string
  scope: 'workspace' | 'project' | 'all'
  selectedId: string | null
  visibleIds: string[]
  expandedIds: string[]
  focusedSearch: boolean
  loading: boolean
}

type SettingsReport = {
  enabled: boolean
  phase: SearchStatus['phase'] | 'unavailable'
  filesIndexed: number
  filesDue: number
  filesFailed: number
  messagesIndexed: number
}

async function statusOf(features: Features): Promise<SearchStatus> {
  const response = await features.h.call<unknown>('quirky.vault/searchStatus', { host: 'local' })
  if (!response || typeof response !== 'object' || Array.isArray(response) || !('status' in response) || !('hosts' in response) || !Array.isArray(response.hosts)) {
    throw new Error('The local search status response was invalid.')
  }
  const status = response.status
  if (!status || typeof status !== 'object' || Array.isArray(status)) throw new Error('The local search status response was invalid.')
  return status as SearchStatus
}
function dialogByTitle(root: ParentNode, title: string): HTMLElement | null {
  return [...root.querySelectorAll<HTMLElement>('[role="dialog"]')].find((dialog) => {
    const titleText = (dialog.getAttribute('aria-labelledby') ?? '')
      .split(/\s+/)
      .map((id) => dialog.ownerDocument.getElementById(id)?.textContent?.trim())
      .filter(Boolean)
      .join(' ')
    return (titleText || dialog.getAttribute('aria-label')) === title
  }) ?? null
}


function sourceHome(): string {
  return mkdtempSync(join(tmpdir(), 'quirky-vault-window-'))
}

function writeClaudeSession(home: string, sessionId: string, assistantText: string): void {
  const root = join(home, '.claude', 'projects', 'window-fixtures')
  mkdirSync(root, { recursive: true })
  const records = [
    {
      type: 'user',
      sessionId,
      cwd: home,
      timestamp: '2026-10-27T10:00:00.000Z',
      message: { role: 'user', content: 'Repair the highlighted history panel' }
    },
    {
      type: 'assistant',
      sessionId,
      cwd: home,
      timestamp: '2026-10-27T10:01:00.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: assistantText }] }
    }
  ]
  writeFileSync(join(root, `${sessionId}.jsonl`), `${records.map((record) => JSON.stringify(record)).join('\n')}\n`)
}


async function makeFeatures(home: string): Promise<Features> {
  return startFeatures({ env: { QUIRKY_VAULT_SOURCE_HOME: home } })
}

test(
  'SC-06/18/20: history selection and expanded source details follow daemon-owned view state',
  async () => {
    const source = sourceHome()
    let f: Features | undefined
    try {
      writeClaudeSession(source, 'window-panel-session', 'The source contains a real preview turn.')
      f = await makeFeatures(source)
      await f.h.call('quirky.vault/setView', { scope: 'all' })
      const listed = await f.h.call<PublicListResult>('quirky.vault/list', { unlimited: true })
      const session = listed.sessions.find((entry) => entry.sessionId === 'window-panel-session')!
      expect(session).toBeDefined()
      expect(session.source).toMatchObject({ presence: 'present' })
      expect(typeof session.source.filePath).toBe('string')
      expect('filePath' in session).toBe(false)

      await runCommand(f, 'command:quirky.vault/open', { agent: 'claude', sessionId: session.sessionId })
      await reportOf<HistoryReport>(f, HISTORY_PANEL, 'the selected source in All scope', (report) => report.scope === 'all' && report.visibleIds.includes(session.id))
      const row = await until(f, () => f!.win.document.querySelector<HTMLElement>(`[data-vault-session-row="${session.id}"]`))
      row.click()
      await reportOf<HistoryReport>(f, HISTORY_PANEL, 'the selected row', (report) => report.selectedId === session.id)
      row.querySelector<HTMLButtonElement>('[aria-label="Toggle session details"]')!.click()
      await reportOf<HistoryReport>(f, HISTORY_PANEL, 'the expanded row', (report) => report.expandedIds.includes(session.id))
      expect(f.calls.some((call) => call.method === 'quirky.vault/firstPrompt' && call.settled)).toBe(true)
      expect(f.win.document.querySelector(`[data-vault-session-details="${session.id}"]`)?.textContent).toContain('real preview turn')
    } finally {
      await f?.stop()
      rmSync(source, { recursive: true, force: true })
    }
  },
  FEATURE_MS
)

test(
  'SC-07/12/13: opt-in search promotes unseen consent, retries active search, then retains ordinary consent',
  async () => {
    const source = sourceHome()
    let f: Features | undefined
    try {
      writeClaudeSession(source, 'window-search-session', 'Literal [[source-brackets]] and \uE0020; <img data-vault-spoof="yes"> vaultneedle')
      f = await makeFeatures(source)
      await f.h.call('quirky.vault/setView', { scope: 'all' })
      await runCommand(f, 'command:quirky.vault/open')
      const promotion = await until(f, () => f!.win.document.querySelector<HTMLElement>('[data-vault-search-tip]'))
      expect(promotion.textContent).toContain('Search every agent session')
      expect(promotion.textContent).toContain('Find any past conversation by what was said in it, then pick up where the agent left off.')
      const promote = promotion.querySelector<HTMLButtonElement>('[data-vault-enable-search]')
      expect(promote?.textContent?.trim()).toBe('Turn on session search')
      expect(await f.h.call<SearchTipState>('quirky.vault/getSearchTip', {})).toEqual({ id: 'agent-session-search', seen: false })

      const input = await until(f, () => f!.win.document.querySelector<HTMLInputElement>('[data-vault-search]'))
      await typeInto(input, 'vaultneedle')
      await until(f, () => f!.win.document.querySelector<HTMLButtonElement>('[data-vault-enable-search]'))
      const titleOnly = await reportOf<HistoryReport>(f, HISTORY_PANEL, 'title-only results in All scope', (report) => report.scope === 'all' && report.query === 'vaultneedle' && !report.loading)
      expect(titleOnly.visibleIds).toHaveLength(0)
      expect((await statusOf(f)).enabled).toBe(false)

      f.win.document.querySelector<HTMLButtonElement>('[data-vault-enable-search]')!.click()
      await waitFor('explicit indexing consent', async () => ((await statusOf(f!)).enabled ? true : undefined), 20_000)

      const evidence = await until(f, () => f!.win.document.querySelector<HTMLElement>('[data-vault-evidence]'), 30_000)
      expect(evidence.textContent).toContain('[[source-brackets]]')
      expect(evidence.textContent).toContain('\uE0020')
      expect(evidence.textContent).toContain('<img data-vault-spoof="yes">')
      expect(evidence.querySelector('img')).toBeNull()
      expect([...evidence.querySelectorAll('mark')].map((mark) => mark.textContent)).toEqual(['vaultneedle'])
      expect(await f.h.call<SearchTipState>('quirky.vault/getSearchTip', {})).toEqual({ id: 'agent-session-search', seen: true })
      expect(f.win.document.querySelector('[data-vault-search-tip]')).toBeNull()

      await f.stopWindow()
      await f.startWindow()
      await runCommand(f, 'command:quirky.vault/open')
      await until(f, () => f!.calls.find((call) => call.method === 'quirky.vault/getSearchTip' && call.settled))
      expect(await f.h.call<SearchTipState>('quirky.vault/getSearchTip', {})).toEqual({ id: 'agent-session-search', seen: true })
      await f.h.call('quirky.vault/setSearchEnabled', { enabled: false })
      await waitFor('disabled local search after reopening history', async () => (!(await statusOf(f!)).enabled ? true : undefined), 20_000)
      const ordinaryConsent = await until(f, () => f!.win.document.querySelector<HTMLElement>('[data-vault-consent]'))
      expect(ordinaryConsent.textContent).toContain('Enable full-text search?')
      expect(ordinaryConsent.textContent).toContain('full, unredacted agent conversations')
      expect(ordinaryConsent.querySelector<HTMLButtonElement>('[data-vault-enable-search]')?.textContent?.trim()).toBe('Enable')
      expect(ordinaryConsent.hasAttribute('data-vault-search-tip')).toBe(false)
      expect(ordinaryConsent.querySelector('[data-vault-search-tip]')).toBeNull()
    } finally {
      await f?.stop()
      rmSync(source, { recursive: true, force: true })
    }
  },
  FEATURE_MS
)

test(
  'SC-08/09/21: search settings use public status, open a focused history panel, and clear only after confirmation',
  async () => {
    const source = sourceHome()
    let f: Features | undefined
    try {
      writeClaudeSession(source, 'window-settings-session', 'Settings panel fixture marker.')
      f = await makeFeatures(source)
      await runCommand(f, 'command:quirky.vault/settings')
      await reportOf<SettingsReport>(f, SEARCH_SETTINGS_VIEW, 'local search status')
      const open = await until(f, () => f!.win.document.querySelector<HTMLButtonElement>('[data-vault-open-sidebar]'))
      open.click()
      await reportOf<HistoryReport>(f, HISTORY_PANEL, 'the focused search panel', (report) => report.focusedSearch)

      await f.h.call('quirky.vault/setSearchEnabled', { enabled: true })
      await waitFor('search to be enabled', async () => ((await statusOf(f!)).enabled ? true : undefined), 20_000)
      await reportOf<SettingsReport>(f, SEARCH_SETTINGS_VIEW, 'enabled search status', (report) => report.enabled)
      const settings = await until(f, () => f!.win.document.querySelector<HTMLElement>('[data-vault-settings]'))
      const advanced = await until(f, () => settings.querySelector<HTMLDetailsElement>('.qvh-settings-advanced'))
      if (!advanced.open) advanced.querySelector('summary')?.click()
      expect(settings.querySelector('[aria-label="Search index counts"]')?.closest('details')).toBe(advanced)
      const clear = await until(f, () => settings.querySelector<HTMLButtonElement>('[data-vault-clear-search]'))
      clear.click()
      const dialog = await until(f, () => dialogByTitle(f!.win.document, 'Clear search data on this computer?'))
      const confirm = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === 'Clear')
      if (!confirm) throw new Error('The clear-search confirmation did not contain its Clear button.')
      confirm.click()
      await waitFor('cleared search data and disabled policy', async () => (!(await statusOf(f!)).enabled ? true : undefined), 20_000)
    } finally {
      await f?.stop()
      rmSync(source, { recursive: true, force: true })
    }
  },
  FEATURE_MS
)
