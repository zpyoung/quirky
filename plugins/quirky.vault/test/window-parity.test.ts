import { afterEach, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { rpcUrl } from '@quirky/protocol/node'
import {
  FEATURE_MS,
  openedLinks,
  press,
  reportOf,
  runCommand,
  startFeatures,
  stopAll,
  typeInto,
  until,
  waitFor,
  type Features
} from '../../quirky.terminal/test/e2e-ui/features-support'
import type { PublicListResult, SearchResponse, SearchStatus } from '../src/types'
import { createWindowVaultHostForwarder, removeWindowVaultHostForwarder } from './window-parity-host'
import { TrashVolume } from './support/trash-volume'
import { VaultRig } from './support/harness'

afterEach(stopAll)

const HISTORY_PANEL = 'panel:quirky.vault/history'
const SEARCH_SETTINGS_VIEW = 'view:quirky.vault/search-settings'

type HistoryReport = {
  query: string
  scope: 'workspace' | 'project' | 'all'
  selectedId: string | null
  visibleIds: string[]
  listedCount: number
  expandedIds: string[]
  focusedSearch: boolean
  group: 'project' | 'folder' | 'agent'
  disabledAgents: string[]
  hideEmptySessions: boolean
  sessionLimit: 250 | 500 | 1000 | null
  browseSort: 'updated' | 'created'
  searchSort: 'relevance' | 'newest'
  adjustmentCount: number
  total: number
  loading: boolean
  searchEnabled: boolean
  searchError: string | null
}

type SettingsReport = {
  enabled: boolean
  phase: SearchStatus['phase'] | 'unavailable'
  filesIndexed: number
  filesDue: number
  filesFailed: number
  messagesIndexed: number
  searchableSessions: number
  degradedRoots: number
  generation: number
  lastReconcileAt: number | null
  pollIntervalMs: number
  failedHosts: string[]
  busy: boolean
}

function sourceHome(): string {
  return mkdtempSync(join(tmpdir(), 'quirky-vault-window-parity-'))
}

function writeClaudeSession(home: string, sessionId: string, options: {
  cwd?: string
  timestamp?: string
  prompt?: string
  response?: string
} = {}): string {
  const root = join(home, '.claude', 'projects', 'parity-fixtures')
  mkdirSync(root, { recursive: true })
  const cwd = options.cwd ?? home
  const timestamp = options.timestamp ?? '2026-10-27T10:00:00.000Z'
  const records = [
    { type: 'user', sessionId, cwd, timestamp, message: { role: 'user', content: options.prompt ?? `Prompt for ${sessionId}` } },
    { type: 'assistant', sessionId, cwd, timestamp, message: { role: 'assistant', content: options.response ?? `Response for ${sessionId}` } }
  ]
  const path = join(root, `${sessionId}.jsonl`)
  writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`)
  return path
}

function writePiSession(home: string, sessionId: string, prompt: string | null, cwd = home): string {
  const root = join(home, '.pi', 'agent', 'sessions')
  mkdirSync(root, { recursive: true })
  const records: Record<string, unknown>[] = [{ type: 'session', id: sessionId, timestamp: '2026-10-27T10:00:00.000Z', cwd }]
  if (prompt !== null) records.push({ type: 'message', timestamp: '2026-10-27T10:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: prompt }] } })
  const path = join(root, `${sessionId}.jsonl`)
  writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`)
  return path
}

async function makeFeatures(home: string): Promise<Features> {
  return startFeatures({ env: { QUIRKY_VAULT_SOURCE_HOME: home } })
}

async function waitForSettledIndex(features: Features, what: string): Promise<SearchStatus> {
  return waitFor(what, async () => {
    const { status } = await features.h.call<{ status: SearchStatus }>('quirky.vault/searchStatus', { host: 'local' })
    const indexedSessions = Object.values(status.sessionsByAgent).some((count) => count > 0)
    const settledPhase = status.phase === 'current' || status.phase === 'degraded'
    return status.enabled && settledPhase && status.filesDue === 0 && indexedSessions && status.messagesIndexed > 0 ? status : undefined
  }, 30_000)
}

function setSelect(select: HTMLSelectElement, value: string): void {
  select.value = value
  select.dispatchEvent(new Event('change', { bubbles: true }))
}

function buttonNamed(root: ParentNode, text: string): HTMLButtonElement {
  const button = [...root.querySelectorAll<HTMLButtonElement>('button')].find((candidate) => candidate.textContent?.trim() === text)
  if (!button) throw new Error(`missing button: ${text}`)
  return button
}
function selectByLabel(root: ParentNode, text: string): HTMLSelectElement {
  const label = [...root.querySelectorAll<HTMLLabelElement>('label')].find((candidate) => candidate.textContent?.trim() === text)
  const select = label?.control
  if (!(select instanceof HTMLSelectElement)) throw new Error(`Missing select: ${text}`)
  return select
}
function inputByLabel(root: ParentNode, text: string): HTMLInputElement {
  const label = [...root.querySelectorAll<HTMLLabelElement>('label')].find((candidate) => candidate.textContent?.trim() === text)
  const input = label?.control
  if (!(input instanceof HTMLInputElement)) throw new Error(`Missing input: ${text}`)
  return input
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


function menuButton(document: Document, sessionId: string): HTMLButtonElement {
  const row = document.querySelector<HTMLElement>(`[data-vault-session-row="${sessionId}"]`)
  const button = row?.querySelector<HTMLButtonElement>('[aria-label="Session actions"]')
  if (!button) throw new Error(`missing actions menu for ${sessionId}`)
  return button
}


test(
  'SC-02/06: an old active-worktree source survives unrelated newer history and rendered rows stay bounded',
  async () => {
    const source = sourceHome()
    let features: Features | undefined
    try {
      features = await makeFeatures(source)
      const worktrees = await features.h.call<{ id: string; path: string }[]>('quirky.worktree/list', {})
      const current = worktrees.find((worktree) => worktree.id === features!.worktree)
      if (!current) throw new Error('The active worktree was not returned by the real worktree API.')
      const oldPath = writeClaudeSession(source, 'old-active-worktree-session', {
        cwd: current.path,
        timestamp: '2025-01-01T00:00:00.000Z',
        prompt: 'Old but in the active worktree'
      })
      for (let index = 0; index < 251; index++) {
        writeClaudeSession(source, `new-unrelated-${index}`, {
          cwd: join(source, 'unrelated-worktree', String(index)),
          timestamp: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString()
        })
      }
      const listed = await features.h.call<PublicListResult>('quirky.vault/list', { within: { worktree: features.worktree }, agents: ['claude'], unlimited: true })
      const old = listed.sessions.find((session) => session.sessionId === 'old-active-worktree-session')
      if (!old) throw new Error('The scoped history did not return the old active-worktree source.')

      await features.h.call('quirky.vault/setView', { scope: 'workspace' })
      await runCommand(features, 'command:quirky.vault/open')
      const report = await reportOf<HistoryReport>(features, HISTORY_PANEL, 'the old active-worktree source', (state) => state.scope === 'workspace' && state.visibleIds.includes(old!.id) && !state.loading)
      expect(report.visibleIds).toContain(old.id)
      expect(existsSync(oldPath)).toBe(true)

      const all = features.win.document.querySelector<HTMLButtonElement>('.qvh-scope-switch button:last-child')
      all?.click()
      const global = await reportOf<HistoryReport>(features, HISTORY_PANEL, 'bounded All history', (state) => state.scope === 'all' && !state.loading && state.listedCount === 250)
      expect(global.visibleIds.length).toBeLessThan(50)
      expect(features.win.document.querySelectorAll('[data-vault-session-row]').length).toBeLessThan(50)
      const showMore = await until(features, () => features!.win.document.querySelector<HTMLButtonElement>('[data-vault-load-more]'))
      expect(showMore.textContent).toContain('Show more sessions')
      showMore.click()
      const expanded = await reportOf<HistoryReport>(features, HISTORY_PANEL, 'show-more depth', (state) => state.sessionLimit === 500 && state.listedCount === 252 && !state.loading)
      expect(expanded.listedCount).toBe(252)
      expect(features.win.document.querySelectorAll('[data-vault-session-row]').length).toBeLessThan(50)
    } finally {
      await features?.stop()
      rmSync(source, { recursive: true, force: true })
    }
  },
  FEATURE_MS
)
test(
  'SC-02: a registered repo input without a worktree resolves Project scope in the mounted history panel',
  async () => {
    const source = sourceHome()
    let features: Features | undefined
    try {
      features = await makeFeatures(source)
      const repos = await features.h.call<{ id: string; name: string; path: string }[]>('quirky.repo/list', {})
      const repo = repos[0]
      if (!repo) throw new Error('The real daemon did not register the test worktree project.')
      const sourcePath = writeClaudeSession(source, 'project-only-history', {
        cwd: repo.path,
        prompt: 'A project session without an active worktree.'
      })
      await features.h.ok(['ui', 'open-view', 'view:quirky.vault/search-settings', '--input', JSON.stringify({ repo: repo.id })])
      await runCommand(features, 'command:quirky.vault/open')
      const listed = await features.h.call<PublicListResult>('quirky.vault/list', { within: { repo: repo.id }, agents: ['claude'], unlimited: true })
      const projectSession = listed.sessions.find((session) => session.sessionId === 'project-only-history')
      if (!projectSession) throw new Error('The real project-scoped list did not include its source session.')
      const report = await reportOf<HistoryReport>(features, HISTORY_PANEL, 'Project context and its source session', (state) => state.scope === 'project' && state.visibleIds.includes(projectSession.id) && !state.loading)
      expect(report.visibleIds).toContain(projectSession.id)
      const workspace = [...features.win.document.querySelectorAll<HTMLButtonElement>('.qvh-scope-switch button')].find((button) => button.textContent?.trim() === 'Workspace')
      const project = [...features.win.document.querySelectorAll<HTMLButtonElement>('.qvh-scope-switch button')].find((button) => button.textContent?.trim() === 'Project')
      expect(workspace?.disabled).toBe(true)
      expect(project?.disabled).toBe(false)
      expect(existsSync(sourcePath)).toBe(true)
    } finally {
      await features?.stop()
      rmSync(source, { recursive: true, force: true })
    }
  },
  FEATURE_MS
)

test(
  'SC-03/06: every view control changes mounted state, selection survives filtering, and stable choices survive window restart',
  async () => {
    const source = sourceHome()
    let features: Features | undefined
    try {
      writeClaudeSession(source, 'control-claude', { response: 'paritycontrolneedle appears in the transcript.' })
      writePiSession(source, 'control-pi', 'A Pi session with paritycontrolneedle.')
      writePiSession(source, 'control-empty-pi', null)
      features = await makeFeatures(source)
      const fixtureList = await features.h.call<PublicListResult>('quirky.vault/list', { host: 'local', agents: ['claude', 'pi'], unlimited: true })
      const emptySession = fixtureList.sessions.find((session) => session.sessionId === 'control-empty-pi')
      if (!emptySession) throw new Error('The actual Pi empty-session fixture was not discovered.')
      await features.h.call('quirky.vault/setView', { scope: 'all' })
      await runCommand(features, 'command:quirky.vault/open')
      await reportOf<HistoryReport>(features, HISTORY_PANEL, 'all real fixture rows', (state) => !state.loading && state.total === 3)

      const document = features.win.document
      const options = until(features, () => document.querySelector<HTMLElement>('[data-vault-view-options]'))
      document.querySelector<HTMLButtonElement>('[aria-label="View options"]')!.click()
      const dialog = await options
      buttonNamed(dialog, 'Clear').click()
      await reportOf<HistoryReport>(features, HISTORY_PANEL, 'no-agent selection', (state) => state.disabledAgents.length === 25)
      buttonNamed(dialog, 'Select all').click()
      await reportOf<HistoryReport>(features, HISTORY_PANEL, 'select-all restored', (state) => state.disabledAgents.length === 0 && !state.loading)

      const claudeRow = await until(features, () => document.querySelector<HTMLElement>('[data-vault-session-row]'))
      const selectedId = claudeRow.dataset.vaultSessionRow!
      claudeRow.click()
      await reportOf<HistoryReport>(features, HISTORY_PANEL, 'selected history identity', (state) => state.selectedId === selectedId)
      const emptyRow = await until(features, () => document.querySelector<HTMLElement>(`[data-vault-session-row=\"${emptySession.id}\"]`))
      const emptyId = emptySession.id
      emptyRow.click()
      await reportOf<HistoryReport>(features, HISTORY_PANEL, 'selected empty identity', (state) => state.selectedId === emptyId)
      const collapseGroup = await until(features, () => document.querySelector<HTMLButtonElement>('.qvh-group-heading button[aria-expanded=\"true\"]'))
      collapseGroup.click()
      const collapsed = await reportOf<HistoryReport>(features, HISTORY_PANEL, 'collapsed selected group', (state) => state.selectedId === emptyId && !state.visibleIds.includes(emptyId))
      expect(collapsed.selectedId).toBe(emptyId)
      const expandGroup = await until(features, () => document.querySelector<HTMLButtonElement>('.qvh-group-heading button[aria-expanded=\"false\"]'))
      expandGroup.click()
      const expandedGroup = await reportOf<HistoryReport>(features, HISTORY_PANEL, 'expanded selected group', (state) => state.selectedId === emptyId && state.visibleIds.includes(emptyId))
      expect(expandedGroup.selectedId).toBe(emptyId)

      const hideEmpty = inputByLabel(dialog, 'Hide empty sessions')
      hideEmpty.click()
      const hidden = await reportOf<HistoryReport>(features, HISTORY_PANEL, 'empty session filter', (state) => state.hideEmptySessions)
      expect(hidden.selectedId).toBe(emptyId)
      expect(hidden.visibleIds).not.toContain(emptyId)

      for (const [label, value] of [['Folder', 'folder'], ['Agent', 'agent'], ['Project', 'project']] as const) {
        const group = inputByLabel(dialog, label)
        group.click()
        await reportOf<HistoryReport>(features, HISTORY_PANEL, `${label} grouping`, (state) => state.group === value)
      }

      const historyDepth = selectByLabel(dialog, 'History depth')
      setSelect(historyDepth, '500')
      await reportOf<HistoryReport>(features, HISTORY_PANEL, '500-session depth', (state) => state.sessionLimit === 500)
      setSelect(historyDepth, '1000')
      await reportOf<HistoryReport>(features, HISTORY_PANEL, '1000-session depth', (state) => state.sessionLimit === 1000)
      setSelect(historyDepth, 'unlimited')
      await reportOf<HistoryReport>(features, HISTORY_PANEL, 'unlimited history depth', (state) => state.sessionLimit === null)
      setSelect(historyDepth, '250')
      await reportOf<HistoryReport>(features, HISTORY_PANEL, 'recommended history depth', (state) => state.sessionLimit === 250)

      const sort = selectByLabel(document, 'Sort')
      setSelect(sort, 'created')
      await reportOf<HistoryReport>(features, HISTORY_PANEL, 'created-time browse sort', (state) => state.browseSort === 'created')

      const gemini = inputByLabel(dialog, 'Gemini')
      gemini.click()
      await reportOf<HistoryReport>(features, HISTORY_PANEL, 'agent selection', (state) => state.disabledAgents.includes('gemini') && !state.loading)
      buttonNamed(dialog, 'Close').click()

      const enableSearch = await until(features, () => document.querySelector<HTMLButtonElement>('[data-vault-enable-search]'))
      enableSearch.click()
      await waitFor('the mounted consent control enables search', async () => ((await features!.h.call<{ status: SearchStatus }>('quirky.vault/searchStatus', { host: 'local' })).status.enabled ? true : undefined), 30_000)
      await waitForSettledIndex(features, 'the real fixture index to settle with indexed sessions')
      await reportOf<HistoryReport>(features, HISTORY_PANEL, 'the UI observes enabled search', (state) => state.searchEnabled)
      const query = await until(features, () => document.querySelector<HTMLInputElement>('[data-vault-search]'))
      await typeInto(query, 'paritycontrolneedle')
      await reportOf<HistoryReport>(features, HISTORY_PANEL, 'indexed query matches', (state) => state.query === 'paritycontrolneedle' && !state.loading && state.visibleIds.length > 0)
      const searchSort = selectByLabel(document, 'Sort')
      setSelect(searchSort, 'newest')
      await reportOf<HistoryReport>(features, HISTORY_PANEL, 'newest search sort', (state) => state.searchSort === 'newest')

      document.querySelector<HTMLButtonElement>('[aria-label="View options"]')!.click()
      const resetDialog = await until(features, () => document.querySelector<HTMLElement>('[data-vault-view-options]'))
      buttonNamed(resetDialog, 'Reset view').click()
      const reset = await reportOf<HistoryReport>(features, HISTORY_PANEL, 'view adjustments reset', (state) => state.adjustmentCount === 0 && !state.loading)
      expect(reset.adjustmentCount).toBe(0)

      const persistDialog = resetDialog
      const agentGroup = inputByLabel(persistDialog, 'Agent')
      agentGroup.click()
      const hideEmptyForPersistence = inputByLabel(persistDialog, 'Hide empty sessions')
      hideEmptyForPersistence.click()
      setSelect(selectByLabel(persistDialog, 'History depth'), '500')
      setSelect(selectByLabel(document, 'Sort'), 'created')
      const geminiForPersistence = inputByLabel(persistDialog, 'Gemini')
      geminiForPersistence.click()
      await reportOf<HistoryReport>(features, HISTORY_PANEL, 'stable browse choices before restart', (state) => state.group === 'agent' && state.disabledAgents.includes('gemini') && state.hideEmptySessions && state.sessionLimit === 500 && state.browseSort === 'created')
      buttonNamed(persistDialog, 'Close').click()
      await typeInto(query, 'paritycontrolneedle')
      await reportOf<HistoryReport>(features, HISTORY_PANEL, 'query restored for search sort', (state) => state.query === 'paritycontrolneedle' && !state.loading)
      setSelect(selectByLabel(document, 'Sort'), 'newest')
      await reportOf<HistoryReport>(features, HISTORY_PANEL, 'stable newest search sort before restart', (state) => state.searchSort === 'newest')
      await typeInto(query, '')
      await reportOf<HistoryReport>(features, HISTORY_PANEL, 'transient query cleared', (state) => state.query === '' && !state.loading)
      await features.stopWindow()
      await features.startWindow()
      await runCommand(features, 'command:quirky.vault/open')
      const reopened = await reportOf<HistoryReport>(features, HISTORY_PANEL, 'all stable view choices after window restart', (state) => state.group === 'agent' && state.disabledAgents.includes('gemini') && state.hideEmptySessions && state.sessionLimit === 500 && state.browseSort === 'created' && state.searchSort === 'newest' && !state.loading)
      expect(reopened.query).toBe('')
    } finally {
      await features?.stop()
      rmSync(source, { recursive: true, force: true })
    }
  },
  FEATURE_MS
)

test(
  'SC-18/19/20: selected prompt copy is literal, details remain identity-bound, and delete cancel/error never claim success',
  async () => {
    const source = sourceHome()
    let features: Features | undefined
    try {
      const promptA = `First prompt for source A with apostrophe ' and shell text ; $(never-run). ${'long context '.repeat(15_000)}`
      const promptB = 'First prompt for source B must not be copied when source A is selected.'
      features = await makeFeatures(source)
      const worktrees = await features.h.call<{ id: string; path: string }[]>('quirky.worktree/list', {})
      const activeWorktree = worktrees.find((worktree) => worktree.id === features!.worktree)
      if (!activeWorktree) throw new Error('The active test worktree is not available for navigation.')
      const pathA = writeClaudeSession(source, 'copy-source-a', { cwd: activeWorktree.path, prompt: promptA, response: 'Assistant response A.' })
      writeClaudeSession(source, 'copy-source-b', { cwd: activeWorktree.path, prompt: promptB, response: 'Assistant response B.' })
      const listing = await features.h.call<PublicListResult>('quirky.vault/list', { host: 'local', agents: ['claude'], unlimited: true })
      const rowA = listing.sessions.find((session) => session.sessionId === 'copy-source-a')
      const rowB = listing.sessions.find((session) => session.sessionId === 'copy-source-b')
      if (!rowA || !rowB) throw new Error('The actual Claude fixtures were not discovered.')
      await features.h.call('quirky.vault/setView', { scope: 'all' })
      await runCommand(features, 'command:quirky.vault/open', { agent: 'claude', sessionId: rowA.sessionId })
      await reportOf<HistoryReport>(features, HISTORY_PANEL, 'selected source A', (state) => state.selectedId === rowA.id && state.visibleIds.includes(rowA.id))

      const document = features.win.document
      menuButton(document, rowA.id).click()
      const menu = await until(features, () => document.body.querySelector<HTMLElement>(`[data-vault-actions="${rowA.id}"] [role="menu"]`))
      const copyPrompt = buttonNamed(menu, 'Copy First Prompt')
      copyPrompt.click()
      await waitFor('full selected prompt copied', async () => features!.clipboard.text === promptA ? true : undefined)
      expect(features.clipboard.text).toBe(promptA)

      const logPath = rowA.source.filePath
      if (!logPath) throw new Error('The local source path is not available for the selected history row.')
      const resumePlan = await features.h.call<{ command: string }>('quirky.vault/prepareResume', { id: rowA.id })
      for (const [label, expected] of [['Copy Session ID', rowA.sessionId], ['Copy Log Path', logPath], ['Copy Resume Command', resumePlan.command]]) {
        menuButton(document, rowA.id).click()
        const copyMenu = await until(features, () => document.body.querySelector<HTMLElement>(`[data-vault-actions=\"${rowA.id}\"]`))
        buttonNamed(copyMenu, label).click()
        await waitFor(`${label} copied`, async () => features!.clipboard.text === expected ? true : undefined)
        expect(features.clipboard.text).toBe(expected)
      }
      for (const [label, reveal] of [['Open Log', false], ['Reveal Log', true]] as const) {
        menuButton(document, rowA.id).click()
        const sourceMenu = await until(features, () => document.body.querySelector<HTMLElement>(`[data-vault-actions=\"${rowA.id}\"]`))
        buttonNamed(sourceMenu, label).click()
        await waitFor(`${label} reached the selected source`, async () => openedLinks(features!).some((entry) => entry.target === logPath && entry.reveal === reveal) ? true : undefined)
      }
      const workingDirectory = rowA.cwd
      if (!workingDirectory) throw new Error('The selected source did not retain its working directory.')
      menuButton(document, rowA.id).click()
      const workingMenu = await until(features, () => document.body.querySelector<HTMLElement>(`[data-vault-actions=\"${rowA.id}\"]`))
      buttonNamed(workingMenu, 'Open Working Directory').click()
      await waitFor('working directory action reached the selected source cwd', async () => openedLinks(features!).some((entry) => entry.target === workingDirectory && !entry.reveal) ? true : undefined)
      menuButton(document, rowA.id).click()
      const deleteMenu = await until(features, () => document.body.querySelector<HTMLElement>(`[data-vault-actions="${rowA.id}"]`))
      buttonNamed(deleteMenu, 'Delete').click()
      const firstDialog = await until(features, () => dialogByTitle(document, 'Delete this agent session?'))
      buttonNamed(firstDialog, 'Cancel').click()
      expect(existsSync(pathA)).toBe(true)
      expect(features.calls.some((call) => call.method === 'quirky.vault/deleteSession' && call.settled)).toBe(false)

      const fault = features.rejectCalls('quirky.vault/deleteSession', 'owned delete refusal')
      try {
        menuButton(document, rowA.id).click()
        const errorMenu = await until(features, () => document.body.querySelector<HTMLElement>(`[data-vault-actions="${rowA.id}"]`))
        buttonNamed(errorMenu, 'Delete').click()
        const confirmDialog = await until(features, () => dialogByTitle(document, 'Delete this agent session?'))
        buttonNamed(confirmDialog, 'Delete').click()
        const failure = await until(features, () => [...document.querySelectorAll<HTMLElement>('[role="alert"]')].find((alert) => alert.textContent?.includes('owned delete refusal')))
        expect(failure.textContent).toContain('owned delete refusal')
        expect(existsSync(pathA)).toBe(true)
        expect([...document.querySelectorAll('[role="alert"]')].some((alert) => alert.textContent?.includes('Session moved to Trash'))).toBe(false)
      } finally {
        fault.restore()
      }

      const rowAElement = await until(features, () => document.querySelector<HTMLElement>(`[data-vault-session-row="${rowA.id}"]`))
      rowAElement.querySelector<HTMLButtonElement>('[aria-label="Toggle session details"]')!.click()
      const detailsA = await until(features, () => document.querySelector<HTMLElement>(`[data-vault-session-details="${rowA.id}"]`))
      document.querySelector<HTMLButtonElement>('[aria-label=\"View options\"]')!.click()
      await until(features, () => document.querySelector('[data-vault-view-options]'))
      await until(features, () => detailsA.querySelector<HTMLElement>('[data-vault-first-prompt]'))
      expect(detailsA.querySelector('[data-vault-first-prompt]')?.textContent).toBe(promptA)

      const rowBElement = await until(features, () => document.querySelector<HTMLElement>(`[data-vault-session-row="${rowB.id}"]`))
      rowBElement.querySelector<HTMLButtonElement>('[aria-label="Toggle session details"]')!.click()
      const detailsB = await until(features, () => document.querySelector<HTMLElement>(`[data-vault-session-details="${rowB.id}"]`))
      await until(features, () => detailsB.querySelector<HTMLElement>('[data-vault-first-prompt]'))
      expect(detailsB.querySelector('[data-vault-first-prompt]')?.textContent).toBe(promptB)

    } finally {
      await features?.stop()
      rmSync(source, { recursive: true, force: true })
    }
  },
  FEATURE_MS
)
test.skipIf(process.platform !== 'darwin')(
  'SC-19: confirmed mounted-window deletion moves the selected real source to owned APFS Trash',
  async () => {
    const volume = TrashVolume.create()
    const previousTmpdir = process.env.TMPDIR
    let source: string | undefined
    let features: Features | undefined
    process.env.TMPDIR = volume.tmpDir
    try {
      source = sourceHome()
      const sourcePath = writeClaudeSession(source, 'confirmed-trash-session', { prompt: 'Confirm this actual owned-volume deletion.' })
      const originalBytes = readFileSync(sourcePath)
      features = await makeFeatures(source)
      volume.assertSafeDeletionTarget(sourcePath, source, features.h.home)
      const listing = await features.h.call<PublicListResult>('quirky.vault/list', { host: 'local', agents: ['claude'], unlimited: true })
      const session = listing.sessions.find((entry) => entry.sessionId === 'confirmed-trash-session')
      if (!session) throw new Error('The real Claude deletion fixture was not discovered.')
      await features.h.call('quirky.vault/setView', { scope: 'all' })
      await runCommand(features, 'command:quirky.vault/open', { agent: 'claude', sessionId: session.sessionId })
      await reportOf<HistoryReport>(features, HISTORY_PANEL, 'selected deletable source', (state) => state.selectedId === session.id)
      await until(features, () => features!.win.document.querySelector(`[data-vault-session-row=\"${session.id}\"]`))
      menuButton(features.win.document, session.id).click()
      const menu = await until(features, () => features!.win.document.body.querySelector<HTMLElement>(`[data-vault-actions=\"${session.id}\"]`))
      buttonNamed(menu, 'Delete').click()
      const confirmation = await until(features, () => dialogByTitle(features!.win.document, 'Delete this agent session?'))
      buttonNamed(confirmation, 'Delete').click()
      await waitFor('confirmed source moved to Trash', async () => !existsSync(sourcePath) ? true : undefined)
      expect(readFileSync(volume.trashPathFor(basename(sourcePath)))).toEqual(originalBytes)
      const refreshed = await reportOf<HistoryReport>(features, HISTORY_PANEL, 'deleted source removed from mounted history', (state) => !state.loading && state.listedCount === 0)
      expect(refreshed.visibleIds).not.toContain(session.id)
      expect((await features.h.call<PublicListResult>('quirky.vault/list', { host: 'local', agents: ['claude'], unlimited: true })).sessions.some((entry) => entry.id === session.id)).toBe(false)
    } finally {
      try {
        await features?.stop()
      } finally {
        if (source) rmSync(source, { recursive: true, force: true })
        if (previousTmpdir === undefined) delete process.env.TMPDIR
        else process.env.TMPDIR = previousTmpdir
        volume.cleanup()
      }
    }
  },
  FEATURE_MS
)

test(
  'SC-08: Settings reports real index counts and focuses search; connection errors expose a retry that recovers against the daemon',
  async () => {
    const source = sourceHome()
    let features: Features | undefined
    try {
      writeClaudeSession(source, 'settings-status-session', { response: 'settingsstatusneedle is indexed from this real transcript.' })
      features = await makeFeatures(source)
      await features.h.call('quirky.vault/setView', { scope: 'all', query: '' })
      const fixtureList = await features.h.call<PublicListResult>('quirky.vault/list', { host: 'local', agents: ['claude'], unlimited: true })
      const session = fixtureList.sessions.find((entry) => entry.sessionId === 'settings-status-session')
      if (!session) throw new Error('The actual Claude search-retry fixture was not discovered.')
      await runCommand(features, 'command:quirky.vault/settings')
      const settings = await until(features, () => features!.win.document.querySelector<HTMLElement>('[data-vault-settings]'))
      const closedStatus = await features.h.call<{ status: SearchStatus }>('quirky.vault/searchStatus', { host: 'local' })
      const sessionsCell = await until(features, () => settings.querySelector<HTMLElement>('[data-vault-status-sessions]'))
      const actualSearchableSessions = Object.values(closedStatus.status.sessionsByAgent).reduce((sum, count) => sum + count, 0)
      expect(Number(sessionsCell.querySelector('strong')?.textContent)).toBe(actualSearchableSessions)
      expect(closedStatus.status.enabled).toBe(false)
      const open = await until(features, () => settings.querySelector<HTMLButtonElement>('[data-vault-open-sidebar]'))
      open.click()
      await reportOf<HistoryReport>(features, HISTORY_PANEL, 'visible focused search', (state) => state.focusedSearch)
      await until(features, () => features!.win.document.activeElement === features!.win.document.querySelector('[data-vault-search]') ? true : undefined)

      const enabled = await features.h.call<{ status: SearchStatus }>('quirky.vault/setSearchEnabled', { enabled: true, host: 'local' })
      expect(enabled.status.enabled).toBe(true)
      await waitForSettledIndex(features, 'real transcript indexing to settle')
      const refreshed = await reportOf<SettingsReport>(features, SEARCH_SETTINGS_VIEW, 'settled search counts', (state) => state.enabled && state.filesDue === 0 && state.searchableSessions === 1 && (state.phase === 'current' || state.phase === 'degraded'))
      expect(refreshed.searchableSessions).toBe(1)
      expect(refreshed.messagesIndexed).toBeGreaterThan(0)
      const baselineStatus = await features.h.call<{ status: SearchStatus }>('quirky.vault/searchStatus', { host: 'local' })
      const baselineRootCount = baselineStatus.status.degradedRoots.length
      const baselineReconcileAt = baselineStatus.status.lastReconcileAt
      const projectsRoot = join(source, '.claude', 'projects')
      const unavailableRoot = join(source, '.claude', 'projects-unavailable')
      renameSync(projectsRoot, unavailableRoot)
      const degradedResult = await features.h.call<SearchResponse>('quirky.vault/search', {
        host: 'local', query: 'settingsstatusneedle', freshness: 'wait-until-current', filters: { agents: ['claude'] }
      })
      expect(degradedResult.kind).toBe('results')
      const degradedStatus = await waitFor('the post-rename root reconciliation', async () => {
        const current = await features!.h.call<{ status: SearchStatus }>('quirky.vault/searchStatus', { host: 'local' })
        return current.status.phase === 'degraded'
          && current.status.degradedRoots.length > baselineRootCount
          && current.status.lastReconcileAt !== null
          && (baselineReconcileAt === null || current.status.lastReconcileAt >= baselineReconcileAt)
          ? current.status
          : undefined
      }, 30_000)
      const degradedReport = await reportOf<SettingsReport>(features, SEARCH_SETTINGS_VIEW, 'post-rename status generation and root counts', (state) => (
        state.phase === 'degraded'
        && state.generation === degradedStatus.generation
        && state.lastReconcileAt === degradedStatus.lastReconcileAt
        && state.degradedRoots === degradedStatus.degradedRoots.length
      ))
      expect(Number(settings.querySelector('[data-vault-status-roots] strong')?.textContent)).toBe(degradedStatus.degradedRoots.length)
      renameSync(unavailableRoot, projectsRoot)
      await features.h.call<SearchResponse>('quirky.vault/search', {
        host: 'local', query: 'settingsstatusneedle', freshness: 'wait-until-current', filters: { agents: ['claude'] }
      })
      await waitForSettledIndex(features, 'the real source root recovery to settle')

      const reject = features.rejectCalls('quirky.vault/search', 'owned connection failure')
      try {
        const query = await until(features, () => features!.win.document.querySelector<HTMLInputElement>('[data-vault-search]'))
        await typeInto(query, 'settingsstatusneedle')
        await reportOf<HistoryReport>(features, HISTORY_PANEL, 'injected search request failure', (state) => state.query === 'settingsstatusneedle' && state.searchError !== null && !state.loading)
        await until(features, () => features!.win.document.querySelector('[data-vault-query-status][data-vault-search-error="true"]'))
      } finally {
        reject.restore()
      }
      const retry = await until(features, () => features!.win.document.querySelector<HTMLButtonElement>('[data-vault-retry-search]'))
      retry.click()
      const recovered = await reportOf<HistoryReport>(features, HISTORY_PANEL, 'retry recovers the selected real source', (state) => (
        state.query === 'settingsstatusneedle'
        && !state.loading
        && state.searchError === null
        && state.visibleIds.includes(session.id)
      ))
      expect(recovered.visibleIds).toContain(session.id)
      expect(features.win.document.querySelector('[data-vault-search-error]')).toBeNull()
    } finally {
      await features?.stop()
      rmSync(source, { recursive: true, force: true })
    }
  },
  FEATURE_MS
)

test(
  'SC-15/16: a stale real index page replaces the old result set, and independently reachable limits are visible',
  async () => {
    const source = sourceHome()
    let features: Features | undefined
    try {
      for (let index = 0; index < 23; index++) {
        writeClaudeSession(source, `page-result-${index}`, {
          timestamp: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
          response: `pagefreshnessneedle ${'context '.repeat(20)} ${index}`
        })
      }
      features = await makeFeatures(source)
      await features.h.call('quirky.vault/setView', { scope: 'all', searchSort: 'newest' })
      await features.h.call('quirky.vault/setSearchEnabled', { enabled: true, host: 'local' })
      await waitForSettledIndex(features, 'real search indexing to settle')
      await runCommand(features, 'command:quirky.vault/open')
      const query = await until(features, () => features!.win.document.querySelector<HTMLInputElement>('[data-vault-search]'))
      await typeInto(query, 'pagefreshnessneedle')
      const firstPage = await reportOf<HistoryReport>(features, HISTORY_PANEL, 'first search page', (state) => state.query === 'pagefreshnessneedle' && !state.loading && state.total === 20)
      expect(new Set(firstPage.visibleIds).size).toBe(firstPage.visibleIds.length)
      await until(features, () => features!.win.document.querySelector('[data-vault-load-more]'))

      writeClaudeSession(source, 'new-page-result', {
        timestamp: '2026-10-28T11:00:00.000Z',
        response: 'pagefreshnessneedle newly indexed after page one'
      })
      const fresh = await features.h.call<SearchResponse>('quirky.vault/search', {
        host: 'local', query: 'pagefreshnessneedle', freshness: 'wait-until-current', limit: 20, filters: { agents: ['claude'] }
      })
      if (fresh.kind !== 'results') throw new Error(`Expected current search results, received ${fresh.kind}.`)
      const newPageHit = fresh.hits.find((hit) => hit.sessionId === 'new-page-result')
      if (!newPageHit) throw new Error('The newly indexed source is missing from current search results.')

      features.win.document.querySelector<HTMLButtonElement>('[data-vault-load-more]')!.click()
      const replaced = await reportOf<HistoryReport>(features, HISTORY_PANEL, 'stale cursor replacement or typed search error', (state) => state.searchError !== null || (
        state.query === 'pagefreshnessneedle'
        && !state.loading
        && state.total === 20
        && state.visibleIds.includes(newPageHit.id)
      ))
      if (replaced.searchError) {
        const statusText = features.win.document.querySelector<HTMLElement>('[data-vault-query-status]')?.textContent ?? ''
        throw new Error(`Search failed while replacing the stale page: ${replaced.searchError}. Query status: ${statusText}`)
      }
      expect(replaced.total).toBe(20)
      expect(replaced.visibleIds).toContain(newPageHit.id)
      expect(new Set(replaced.visibleIds).size).toBe(replaced.visibleIds.length)
      const longQuery = await until(features, () => features!.win.document.querySelector<HTMLInputElement>('[data-vault-search]'))
      const queryTerms = ['querylimitneedle', ...Array.from({ length: 48 }, (_, index) => `term${index}`)]
      const queryLimit = queryTerms.join(' ')
      writeClaudeSession(source, 'query-term-limit', { response: queryTerms.join(' ') })
      const queryLimitResponse = await features.h.call<SearchResponse>('quirky.vault/search', {
        host: 'local', query: queryLimit, freshness: 'wait-until-current', filters: { agents: ['claude'] }
      })
      if (queryLimitResponse.kind !== 'results') throw new Error(`Expected query-limit results, received ${queryLimitResponse.kind}.`)
      expect(queryLimitResponse.truncated.query).toBe(true)
      const queryLimitHit = queryLimitResponse.hits.find((hit) => hit.sessionId === 'query-term-limit')
      if (!queryLimitHit) throw new Error('The valid over-term-limit query did not match its real transcript.')
      await typeInto(longQuery, queryLimit)
      await reportOf<HistoryReport>(features, HISTORY_PANEL, 'valid over-term-limit query results', (state) => (
        state.query === queryLimit
        && !state.loading
        && state.searchError === null
        && state.visibleIds.includes(queryLimitHit.id)
      ))
      expect(features.win.document.querySelector('[data-vault-truncation="query"]')).not.toBeNull()

      writeClaudeSession(source, 'overlong-evidence', {
        response: `snippetlimitneedle ${Array.from({ length: 12 }, (_, at) => `${String(at).padEnd(90, 'x')}`).join(' ')}`
      })
      const snippetResponse = await features.h.call<SearchResponse>('quirky.vault/search', {
        host: 'local', query: 'snippetlimitneedle', freshness: 'wait-until-current', filters: { agents: ['claude'] }
      })
      if (snippetResponse.kind !== 'results') throw new Error(`Expected snippet-limit results, received ${snippetResponse.kind}.`)
      expect(snippetResponse.truncated.snippets).toBe(true)
      const snippetHit = snippetResponse.hits.find((hit) => hit.sessionId === 'overlong-evidence')
      if (!snippetHit) throw new Error('The long-evidence transcript was not returned by its real query.')
      await typeInto(longQuery, 'snippetlimitneedle')
      await reportOf<HistoryReport>(features, HISTORY_PANEL, 'long evidence query result', (state) => (
        state.query === 'snippetlimitneedle'
        && !state.loading
        && state.searchError === null
        && state.visibleIds.includes(snippetHit.id)
      ))
      expect(features.win.document.querySelector('[data-vault-truncation="snippets"]')).not.toBeNull()
      expect(features.win.document.querySelector(`[data-vault-session-row="${snippetHit.id}"] [data-vault-evidence]`)).not.toBeNull()

      await features.h.call('quirky.vault/setView', { searchSort: 'relevance' })
      const beforeCandidates = await features.h.call<{ status: SearchStatus }>('quirky.vault/searchStatus', { host: 'local' })
      const expectedClaudeSessions = (beforeCandidates.status.sessionsByAgent.claude ?? 0) + 601
      for (let index = 0; index < 601; index++) {
        writeClaudeSession(source, `candidate-cap-${index}`, { response: `candidatecapneedle distinct source ${index}` })
      }
      await waitFor('all candidate-cap sources are indexed independently of retrieval truncation', async () => {
        await features!.h.call<SearchResponse>('quirky.vault/search', {
          host: 'local', query: 'candidatecapneedle', freshness: 'wait-until-current', filters: { agents: ['claude'], sort: 'relevance' }
        })
        const { status } = await features!.h.call<{ status: SearchStatus }>('quirky.vault/searchStatus', { host: 'local' })
        return status.filesDue === 0 && (status.sessionsByAgent.claude ?? 0) >= expectedClaudeSessions ? true : undefined
      }, 30_000)
      const candidateResponse = await features.h.call<SearchResponse>('quirky.vault/search', {
        host: 'local', query: 'candidatecapneedle', freshness: 'wait-until-current', filters: { agents: ['claude'] }
      })
      if (candidateResponse.kind !== 'results') throw new Error(`Expected candidate-limit results, received ${candidateResponse.kind}.`)
      expect(candidateResponse.truncated.candidates).toBe(true)
      await typeInto(longQuery, 'candidatecapneedle')
      await reportOf<HistoryReport>(features, HISTORY_PANEL, 'candidate-limited query results', (state) => (
        state.query === 'candidatecapneedle'
        && !state.loading
        && state.searchError === null
        && state.visibleIds.length > 0
      ))
      expect(features.win.document.querySelector('[data-vault-truncation="candidates"]')).not.toBeNull()
    } finally {
      await features?.stop()
      rmSync(source, { recursive: true, force: true })
    }
  },
  FEATURE_MS
)
test(
  'SC-20: Up/Down selects the exact source and Enter launches its configured fake provider once',
  async () => {
    const source = sourceHome()
    const canonicalSource = realpathSync(source)
    let features: Features | undefined
    try {
      writeClaudeSession(source, 'keyboard-session-a', {
        timestamp: '2026-10-27T10:02:00.000Z',
        cwd: canonicalSource,
        prompt: 'The first keyboard source must not launch.'
      })
      writeClaudeSession(source, 'keyboard-session-b', {
        timestamp: '2026-10-27T10:01:00.000Z',
        cwd: canonicalSource,
        prompt: 'The second keyboard source must launch exactly once.'
      })
      features = await makeFeatures(source)
      const provider = join(source, 'owned fake provider')
      const capture = join(source, 'provider invocation.log')
      writeFileSync(provider, `#!/bin/sh
printf '%s\\n' "$PWD" "$@" > "$VAULT_CAPTURE_LOG"
`, { mode: 0o700 })
      chmodSync(provider, 0o700)
      await features.h.call('quirky.agents/configure', {
        agent: 'claude',
        command: `'${provider.replaceAll("'", "'\\''")}'`,
        args: '--window-parity',
        env: { VAULT_CAPTURE_LOG: capture }
      })
      const listing = await features.h.call<PublicListResult>('quirky.vault/list', { host: 'local', agents: ['claude'], unlimited: true })
      const first = listing.sessions.find((session) => session.sessionId === 'keyboard-session-a')
      const second = listing.sessions.find((session) => session.sessionId === 'keyboard-session-b')
      if (!first || !second) throw new Error('The real keyboard fixtures were not discovered.')

      await features.h.call('quirky.vault/setView', { scope: 'all' })
      await runCommand(features, 'command:quirky.vault/open', { agent: 'claude', sessionId: first.sessionId })
      await reportOf<HistoryReport>(features, HISTORY_PANEL, 'keyboard source A selected', (state) => state.selectedId === first.id)
      const rowA = await until(features, () => features!.win.document.querySelector<HTMLElement>(`[data-vault-session-row=\"${first.id}\"]`))
      await press('down', rowA)
      await reportOf<HistoryReport>(features, HISTORY_PANEL, 'Down selects source B', (state) => state.selectedId === second.id)
      const rowB = await until(features, () => features!.win.document.querySelector<HTMLElement>(`[data-vault-session-row=\"${second.id}\"]`))
      await press('enter', rowB)
      await waitFor('the owned provider process to record its invocation', async () => existsSync(capture) ? true : undefined)
      const invocation = readFileSync(capture, 'utf8').trim().split('\n')
      expect(invocation[0]).toBe(canonicalSource)
      expect(invocation.filter((argument) => argument === '--resume')).toHaveLength(1)
      expect(invocation.at(-1)).toBe(second.sessionId)
    } finally {
      await features?.stop()
      rmSync(source, { recursive: true, force: true })
    }
  },
  FEATURE_MS
)
test(
  'SC-23: authenticated contributed hosts have individual Settings controls and Enable all runs local first',
  async () => {
    const localSource = sourceHome()
    let local: Features | undefined
    let remote: VaultRig | undefined
    const pluginRoots: string[] = []
    try {
      local = await makeFeatures(localSource)
      remote = await VaultRig.start()
      const runtime = remote.h.runtime
      if (!runtime) throw new Error('The second real daemon did not publish its runtime endpoint.')
      const healthyPlugin = createWindowVaultHostForwarder({
        pluginId: 'test.vault-window-healthy',
        label: 'Healthy remote fixture',
        remoteUrl: rpcUrl(runtime)
      })
      const unavailablePlugin = createWindowVaultHostForwarder({
        pluginId: 'test.vault-window-unavailable',
        label: 'Unavailable remote fixture',
        remoteUrl: 'ws://127.0.0.1:1'
      })
      pluginRoots.push(healthyPlugin.root, unavailablePlugin.root)
      await local.h.call('plugin.install', { path: healthyPlugin.directory, yes: true })
      await local.h.call('plugin.install', { path: unavailablePlugin.directory, yes: true })
      const contributions = await local.h.call<{ id: string; plugin: string }[]>('plugin.contributions', { kind: 'vault-host' })
      const healthy = contributions.find((entry) => entry.plugin === 'test.vault-window-healthy')
      const unavailable = contributions.find((entry) => entry.plugin === 'test.vault-window-unavailable')
      if (!healthy || !unavailable) throw new Error('The effective authenticated host contributions were not installed.')

      await runCommand(local, 'command:quirky.vault/settings')
      const settingsReport = await reportOf<SettingsReport>(local, SEARCH_SETTINGS_VIEW, 'real and unavailable host status', (state) => state.failedHosts.includes(unavailable.id))
      expect(settingsReport.pollIntervalMs).toBe(10_000)
      const document = local.win.document
      const rows = await until(local, () => {
        const hostRows = [...document.querySelectorAll<HTMLElement>('[data-vault-host-row]')]
        const healthyRow = hostRows.find((row) => row.dataset.vaultHostId === healthy.id)
        const unavailableRow = hostRows.find((row) => row.dataset.vaultHostId === unavailable.id)
        return healthyRow && unavailableRow ? { healthyRow, unavailableRow } : undefined
      })
      expect(rows.healthyRow.dataset.vaultHostOutcome).toBe('ok')
      expect(rows.unavailableRow.dataset.vaultHostOutcome).not.toBe('ok')
      expect(rows.unavailableRow.textContent).toContain('Unavailable')

      const enableAll = await until(local, () => document.querySelector<HTMLButtonElement>('[data-vault-enable-all]'))
      const refusal = local.rejectCalls('quirky.vault/setSearchEnabled', 'local enable refusal')
      try {
        enableAll.click()
        const error = await until(local, () => [...document.querySelectorAll<HTMLElement>('[role=\"alert\"]')].find((entry) => entry.textContent?.includes('local enable refusal')))
        expect(error.textContent).toContain('Could not enable local search')
      } finally {
        refusal.restore()
      }
      const localBeforeRemote = await local.h.call<{ status: SearchStatus }>('quirky.vault/searchStatus', { host: 'local' })
      const remoteBeforeEnable = await local.h.call<{ status: SearchStatus }>('quirky.vault/searchStatus', { host: healthy.id })
      expect(localBeforeRemote.status.enabled).toBe(false)
      expect(remoteBeforeEnable.status.enabled).toBe(false)

      enableAll.click()
      await waitFor('local and healthy remote indexes enabled by authenticated UI', async () => {
        const [localStatus, remoteStatus] = await Promise.all([
          local!.h.call<{ status: SearchStatus }>('quirky.vault/searchStatus', { host: 'local' }),
          local!.h.call<{ status: SearchStatus }>('quirky.vault/searchStatus', { host: healthy.id })
        ])
        return localStatus.status.enabled && remoteStatus.status.enabled ? true : undefined
      }, 30_000)
      const enabledRemoteSwitch = await until(local, () => {
        const currentRow = [...document.querySelectorAll<HTMLElement>('[data-vault-host-row]')].find((row) => row.dataset.vaultHostId === healthy.id)
        const currentSwitch = currentRow?.querySelector<HTMLInputElement>('[data-vault-host-switch]')
        return currentSwitch?.checked ? currentSwitch : undefined
      })
      enabledRemoteSwitch.click()
      await waitFor('remote switch disabled the actual remote index', async () => (!(await local!.h.call<{ status: SearchStatus }>('quirky.vault/searchStatus', { host: healthy.id })).status.enabled ? true : undefined), 30_000)
      const disabledRemoteSwitch = await until(local, () => {
        const currentRow = [...document.querySelectorAll<HTMLElement>('[data-vault-host-row]')].find((row) => row.dataset.vaultHostId === healthy.id)
        const currentSwitch = currentRow?.querySelector<HTMLInputElement>('[data-vault-host-switch]')
        return currentSwitch && !currentSwitch.checked ? currentSwitch : undefined
      })
      disabledRemoteSwitch.click()
      await waitFor('remote switch re-enabled the actual remote index', async () => ((await local!.h.call<{ status: SearchStatus }>('quirky.vault/searchStatus', { host: healthy.id })).status.enabled ? true : undefined), 30_000)
    } finally {
      await local?.stop()
      await remote?.cleanup()
      for (const root of pluginRoots.splice(0).reverse()) removeWindowVaultHostForwarder(root)
      rmSync(localSource, { recursive: true, force: true })
    }
  },
  FEATURE_MS
)

