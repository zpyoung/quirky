import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import type { Ask, AskAnswer, AskEnvelope, AskQuestion as AskQuestionSpec, MobileMarkdownDocument, MobileWorkspaceTab, PtySnapshot, Session, Worktree } from '@quirky/protocol'
import type { MobilePageBridge, MobileRoute } from '../contracts'
import { PageError, PageModal, errorMessage, statusLabel } from './components'
import { BrowserWatchView } from './BrowserWatchView'
import { MarkdownTabView } from './MarkdownTabView'
import { TerminalView, type PhoneTerminalLease, type TerminalViewHandle } from './TerminalView'

type SessionRoute = Extract<MobileRoute, { kind: 'session' }>
type Props = {
  bridge: MobilePageBridge
  route: SessionRoute
  connected: boolean
  onNavigate(route: MobileRoute | { kind: 'home' }): Promise<void>
  onReport(state: Record<string, unknown>): void
}
type AgentChoice = { id: string; label: string; installed: boolean; enabled: boolean; isDefault: boolean; resumable: boolean }
type AgentCatalog = { defaultAgent: string | null; agents: AgentChoice[] }
type QuickCommand = { id: string; label: string; text: string }
type PageShortcut = { id: string; label: string; text: string }
type ReadResult = { lines: string[]; cols: number; rows: number; alt: boolean }
type LeaseResult = { terminals: PhoneTerminalLease[] }
type CloseResult = { ok: true } | { ok: false; reason: string }
type CloseDialog = { sessionIds: string[]; descriptions: string[]; leaveAfterClose: boolean }
type AnswerDraft = { selected: string[]; freeText: string; text: string; confirm: boolean | null }

const QUICK_PREFIX = 'quirky.mobile.terminal.quick.v1:'
const SHORTCUT_PREFIX = 'quirky.mobile.terminal.shortcuts.v1:'
const MAX_COPY_CHARS = 200_000

function viewportCells(): { cols: number; rows: number } {
  const width = typeof window === 'undefined' ? 390 : window.innerWidth
  const height = typeof window === 'undefined' ? 844 : window.innerHeight
  return {
    cols: Math.max(20, Math.min(160, Math.floor((width - 28) / 8))),
    rows: Math.max(10, Math.min(80, Math.floor((height - 230) / 18)))
  }
}

function parseCommands(raw: string | null): QuickCommand[] {
  if (!raw) return []
  try {
    const value: unknown = JSON.parse(raw)
    if (!Array.isArray(value)) return []
    return value.filter((item): item is QuickCommand => typeof item === 'object' && item !== null &&
      'id' in item && typeof item.id === 'string' && item.id.length <= 100 &&
      'label' in item && typeof item.label === 'string' && item.label.length <= 80 &&
      'text' in item && typeof item.text === 'string' && item.text.length <= 4000).slice(0, 40)
  } catch {
    return []
  }
}

function parseShortcuts(raw: string | null): PageShortcut[] {
  if (!raw) return []
  try {
    const value: unknown = JSON.parse(raw)
    if (!Array.isArray(value)) return []
    return value.filter((item): item is PageShortcut => typeof item === 'object' && item !== null &&
      'id' in item && typeof item.id === 'string' && item.id.length <= 100 &&
      'label' in item && typeof item.label === 'string' && item.label.length <= 60 &&
      'text' in item && typeof item.text === 'string' && item.text.length <= 1000).slice(0, 32)
  } catch {
    return []
  }
}

function askTitle(ask: Ask): string {
  return ask.spec.title?.trim() || 'A question needs your answer'
}

function answerDrafts(ask: Ask): Record<string, AnswerDraft> {
  const values: Record<string, AnswerDraft> = {}
  for (const question of ask.spec.questions) {
    const partial = ask.partial[question.id]
    if (question.type === 'select') {
      const selected = partial?.selected ?? (question.default === undefined ? [] : [question.default])
      values[question.id] = {
        selected: [...selected],
        freeText: selected.length > 0 ? partial?.note ?? partial?.other ?? '' : partial?.other ?? '',
        text: '',
        confirm: null
      }
    } else if (question.type === 'multiselect') {
      const selected = partial?.selected ?? question.default ?? []
      values[question.id] = {
        selected: [...selected],
        freeText: partial?.other ?? '',
        text: '',
        confirm: null
      }
    } else if (question.type === 'text') {
      values[question.id] = { selected: [], freeText: '', text: partial?.draft ?? question.default ?? '', confirm: null }
    } else if (question.type === 'number') {
      values[question.id] = { selected: [], freeText: '', text: partial?.draft ?? (question.default === undefined ? '' : String(question.default)), confirm: null }
    } else if (question.type === 'date') {
      values[question.id] = { selected: [], freeText: '', text: partial?.draft ?? question.default ?? '', confirm: null }
    } else {
      values[question.id] = { selected: [], freeText: '', text: '', confirm: partial?.confirm ?? question.default ?? null }
    }
  }
  return values
}

function validAskDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function buildAskSubmission(ask: Ask, drafts: Record<string, AnswerDraft>) {
  const answers: Record<string, AskAnswer> = {}
  const skipped: string[] = []
  const errors: Record<string, string> = {}
  for (const question of ask.spec.questions) {
    const draft = drafts[question.id] ?? { selected: [], freeText: '', text: '', confirm: null }
    const requiredOrSkipped = () => {
      if (question.required) errors[question.id] = `Answer “${question.header || question.question}” before submitting.`
      else skipped.push(question.id)
    }
    if (question.type === 'select') {
      const option = question.options.find((item) => item.value === draft.selected[0])
      const freeText = draft.freeText.trim()
      if (option) answers[question.id] = { value: option.value, label: option.label, ...(freeText ? { note: freeText } : {}), source: 'option' }
      else if (freeText) answers[question.id] = { value: freeText, source: 'other' }
      else requiredOrSkipped()
    } else if (question.type === 'multiselect') {
      const options = question.options.filter((item) => draft.selected.includes(item.value))
      const other = draft.freeText.trim()
      if (options.length === 0 && !other) {
        requiredOrSkipped()
      } else {
        answers[question.id] = {
          values: options.map((item) => item.value),
          labels: options.map((item) => item.label),
          ...(other ? { other } : {}),
          source: 'options'
        }
      }
    } else if (question.type === 'text') {
      const value = draft.text
      if (!value.trim()) {
        requiredOrSkipped()
        continue
      }
      if (question.format === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
        errors[question.id] = 'Enter a valid email address.'
        continue
      }
      if (question.format === 'url' && !/^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(value)) {
        errors[question.id] = 'Enter a valid URL.'
        continue
      }
      if (question.pattern) {
        let matches = false
        try { matches = value.length <= 200 && new RegExp(question.pattern).test(value) } catch { /* the daemon validates the stored question spec */ }
        if (!matches) {
          errors[question.id] = "Doesn't match the expected format."
          continue
        }
      }
      answers[question.id] = { value, source: 'input' }
    } else if (question.type === 'number') {
      const raw = draft.text.trim()
      if (!raw) {
        requiredOrSkipped()
        continue
      }
      const value = Number(raw)
      if (!Number.isFinite(value)) errors[question.id] = 'Enter a number.'
      else if (question.integer && !Number.isInteger(value)) errors[question.id] = 'Enter a whole number.'
      else if (question.min !== undefined && value < question.min) errors[question.id] = `Enter a number of at least ${question.min}.`
      else if (question.max !== undefined && value > question.max) errors[question.id] = `Enter a number of at most ${question.max}.`
      else answers[question.id] = { value, source: 'input' }
    } else if (question.type === 'date') {
      const value = draft.text.trim()
      if (!value) requiredOrSkipped()
      else if (!validAskDate(value)) errors[question.id] = 'Enter a valid date.'
      else answers[question.id] = { value, source: 'input' }
    } else if (draft.confirm === null) {
      requiredOrSkipped()
    } else {
      answers[question.id] = { value: draft.confirm, source: 'input' }
    }
  }
  return { answers, skipped, errors }
}

export function SessionPage({ bridge, route, connected, onNavigate, onReport }: Props) {
  const [sessions, setSessions] = useState<Session[]>([])
  const [worktrees, setWorktrees] = useState<Worktree[]>([])
  const [workspaceTabs, setWorkspaceTabs] = useState<MobileWorkspaceTab[]>([])
  const [asks, setAsks] = useState<Ask[]>([])
  const [showResolvedAsks, setShowResolvedAsks] = useState(false)
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(route.sessionId ?? null)
  const [selectedWorkspaceTabId, setSelectedWorkspaceTabId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [pageError, setPageError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [askScope, setAskScope] = useState<'session' | 'workspace'>(route.sessionId ? 'session' : 'workspace')
  const [askError, setAskError] = useState<string | null>(null)
  const [terminalLease, setTerminalLease] = useState<PhoneTerminalLease | null>(null)
  const [displayMode, setDisplayMode] = useState<'phone' | 'desktop'>('phone')
  const [actionsOpen, setActionsOpen] = useState(false)
  const [newTabOpen, setNewTabOpen] = useState(false)
  const [agentChoices, setAgentChoices] = useState<AgentChoice[]>([])
  const [agentLoading, setAgentLoading] = useState(false)
  const [agentError, setAgentError] = useState<string | null>(null)
  const [startingAgent, setStartingAgent] = useState(false)
  const [creatingMarkdown, setCreatingMarkdown] = useState(false)
  const [creatingBrowser, setCreatingBrowser] = useState(false)
  const [tabCreationError, setTabCreationError] = useState<string | null>(null)
  const [manageTabs, setManageTabs] = useState(false)
  const [selectedTabIds, setSelectedTabIds] = useState<string[]>([])
  const [renameDialog, setRenameDialog] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const [renameBusy, setRenameBusy] = useState(false)
  const [renameError, setRenameError] = useState<string | null>(null)
  const [closeDialog, setCloseDialog] = useState<CloseDialog | null>(null)
  const [closeBusy, setCloseBusy] = useState(false)
  const [closeError, setCloseError] = useState<string | null>(null)
  const [copyBusy, setCopyBusy] = useState(false)
  const [copyError, setCopyError] = useState<string | null>(null)
  const [quickCommands, setQuickCommands] = useState<QuickCommand[]>([])
  const [customShortcuts, setCustomShortcuts] = useState<PageShortcut[]>([])
  const [commandStorageReady, setCommandStorageReady] = useState(false)
  const [commandsOpen, setCommandsOpen] = useState(false)
  const [shortcutOpen, setShortcutOpen] = useState(false)
  const [commandLabel, setCommandLabel] = useState('')
  const [commandText, setCommandText] = useState('')
  const [shortcutLabel, setShortcutLabel] = useState('')
  const [shortcutText, setShortcutText] = useState('')
  const [commandDraft, setCommandDraft] = useState('')
  const [commandBusy, setCommandBusy] = useState(false)
  const [commandError, setCommandError] = useState<string | null>(null)
  const terminalRef = useRef<TerminalViewHandle>(null)
  const selectedSessionRef = useRef<string | null>(selectedSessionId)
  const leaseQueries = useRef(new Set<string>())
  const loadSequence = useRef(0)
  const loadInFlight = useRef<{ key: string; request: number } | null>(null)
  const terminalGranted = bridge.init.grants.includes('terminal')
  const storageGranted = bridge.init.grants.includes('storage')
  const clipboardReadGranted = bridge.init.grants.includes('clipboard.read')
  const clipboardWriteGranted = bridge.init.grants.includes('clipboard.write')
  const rpcGranted = bridge.init.grants.includes('rpc')
  const pageActiveNow = useCallback(() => connected && bridge.state.phase === 'connected' &&
    (typeof document === 'undefined' || document.visibilityState !== 'hidden'), [bridge, connected])
  const canMutateNow = useCallback(() => pageActiveNow() && rpcGranted, [pageActiveNow, rpcGranted])
  const canMutate = canMutateNow()

  useEffect(() => {
    setSelectedSessionId(route.sessionId ?? null)
    setSelectedWorkspaceTabId(null)
    setAskScope(route.sessionId ? 'session' : 'workspace')
  }, [route.worktreeId, route.sessionId])

  useEffect(() => { selectedSessionRef.current = selectedSessionId }, [selectedSessionId])

  useEffect(() => {
    let active = true
    if (!storageGranted) {
      setCommandStorageReady(true)
      return () => { active = false }
    }
    void Promise.all([
      bridge.storage.get(`${QUICK_PREFIX}${bridge.init.host.id}`),
      bridge.storage.get(`${SHORTCUT_PREFIX}${bridge.init.host.id}`)
    ]).then(([commands, shortcuts]) => {
      if (!active) return
      setQuickCommands(parseCommands(commands))
      setCustomShortcuts(parseShortcuts(shortcuts))
      setCommandStorageReady(true)
    }).catch(() => {
      if (active) setCommandStorageReady(true)
    })
    return () => { active = false }
  }, [bridge, storageGranted])

  useEffect(() => {
    if (!commandStorageReady || !storageGranted) return
    void bridge.storage.set(`${QUICK_PREFIX}${bridge.init.host.id}`, JSON.stringify(quickCommands)).catch((cause) => setCommandError(errorMessage(cause, 'Could not save quick commands.')))
  }, [bridge, commandStorageReady, storageGranted, quickCommands])

  useEffect(() => {
    if (!commandStorageReady || !storageGranted) return
    void bridge.storage.set(`${SHORTCUT_PREFIX}${bridge.init.host.id}`, JSON.stringify(customShortcuts)).catch((cause) => setCommandError(errorMessage(cause, 'Could not save shortcuts.')))
  }, [bridge, commandStorageReady, storageGranted, customShortcuts])

  const refreshLease = useCallback(async (sessionId: string) => {
    if (!pageActiveNow() || leaseQueries.current.has(sessionId)) return
    leaseQueries.current.add(sessionId)
    try {
      const result = await bridge.call<LeaseResult>('quirky.terminal/mobileState', { session: sessionId }, { timeoutMs: 5000 })
      if (selectedSessionRef.current !== sessionId || !pageActiveNow()) return
      const next = result.terminals.find((item) => item.session === sessionId) ?? null
      setTerminalLease(next)
      setDisplayMode(next && (next.controlledByCaller || next.driver !== null || next.phoneFit) ? 'phone' : 'desktop')
    } catch (cause) {
      if (selectedSessionRef.current === sessionId && pageActiveNow()) setActionError(errorMessage(cause, 'Could not read terminal control state.'))
    } finally {
      leaseQueries.current.delete(sessionId)
    }
  }, [bridge, pageActiveNow])

  const load = useCallback(async () => {
    if (!pageActiveNow()) {
      loadSequence.current += 1
      loadInFlight.current = null
      setLoading(false)
      return
    }
    const key = `${route.worktreeId}\u0000${showResolvedAsks ? 'all' : 'pending'}`
    if (loadInFlight.current?.key === key) return
    const currentRequest = ++loadSequence.current
    loadInFlight.current = { key, request: currentRequest }
    setLoading(true)
    try {
      const calls: Promise<unknown>[] = [
        bridge.call<Session[]>('quirky.session/list', { worktree: route.worktreeId }),
        bridge.call<Ask[]>('quirky.ask/list', { pendingOnly: !showResolvedAsks })
      ]
      if (route.worktreeId !== 'floating') {
        calls.push(bridge.call<Worktree[]>('quirky.worktree/list', {}))
        calls.push(bridge.call<MobileWorkspaceTab[]>('quirky.mobile/sessionTabs', { worktree: route.worktreeId }))
      }
      const [sessionResult, askResult, worktreeResult, tabResult] = await Promise.all(calls)
      if (currentRequest !== loadSequence.current || !pageActiveNow()) return
      setSessions(sessionResult as Session[])
      setAsks(askResult as Ask[])
      if (route.worktreeId !== 'floating' && Array.isArray(worktreeResult)) setWorktrees(worktreeResult as Worktree[])
      setWorkspaceTabs(route.worktreeId !== 'floating' && Array.isArray(tabResult) ? tabResult as MobileWorkspaceTab[] : [])
      setPageError(null)
    } catch (cause) {
      if (currentRequest === loadSequence.current && pageActiveNow()) setPageError(errorMessage(cause, 'Could not load this workspace.'))
    } finally {
      if (loadInFlight.current?.request === currentRequest) loadInFlight.current = null
      if (currentRequest === loadSequence.current) setLoading(false)
    }
  }, [bridge, pageActiveNow, route.worktreeId, showResolvedAsks])

  useEffect(() => { void load() }, [load])

  useEffect(() => {
    if (!connected) return
    const timer = window.setInterval(() => void load(), 5000)
    return () => window.clearInterval(timer)
  }, [connected, load])

  useEffect(() => {
    if (!connected || !terminalGranted || !selectedSessionId) return
    void refreshLease(selectedSessionId)
    const timer = window.setInterval(() => void refreshLease(selectedSessionId), 2000)
    return () => window.clearInterval(timer)
  }, [connected, terminalGranted, selectedSessionId, refreshLease])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), 4500)
    return () => window.clearTimeout(timer)
  }, [notice])

  const terminalSessions = useMemo(() => sessions.filter((session) => session.kind === 'terminal'), [sessions])
  const structuredCount = sessions.length - terminalSessions.length
  const selectedWorkspaceTab = workspaceTabs.find((tab) => tab.tabId === selectedWorkspaceTabId && tab.worktreeId === route.worktreeId) ?? null
  const selectedMarkdownTab = selectedWorkspaceTab?.kind === 'markdown' ? selectedWorkspaceTab : null
  const selectedBrowserTab = selectedWorkspaceTab?.kind === 'browser' ? selectedWorkspaceTab : null
  const selectedSession = selectedWorkspaceTabId === null
    ? terminalSessions.find((session) => session.id === selectedSessionId && session.worktreeId === route.worktreeId) ?? null
    : null
  const activeLease = selectedSession && terminalLease?.session === selectedSession.id ? terminalLease : null
  const ownsTerminal = canMutateNow() && terminalGranted && displayMode === 'phone' && activeLease?.controlledByCaller === true
  const currentWorktree = worktrees.find((worktree) => worktree.id === route.worktreeId)
  const title = route.worktreeId === 'floating' ? 'Floating workspace' : currentWorktree?.name ?? 'Workspace'
  const askSessions = useMemo(() => new Set(sessions.map((session) => session.id)), [sessions])
  const visibleAsks = useMemo(() => asks.filter((ask) => {
    if (askScope === 'session') return selectedSession !== null && ask.sessionId === selectedSession.id
    if (ask.worktreeId === route.worktreeId) return true
    return route.worktreeId === 'floating' && ask.sessionId !== null && askSessions.has(ask.sessionId)
  }), [asks, askScope, selectedSession, route.worktreeId, askSessions])

  useEffect(() => {
    if (!loading && selectedWorkspaceTabId && !workspaceTabs.some((tab) => tab.tabId === selectedWorkspaceTabId && tab.worktreeId === route.worktreeId)) {
      setSelectedWorkspaceTabId(null)
    }
  }, [loading, route.worktreeId, selectedWorkspaceTabId, workspaceTabs])

  useEffect(() => {
    if (!selectedWorkspaceTabId && !selectedSessionId && terminalSessions.length > 0) {
      const first = terminalSessions[0]!
      setSelectedSessionId(first.id)
      void onNavigate({ kind: 'session', worktreeId: route.worktreeId, sessionId: first.id })
    }
  }, [selectedWorkspaceTabId, selectedSessionId, terminalSessions, onNavigate, route.worktreeId])

  useEffect(() => {
    if (!loading && !selectedWorkspaceTabId && !selectedSessionId && terminalSessions.length === 0 && workspaceTabs.length > 0) {
      setSelectedWorkspaceTabId(workspaceTabs[0]!.tabId)
    }
  }, [loading, selectedWorkspaceTabId, selectedSessionId, terminalSessions.length, workspaceTabs])

  useEffect(() => {
    setTerminalLease(null)
    setDisplayMode('phone')
  }, [selectedSessionId])

  useEffect(() => {
    const reportState: Record<string, unknown> = {
      tabSessionIds: terminalSessions.slice(0, 256).map((session) => session.id),
      terminalVisible: selectedSession !== null,
      dockOpen: selectedSession !== null,
      sheetOpen: actionsOpen || newTabOpen || renameDialog || closeDialog !== null || commandsOpen || shortcutOpen,
      displayMode
    }
    if (selectedSession) reportState.selectedSessionId = selectedSession.id
    onReport(reportState)
  }, [onReport, terminalSessions, selectedSession, actionsOpen, newTabOpen, renameDialog, closeDialog, commandsOpen, shortcutOpen, displayMode])
  const loadRef = useRef(load)
  loadRef.current = load
  const onTerminalRestored = useCallback(() => { void loadRef.current() }, [])
  const onWorkspaceTabsChanged = useCallback(() => { void loadRef.current() }, [])
  const onWorkspaceTabClosed = useCallback(() => {
    setSelectedWorkspaceTabId(null)
    void loadRef.current()
  }, [])

  const selectSession = (sessionId: string, navigate = true) => {
    if (manageTabs) {
      setSelectedTabIds((current) => current.includes(sessionId) ? current.filter((id) => id !== sessionId) : [...current, sessionId])
      return
    }
    setSelectedWorkspaceTabId(null)
    setSelectedSessionId(sessionId)
    setActionError(null)
    if (navigate) void onNavigate({ kind: 'session', worktreeId: route.worktreeId, sessionId })
  }

  const selectWorkspaceTab = (tab: MobileWorkspaceTab) => {
    if (manageTabs) return
    setSelectedTabIds([])
    setSelectedWorkspaceTabId(tab.tabId)
    setSelectedSessionId(null)
    setActionError(null)
  }

  const openNewTab = () => {
    setAgentError(null)
    setAgentChoices([])
    setNewTabOpen(true)
  }
  const chooseWorkspaceTab = (tab: MobileWorkspaceTab) => {
    setWorkspaceTabs((current) => current.some((entry) => entry.tabId === tab.tabId)
      ? current.map((entry) => entry.tabId === tab.tabId ? tab : entry)
      : [...current, tab])
    setSelectedTabIds([])
    setManageTabs(false)
    setSelectedSessionId(null)
    setSelectedWorkspaceTabId(tab.tabId)
    setNewTabOpen(false)
    setTabCreationError(null)
  }

  const createMarkdownNote = async () => {
    if (!canMutateNow() || route.worktreeId === 'floating' || creatingMarkdown || creatingBrowser) return
    setCreatingMarkdown(true)
    setTabCreationError(null)
    try {
      const document = await bridge.call<MobileMarkdownDocument>('quirky.mobile/markdownCreate', { worktree: route.worktreeId })
      chooseWorkspaceTab({
        tabId: document.tabId, worktreeId: document.worktreeId, kind: 'markdown', title: document.title, dirty: document.dirty
      })
      setNotice('Markdown note created in the editor.')
      await load()
    } catch (cause) {
      setTabCreationError(errorMessage(cause, 'Could not create a Markdown note.'))
    } finally {
      setCreatingMarkdown(false)
    }
  }

  const createBrowserWatch = async () => {
    if (!canMutateNow() || route.worktreeId === 'floating' || creatingMarkdown || creatingBrowser) return
    setCreatingBrowser(true)
    setTabCreationError(null)
    try {
      const created = await bridge.call<{ tab: MobileWorkspaceTab; watchId: string }>('quirky.mobile/browserWatchCreate', { worktree: route.worktreeId })
      chooseWorkspaceTab(created.tab)
      setNotice('Browser (Chrome Watch) opened. This is an explicit agent-page Watch, not a Native browser mirror.')
      await load()
    } catch (cause) {
      setTabCreationError(errorMessage(cause, 'Could not open a Browser (Chrome Watch) tab.'))
    } finally {
      setCreatingBrowser(false)
    }
  }

  useEffect(() => {
    if (!newTabOpen) return
    let active = true
    setAgentChoices([])
    if (!pageActiveNow()) {
      setAgentLoading(false)
      setAgentError('Reconnect to the desktop to read available terminal agents.')
      return () => { active = false }
    }
    setAgentLoading(true)
    setAgentError(null)
    void bridge.call<AgentCatalog>('quirky.mobile/agentCatalog', {}).then((result) => {
      if (!active) return
      setAgentChoices(result.agents.filter((agent) => agent.id !== 'shell' && agent.installed && agent.enabled))
    }).catch((cause) => {
      if (active) setAgentError(errorMessage(cause, 'Could not read the available terminal agents.'))
    }).finally(() => { if (active) setAgentLoading(false) })
    return () => { active = false }
  }, [bridge, newTabOpen, pageActiveNow])

  const createSession = async (agent: string) => {
    if (!canMutateNow() || !terminalGranted || startingAgent) return
    setStartingAgent(true)
    setAgentError(null)
    try {
      const { cols, rows } = viewportCells()
      const created = await bridge.call<Session>('quirky.session/create', { worktree: route.worktreeId, agent, cols, rows })
      setNewTabOpen(false)
      setManageTabs(false)
      setSelectedTabIds([])
      setSelectedWorkspaceTabId(null)
      setSelectedSessionId(created.id)
      await onNavigate({ kind: 'session', worktreeId: route.worktreeId, sessionId: created.id })
      await load()
    } catch (cause) {
      setAgentError(errorMessage(cause, 'The desktop refused to start this terminal session.'))
    } finally {
      setStartingAgent(false)
    }
  }

  const updateLease = useCallback((next: PhoneTerminalLease | null) => {
    setTerminalLease(next)
    setDisplayMode(next && (next.controlledByCaller || next.driver !== null || next.phoneFit) ? 'phone' : 'desktop')
  }, [])
  const updateLeaseFromView = useCallback((next: PhoneTerminalLease | null) => {
    if (selectedSessionRef.current !== selectedSession?.id) return
    updateLease(next)
  }, [selectedSession?.id, updateLease])

  const takeControl = async () => {
    if (!selectedSession || !canMutateNow() || !terminalGranted) return
    setActionError(null)
    try {
      const dimensions = terminalRef.current?.fit() ?? viewportCells()
      await bridge.call('quirky.terminal/claim', { session: selectedSession.id, ...dimensions })
      await refreshLease(selectedSession.id)
    } catch (cause) {
      setActionError(errorMessage(cause, 'Could not claim terminal control.'))
    }
  }

  const toggleDisplayMode = async () => {
    if (!selectedSession || !canMutateNow() || !terminalGranted) return
    setActionError(null)
    try {
      if (displayMode === 'phone' && ownsTerminal) {
        await bridge.call('quirky.terminal/displayMode', { session: selectedSession.id, mode: 'desktop' })
        setDisplayMode('desktop')
      } else {
        const dimensions = terminalRef.current?.fit() ?? viewportCells()
        await bridge.call('quirky.terminal/displayMode', { session: selectedSession.id, mode: 'phone', ...dimensions })
        setDisplayMode('phone')
      }
      await refreshLease(selectedSession.id)
    } catch (cause) {
      setActionError(errorMessage(cause, 'Could not change the terminal display mode.'))
      await refreshLease(selectedSession.id)
    }
  }

  const focusTerminal = () => terminalRef.current?.focus()

  const writeTerminal = async (data: string) => {
    if (!selectedSession || !pageActiveNow() || !ownsTerminal) return
    setActionError(null)
    try {
      await bridge.call('quirky.terminal/write', { session: selectedSession.id, data })
      focusTerminal()
    } catch (cause) {
      setActionError(errorMessage(cause, 'Terminal input was refused.'))
      await refreshLease(selectedSession.id)
    }
  }

  const paste = async () => {
    if (!selectedSession || !pageActiveNow() || !ownsTerminal || !clipboardReadGranted) return
    setActionError(null)
    try {
      const text = await bridge.native.clipboardRead()
      if (!pageActiveNow() || !ownsTerminal) return
      if (text) await bridge.call('quirky.terminal/send', { session: selectedSession.id, text, enter: false })
      focusTerminal()
    } catch (cause) {
      setActionError(errorMessage(cause, 'Could not paste clipboard text into the terminal.'))
      await refreshLease(selectedSession.id)
    }
  }
  const submitCommand = async (text = commandDraft, enter = true) => {
    if (!selectedSession || !pageActiveNow() || !ownsTerminal || text.length === 0 || commandBusy) return
    setCommandBusy(true)
    setCommandError(null)
    try {
      await bridge.call('quirky.terminal/send', { session: selectedSession.id, text, enter })
      if (text === commandDraft) setCommandDraft('')
      focusTerminal()
    } catch (cause) {
      setCommandError(errorMessage(cause, 'The command was refused by the terminal.'))
      await refreshLease(selectedSession.id)
    } finally {
      setCommandBusy(false)
    }
  }

  const addQuickCommand = (event: FormEvent) => {
    event.preventDefault()
    const label = commandLabel.trim()
    const text = commandText
    if (!storageGranted || !label || !text.trim() || quickCommands.length >= 40) return
    setQuickCommands((current) => [...current, { id: crypto.randomUUID(), label, text }])
    setCommandLabel('')
    setCommandText('')
  }

  const addShortcut = (event: FormEvent) => {
    event.preventDefault()
    const label = shortcutLabel.trim()
    if (!storageGranted || !label || !shortcutText || customShortcuts.length >= 32) return
    setCustomShortcuts((current) => [...current, { id: crypto.randomUUID(), label, text: shortcutText }])
    setShortcutLabel('')
    setShortcutText('')
  }

  const renameSession = async (event: FormEvent) => {
    event.preventDefault()
    if (!selectedSession || !canMutateNow() || renameBusy) return
    const name = renameValue.trim()
    if (!name) {
      setRenameError('Enter a name before saving.')
      return
    }
    setRenameBusy(true)
    setRenameError(null)
    try {
      await bridge.call<Session>('quirky.session/setName', { session: selectedSession.id, name })
      setRenameDialog(false)
      setNotice('Session renamed.')
      await load()
    } catch (cause) {
      setRenameError(errorMessage(cause, 'Could not rename this session.'))
    } finally {
      setRenameBusy(false)
    }
  }

  const clearTerminal = async () => {
    if (!selectedSession || !canMutateNow() || !terminalGranted || !ownsTerminal) return
    setActionError(null)
    try {
      const result = await bridge.call<{ ok: boolean }>('quirky.terminal/clear', { session: selectedSession.id })
      if (!result.ok) throw new Error('The desktop did not confirm clearing terminal scrollback.')
      if (!pageActiveNow()) return
      try {
        const snapshot = await bridge.call<PtySnapshot>('quirky.terminal/snapshot', { session: selectedSession.id })
        if (!pageActiveNow()) return
        terminalRef.current?.applySnapshot(snapshot)
        setNotice('Terminal scrollback cleared on the desktop.')
      } catch (cause) {
        setActionError(`Terminal scrollback was cleared, but this phone could not refresh the screen: ${errorMessage(cause)}`)
      }
    } catch (cause) {
      setActionError(errorMessage(cause, 'Could not clear terminal scrollback.'))
    }
  }

  const prepareClose = async (sessionIds: string[], leaveAfterClose: boolean) => {
    if (!canMutateNow() || sessionIds.length === 0) return
    setActionsOpen(false)
    setCloseError(null)
    try {
      const descriptions = await Promise.all(sessionIds.map((sessionId) => bridge.call<string | null>('quirky.terminal/describeClose', { session: sessionId })))
      if (!pageActiveNow()) return
      setCloseDialog({ sessionIds, descriptions: descriptions.map((description) => description ?? ''), leaveAfterClose })
    } catch (cause) {
      if (pageActiveNow()) setCloseError(errorMessage(cause, 'Could not check whether closing these sessions would stop active work.'))
    }
  }

  const confirmClose = async () => {
    if (!closeDialog || !canMutateNow() || closeBusy) return
    setCloseBusy(true)
    setCloseError(null)
    const closed = new Set<string>()
    try {
      for (const sessionId of closeDialog.sessionIds) {
        if (!canMutateNow()) throw new Error('The desktop connection changed before the remaining sessions could be closed.')
        const result = await bridge.call<CloseResult>('quirky.session/close', { session: sessionId })
        if (result.ok !== true) throw new Error(`The desktop did not close session ${sessionId} (${result.reason}).`)
        closed.add(sessionId)
      }
      const leaveAfterClose = closeDialog.leaveAfterClose
      setCloseDialog(null)
      setManageTabs(false)
      setSelectedTabIds([])
      await load()
      if (leaveAfterClose) {
        await onNavigate({ kind: 'workspaces' })
      } else {
        const next = terminalSessions.find((session) => !closed.has(session.id))
        if (next) {
          setSelectedSessionId(next.id)
          await onNavigate({ kind: 'session', worktreeId: route.worktreeId, sessionId: next.id })
        } else {
          await onNavigate({ kind: 'workspaces' })
        }
      }
    } catch (cause) {
      setCloseError(errorMessage(cause, 'The desktop refused to close one or more sessions.'))
      await load()
    } finally {
      setCloseBusy(false)
    }
  }

  const copyAndLeave = async (sessionIds: string[]) => {
    if (!canMutateNow() || !terminalGranted || !clipboardWriteGranted || sessionIds.length === 0 || copyBusy) return
    setCopyBusy(true)
    setCopyError(null)
    try {
      const selected = terminalSessions.filter((session) => sessionIds.includes(session.id))
      const pages = await Promise.all(selected.map(async (session) => {
        const result = await bridge.call<ReadResult>('quirky.terminal/read', { session: session.id, lines: 50 })
        return `--- ${session.name || session.title} ---\n${result.lines.join('\n')}`
      }))
      if (!pageActiveNow()) return
      const text = pages.join('\n\n')
      if (text.length > MAX_COPY_CHARS) throw new Error('The selected terminal output is too large to copy at once. Select fewer tabs.')
      await bridge.native.clipboardWrite(text)
      await onNavigate({ kind: 'workspaces' })
    } catch (cause) {
      setCopyError(errorMessage(cause, 'Could not copy terminal output.'))
    } finally {
      setCopyBusy(false)
    }
  }

  const submitAsk = async (ask: Ask, answers: Record<string, unknown>, skipped: string[]) => {
    if (!canMutateNow()) return
    setAskError(null)
    try {
      const envelope = await bridge.call<AskEnvelope>('quirky.ask/answer', { askId: ask.id, answers, skipped })
      setShowResolvedAsks(true)
      setNotice(envelope.status === 'answered' ? 'Answer sent.' : `Answer saved as ${statusLabel(envelope.status)}.`)
      if (!pageActiveNow()) return
      const next = await bridge.call<Ask[]>('quirky.ask/list', { pendingOnly: false })
      if (pageActiveNow()) setAsks(next)
    } catch (cause) {
      setAskError(errorMessage(cause, 'This question could not be answered.'))
      setShowResolvedAsks(true)
      if (!pageActiveNow()) return
      try {
        const current = await bridge.call<Ask[]>('quirky.ask/list', { pendingOnly: false })
        if (pageActiveNow()) setAsks(current)
      } catch { /* keep the authoritative answer error visible */ }
    }
  }

  const refreshAsks = async () => {
    if (!pageActiveNow()) return
    setAskError(null)
    try {
      const current = await bridge.call<Ask[]>('quirky.ask/list', { pendingOnly: !showResolvedAsks })
      if (pageActiveNow()) setAsks(current)
    } catch (cause) {
      if (pageActiveNow()) setAskError(errorMessage(cause, 'Could not refresh questions.'))
    }
  }

  const activeName = selectedSession?.name || selectedSession?.title || selectedWorkspaceTab?.title || 'Terminal sessions'
  const sheetOpen = actionsOpen || newTabOpen || renameDialog || closeDialog !== null || commandsOpen || shortcutOpen

  return (
    <div className="qp-session-layout">
      <header className="qp-topbar">
        <button className="qp-icon-button" type="button" aria-label="Back to workspaces" onClick={() => void onNavigate({ kind: 'workspaces' })}>‹</button>
        <div className="qp-topbar__titles">
          <h1>{title}</h1>
          <p>{currentWorktree?.branch || (route.worktreeId === 'floating' ? 'Floating workspace' : `${terminalSessions.length + workspaceTabs.length} workspace tabs`)} · {terminalSessions.length + workspaceTabs.length} {terminalSessions.length + workspaceTabs.length === 1 ? 'tab' : 'tabs'}</p>
        </div>
        <button className="qp-button qp-button--primary" type="button" disabled={!canMutate} onClick={openNewTab}>New Tab</button>
        <button className="qp-icon-button" type="button" aria-label="More session actions" aria-expanded={actionsOpen} onClick={() => setActionsOpen(true)}>⋯</button>
      </header>
      <div className="qp-session-header">
        <div className="qp-session-header__title">
          <strong>{activeName}</strong>
          <small>{selectedSession ? `${selectedSession.agent} · ${statusLabel(selectedSession.status)}` : selectedMarkdownTab ? `${selectedMarkdownTab.dirty ? 'Unsaved Markdown' : 'Markdown'} · editor buffer` : selectedBrowserTab ? selectedBrowserTab.browserMode === 'watch' ? 'Browser · Chrome Watch' : 'Browser · Native unavailable on phone' : loading ? 'Loading workspace tabs…' : 'Select a workspace tab or create a new one.'}</small>
        </div>
        <button className="qp-button qp-button--quiet" type="button" aria-pressed={manageTabs} onClick={() => {
          setManageTabs((value) => !value)
          setSelectedTabIds([])
        }}>{manageTabs ? 'Done' : 'Manage terminal tabs'}</button>
      </div>
      {pageError && <div className="qp-content"><PageError>{pageError}</PageError></div>}
      {actionError && <div className="qp-content"><PageError>{actionError}</PageError></div>}
      {notice && <div className="qp-content"><div className="qp-error" role="status">{notice}</div></div>}
      <div className="qp-tabs" role="tablist" aria-label="Workspace tabs">
        {terminalSessions.map((session) => {
          const active = session.id === selectedSession?.id
          const selected = selectedTabIds.includes(session.id)
          return <button
            className="qp-tab"
            key={session.id}
            type="button"
            role="tab"
            aria-selected={active}
            aria-pressed={manageTabs ? selected : undefined}
            onClick={() => selectSession(session.id)}
          >
            {manageTabs && <span aria-hidden="true">{selected ? '☑' : '☐'} </span>}
            <span className="qp-tab__name">{session.name || session.title}</span>
            <span className="qp-chip qp-chip--muted">{statusLabel(session.status)}</span>
          </button>
        })}
        {workspaceTabs.map((tab) => {
          const active = tab.tabId === selectedWorkspaceTabId
          const label = tab.kind === 'markdown' ? 'Markdown' : tab.browserMode === 'watch' ? 'Chrome Watch' : 'Native browser'
          return <button
            className="qp-tab"
            key={tab.tabId}
            type="button"
            role="tab"
            aria-selected={active}
            disabled={manageTabs}
            onClick={() => selectWorkspaceTab(tab)}
          >
            <span className="qp-tab__name">{tab.title}</span>
            <span className="qp-chip qp-chip--muted">{label}</span>
            {tab.dirty && <span aria-label="Unsaved changes">●</span>}
          </button>
        })}
        <button className="qp-icon-button" type="button" aria-label="New Tab" disabled={!canMutate} onClick={openNewTab}>＋</button>
      </div>
      <div className="qp-session-body">
        {structuredCount > 0 && <div className="qp-error" role="note">{structuredCount} structured {structuredCount === 1 ? 'session is' : 'sessions are'} not shown here. This phone view supports real terminal sessions and asks, not native chat.</div>}
        {pageError && sessions.length === 0 && workspaceTabs.length === 0 ? <div className="qp-session-empty qp-empty"><strong>Workspace unavailable</strong>Reconnect or return to the workspace list and retry.</div> : null}
        {selectedMarkdownTab && <MarkdownTabView
          key={selectedMarkdownTab.tabId}
          bridge={bridge}
          worktreeId={route.worktreeId}
          tab={selectedMarkdownTab}
          canMutate={canMutate}
          canCopy={clipboardWriteGranted}
          onTabsChanged={onWorkspaceTabsChanged}
          onClosed={onWorkspaceTabClosed}
        />}
        {selectedBrowserTab && <BrowserWatchView
          key={selectedBrowserTab.tabId}
          bridge={bridge}
          worktreeId={route.worktreeId}
          tab={selectedBrowserTab}
          canMutate={canMutate}
          onTabsChanged={onWorkspaceTabsChanged}
          onClosed={onWorkspaceTabClosed}
        />}
        {selectedSession && terminalGranted ? (
          <TerminalView
            key={selectedSession.id}
            ref={terminalRef}
            bridge={bridge}
            session={selectedSession}
            connected={pageActiveNow()}
            canDrive={ownsTerminal}
            displayMode={displayMode}
            lease={activeLease}
            textScale={bridge.init.preferences.terminalTextScale}
            onLease={updateLeaseFromView}
            onRestored={onTerminalRestored}
          />
        ) : selectedSession ? (
          <div className="qp-session-empty qp-empty" role="alert"><strong>Terminal view unavailable</strong>This page bundle did not receive the terminal grant; no terminal stream is opened.</div>
        ) : !selectedSession && !selectedWorkspaceTab && selectedWorkspaceTabId ? (
          <div className="qp-session-empty qp-empty"><strong>Workspace tab unavailable</strong>Refresh to load the actual tab identities for this worktree.</div>
        ) : !selectedSession && !selectedWorkspaceTab && terminalSessions.length === 0 && workspaceTabs.length === 0 ? (
          <div className="qp-session-empty qp-empty">
            <strong>{loading ? 'Loading workspace tabs…' : 'No workspace tabs yet'}</strong>
            {loading ? 'Reading real terminal and editor tabs from this workspace.' : 'Create a terminal, Markdown note, or explicit Browser (Chrome Watch) tab.'}
            {!loading && <div className="qp-sheet__footer"><button className="qp-button qp-button--primary" type="button" disabled={!canMutate} onClick={openNewTab}>New Tab</button></div>}
          </div>
        ) : !selectedSession && !selectedWorkspaceTab && terminalSessions.length === 0 && workspaceTabs.length > 0 ? (
          <div className="qp-session-empty qp-empty"><strong>Select a workspace tab</strong>Choose a Markdown or Browser tab above.</div>
        ) : !selectedSession && !selectedWorkspaceTab && selectedSessionId ? (
          <div className="qp-session-empty qp-empty"><strong>Session unavailable</strong>This session is not in the current workspace list. Refresh to load the current tabs.</div>
        ) : null}
        {selectedSession && (
          <div className="qp-terminal-stale" role="status">
            {!pageActiveNow() ? 'Disconnected · terminal output and session data may be stale.' : !activeLease ? 'Terminal control state is not available yet.' : activeLease.controlledByCaller ? 'This phone controls terminal input.' : activeLease.driver ? `${activeLease.driver.name || 'Another phone'} controls terminal input. Output remains visible.` : 'Desktop control is active. Reclaim the terminal explicitly before typing.'}
          </div>
        )}
        <section className="qp-ask-card" aria-label="Agent questions">
          <div className="qp-ask-card__scope">
            <button className="qp-chip" type="button" aria-pressed={askScope === 'session'} disabled={!selectedSession} onClick={() => setAskScope('session')}>This session</button>
            <button className="qp-chip" type="button" aria-pressed={askScope === 'workspace'} onClick={() => setAskScope('workspace')}>Workspace</button>
            <button className="qp-chip" type="button" aria-pressed={showResolvedAsks} disabled={!pageActiveNow()} onClick={() => setShowResolvedAsks((value) => !value)}>{showResolvedAsks ? 'Show pending only' : 'Show resolved'}</button>
            <button className="qp-icon-button" type="button" aria-label="Refresh questions" disabled={!pageActiveNow()} onClick={() => void refreshAsks()}>↻</button>
          </div>
          {askError && <p className="qp-ask-card__error" role="alert">{askError}</p>}
          {visibleAsks.length === 0 ? <p className="qp-dialog-copy">{loading ? 'Loading questions…' : `No ${showResolvedAsks ? 'recent' : 'pending'} questions in this ${askScope === 'session' ? 'session' : 'workspace'}.`}</p> : visibleAsks.map((ask) => (
            <AskCard key={ask.id} ask={ask} canMutate={canMutate} onSubmit={submitAsk} />
          ))}
        </section>
      </div>
      <footer className="qp-session-dock" aria-label="Terminal command dock">
        {selectedSession && (
          <>
            <div className="qp-dock-row">
              <button className="qp-icon-button" type="button" aria-label={displayMode === 'phone' && ownsTerminal ? 'Use desktop terminal size' : 'Fit terminal to phone'} disabled={!canMutate || !terminalGranted} onClick={() => void toggleDisplayMode()}>{displayMode === 'phone' ? '▣' : '▱'}</button>
              {!ownsTerminal && <button className="qp-button qp-button--primary" type="button" disabled={!canMutate || !terminalGranted} onClick={() => void takeControl()}>Take control</button>}
              <button className="qp-icon-button" type="button" aria-label="Focus terminal keyboard" disabled={!terminalGranted} onClick={focusTerminal}>⌨</button>
              <button className="qp-button" type="button" aria-label="Focus terminal" disabled={!terminalGranted} onClick={focusTerminal}>Keyboard</button>
              <button className="qp-button" type="button" disabled={!ownsTerminal || !clipboardReadGranted} onClick={() => void paste()}>Paste</button>
              <button className="qp-button" type="button" disabled={!ownsTerminal} onClick={() => void writeTerminal('\u001b')}>Esc</button>
              <button className="qp-button" type="button" disabled={!ownsTerminal} onClick={() => void writeTerminal('\t')}>Tab</button>
              <button className="qp-button" type="button" disabled={!ownsTerminal} onClick={() => void writeTerminal('\r')}>Enter</button>
              <button className="qp-button" type="button" disabled={!ownsTerminal} onClick={() => void writeTerminal('\u001b[Z')}>Shift+Tab</button>
            </div>
            <div className="qp-dock-row">
              <input className="qp-dock-input" aria-label="Terminal command" placeholder={ownsTerminal ? 'Type a command…' : 'Take control to send input'} value={commandDraft} disabled={!ownsTerminal}
                autoComplete={bridge.init.preferences.autocomplete ? 'on' : 'off'}
                autoCorrect={bridge.init.preferences.autocomplete ? 'on' : 'off'}
                autoCapitalize="none" spellCheck={bridge.init.preferences.autocomplete}
                onChange={(event) => setCommandDraft(event.currentTarget.value)} onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submitCommand() }
                }} />
              <button className="qp-button qp-button--primary" type="button" disabled={!ownsTerminal || commandBusy || !commandDraft} onClick={() => void submitCommand()}>{commandBusy ? 'Sending…' : 'Send'}</button>
              <button className="qp-button" type="button" disabled={!ownsTerminal} onClick={() => setCommandsOpen(true)}>Quick commands</button>
              <button className="qp-button" type="button" disabled={!ownsTerminal} onClick={() => setShortcutOpen(true)}>Shortcuts</button>
              <button className="qp-button" type="button" disabled={!ownsTerminal} onClick={() => void clearTerminal()}>Clear</button>
            </div>
            {commandError && <div className="qp-terminal-stale" role="alert">{commandError}</div>}
          </>
        )}
        {manageTabs && <div className="qp-dock-row">
          <span className="qp-count">{selectedTabIds.length} selected</span>
          <button className="qp-button" type="button" disabled={selectedTabIds.length === 0 || copyBusy || !canMutate || !terminalGranted || !clipboardWriteGranted} onClick={() => void copyAndLeave(selectedTabIds)}>{copyBusy ? 'Copying…' : 'Copy & leave'}</button>
          <button className="qp-button qp-button--danger" type="button" disabled={selectedTabIds.length === 0 || !canMutate} onClick={() => void prepareClose(selectedTabIds, true)}>Discard & leave</button>
          <button className="qp-button" type="button" onClick={() => setSelectedTabIds(terminalSessions.map((session) => session.id))}>Select all</button>
        </div>}
        {copyError && <div className="qp-terminal-stale" role="alert">{copyError}</div>}
      </footer>

      {actionsOpen && <PageModal title="Session actions" labelledBy="qp-session-actions-title" onClose={() => setActionsOpen(false)}>
        <div className="qp-choice-list">
          <button className="qp-button" type="button" disabled={!selectedSession || !canMutate} onClick={() => {
            if (!selectedSession) return
            setRenameValue(selectedSession.name || selectedSession.title)
            setRenameError(null)
            setActionsOpen(false)
            setRenameDialog(true)
          }}>Rename session</button>
          <button className="qp-button" type="button" disabled={!selectedSession || !ownsTerminal} onClick={() => void clearTerminal()}>Clear terminal</button>
          <button className="qp-button" type="button" disabled={!selectedSession || !canMutate} onClick={() => selectedSession && void prepareClose([selectedSession.id], false)}>Close tab</button>
          <button className="qp-button" type="button" disabled={!selectedSession || !canMutate || !terminalGranted || !clipboardWriteGranted || copyBusy} onClick={() => selectedSession && void copyAndLeave([selectedSession.id])}>Copy & leave</button>
          <button className="qp-button qp-button--danger" type="button" disabled={!selectedSession || !canMutate} onClick={() => selectedSession && void prepareClose([selectedSession.id], true)}>Discard & leave</button>
          <button className="qp-button" type="button" onClick={() => { setActionsOpen(false); setManageTabs(true); setSelectedTabIds([]) }}>Manage tabs</button>
        </div>
        {closeError && <PageError>{closeError}</PageError>}
        {copyError && <PageError>{copyError}</PageError>}
      </PageModal>}

      {newTabOpen && <PageModal title="New tab" labelledBy="qp-new-tab-title" onClose={() => { if (!startingAgent && !creatingMarkdown && !creatingBrowser) setNewTabOpen(false) }}>
        <section className="qp-sheet__section">
          <h3>Terminal</h3>
          <button className="qp-button qp-button--primary" type="button" disabled={!canMutate || !terminalGranted || startingAgent || creatingMarkdown || creatingBrowser} onClick={() => void createSession('shell')}>{startingAgent ? 'Starting…' : 'Terminal'}</button>
        </section>
        <section className="qp-sheet__section">
          <h3>Terminal agents</h3>
          {agentLoading ? <p className="qp-dialog-copy">Loading available terminal agents…</p> : agentChoices.length > 0 ? (
            <div className="qp-choice-list">{agentChoices.map((agent) => <button className="qp-button" type="button" key={agent.id} disabled={!canMutate || !terminalGranted || startingAgent || creatingMarkdown || creatingBrowser} onClick={() => void createSession(agent.id)}>{agent.label}</button>)}</div>
          ) : agentError ? null : <p className="qp-dialog-copy">No available terminal agents are enabled for this desktop. Structured chat and agent transcripts are not part of this phone page.</p>}
          {agentError && <PageError>{agentError}</PageError>}
        </section>
        <section className="qp-sheet__section">
          <h3>Markdown</h3>
          <p className="qp-dialog-copy">Create a real editor-owned Markdown note. Phone text is limited to 64 KiB and stays in the worktree-bound editor buffer until saved.</p>
          <button className="qp-button qp-button--primary" type="button" disabled={!canMutate || route.worktreeId === 'floating' || creatingMarkdown || creatingBrowser || startingAgent} onClick={() => void createMarkdownNote()}>{creatingMarkdown ? 'Creating note…' : 'New Markdown Note'}</button>
        </section>
        <section className="qp-sheet__section">
          <h3>Browser</h3>
          <p className="qp-dialog-copy">Browser (Chrome Watch) is an explicit view of a managed agent Chrome page; it is not a mirror of a human Native browser.</p>
          <button className="qp-button qp-button--primary" type="button" disabled={!canMutate || route.worktreeId === 'floating' || creatingMarkdown || creatingBrowser || startingAgent} onClick={() => void createBrowserWatch()}>{creatingBrowser ? 'Starting Chrome Watch…' : 'Browser (Chrome Watch)'}</button>
          <p className="qp-dialog-copy">Existing Native browser tabs remain listed but cannot stream to this phone. Switch a Native pane to Watch explicitly on the desktop; the phone never converts it silently.</p>
        </section>
        {tabCreationError && <PageError>{tabCreationError}</PageError>}
      </PageModal>}

      {renameDialog && selectedSession && <PageModal title="Rename session" labelledBy="qp-rename-session-title" onClose={() => { if (!renameBusy) setRenameDialog(false) }} footer={
        <>
          <button className="qp-button" type="button" disabled={renameBusy} onClick={() => setRenameDialog(false)}>Cancel</button>
          <button className="qp-button qp-button--primary" type="submit" form="qp-rename-session-form" disabled={!canMutate || renameBusy}>{renameBusy ? 'Saving…' : 'Save name'}</button>
        </>
      }>
        <form id="qp-rename-session-form" onSubmit={renameSession}>
          <label className="qp-form-field">Session name<input aria-label="Session name" maxLength={80} value={renameValue} onChange={(event) => setRenameValue(event.currentTarget.value)} autoFocus /></label>
          {renameError && <PageError>{renameError}</PageError>}
        </form>
      </PageModal>}

      {closeDialog && <PageModal title={closeDialog.leaveAfterClose ? 'Discard and leave?' : 'Close terminal session?'} labelledBy="qp-close-session-title" onClose={() => { if (!closeBusy) setCloseDialog(null) }} footer={
        <>
          <button className="qp-button" type="button" disabled={closeBusy} onClick={() => setCloseDialog(null)}>Cancel</button>
          <button className="qp-button qp-button--danger" type="button" aria-label="Confirm discard sessions" disabled={!canMutate || closeBusy} onClick={() => void confirmClose()}>{closeBusy ? 'Closing…' : closeDialog.leaveAfterClose ? 'Discard & leave' : 'Close tab'}</button>
        </>
      }>
        <p className="qp-dialog-copy">{closeDialog.sessionIds.length === 1 ? 'The daemon checks for active work before stopping this session.' : `The daemon checks ${closeDialog.sessionIds.length} sessions before stopping them.`}</p>
        {closeDialog.descriptions.map((description, index) => description ? <p className="qp-dialog-copy" key={`${closeDialog.sessionIds[index]}:${index}`}>{description}</p> : null)}
        <p className="qp-dialog-copy">If the desktop reports no warning, this action still stops the selected terminal sessions and removes their session records.</p>
        {closeError && <PageError>{closeError}</PageError>}
      </PageModal>}

      {commandsOpen && <PageModal title="Quick commands" labelledBy="qp-quick-commands-title" onClose={() => setCommandsOpen(false)}>
        <p className="qp-dialog-copy">Quick commands are saved on this phone for this desktop. Running one sends its exact text through the terminal API.</p>
        {!storageGranted && <PageError>Phone storage access was not granted; quick commands cannot be saved or edited.</PageError>}
        {quickCommands.length > 0 && <div className="qp-choice-list">{quickCommands.map((command) => <div className="qp-form-row" key={command.id}>
          <button className="qp-button" type="button" disabled={!ownsTerminal || commandBusy} onClick={() => void submitCommand(command.text, true)}>{command.label}</button>
          <button className="qp-icon-button" type="button" aria-label={`Remove quick command ${command.label}`} disabled={!storageGranted || !commandStorageReady} onClick={() => setQuickCommands((current) => current.filter((item) => item.id !== command.id))}>×</button>
        </div>)}</div>}
        <form onSubmit={addQuickCommand}>
          <label className="qp-form-field">Label<input aria-label="Quick command label" maxLength={80} value={commandLabel} disabled={!storageGranted} onChange={(event) => setCommandLabel(event.currentTarget.value)} /></label>
          <label className="qp-form-field">Command<textarea aria-label="Quick command text" maxLength={4000} value={commandText} disabled={!storageGranted} onChange={(event) => setCommandText(event.currentTarget.value)} /></label>
          <button className="qp-button qp-button--primary" type="submit" disabled={!storageGranted || !commandStorageReady || !commandLabel.trim() || !commandText.trim() || quickCommands.length >= 40}>Add quick command</button>
        </form>
        {commandError && <PageError>{commandError}</PageError>}
      </PageModal>}

      {shortcutOpen && <PageModal title="Terminal shortcuts" labelledBy="qp-terminal-shortcuts-title" onClose={() => setShortcutOpen(false)}>
        <p className="qp-dialog-copy">Shortcuts send the exact configured text to the selected terminal.</p>
        {!storageGranted && <PageError>Phone storage access was not granted; custom shortcuts cannot be saved or edited.</PageError>}
        <div className="qp-choice-list">
          {bridge.init.preferences.shortcuts.map((shortcut) => <button className="qp-button" type="button" key={shortcut.id} disabled={!ownsTerminal} onClick={() => void writeTerminal(shortcut.text)}>{shortcut.label}</button>)}
          {customShortcuts.map((shortcut) => <div className="qp-form-row" key={shortcut.id}>
            <button className="qp-button" type="button" disabled={!ownsTerminal} onClick={() => void writeTerminal(shortcut.text)}>{shortcut.label}</button>
            <button className="qp-icon-button" type="button" aria-label={`Remove shortcut ${shortcut.label}`} disabled={!storageGranted || !commandStorageReady} onClick={() => setCustomShortcuts((current) => current.filter((item) => item.id !== shortcut.id))}>×</button>
          </div>)}
        </div>
        <form onSubmit={addShortcut}>
          <label className="qp-form-field">Label<input aria-label="Shortcut label" maxLength={60} value={shortcutLabel} disabled={!storageGranted} onChange={(event) => setShortcutLabel(event.currentTarget.value)} /></label>
          <label className="qp-form-field">Exact terminal input<textarea aria-label="Shortcut text" maxLength={1000} value={shortcutText} disabled={!storageGranted} onChange={(event) => setShortcutText(event.currentTarget.value)} /></label>
          <button className="qp-button qp-button--primary" type="submit" disabled={!storageGranted || !commandStorageReady || !shortcutLabel.trim() || !shortcutText || customShortcuts.length >= 32}>Add shortcut</button>
        </form>
        {commandError && <PageError>{commandError}</PageError>}
      </PageModal>}
    </div>
  )
}

function AskCard({ ask, canMutate, onSubmit }: {
  ask: Ask
  canMutate: boolean
  onSubmit(ask: Ask, answers: Record<string, AskAnswer>, skipped: string[]): Promise<void>
}) {
  const [drafts, setDrafts] = useState<Record<string, AnswerDraft>>(() => answerDrafts(ask))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const pending = ask.envelope.status === 'pending'
  const deadlinePassed = pending && ask.expiresAt !== null && ask.expiresAt <= Date.now()
  const askVersion = useRef({ id: ask.id, seq: ask.seq, status: ask.envelope.status })

  useEffect(() => {
    if (askVersion.current.id === ask.id && askVersion.current.seq === ask.seq && askVersion.current.status === ask.envelope.status) return
    askVersion.current = { id: ask.id, seq: ask.seq, status: ask.envelope.status }
    setDrafts(answerDrafts(ask))
    setErrors({})
  }, [ask])

  const setAnswer = (id: string, value: AnswerDraft) => {
    setDrafts((current) => ({ ...current, [id]: value }))
    setErrors((current) => {
      if (!(id in current)) return current
      const remaining = { ...current }
      delete remaining[id]
      return remaining
    })
  }

  const submit = async () => {
    if (deadlinePassed) return
    const submission = buildAskSubmission(ask, drafts)
    if (Object.keys(submission.errors).length > 0) {
      setErrors(submission.errors)
      return
    }
    setBusy(true)
    setErrors({})
    try { await onSubmit(ask, submission.answers, submission.skipped) }
    catch (cause) { setErrors({ form: errorMessage(cause, 'The answer was refused.') }) }
    finally { setBusy(false) }
  }

  return (
    <article className="qp-ask-card__question" data-ask-id={ask.id}>
      <h2>{askTitle(ask)}</h2>
      {!pending ? (
        <p className="qp-dialog-copy">Question status: {statusLabel(ask.envelope.status)}{ask.envelope.summary ? ` · ${ask.envelope.summary}` : ''}</p>
      ) : (
        <>
          {ask.queued && <span className="qp-chip qp-chip--muted">Queued</span>}
          {deadlinePassed && <p className="qp-ask-card__error" role="status">The deadline passed; answering is paused until the desktop reports the authoritative status. Refresh to synchronize.</p>}
          {ask.spec.questions.map((question) => <AskQuestionControl
            key={question.id}
            question={question}
            draft={drafts[question.id] ?? { selected: [], freeText: '', text: '', confirm: null }}
            error={errors[question.id]}
            onChange={(value) => setAnswer(question.id, value)}
          />)}
          <button className="qp-button qp-button--primary" type="button" disabled={!canMutate || busy || deadlinePassed} onClick={() => void submit()}>{busy ? 'Submitting…' : 'Submit answer'}</button>
          {errors.form && <p className="qp-ask-card__error" role="alert">{errors.form}</p>}
        </>
      )}
    </article>
  )
}

function AskQuestionControl({ question, draft, error, onChange }: {
  question: AskQuestionSpec
  draft: AnswerDraft
  error?: string
  onChange(value: AnswerDraft): void
}) {
  const label = question.header || question.question
  const toggleOption = (value: string) => {
    const selected = draft.selected.includes(value)
    if (question.type === 'multiselect') {
      onChange({ ...draft, selected: selected ? draft.selected.filter((item) => item !== value) : [...draft.selected, value] })
    } else {
      onChange({ ...draft, selected: selected ? [] : [value] })
    }
  }
  return (
    <div className="qp-ask-card__question">
      <strong>{label}{question.required ? ' *' : ''}</strong>
      {question.header && <p className="qp-dialog-copy">{question.question}</p>}
      {!question.required && <small>Optional</small>}
      {question.type === 'select' && <div className="qp-option-row" role="group" aria-label={label}>
        {question.options.map((option) => (
          <div className="qp-ask-option" key={option.value}>
            <button className="qp-chip" type="button" aria-pressed={draft.selected[0] === option.value} onClick={() => toggleOption(option.value)}>{option.label}</button>
            {option.description && <small>{option.description}</small>}
            {option.preview && <details><summary>Show {option.preview.format} preview</summary><pre>{option.preview.content}</pre></details>}
          </div>
        ))}
        <label className="qp-form-field">Other answer or note for {label}<input aria-label={`Other answer or note for ${label}`} value={draft.freeText} onChange={(event) => onChange({ ...draft, freeText: event.currentTarget.value })} /></label>
      </div>}
      {question.type === 'multiselect' && <div className="qp-choice-list" role="group" aria-label={label}>
        {question.options.map((option) => (
          <div className="qp-ask-option" key={option.value}>
            <label className="qp-choice">
              <input type="checkbox" checked={draft.selected.includes(option.value)} onChange={() => toggleOption(option.value)} />
              <span>{option.label}{option.description ? <small>{option.description}</small> : null}</span>
            </label>
            {option.preview && <details><summary>Show {option.preview.format} preview</summary><pre>{option.preview.content}</pre></details>}
          </div>
        ))}
        <label className="qp-form-field">Other answer for {label}<input aria-label={`Other answer for ${label}`} value={draft.freeText} onChange={(event) => onChange({ ...draft, freeText: event.currentTarget.value })} /></label>
      </div>}
      {question.type === 'text' && (question.multiline ?
        <textarea aria-label={label} value={draft.text} onChange={(event) => onChange({ ...draft, text: event.currentTarget.value })} /> :
        <input aria-label={label} type={question.format === 'email' ? 'email' : question.format === 'url' ? 'url' : 'text'} pattern={question.pattern} value={draft.text} onChange={(event) => onChange({ ...draft, text: event.currentTarget.value })} />)}
      {question.type === 'number' && <input aria-label={label} type="number" inputMode="decimal" min={question.min} max={question.max} step={question.integer ? 1 : 'any'} value={draft.text} onChange={(event) => onChange({ ...draft, text: event.currentTarget.value })} />}
      {question.type === 'date' && <input aria-label={label} type="date" value={draft.text} onChange={(event) => onChange({ ...draft, text: event.currentTarget.value })} />}
      {question.type === 'confirm' && <div className="qp-option-row" role="group" aria-label={label}>
        <button className="qp-chip" type="button" aria-pressed={draft.confirm === true} onClick={() => onChange({ ...draft, confirm: true })}>Yes</button>
        <button className="qp-chip" type="button" aria-pressed={draft.confirm === false} onClick={() => onChange({ ...draft, confirm: false })}>No</button>
      </div>}
      {error && <p className="qp-ask-card__error" role="alert">{error}</p>}
    </div>
  )
}
