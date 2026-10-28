import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent, type MouseEvent } from 'react'
import { createRoot } from 'react-dom/client'
import type { Session, UiPluginContext } from '@quirky/protocol'
import { HISTORY_AGENTS } from '../agents'
import type { HostedSession, ViewState } from '../types'
import { EvidenceText } from './evidence'
import {
  AGENT_LABELS,
  HISTORY_PANEL_ID,
  VAULT_RESUME_COMMAND,
  VaultWindowModel,
  isResumable,
  type VaultRow,
  type VaultSnapshot,
  type VaultViewReport
} from './model'
import { injectVaultStyles } from './styles'

const ROW_HEIGHT = 76
const GROUP_HEIGHT = 32
const EXPANDED_HEIGHT = 360
const OVERSCAN = 7

type HistoryPanelProps = { context: UiPluginContext; report?(state: unknown): void }
type RenderEntry = { kind: 'group'; id: string; label: string; count: number; collapsed: boolean } | { kind: 'session'; id: string; row: VaultRow; group: string }
type DetailState = { session: HostedSession | null; firstPrompt: string | null; subagents: HostedSession[]; loading: boolean; error: string | null }

type GroupedRows = { entries: RenderEntry[]; allRows: VaultRow[]; totalHeight: number; offsets: number[]; heights: number[] }
function cancelCommandDrag(context: UiPluginContext, token: { current: string | null }): void {
  const value = token.current
  token.current = null
  if (value === null) return
  try {
    context.cancelCommandDrag(value)
  } catch {
    // The host may have revoked the owner context and cleared the entry already.
  }
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))
function isHostedSession(value: unknown): value is HostedSession {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const source = record.source
  if (!source || typeof source !== 'object' || Array.isArray(source)) return false
  const presence = (source as Record<string, unknown>).presence
  return typeof record.id === 'string'
    && typeof record.sourceId === 'string'
    && typeof record.hostId === 'string'
    && typeof record.presence === 'string'
    && ['present', 'missing', 'unverifiable'].includes(record.presence)
    && ['present', 'missing', 'unverifiable'].includes(String(presence))
    && !('filePath' in record)
    && !('codexHome' in record)
}

function requireSourceOpened(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('ok' in value) || value.ok !== true) {
    throw new Error('The source could not be opened.')
  }
}
const agentLabel = (agent: string): string => AGENT_LABELS[agent] ?? agent
const ageLabel = (timestamp: number | null | undefined): string => {
  if (!timestamp) return 'date unavailable'
  const elapsed = Math.max(0, Date.now() - timestamp)
  if (elapsed < 60_000) return 'just now'
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`
  return `${Math.floor(elapsed / 86_400_000)}d ago`
}

function projectFor(model: VaultWindowModel, row: VaultRow): string {
  if (row.cwd) return model.repoLabelForPath(row.cwd)
  return 'No project'
}

function folderFor(row: VaultRow): string {
  if (!row.cwd) return 'No working directory'
  const parts = row.cwd.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts.length > 1 ? `…/${parts.slice(-2).join('/')}` : row.cwd
}

function groupName(model: VaultWindowModel, view: ViewState, row: VaultRow): string {
  if (view.group === 'agent') return agentLabel(row.agent)
  if (view.group === 'folder') return folderFor(row)
  return projectFor(model, row)
}

function groupedRows(model: VaultWindowModel, view: ViewState, rows: VaultRow[], collapsed: Set<string>): GroupedRows {
  const buckets = new Map<string, VaultRow[]>()
  for (const row of rows) {
    const name = groupName(model, view, row)
    const existing = buckets.get(name)
    if (existing) existing.push(row)
    else buckets.set(name, [row])
  }
  const groups = [...buckets.entries()].sort(([left], [right]) => left.localeCompare(right))
  const entries: RenderEntry[] = []
  const allRows: VaultRow[] = []
  for (const [label, groupRows] of groups) {
    const key = `${view.group}:${label}`
    const isCollapsed = collapsed.has(key)
    entries.push({ kind: 'group', id: key, label, count: groupRows.length, collapsed: isCollapsed })
    if (!isCollapsed) {
      for (const row of groupRows) {
        entries.push({ kind: 'session', id: row.id, row, group: key })
        allRows.push(row)
      }
    }
  }
  const heights = entries.map((entry) => entry.kind === 'group' ? GROUP_HEIGHT : (view.expandedIds.includes(entry.id) ? EXPANDED_HEIGHT : ROW_HEIGHT))
  const offsets: number[] = []
  let totalHeight = 0
  for (const height of heights) {
    offsets.push(totalHeight)
    totalHeight += height
  }
  return { entries, allRows, totalHeight, offsets, heights }
}

function adjustmentCount(view: ViewState): number {
  return Number(view.disabledAgents.length > 0) + Number(view.group !== 'project') + Number(view.hideEmptySessions) + Number(view.sessionLimit !== 250) + Number(view.browseSort !== 'updated') + Number(view.searchSort !== 'relevance')
}

function messageRole(role: string): string {
  if (role === 'user') return 'You'
  if (role === 'assistant') return 'Agent'
  if (role === 'tool') return 'Tool'
  return 'System'
}

function canReveal(row: VaultRow): boolean {
  return row.hostId === 'local' && row.presence === 'present' && Boolean(row.filePath)
}

function localClipboard(text: string): Promise<void> {
  if (!navigator.clipboard) return Promise.reject(new Error('The clipboard is not available.'))
  return navigator.clipboard.writeText(text)
}

const SEARCH_PRIVACY_DISCLOSURE = 'It stores full, unredacted agent conversations on this computer, including up to 3,072 characters from each tool output. Authenticated clients can search this local index through the daemon.'

function SearchDisclosure({ enabled, busy, onEnable, searchTip }: { enabled: boolean; busy: boolean; onEnable(): void; searchTip: VaultSnapshot['searchTip'] }) {
  if (enabled) return null
  const promoting = searchTip?.seen === false
  return <div className="qvh-consent" data-vault-consent {...(promoting ? { 'data-vault-search-tip': '' } : {})}>
    {promoting
      ? <>
        <p><strong>Search every agent session</strong> Find any past conversation by what was said in it, then pick up where the agent left off.</p>
        <p>{SEARCH_PRIVACY_DISCLOSURE}</p>
      </>
      : <p><strong>Enable full-text search?</strong> {SEARCH_PRIVACY_DISCLOSURE}</p>}
    <div className="qvh-consent-actions"><button type="button" className="qvh-button qvh-primary" data-vault-enable-search disabled={busy} onClick={onEnable}>{promoting ? 'Turn on session search' : 'Enable'}</button><span className="qvh-muted">Until enabled, this box filters session titles only.</span></div>
  </div>
}

function SearchMessage({ snapshot, noAgents }: { snapshot: VaultSnapshot; noAgents: boolean }): string | null {
  if (noAgents) return 'No agents selected.'
  if (snapshot.search.error) return `Could not search this computer. ${snapshot.search.error}`
  const response = snapshot.search.response
  if (response?.kind === 'stale-cursor') return 'The index changed while searching. Restarting the search for current results.'
  if (response?.kind === 'malformed-cursor') return 'The result page is invalid. Refresh search to start a new page.'
  if (response?.kind === 'unavailable') {
    if (response.reason === 'disabled') return 'Full-text search is off on this computer, so only session titles are matched.'
    if (response.reason === 'not-ready') return 'The search index is not ready yet. Try again shortly.'
    if (response.reason === 'no-service') return 'Search is unavailable on this computer. It may need an update or a runtime with search support.'
    if (response.reason === 'scope-unknown') return 'This computer does not have this workspace or project. Switch the scope to All explicitly.'
    return 'This computer does not support history search for the selected agent. Change the agent filter or host.'
  }
  if (snapshot.searchStatus?.enabled && snapshot.view.query.trim() && response?.kind !== 'results' && !snapshot.search.loading) return 'Search is preparing results. Try again shortly.'
  if (snapshot.searchStatus?.enabled && response?.kind === 'results') {
    if (response.truncated.freshness) return 'Some session history is still being indexed; these results may not include recent changes.'
    if (response.truncated.candidates || response.truncated.snippets || response.truncated.query) return 'Results are partial because a search limit was reached. Narrow the query to see more.'
    if (response.repairedTerms && Object.keys(response.repairedTerms).length) return `Search adjusted ${Object.entries(response.repairedTerms).map(([before, after]) => `${before} → ${after}`).join(', ')}.`
    if (response.hits.length === 0) return 'No matching sessions in the indexed history. Try another query or scope.'
  }
  if (!snapshot.searchStatus?.enabled && snapshot.view.query.trim()) return 'Full-text search is off on this computer, so only session titles are matched.'
  return null
}

function SearchEvidence({ row }: { row: VaultRow }) {
  if (!row.evidence) return <div className="qvh-row-snippet">Match in session metadata</div>
  return <div className="qvh-evidence" data-vault-evidence>
    <span className="qvh-role">{messageRole(row.evidence.role)}</span>
    <EvidenceText source={row.evidence.snippet} />
    {row.evidence.timestamp ? <span className="qvh-muted"> · {ageLabel(row.evidence.timestamp)}</span> : null}
  </div>
}

function ActionButton({ label, onClick, disabled = false }: { label: string; onClick(): void; disabled?: boolean }) {
  return <button type="button" className="qvh-button" disabled={disabled} onClick={(event) => { event.stopPropagation(); onClick() }}>{label}</button>
}

function SessionDetails({
  context,
  row,
  expanded,
  onError,
  onResume,
  onHandoff,
  onResumeWorktree,
  onOpenSource,
  onCopy,
  onClose
}: {
  context: UiPluginContext
  row: VaultRow
  expanded: boolean
  onError(error: string): void
  onResume(): void
  onResumeWorktree(): void
  onHandoff(): void
  onOpenSource(mode: 'view' | 'open' | 'reveal'): void
  onCopy(text: string): Promise<void>
  onClose(): void
}) {
  const [detail, setDetail] = useState<DetailState>({ session: null, firstPrompt: null, subagents: [], loading: false, error: null })
  const lastRequest = useRef('')
  useEffect(() => {
    if (!expanded || lastRequest.current === row.id) return
    lastRequest.current = row.id
    let active = true
    setDetail((current) => ({ ...current, loading: true, error: null }))
    Promise.all([
      context.call('quirky.vault/get', { id: row.id }),
      context.call('quirky.vault/firstPrompt', { id: row.id }),
      context.call('quirky.vault/subagents', { id: row.id })
    ]).then(([session, prompt, subagents]) => {
      if (!active) return
      if (session !== null && !isHostedSession(session)) throw new Error('The vault returned an invalid hosted session.')
      if (!prompt || typeof prompt !== 'object' || Array.isArray(prompt) || !('prompt' in prompt)) {
        throw new Error('The vault returned an invalid first-prompt response.')
      }
      const promptValue = prompt.prompt
      if (promptValue !== null && typeof promptValue !== 'string') throw new Error('The vault returned an invalid first-prompt response.')
      if (!Array.isArray(subagents)) throw new Error('The vault returned invalid hosted subagents.')
      const children = subagents.filter(isHostedSession)
      if (children.length !== subagents.length) throw new Error('The vault returned invalid hosted subagents.')
      setDetail({ session, firstPrompt: promptValue, subagents: children, loading: false, error: null })
    }).catch((error: unknown) => {
      if (!active) return
      const message = messageOf(error)
      setDetail((current) => ({ ...current, loading: false, error: message }))
      onError(message)
    })
    return () => { active = false }
  }, [context, expanded, row.id, onError])

  const previewMessages = detail.session?.previewMessages ?? row.previewMessages ?? []
  const available = isResumable(row)
  return <div className="qvh-row-details" data-vault-session-details={row.id} onClick={(event) => event.stopPropagation()}>
    <div className="qvh-action-row">
      <ActionButton label="Resume" disabled={!available} onClick={onResume} />
      <ActionButton label="Resume in Worktree" disabled={!available || !row.cwd} onClick={onResumeWorktree} />
      <ActionButton label="Hand Off" disabled={!available} onClick={onHandoff} />
      <ActionButton label="View Log" disabled={!canReveal(row)} onClick={() => onOpenSource('view')} />
      <ActionButton label="Reveal Log" disabled={!canReveal(row)} onClick={() => onOpenSource('reveal')} />
      <ActionButton label="Open Working Directory" disabled={row.hostId !== 'local' || !row.cwd || row.presence !== 'present'} onClick={() => void context.call('quirky.vault/openWorkingDirectory', { id: row.id }).then((result) => {
        if (result === false || (result && typeof result === 'object' && 'available' in result && result.available === false)) {
          const reason = result && typeof result === 'object' && 'reason' in result && typeof result.reason === 'string' ? result.reason : 'The working directory could not be opened.'
          throw new Error(reason)
        }
      }).catch((error: unknown) => onError(messageOf(error)))} />
      <button type="button" className="qvh-button" onClick={onClose}>Hide details</button>
    </div>
    {detail.loading ? <div className="qvh-muted" role="status">Loading source details…</div> : null}
    {detail.error ? <div className="qvh-error" role="alert">Could not inspect this source. {detail.error}</div> : null}
    {row.presence !== 'present' ? <div className="qvh-error" role="status">{row.presence === 'missing' ? 'The source transcript is no longer available.' : 'The source transcript availability could not be verified.'} Resume and file actions are unavailable.</div> : null}
    {detail.firstPrompt ? <section className="qvh-detail-section"><span className="qvh-detail-label">First prompt</span><div className="qvh-first-prompt" data-vault-first-prompt>{detail.firstPrompt}</div><button type="button" className="qvh-button" onClick={() => void onCopy(detail.firstPrompt!).catch((error) => onError(messageOf(error)))}>Copy first prompt</button></section> : null}
    <section className="qvh-detail-section"><span className="qvh-detail-label">Latest turns</span>
      {previewMessages.length ? previewMessages.slice(-5).map((message, index) => <div className="qvh-turn" key={`${message.timestamp ?? 'none'}:${index}`}><span className="qvh-role">{messageRole(message.role)}</span>{message.text}</div>) : <div className="qvh-muted">No conversation preview available.</div>}
    </section>
    {detail.subagents.length ? <section className="qvh-detail-section"><span className="qvh-detail-label">Subagents</span><div className="qvh-subagents">{detail.subagents.map((agent) => <button type="button" className="qvh-button" key={agent.id} onClick={() => void context.call('quirky.vault/openSource', { id: agent.id, mode: 'view' }).then(requireSourceOpened).catch((error: unknown) => onError(messageOf(error)))}>{agent.title || agent.sessionId} · {agentLabel(agent.agent)}</button>)}</div></section> : null}
  </div>
}

function SessionRow({
  context,
  row,
  view,
  selected,
  expanded,
  menuOpen,
  onSelect,
  onExpand,
  onMenu,
  onError,
  onResume,
  onResumeWorktree,
  onHandoff,
  onOpenSource,
  onCopy,
  onDelete
}: {
  context: UiPluginContext
  row: VaultRow
  view: ViewState
  selected: boolean
  expanded: boolean
  menuOpen: boolean
  onSelect(): void
  onExpand(): void
  onMenu(): void
  onError(error: string): void
  onResume(): void
  onResumeWorktree(): void
  onHandoff(): void
  onOpenSource(mode: 'view' | 'open' | 'reveal'): void
  onCopy(text: string): Promise<void>
  onDelete(): void
}) {
  const [dragAllowed, setDragAllowed] = useState(false)
  const commandDragToken = useRef<string | null>(null)
  useEffect(() => () => cancelCommandDrag(context, commandDragToken), [context])
  const resumable = isResumable(row)
  const handleMenu = (event: MouseEvent) => {
    event.stopPropagation()
    onMenu()
  }
  const commandCopy = async () => {
    try {
      const prepared = await context.call('quirky.vault/prepareResume', { id: row.id })
      const result = prepared && typeof prepared === 'object' && 'command' in prepared && typeof prepared.command === 'string' ? prepared.command : null
      if (!result) throw new Error('The agent did not provide a copyable resume command.')
      await onCopy(result)
      context.toast('Resume command copied', 'The provider-prepared command is on the clipboard.')
    } catch (error) {
      onError(messageOf(error))
    }
  }
  const action = async (operation: string, params: Record<string, unknown> = {}) => {
    try {
      const result = await context.call(`quirky.vault/${operation}`, { id: row.id, ...params })
      if (result === false) throw new Error('The requested session action was not completed.')
      if (result && typeof result === 'object' && 'kind' in result && result.kind === 'unavailable') {
        const reason = 'reason' in result && typeof result.reason === 'string' ? result.reason : 'This action is unavailable.'
        throw new Error(reason)
      }
      if (result && typeof result === 'object' && (('available' in result && result.available === false) || ('opened' in result && result.opened === false))) {
        const reason = 'reason' in result && typeof result.reason === 'string' ? result.reason : 'This action is unavailable.'
        throw new Error(reason)
      }
      return result
    } catch (error) {
      onError(messageOf(error))
      return null
    }
  }
  const copyText = async (text: string, title: string) => {
    try {
      await onCopy(text)
      context.toast(title, '')
    } catch (error) {
      onError(messageOf(error))
    }
  }
  const deleteSession = async () => {
    const accepted = await context.confirm({ title: 'Delete this agent session?', body: 'The supported local transcript will be moved to the operating system trash if present. An already-missing source counts as deleted.', confirmLabel: 'Delete' })
    if (!accepted) return
    let result: unknown
    try {
      result = await context.call('quirky.vault/deleteSession', { id: row.id, yes: true })
    } catch (error) {
      onError(messageOf(error))
      return
    }
    const response = result && typeof result === 'object' && !Array.isArray(result) ? result as Record<string, unknown> : {}
    if (response.deleted !== true || typeof response.trashed !== 'number' || typeof response.alreadyMissing !== 'boolean') {
      onError(typeof response.reason === 'string' ? response.reason : 'The vault did not confirm that the source was deleted.')
      return
    }
    const deletion = response as { trashed: number; alreadyMissing: boolean }
    const { trashed, alreadyMissing } = deletion
    if (!Number.isInteger(trashed) || trashed < 0 || (trashed === 0 && !alreadyMissing)) {
      onError('The vault did not confirm where the source was moved.')
      return
    }
    if (trashed > 0) context.toast('Session moved to Trash', 'The operating system trash received the validated source.')
    else context.toast('Session already missing', 'The source was not present; no other files were changed.')
    onDelete()
  }
  return <article
    className={`qvh-session-row${expanded ? ' qvh-expanded' : ''}`}
    role="option"
    aria-selected={selected}
    tabIndex={selected ? 0 : -1}
    data-vault-session-row={row.id}
    draggable={resumable}
    onClick={onSelect}
    onDoubleClick={() => { if (resumable) onResume() }}
    onContextMenu={(event) => { event.preventDefault(); onMenu() }}
    onDragStart={(event) => {
      cancelCommandDrag(context, commandDragToken)
      if (!resumable || row.hostId !== 'local') { event.preventDefault(); return }
      const transfer = event.dataTransfer
      if (!transfer) { event.preventDefault(); return }
      try {
        const token = context.createCommandDrag(VAULT_RESUME_COMMAND, { id: row.id })
        commandDragToken.current = token
        transfer.setData('application/x-quirky-command', token)
        transfer.effectAllowed = 'copy'
        setDragAllowed(true)
      } catch {
        cancelCommandDrag(context, commandDragToken)
        setDragAllowed(false)
        event.preventDefault()
      }
    }}
    onDragEnd={() => {
      cancelCommandDrag(context, commandDragToken)
      setDragAllowed(false)
    }}
    data-dragging={dragAllowed ? 'true' : undefined}
  >
    <div className="qvh-row-top">
      <div className="qvh-row-title">
        <button type="button" className="qvh-row-title-button" onClick={(event) => { event.stopPropagation(); onSelect() }}>{row.title || row.sessionId}</button>
      </div>
      <div className="qvh-inline-actions">
        <button type="button" className="qvh-icon-button" aria-label="Resume session" title="Resume" disabled={!resumable} onClick={(event) => { event.stopPropagation(); onResume() }}>↻</button>
        <button type="button" className="qvh-icon-button" aria-label="Toggle session details" title={expanded ? 'Hide details' : 'Show details'} onClick={(event) => { event.stopPropagation(); onExpand() }}>{expanded ? '−' : '⌄'}</button>
        <button type="button" className="qvh-icon-button" aria-label="Session actions" title="Session actions" aria-haspopup="menu" aria-expanded={menuOpen} onClick={handleMenu}>⋯</button>
      </div>
    </div>
    <div className="qvh-row-meta">
      <span>{agentLabel(row.agent)}</span><span>{row.messageCount} messages</span>
      {row.subagentTranscriptCount ? <span>{row.subagentTranscriptCount} subagents</span> : null}
      {row.model ? <span>{row.model}</span> : null}
      <span>{ageLabel(view.query.trim() && row.evidence ? row.evidence.timestamp ?? row.updatedAt : row.updatedAt)}</span>
      {row.cwd ? <span title={row.cwd}>{folderFor(row)}</span> : null}
      {row.duplicateCount && row.duplicateCount > 1 ? <span>{row.duplicateCount} copies</span> : null}
    </div>
    {row.evidence ? <SearchEvidence row={row} /> : row.previewMessages?.length ? <div className="qvh-row-snippet"><span className="qvh-role">{messageRole(row.previewMessages.at(-1)!.role)}</span>{row.previewMessages.at(-1)!.text}</div> : null}
    {row.presence !== 'present' ? <div className="qvh-muted">Transcript {row.presence === 'missing' ? 'no longer available' : 'availability could not be verified'}</div> : null}
    {menuOpen ? <div role="menu" className="qvh-action-menu" data-vault-actions={row.id} onClick={(event) => event.stopPropagation()}>
      <button role="menuitem" disabled={!resumable} onClick={onResume}>Resume in New Tab</button>
      <button role="menuitem" disabled={!resumable || !row.cwd} onClick={onResumeWorktree}>Resume in Worktree</button>
      <button role="menuitem" disabled={!resumable} onClick={onResume}>Resume in New Terminal</button>
      <button role="menuitem" disabled={!resumable} onClick={() => void commandCopy()}>Copy Resume Command</button>
      <button role="menuitem" disabled={!resumable} onClick={onHandoff}>Hand Off to Another Agent</button>
      <button role="menuitem" onClick={() => void action('jump', { target: 'pane' })}>Jump to Original Pane</button>
      <button role="menuitem" onClick={() => void action('jump', { target: 'worktree' })}>Jump to Worktree</button>
      <button role="menuitem" onClick={() => void action('jump', { target: 'folder' })}>Jump to Folder</button>
      <button role="menuitem" disabled={!canReveal(row)} onClick={() => onOpenSource('open')}>Open Log</button>
      <button role="menuitem" disabled={!canReveal(row)} onClick={() => onOpenSource('reveal')}>Reveal Log</button>
      <button role="menuitem" disabled={row.hostId !== 'local' || !row.cwd || row.presence !== 'present'} onClick={() => void action('openWorkingDirectory')}>Open Working Directory</button>
      <button role="menuitem" onClick={() => void copyText(row.sessionId, 'Session ID copied')}>Copy Session ID</button>
      <button role="menuitem" disabled={!row.filePath} onClick={() => void copyText(row.filePath!, 'Log path copied')}>Copy Log Path</button>
      <button role="menuitem" onClick={onExpand}>Show Details</button>
      <button role="menuitem" className="qvh-danger" disabled={!['gemini', 'copilot', 'cursor', 'hermes', 'devin', 'openclaw', 'droid', 'pi', 'omp', 'claude', 'codebuddy', 'rovo', 'grok', 'cline'].includes(row.agent) || row.hostId !== 'local' || row.presence === 'unverifiable'} onClick={() => void deleteSession()}>Delete</button>
    </div> : null}
    {expanded ? <SessionDetails
      context={context}
      row={row}
      expanded={expanded}
      onError={onError}
      onResume={onResume}
      onResumeWorktree={onResumeWorktree}
      onHandoff={onHandoff}
      onOpenSource={onOpenSource}
      onCopy={onCopy}
      onClose={onExpand}
    /> : null}
  </article>
}

function rowHeight(entry: RenderEntry, view: ViewState): number {
  return entry.kind === 'group' ? GROUP_HEIGHT : (view.expandedIds.includes(entry.id) ? EXPANDED_HEIGHT : ROW_HEIGHT)
}

function emptyListText(snapshot: VaultSnapshot, noAgents: boolean, rows: VaultRow[]): string {
  if (noAgents) return 'No agents selected. Select one or more agents in View options.'
  if (snapshot.list.error) return snapshot.list.error
  if (snapshot.search.error) return `Search failed. ${snapshot.search.error}`
  if (snapshot.search.loading) return 'Searching indexed conversations…'
  if (snapshot.list.loading || snapshot.scanProgress?.phase === 'reading') return 'Scanning agent history…'
  if (snapshot.view.query.trim() && rows.length === 0) {
    const response = snapshot.search.response
    if (response?.kind === 'unavailable') {
      if (response.reason === 'scope-unknown') return 'This scope is unavailable. Switch to All explicitly.'
      if (response.reason === 'not-ready') return 'The search index is not ready yet. Try again shortly.'
      if (response.reason === 'unsupported-agent') return 'Search is unavailable for the selected agent.'
      if (snapshot.view.host === 'all') return 'All-host search is unavailable. Select a host explicitly.'
      return 'No sessions match the current title filter.'
    }
    if (!snapshot.searchStatus?.enabled) return 'No sessions match the current title filter.'
    if (response?.kind === 'stale-cursor') return 'The index changed while searching. Search again for current results.'
    if (response?.kind === 'malformed-cursor') return 'The search page is no longer valid. Search again.'
    return 'No matching sessions in the indexed history. Try another query or scope.'
  }
  if (snapshot.list.result?.total === 0 && snapshot.list.result.issues.length === 0) return 'No agent history found. Resume past sessions after your agents have created session files.'
  return 'No sessions match the current filters.'
}

function HistoryPanel({ context, report }: HistoryPanelProps) {
  const model = useMemo(() => new VaultWindowModel(context), [context])
  const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot)
  const [optionsOpen, setOptionsOpen] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [menuId, setMenuId] = useState<string | null>(null)
  const [width, setWidth] = useState(700)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(520)
  const [now, setNow] = useState(Date.now())
  const root = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const listRequestKey = useRef('')
  const noAgents = model.selectedAgents().length === 0
  const allRows = model.rows().filter((row) => !snapshot.view.hideEmptySessions || row.messageCount > 0 || (row.queuedMessageCount ?? 0) > 0 || (row.subagentTranscriptCount ?? 0) > 0)
  const grouped = useMemo(() => groupedRows(model, snapshot.view, allRows, collapsed), [model, snapshot.view, allRows, collapsed])

  useEffect(() => { model.start(); return () => model.stop() }, [model])

  useEffect(() => {
    if (snapshot.viewReady) void model.refreshSearchStatus(snapshot.view.host)
  }, [model, snapshot.viewReady, snapshot.view.host])

  useEffect(() => {
    const key = JSON.stringify([snapshot.view.host, snapshot.view.scope, snapshot.scope.worktree, snapshot.scope.repo, snapshot.scope.loading, snapshot.view.disabledAgents, snapshot.view.browseSort, snapshot.view.hideEmptySessions, snapshot.view.sessionLimit])
    if (!snapshot.viewReady || snapshot.scope.loading || key === listRequestKey.current) return
    listRequestKey.current = key
    void model.refreshList(false)
  }, [model, snapshot.viewReady, snapshot.view.host, snapshot.view.scope, snapshot.view.disabledAgents, snapshot.view.browseSort, snapshot.view.hideEmptySessions, snapshot.view.sessionLimit, snapshot.scope.worktree, snapshot.scope.repo, snapshot.scope.loading])

  useEffect(() => {
    if (!snapshot.viewReady) return
    if (!snapshot.searchStatus?.enabled || snapshot.view.query.trim() === '' || noAgents) {
      model.clearSearchResults()
      return
    }
    model.clearSearchResults()
    const timer = window.setTimeout(() => void model.runSearch(), 250)
    return () => window.clearTimeout(timer)
  }, [model, snapshot.viewReady, snapshot.view.query, snapshot.view.host, snapshot.view.scope, snapshot.view.disabledAgents, snapshot.view.searchSort, snapshot.searchStatus?.enabled, snapshot.scope.worktree, snapshot.scope.repo, noAgents])

  useEffect(() => {
    if (snapshot.view.focusedSearch) searchInput.current?.focus()
  }, [snapshot.view.focusedSearch, snapshot.viewReady])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    const element = root.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => setWidth(entries[0]?.contentRect.width ?? element.clientWidth))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const element = list.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => setViewportHeight(Math.max(240, entries[0]?.contentRect.height ?? element.clientHeight)))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const rowsInView = grouped.entries.map((entry, index) => ({ entry, index, top: grouped.offsets[index] ?? 0, height: grouped.heights[index] ?? rowHeight(entry, snapshot.view) }))
  let firstVisible = rowsInView.findIndex((entry) => entry.top + entry.height >= scrollTop)
  if (firstVisible < 0) firstVisible = 0
  let lastVisible = firstVisible
  while (lastVisible < rowsInView.length && (rowsInView[lastVisible]?.top ?? 0) < scrollTop + viewportHeight) lastVisible += 1
  const virtual = rowsInView.slice(Math.max(0, firstVisible - OVERSCAN), Math.min(rowsInView.length, lastVisible + OVERSCAN))
  const visibleIds = virtual.flatMap(({ entry }) => entry.kind === 'session' ? [entry.id] : [])
  const reportState: VaultViewReport = {
    host: snapshot.view.host,
    scope: snapshot.view.scope,
    query: snapshot.view.query,
    selectedId: snapshot.view.selectedId,
    expandedIds: snapshot.view.expandedIds,
    focusedSearch: snapshot.view.focusedSearch,
    group: snapshot.view.group,
    disabledAgents: snapshot.view.disabledAgents,
    hideEmptySessions: snapshot.view.hideEmptySessions,
    sessionLimit: snapshot.view.sessionLimit,
    visibleIds,
    total: snapshot.view.query.trim() && snapshot.search.response?.kind === 'results' ? snapshot.search.response.hits.length : snapshot.list.result?.total ?? 0,
    loading: snapshot.list.loading || snapshot.search.loading,
    searchEnabled: snapshot.searchStatus?.enabled ?? false,
    hostIssues: snapshot.hostOutcomes.filter((host) => host.kind !== 'ok').length,
    sourceIssues: snapshot.list.result?.issues.length ?? 0,
    status: snapshot.actionError ?? snapshot.list.error ?? (snapshot.search.error ? 'search-error' : null)
  }

  useEffect(() => { report?.(reportState) }, [report, JSON.stringify(reportState)])

  const selectedRows = grouped.allRows
  const selectRow = (id: string) => { void model.setView({ selectedId: id }).catch(() => {}) }
  const toggleExpanded = (id: string) => {
    const expandedIds = snapshot.view.expandedIds.includes(id) ? snapshot.view.expandedIds.filter((entry) => entry !== id) : [...snapshot.view.expandedIds, id]
    void model.setView({ expandedIds }).catch(() => {})
  }

  const setError = (message: string) => {
    model.setActionError(message)
    context.toast('Vault action failed', message)
  }

  const resume = async (row: VaultRow, options: Record<string, unknown> = {}) => {
    if (!isResumable(row)) { setError(row.presence === 'missing' ? 'The transcript no longer exists.' : 'The transcript availability could not be verified.'); return }
    try {
      const result = await context.call('quirky.vault/resume', { id: row.id, ...options })
      const sessionRecord = result && typeof result === 'object' && !Array.isArray(result) ? result as Record<string, unknown> : {}
      if (typeof sessionRecord.id !== 'string' || typeof sessionRecord.worktreeId !== 'string') throw new Error('The vault did not return a launched session.')
      const session = result as Session
      if (typeof options.worktree === 'string' && options.worktree !== session.worktreeId) throw new Error('The vault launched the session in a different worktree than requested.')
      context.openView('view:quirky.session/worktree', { worktree: session.worktreeId, session: session.id })
      context.toast('Session resumed', `${agentLabel(row.agent)} session opened from its original source.`)
    } catch (error) { setError(messageOf(error)) }
  }

  const resumeInWorktree = async (row: VaultRow) => {
    if (!isResumable(row) || !row.cwd) { setError('This session has no verifiable working directory.'); return }
    try {
      const rows = await context.call('quirky.worktree/list', {}) as unknown
      if (!Array.isArray(rows)) throw new Error('Available worktrees could not be listed.')
      const normalize = (path: string) => path.replaceAll('\\', '/').replace(/\/+$/, '') || '/'
      const cwd = normalize(row.cwd)
      const target = rows.flatMap((value) => {
        if (!value || typeof value !== 'object') return []
        const worktree = value as Record<string, unknown>
        if (typeof worktree.id !== 'string' || typeof worktree.path !== 'string') return []
        const path = normalize(worktree.path)
        return cwd === path || cwd.startsWith(`${path}/`) ? [{ id: worktree.id, path }] : []
      }).sort((left, right) => right.path.length - left.path.length)[0]
      if (!target) throw new Error('No known worktree contains this session’s original working directory.')
      await resume(row, { worktree: target.id })
    } catch (error) { setError(messageOf(error)) }
  }

  const handoff = async (row: VaultRow) => {
    if (!isResumable(row)) { setError('This source cannot be resumed or handed off.'); return }
    try {
      const result = await context.call('quirky.vault/handoff', { id: row.id })
      if (result === false || (result && typeof result === 'object' && (('kind' in result && result.kind === 'unavailable') || ('available' in result && result.available === false)))) {
        const reason = result && typeof result === 'object' && 'reason' in result && typeof result.reason === 'string' ? result.reason : 'Hand off is unavailable.'
        throw new Error(reason)
      }
    } catch (error) { setError(messageOf(error)) }
  }

  const openSource = async (row: VaultRow, mode: 'view' | 'open' | 'reveal') => {
    if (!canReveal(row)) { setError('This source file is not available for local file actions.'); return }
    try {
      const result = await context.call('quirky.vault/openSource', { id: row.id, mode })
      requireSourceOpened(result)
      context.toast(mode === 'reveal' ? 'Source revealed' : mode === 'view' ? 'Source opened' : 'Log opened', '')
    } catch (error) { setError(messageOf(error)) }
  }

  const copy = async (text: string) => {
    await localClipboard(text)
  }

  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target instanceof HTMLElement && (event.target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName))) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const current = selectedRows.findIndex((row) => row.id === snapshot.view.selectedId)
      const next = event.key === 'ArrowDown' ? Math.min(selectedRows.length - 1, current + 1) : Math.max(0, current < 0 ? 0 : current - 1)
      const row = selectedRows[next]
      if (row) {
        selectRow(row.id)
        const entryIndex = grouped.entries.findIndex((entry) => entry.kind === 'session' && entry.id === row.id)
        const top = grouped.offsets[entryIndex] ?? 0
        const bottom = top + (grouped.heights[entryIndex] ?? ROW_HEIGHT)
        const nextScroll = top < scrollTop ? top : bottom > scrollTop + viewportHeight ? bottom - viewportHeight : scrollTop
        if (list.current) list.current.scrollTop = nextScroll
        setScrollTop(nextScroll)
      }
    } else if (event.key === 'Enter') {
      const row = selectedRows.find((candidate) => candidate.id === snapshot.view.selectedId)
      if (row) { event.preventDefault(); void resume(row) }
    } else if (event.key === 'Escape') {
      setOptionsOpen(false)
      setMenuId(null)
    }
  }

  const setQuery = (query: string) => { void model.setView({ query }).catch(() => {}) }
  const scope = snapshot.view.scope
  const scopeAvailability = {
    workspace: Boolean(snapshot.scope.worktree),
    project: Boolean(snapshot.scope.repo),
    all: true
  }
  const currentSearchMessage = SearchMessage({ snapshot, noAgents })
  
  const pageHasMore = snapshot.view.query.trim() && snapshot.searchStatus?.enabled
    ? snapshot.search.response?.kind === 'results' && snapshot.search.response.page.hasMore
    : snapshot.list.result?.hasMore === true
  const totalLimit = snapshot.view.sessionLimit

  return <div className="qvh-root" ref={root} data-narrow={width < 300 ? 'true' : 'false'} data-vault-history onKeyDown={keyDown}>
    <header className="qvh-header">
      <div className="qvh-heading"><div className="qvh-title">{width < 300 ? 'Agents' : 'Agent Session History'}</div><div className="qvh-subtitle">{snapshot.list.result || snapshot.view.query ? 'Indexed history' : 'Resume past sessions'}</div></div>
      <div className="qvh-head-actions">
        <select className="qvh-select qvh-host-select" aria-label="History host" value={snapshot.view.host} onChange={(event) => void model.setView({ host: event.currentTarget.value }).catch(() => {})}>
          <option value="local">Local Mac</option><option value="all">All hosts</option>
          {snapshot.hostOutcomes.filter((host) => host.hostId !== 'local' && host.hostId !== 'all').map((host) => <option key={host.hostId} value={host.hostId}>{host.label}{host.kind === 'ok' ? '' : ` · ${host.kind}`}</option>)}
        </select>
        <button type="button" className="qvh-icon-button" aria-label="View options" aria-expanded={optionsOpen} title="View options" onClick={() => setOptionsOpen((open) => !open)}>
          ⛭{adjustmentCount(snapshot.view) ? <span className="qvh-adjustment">{adjustmentCount(snapshot.view)}</span> : null}
        </button>
        <button type="button" className="qvh-icon-button" aria-label="Refresh Session History" title="Refresh Session History" disabled={snapshot.list.loading || snapshot.search.loading} onClick={() => {
          if (!snapshot.viewReady) void model.retryView()
          else if (snapshot.searchStatus?.enabled && snapshot.view.query.trim()) void model.runSearch()
          else void model.refreshList(true)
        }}>↻</button>
      </div>
    </header>
    <div className="qvh-controls">
      <div className="qvh-control-line">
        <div className="qvh-scope-switch" role="group" aria-label="History scope">
          {(['workspace', 'project', 'all'] as const).map((value) => <button type="button" key={value} aria-pressed={scope === value} disabled={!scopeAvailability[value]} title={!scopeAvailability[value] ? value === 'workspace' ? 'A current worktree is required.' : 'A current project is required.' : undefined} onClick={() => void model.setView({ scope: value }).catch(() => {})}>{value === 'workspace' ? 'Workspace' : value === 'project' ? 'Project' : 'All'}</button>)}
        </div>
        <label className="qvh-search-line">
          <input ref={searchInput} className="qvh-input" type="search" aria-label="Search sessions" placeholder="Search sessions" data-vault-search value={snapshot.view.query} onChange={(event) => setQuery(event.currentTarget.value)} />
        </label>
      </div>
      {snapshot.view.host === 'local' && !snapshot.searchStatus?.enabled ? <SearchDisclosure enabled={false} busy={snapshot.searchStatus === null} searchTip={snapshot.searchTip} onEnable={() => void model.setSearchEnabled(true, 'local').catch((error) => context.toast('Could not enable search', `Try again. ${messageOf(error)}`))} /> : null}
      <div className="qvh-query-status" role="status" aria-live="polite">{currentSearchMessage}</div>
    </div>
    {optionsOpen ? <ViewOptions model={model} snapshot={snapshot} onClose={() => setOptionsOpen(false)} /> : null}
    <div className="qvh-scan-strip" data-vault-scan-status={snapshot.list.loading ? 'scanning' : 'settled'}>
      {snapshot.list.loading ? <><span>Scanning {snapshot.scanProgress?.scannedFiles ?? 0} files{snapshot.scanProgress?.current ? ` · ${snapshot.scanProgress.current}` : ''}</span><span className="qvh-progress"><span /></span><span>{model.scanElapsed(now)}</span></> : <><span>Scanned {snapshot.list.result?.scannedFiles ?? 0} files</span><span>{model.ageText(now)}</span><span>{snapshot.list.result?.total ?? 0} sessions</span></>}
    </div>
    {snapshot.hostOutcomes.filter((host) => host.kind !== 'ok').map((host) => <div className="qvh-issue" role="status" key={host.hostId}>{host.label}: {host.reason ?? (host.kind === 'unavailable' ? 'This host does not provide history search.' : 'This host could not be reached.')}</div>)}
    {snapshot.list.result?.issues.map((issue, index) => <div className="qvh-issue" role="status" key={`${issue.hostId}:${issue.filePath ?? issue.root ?? index}`}>{issue.kind === 'notice' ? 'Notice: ' : 'History source issue: '}{issue.reason}</div>)}
    {snapshot.list.error ? <div className="qvh-error" role="alert">{snapshot.list.error} <button type="button" className="qvh-button" onClick={() => snapshot.viewReady ? void model.refreshList(true) : void model.retryView()}>Retry</button></div> : null}
    <div className="qvh-sortbar">
      <strong>{snapshot.view.query.trim() && snapshot.searchStatus?.enabled ? `${snapshot.search.response?.kind === 'results' ? snapshot.search.response.hits.length : 0} matches` : `${allRows.length} of ${snapshot.list.result?.total ?? 0} sessions`}</strong>
      <label className="qvh-muted" htmlFor="qvh-sort">Sort</label>
      <select id="qvh-sort" className="qvh-select" aria-label="Sort sessions" value={snapshot.view.query.trim() && snapshot.searchStatus?.enabled ? snapshot.view.searchSort : snapshot.view.browseSort} onChange={(event) => {
        if (snapshot.view.query.trim() && snapshot.searchStatus?.enabled) void model.setView({ searchSort: event.currentTarget.value as ViewState['searchSort'] }).catch(() => {})
        else void model.setView({ browseSort: event.currentTarget.value as ViewState['browseSort'] }).catch(() => {})
      }}>
        {snapshot.view.query.trim() && snapshot.searchStatus?.enabled ? <><option value="relevance">Most relevant</option><option value="newest">Newest</option></> : <><option value="updated">Last updated</option><option value="created">Created</option></>}
      </select>
    </div>
    <div className="qvh-list" ref={list} data-vault-virtual-list onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}>
      {grouped.entries.length ? <div className="qvh-list-spacer" style={{ height: grouped.totalHeight }}>
        {virtual.map(({ entry, top, height }) => {
          const style: CSSProperties = { transform: `translateY(${top}px)`, height }
          if (entry.kind === 'group') return <div className="qvh-virtual-item" key={entry.id} style={style}><div className="qvh-group-heading"><button type="button" aria-label={`${entry.collapsed ? 'Expand' : 'Collapse'} ${entry.label}`} aria-expanded={!entry.collapsed} onClick={() => setCollapsed((current) => {
            const next = new Set(current)
            if (next.has(entry.id)) next.delete(entry.id)
            else next.add(entry.id)
            return next
          })}>{entry.collapsed ? '›' : '⌄'}</button><strong>{entry.label}</strong><span className="qvh-group-count">{entry.count}</span></div></div>
          const row = entry.row
          const expanded = snapshot.view.expandedIds.includes(row.id)
          return <div className="qvh-virtual-item" key={entry.id} style={style}><SessionRow
            context={context}
            row={row}
            view={snapshot.view}
            selected={snapshot.view.selectedId === row.id}
            expanded={expanded}
            menuOpen={menuId === row.id}
            onSelect={() => { selectRow(row.id); setMenuId(null) }}
            onExpand={() => { selectRow(row.id); toggleExpanded(row.id) }}
            onMenu={() => { selectRow(row.id); setMenuId((current) => current === row.id ? null : row.id) }}
            onError={setError}
            onResumeWorktree={() => { selectRow(row.id); void resumeInWorktree(row) }}
            onResume={() => { selectRow(row.id); void resume(row) }}
            onHandoff={() => { selectRow(row.id); void handoff(row) }}
            onOpenSource={(mode) => { selectRow(row.id); void openSource(row, mode) }}
            onCopy={copy}
            onDelete={() => {
              setMenuId(null)
              void model.setView({ selectedId: null, expandedIds: snapshot.view.expandedIds.filter((id) => id !== row.id) }).catch(() => {})
              void model.refreshList(true)
            }}
          /></div>
        })}
      </div> : <div className={snapshot.list.error ? 'qvh-error' : 'qvh-empty'} role={snapshot.list.error ? 'alert' : 'status'}>{emptyListText(snapshot, noAgents, allRows)}{!snapshot.list.error && !noAgents && !snapshot.list.loading && allRows.length === 0 && snapshot.view.query.trim() ? <button type="button" className="qvh-button" onClick={() => setQuery('')}>Clear search</button> : null}</div>}
    </div>
    <div className="qvh-list-footer">
      {pageHasMore ? <button type="button" className="qvh-button" data-vault-load-more onClick={() => {
        if (snapshot.view.query.trim() && snapshot.searchStatus?.enabled) void model.loadMoreSearch()
        else if (totalLimit === 250) void model.setView({ sessionLimit: 500 }).catch(() => {})
        else if (totalLimit === 500) void model.setView({ sessionLimit: 1000 }).catch(() => {})
        else if (totalLimit === 1000) void model.setView({ sessionLimit: null }).catch(() => {})
      }} disabled={snapshot.list.loading || snapshot.search.loading}>{snapshot.view.query.trim() && snapshot.searchStatus?.enabled ? 'Load more matches' : 'Show more sessions'}</button> : snapshot.search.response?.kind === 'results' && snapshot.search.response.truncated.candidates ? <div className="qvh-footer-count">Some matches are beyond the candidate limit. Narrow your query.</div> : null}
      {snapshot.view.sessionLimit === null ? <div className="qvh-footer-count">Unlimited history can take longer to scan and may slow the app.</div> : null}
    </div>
    {snapshot.actionError ? <div className="qvh-error" role="alert">{snapshot.actionError}</div> : null}
  </div>
}

function ViewOptions({ model, snapshot, onClose }: { model: VaultWindowModel; snapshot: VaultSnapshot; onClose(): void }) {
  const disabled = new Set(snapshot.view.disabledAgents)
  const option = (patch: Partial<ViewState>) => void model.setView(patch).catch(() => {})
  return <div className="qvh-view-options" role="dialog" aria-label="View options" data-vault-view-options>
    <div className="qvh-option-toolbar"><strong className="qvh-options-title">View options</strong><button type="button" className="qvh-button" onClick={onClose}>Close</button></div>
    <section className="qvh-options-section">
      <div className="qvh-options-title">Agents</div>
      <div className="qvh-option-toolbar"><button type="button" className="qvh-button" onClick={() => option({ disabledAgents: [] })}>Select all</button><button type="button" className="qvh-button" onClick={() => option({ disabledAgents: [...HISTORY_AGENTS] })}>Clear</button></div>
      <div className="qvh-agent-list">{HISTORY_AGENTS.map((agent) => <label key={agent}><input type="checkbox" checked={!disabled.has(agent)} onChange={(event) => {
        const next = new Set(disabled)
        if (event.currentTarget.checked) next.delete(agent)
        else next.add(agent)
        option({ disabledAgents: [...next] })
      }} />{agentLabel(agent)}</label>)}</div>
    </section>
    <section className="qvh-options-section"><div className="qvh-options-title">Group</div><div className="qvh-option-line"><label><input type="radio" name="qvh-group" checked={snapshot.view.group === 'project'} onChange={() => option({ group: 'project' })} />Project</label><label><input type="radio" name="qvh-group" checked={snapshot.view.group === 'folder'} onChange={() => option({ group: 'folder' })} />Folder</label><label><input type="radio" name="qvh-group" checked={snapshot.view.group === 'agent'} onChange={() => option({ group: 'agent' })} />Agent</label></div></section>
    <section className="qvh-options-section"><div className="qvh-option-line"><label><input type="checkbox" checked={snapshot.view.hideEmptySessions} onChange={(event) => option({ hideEmptySessions: event.currentTarget.checked })} />Hide empty sessions</label></div></section>
    <section className="qvh-options-section">
      <div className="qvh-options-title">History depth</div>
      <select className="qvh-select" aria-label="History depth" value={snapshot.view.sessionLimit === null ? 'unlimited' : String(snapshot.view.sessionLimit)} onChange={(event) => option({ sessionLimit: event.currentTarget.value === 'unlimited' ? null : Number(event.currentTarget.value) as 250 | 500 | 1000 })}>
        <option value="250">250 · Recommended</option><option value="500">500 · May be slower</option><option value="1000">1,000</option><option value="unlimited">Unlimited · Slowest</option>
      </select>
      <p className="qvh-option-warning">Larger histories can slow the entire app, especially on remote hosts. Unlimited scans all available history.</p>
    </section>
    <section className="qvh-options-section"><button type="button" className="qvh-button" disabled={adjustmentCount(snapshot.view) === 0} onClick={() => void model.resetView().catch(() => {})}>Reset view</button></section>
  </div>
}

export function mountHistoryPanel(context: UiPluginContext, element: HTMLElement, props: { report?(state: unknown): void }): () => void {
  injectVaultStyles(element.ownerDocument)
  Object.assign(element.style, { display: 'flex', flexDirection: 'column', flex: '1', minHeight: '0', minWidth: '0', position: 'relative' })
  const root = createRoot(element)
  root.render(<HistoryPanel context={context} report={props.report} />)
  return () => root.unmount()
}
