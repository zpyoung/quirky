import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { GitChange, GitCommit, GitCompare, GitDiff, GitDiffSource, GitHistory, GitStatus } from '@quirky/protocol'
import type { MobileConnectionState } from '../../contracts'
import type { PanelProps } from '../contracts'
import {
  clearSentNotes,
  collectReviewFiles,
  EMPTY_REVIEW_STATE,
  moveDiffIndex,
  normalizeReviewState,
  recordSentNotes,
  reviewProgress,
  reviewStorageKey,
  stageableReviewedPaths,
  toggleReviewedPath,
  type ReviewFile,
  type ReviewNote,
  type ReviewState
} from './model'

type ConnectionAwareBridge = PanelProps['bridge'] & {
  readonly state: MobileConnectionState
  onState(handler: (state: MobileConnectionState) => void): () => void
}
type HubTab = 'changes' | 'pull-request' | 'commits'
type HostingReview = {
  number: number
  url: string
  title: string
  state: 'open' | 'draft' | 'closed' | 'merged'
  headRefName: string
  baseRefName: string
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
  mergeStateStatus: string
  changedFiles?: number
  additions?: number
  deletions?: number
  checksStatus?: string
}
type PullRequestLookup =
  | { kind: 'found'; review: HostingReview }
  | { kind: 'no-review' }
  | { kind: 'unavailable'; message?: string; reason?: string }
type CreationEligibility = {
  eligible: boolean
  defaultBase: string | null
  head: string | null
  title: string
  body: string
  review?: HostingReview
  blockers: { reason: string; nextAction: string; message: string }[]
}
type NoteTargets = {
  sessions: { session: string; agent: string; label: string; title: string; sendable: boolean; reason?: string }[]
  agents: { id: string; label: string }[]
}
type NotesResult = { notes: ReviewNote[] }
type DiffSource = GitDiffSource | 'conflict'
type ConflictFile = { path: string; kind: string; state: 'unresolved' | 'resolved_locally'; content: string | null; hash: string | null; operation: string }
type ReviewDiffState = { key: string; loading: boolean; diff?: GitDiff; conflict?: ConflictFile; error?: string }
type Confirmation = { title: string; message: string; button: string; danger: boolean; run: () => Promise<void> }
type CommitFilesResult = { commit: string; parent: string | null; entries: GitChange[] }
type SessionCreation = { id: string }
type ReviewNoteDraft = { start: string; end: string; body: string }
const EMPTY_REVIEW_NOTE_DRAFT: ReviewNoteDraft = { start: '1', end: '1', body: '' }
type ChangeResult<T> = { ok: true; value: T } | { ok: false; error: unknown }

const PAGE_STYLE = `
.sc-root{box-sizing:border-box;min-height:100%;padding:16px;overflow:auto;color:var(--text,#202124);font:14px/1.45 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:var(--bg,#fff)}
.sc-root *{box-sizing:border-box}.sc-shell{max-width:980px;margin:0 auto;padding-bottom:24px}.sc-header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.sc-header h1{margin:0;font-size:22px;line-height:1.2}.sc-subtitle{margin:4px 0 0;color:var(--muted,#667085);overflow-wrap:anywhere}.sc-eyebrow{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted,#667085)}
.sc-card{border:1px solid var(--border,#d0d5dd);border-radius:12px;padding:14px;margin:12px 0;background:var(--bg-raised,#fff)}.sc-card h2,.sc-card h3{margin:0 0 8px;font-size:15px}.sc-branch{display:flex;flex-wrap:wrap;align-items:center;gap:8px}.sc-branch strong{font-size:16px;overflow-wrap:anywhere}.sc-stats,.sc-actions,.sc-tabs,.sc-row-main,.sc-note-head,.sc-commit-main{display:flex;align-items:center;gap:8px}.sc-stats{flex-wrap:wrap;margin-top:10px;color:var(--muted,#667085)}.sc-stats span{border-right:1px solid var(--border,#d0d5dd);padding-right:8px}.sc-stats span:last-child{border:0}.sc-actions{flex-wrap:wrap;margin-top:10px}.sc-button{appearance:none;border:1px solid var(--border,#c7ccd4);background:var(--bg-raised,#fff);color:inherit;border-radius:8px;padding:8px 11px;font:inherit;font-weight:600;cursor:pointer;min-height:38px}.sc-button:hover:not(:disabled){background:var(--bg-hover,#f2f4f7)}.sc-button:focus-visible,.sc-tabs button:focus-visible,.sc-row button:focus-visible,.sc-root input:focus-visible,.sc-root textarea:focus-visible,.sc-root select:focus-visible{outline:2px solid var(--accent,#3978d4);outline-offset:2px}.sc-button:disabled{opacity:.48;cursor:not-allowed}.sc-primary{background:var(--accent,#2463b5);color:#fff;border-color:var(--accent,#2463b5)}.sc-danger{color:var(--danger,#b42318);border-color:currentColor}.sc-tabs{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;margin:14px 0}.sc-tabs button{border:1px solid var(--border,#d0d5dd);border-radius:8px;background:transparent;color:inherit;padding:9px 5px;font:inherit;font-weight:650;cursor:pointer}.sc-tabs button[aria-selected=true]{background:var(--bg-active,#eaf2ff);border-color:var(--accent,#3978d4);color:var(--accent,#2463b5)}.sc-section{margin:16px 0}.sc-section-title{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 0 8px;font-size:12px;letter-spacing:.07em;text-transform:uppercase;color:var(--muted,#667085)}.sc-row,.sc-commit-row{border:1px solid var(--border,#e1e4e8);border-radius:9px;padding:10px;margin:7px 0}.sc-row-main{justify-content:space-between;align-items:flex-start}.sc-row-path{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}.sc-row-meta{display:block;color:var(--muted,#667085);font-size:12px}.sc-row button{font:inherit}.sc-tag{display:inline-block;border-radius:20px;padding:2px 8px;background:var(--bg-hover,#f2f4f7);color:var(--muted,#475467);font-size:12px}.sc-tag-conflict{background:#fff0ee;color:#b42318}.sc-muted{color:var(--muted,#667085)}.sc-alert{border:1px solid #f0b8b1;background:#fff5f4;border-radius:8px;padding:10px;margin:10px 0;color:#8a1c13;overflow-wrap:anywhere}.sc-info{border:1px solid var(--border,#d0d5dd);border-radius:8px;padding:10px;margin:10px 0;background:var(--bg-hover,#f7f8fa)}.sc-empty{padding:18px 10px;text-align:center;color:var(--muted,#667085)}.sc-form{display:grid;gap:10px}.sc-root label{display:grid;gap:4px;font-size:13px;font-weight:600}.sc-root input,.sc-root textarea,.sc-root select{width:100%;border:1px solid var(--border,#c7ccd4);border-radius:8px;background:var(--bg,#fff);color:inherit;padding:9px;font:inherit}.sc-root textarea{resize:vertical;min-height:80px}.sc-root .sc-small-input{max-width:130px}.sc-grid-two{display:grid;grid-template-columns:1fr 1fr;gap:8px}.sc-pr-title{font-size:16px;font-weight:700;overflow-wrap:anywhere}.sc-pr-link{color:var(--accent,#2463b5);overflow-wrap:anywhere}.sc-diff-sides{display:grid;grid-template-columns:minmax(0,1fr);gap:8px}.sc-diff-side{min-width:0;border:1px solid var(--border,#d0d5dd);border-radius:8px;overflow:hidden}.sc-diff-side h4{margin:0;padding:7px 9px;background:var(--bg-hover,#f2f4f7);font-size:12px}.sc-diff-side pre{margin:0;padding:10px;overflow:auto;max-height:45vh;white-space:pre;tab-size:2;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}.sc-file-nav{display:flex;align-items:center;justify-content:space-between;gap:8px}.sc-note{border-top:1px solid var(--border,#e1e4e8);padding:10px 0}.sc-note-body{white-space:pre-wrap;overflow-wrap:anywhere}.sc-note-range{color:var(--muted,#667085);font-size:12px}.sc-compact{display:flex;flex-wrap:wrap;align-items:center;gap:8px}.sc-compact>*{flex:0 1 auto}.sc-busy{color:var(--muted,#667085);font-style:italic}.sc-review-progress{font-weight:650}.sc-details{border-top:1px solid var(--border,#e1e4e8);padding-top:9px;margin-top:10px}.sc-details summary{cursor:pointer;font-weight:650}.sc-confirm-overlay{position:fixed;inset:0;z-index:1000;display:grid;place-items:center;padding:16px;background:#0008}.sc-confirm{width:min(100%,440px);border-radius:12px;padding:16px;background:var(--bg,#fff);color:var(--text,#202124);box-shadow:0 16px 60px #0004}.sc-confirm h2{margin:0 0 8px;font-size:18px}.sc-confirm p{overflow-wrap:anywhere}.sc-footer{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}.sc-inline{display:inline}.sc-divider{height:1px;border:0;background:var(--border,#e1e4e8);margin:14px 0}.sc-pr-context{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;flex-wrap:wrap}
.sc-header{flex-wrap:wrap}.sc-row-main,.sc-note-head{flex-wrap:wrap}.sc-row-path{appearance:none;border:0;padding:0;background:transparent;color:var(--accent,#2463b5);text-align:left;cursor:pointer;font:ui-monospace,SFMono-Regular,Menlo,monospace}.sc-commit-row{display:block;width:100%;text-align:left}.sc-grid-two{grid-template-columns:1fr}@media(min-width:860px){.sc-grid-two{grid-template-columns:minmax(230px,.65fr) minmax(0,1fr)}}
@media(min-width:680px){.sc-root{padding:24px}.sc-diff-sides{grid-template-columns:1fr 1fr}.sc-diff-side pre{max-height:60vh}}
`

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : 'The host request failed. Refresh and try again.'
}

function uniqueCount(entries: readonly { path: string }[]): number {
  return new Set(entries.map((entry) => entry.path)).size
}

function areaCount(status: GitStatus | null, area: string): number {
  if (!status) return 0
  return uniqueCount(status.entries.filter((entry) => entry.area === area))
}

function lineRange(note: ReviewNote): string {
  return note.startLine === note.line ? `Line ${note.line}` : `Lines ${note.startLine}–${note.line}`
}

function sourcesForReviewFile(file: ReviewFile, compare: GitCompare | null): DiffSource[] {
  const options: DiffSource[] = []
  if (file.areas.includes('conflicts')) options.push('conflict')
  if (file.areas.includes('staged')) options.push('staged')
  if (file.areas.includes('unstaged') || file.areas.includes('untracked')) options.push('unstaged')
  if (compare?.status === 'ready' && compare.entries.some((entry) => entry.path === file.path)) options.push('branch')
  if (options.length === 0 && file.source === 'branch') options.push('branch')
  return [...new Set(options)]
}

function activeReviewSource(file: ReviewFile, selected: DiffSource | undefined, compare: GitCompare | null): DiffSource {
  const options = sourcesForReviewFile(file, compare)
  return selected !== undefined && options.includes(selected) ? selected : file.source
}

function DiffSides({ diff }: { diff: GitDiff }) {
  if (diff.tooLarge) {
    return <p className="sc-info">This text diff is too large to display ({diff.tooLarge.originalLines} original and {diff.tooLarge.modifiedLines} modified lines).</p>
  }
  if (diff.binary || diff.kind !== 'text') {
    const kind = diff.kind === 'image' ? 'Image' : 'Binary'
    return <p className="sc-info">{kind} changes are not presented as editable text.</p>
  }
  return (
    <div className="sc-diff-sides">
      <section className="sc-diff-side" aria-label="Original file content">
        <h4>Original</h4>
        <pre>{diff.original}</pre>
      </section>
      <section className="sc-diff-side" aria-label="Modified file content">
        <h4>Modified</h4>
        <pre>{diff.modified}</pre>
      </section>
    </div>
  )
}

export function SourceControlPanel({ bridge, route }: PanelProps) {
  const supportedRoute = route.kind === 'source-control' || route.kind === 'review'
  const worktreeId = supportedRoute ? route.worktreeId : ''
  const hostId = bridge.init.host.id
  const routeKey = `${hostId}\u0000${worktreeId}`
  const activeRouteKey = useRef(routeKey)
  activeRouteKey.current = routeKey
  const connectionBridge = bridge as ConnectionAwareBridge
  const [connection, setConnection] = useState<MobileConnectionState>(() => connectionBridge.state)
  const connectionRef = useRef(connectionBridge.state)
  const connected = connection.phase === 'connected'
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [compare, setCompare] = useState<GitCompare | null>(null)
  const [statusLoading, setStatusLoading] = useState(true)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [compareError, setCompareError] = useState<string | null>(null)
  const [statusStale, setStatusStale] = useState(!connected)
  const [tab, setTab] = useState<HubTab>(() => (route.kind === 'source-control' ? route.tab ?? 'changes' : 'changes'))
  const [pending, setPending] = useState<string | null>(null)
  const [mutationError, setMutationError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const [branchPickerOpen, setBranchPickerOpen] = useState(false)
  const [branchQuery, setBranchQuery] = useState('')
  const [branches, setBranches] = useState<{ name: string; kind: 'local' | 'remote' }[]>([])
  const [branchesLoading, setBranchesLoading] = useState(false)
  const [selectedBranch, setSelectedBranch] = useState('')
  const [commitMessage, setCommitMessage] = useState('')
  const messageRevision = useRef(0)
  const generationSequence = useRef(0)
  const [generatingMessage, setGeneratingMessage] = useState(false)
  const [prState, setPrState] = useState<PullRequestLookup | { kind: 'loading' } | { kind: 'no-branch' }>({ kind: 'loading' })
  const [prError, setPrError] = useState<string | null>(null)
  const [eligibility, setEligibility] = useState<CreationEligibility | null>(null)
  const [eligibilityError, setEligibilityError] = useState<string | null>(null)
  const [prTitle, setPrTitle] = useState('')
  const [prBody, setPrBody] = useState('')
  const [prBase, setPrBase] = useState('')
  const [prSuccess, setPrSuccess] = useState<string | null>(null)
  const [linkPRNumber, setLinkPRNumber] = useState('')
  const [linkPRError, setLinkPRError] = useState<string | null>(null)
  const [history, setHistory] = useState<GitHistory | null>(null)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [selectedCommit, setSelectedCommit] = useState<GitCommit | null>(null)
  const [commitFiles, setCommitFiles] = useState<CommitFilesResult | null>(null)
  const [commitFilesError, setCommitFilesError] = useState<string | null>(null)
  const [selectedCommitPath, setSelectedCommitPath] = useState('')
  const [commitDiff, setCommitDiff] = useState<GitDiff | null>(null)
  const [commitDiffError, setCommitDiffError] = useState<string | null>(null)
  const [commitDiffLoading, setCommitDiffLoading] = useState(false)
  const [notes, setNotes] = useState<ReviewNote[]>([])
  const [notesError, setNotesError] = useState<string | null>(null)
  const [notesLoading, setNotesLoading] = useState(false)
  const [reviewState, setReviewState] = useState<ReviewState>(EMPTY_REVIEW_STATE)
  const reviewStateRef = useRef(reviewState)
  const [reviewStorageError, setReviewStorageError] = useState<string | null>(null)
  const [reviewStorageLoading, setReviewStorageLoading] = useState(true)
  const [reviewIndex, setReviewIndex] = useState(0)
  const [selectedSources, setSelectedSources] = useState<Record<string, DiffSource>>({})
  const [reviewDiff, setReviewDiff] = useState<ReviewDiffState | null>(null)
  const [noteDrafts, setNoteDrafts] = useState<Record<string, ReviewNoteDraft>>({})
  const [editingNote, setEditingNote] = useState<string | null>(null)
  const [editingBody, setEditingBody] = useState('')
  const [noteBusy, setNoteBusy] = useState(false)
  const [noteNotice, setNoteNotice] = useState<string | null>(null)
  const [targets, setTargets] = useState<NoteTargets | null>(null)
  const [targetsError, setTargetsError] = useState<string | null>(null)
  const [targetsLoading, setTargetsLoading] = useState(false)
  const [targetChoice, setTargetChoice] = useState('')
  const [lastTargetSession, setLastTargetSession] = useState<string | null>(null)
  const [copyBusy, setCopyBusy] = useState(false)
  const requestSequence = useRef(0)
  const pullRequestSequence = useRef(0)
  const notesSequence = useRef(0)
  const historySequence = useRef(0)
  const targetsSequence = useRef(0)
  const targetLoadRouteKey = useRef<string | null>(null)
  const mutationSequence = useRef(0)
  const noteOperationSequence = useRef(0)
  const reviewStorageKeyValue = reviewStorageKey(hostId, worktreeId)
  const prLinkStorageKeyValue = `quirky.mobile.review-pr-link.v1.${encodeURIComponent(hostId)}.${encodeURIComponent(worktreeId)}`

  const refreshGit = useCallback(async (): Promise<void> => {
    const key = routeKey
    const sequence = ++requestSequence.current
    if (connectionRef.current.phase !== 'connected') {
      setStatusLoading(false)
      setStatusStale(true)
      return
    }
    setStatusLoading(true)
    const [statusResult, compareResult] = await Promise.all([
      bridge.call<GitStatus>('quirky.git/status', { worktree: worktreeId }).then((value): ChangeResult<GitStatus> => ({ ok: true, value })).catch((error): ChangeResult<GitStatus> => ({ ok: false, error })),
      bridge.call<GitCompare>('quirky.git/compare', { worktree: worktreeId }).then((value): ChangeResult<GitCompare> => ({ ok: true, value })).catch((error): ChangeResult<GitCompare> => ({ ok: false, error }))
    ])
    if (sequence !== requestSequence.current || activeRouteKey.current !== key) return
    if (statusResult.ok) {
      setStatus(statusResult.value)
      setStatusError(null)
      setStatusStale(connectionRef.current.phase !== 'connected')
    } else {
      setStatusError(messageOf(statusResult.error))
      setStatusStale(true)
    }
    if (compareResult.ok) {
      setCompare(compareResult.value)
      setCompareError(null)
    } else {
      setCompare(null)
      setCompareError(messageOf(compareResult.error))
    }
    setStatusLoading(false)
  }, [bridge, routeKey, worktreeId])

  const loadNotes = useCallback(async (): Promise<void> => {
    const key = routeKey
    const sequence = ++notesSequence.current
    if (connectionRef.current.phase !== 'connected') {
      setNotesLoading(false)
      return
    }
    setNotesLoading(true)
    try {
      const result = await bridge.call<NotesResult>('quirky.git/notes', { worktree: worktreeId })
      if (activeRouteKey.current !== key || sequence !== notesSequence.current) return
      setNotes(result.notes)
      setNotesError(null)
    } catch (error) {
      if (activeRouteKey.current === key && sequence === notesSequence.current) setNotesError(messageOf(error))
    } finally {
      if (activeRouteKey.current === key && sequence === notesSequence.current) setNotesLoading(false)
    }
  }, [bridge, routeKey, worktreeId])

  const refreshPullRequest = useCallback(async (): Promise<void> => {
    const key = routeKey
    const sequence = ++pullRequestSequence.current
    if (connectionRef.current.phase !== 'connected') return
    if (!status?.branch || !status.head) {
      setPrState({ kind: 'no-branch' })
      setEligibility(null)
      return
    }
    setPrState({ kind: 'loading' })
    setPrError(null)
    setEligibilityError(null)

    let fallbackPRNumber: number | undefined
    try {
      const saved = await bridge.storage.get(prLinkStorageKeyValue)
      const parsed = saved === null ? NaN : Number(saved)
      if (Number.isSafeInteger(parsed) && parsed > 0) fallbackPRNumber = parsed
    } catch {
      fallbackPRNumber = undefined
    }
    if (sequence !== pullRequestSequence.current || activeRouteKey.current !== key) return

    let lookup: PullRequestLookup
    try {
      lookup = await bridge.call<PullRequestLookup>('quirky.hosting/forBranch', {
        worktree: worktreeId,
        branch: status.branch,
        headOid: status.head,
        ...(fallbackPRNumber === undefined ? {} : { fallbackPRNumber })
      })
    } catch (error) {
      if (sequence !== pullRequestSequence.current || activeRouteKey.current !== key) return
      setPrState({ kind: 'unavailable', message: messageOf(error) })
      setPrError(messageOf(error))
      return
    }
    if (sequence !== pullRequestSequence.current || activeRouteKey.current !== key) return
    if (lookup.kind === 'found') {
      setPrState(lookup)
      setEligibility(null)
      return
    }
    if (lookup.kind === 'unavailable') {
      setPrState(lookup)
      return
    }

    if (fallbackPRNumber !== undefined) {
      try {
        const linked = await bridge.call<PullRequestLookup>('quirky.hosting/review', { worktree: worktreeId, number: fallbackPRNumber })
        if (sequence !== pullRequestSequence.current || activeRouteKey.current !== key) return
        if (linked.kind === 'found' || linked.kind === 'unavailable') {
          setPrState(linked)
          return
        }
        await bridge.storage.remove(prLinkStorageKeyValue).catch(() => undefined)
      } catch (error) {
        if (sequence !== pullRequestSequence.current || activeRouteKey.current !== key) return
        setPrState({ kind: 'unavailable', message: messageOf(error) })
        setPrError(messageOf(error))
        return
      }
    }

    setPrState({ kind: 'no-review' })
    try {
      const defaults = await bridge.call<CreationEligibility>('quirky.hosting/creationEligibility', {
        worktree: worktreeId,
        head: status.branch
      })
      if (sequence !== pullRequestSequence.current || activeRouteKey.current !== key) return
      setEligibility(defaults)
      setPrTitle(defaults.title)
      setPrBody(defaults.body)
      setPrBase(defaults.defaultBase ?? '')
      if (defaults.review) setPrState({ kind: 'found', review: defaults.review })
    } catch (error) {
      if (sequence === pullRequestSequence.current && activeRouteKey.current === key) {
        setEligibilityError(messageOf(error))
      }
    }
  }, [bridge, prLinkStorageKeyValue, routeKey, status?.branch, status?.head, worktreeId])

  const loadHistory = useCallback(async (): Promise<void> => {
    const key = routeKey
    const sequence = ++historySequence.current
    if (connectionRef.current.phase !== 'connected') {
      setHistoryLoading(false)
      return
    }
    setHistoryLoading(true)
    try {
      const result = await bridge.call<GitHistory>('quirky.git/history', { worktree: worktreeId, limit: 50 })
      if (activeRouteKey.current !== key || sequence !== historySequence.current) return
      setHistory(result)
      setHistoryError(null)
      setSelectedCommit((current) => current && result.commits.some((commit) => commit.oid === current.oid) ? current : result.commits[0] ?? null)
    } catch (error) {
      if (activeRouteKey.current === key && sequence === historySequence.current) setHistoryError(messageOf(error))
    } finally {
      if (activeRouteKey.current === key && sequence === historySequence.current) setHistoryLoading(false)
    }
  }, [bridge, routeKey, worktreeId])

  const loadTargets = useCallback(async (): Promise<void> => {
    const key = routeKey
    const sequence = ++targetsSequence.current
    if (connectionRef.current.phase !== 'connected') {
      setTargetsLoading(false)
      return
    }
    setTargetsLoading(true)
    try {
      const result = await bridge.call<NoteTargets>('quirky.git/noteTargets', { worktree: worktreeId })
      if (activeRouteKey.current !== key || sequence !== targetsSequence.current) return
      setTargets(result)
      setTargetsError(null)
      setTargetChoice((current) => current || (result.sessions.find((session) => session.sendable) ? `session:${result.sessions.find((session) => session.sendable)!.session}` : result.agents[0] ? `agent:${result.agents[0].id}` : ''))
    } catch (error) {
      if (activeRouteKey.current === key && sequence === targetsSequence.current) setTargetsError(messageOf(error))
    } finally {
      if (activeRouteKey.current === key && sequence === targetsSequence.current) setTargetsLoading(false)
    }
  }, [bridge, routeKey, worktreeId])

  useEffect(() => {
    const initial = connectionBridge.state
    connectionRef.current = initial
    setConnection(initial)
    if (initial.phase !== 'connected') setStatusStale(true)
    const off = connectionBridge.onState((next) => {
      const wasConnected = connectionRef.current.phase === 'connected'
      connectionRef.current = next
      setConnection(next)
      if (next.phase !== 'connected') {
        setStatusStale(true)
        setTargets(null)
        setTargetsError(null)
        setTargetChoice('')
        targetLoadRouteKey.current = null
      } else if (!wasConnected) {
        void refreshGit()
        void loadNotes()
      }
    })
    return off
  }, [connectionBridge, refreshGit, loadNotes])

  useEffect(() => {
    setStatus(null)
    setCompare(null)
    setStatusError(null)
    setCompareError(null)
    setStatusStale(connectionRef.current.phase !== 'connected')
    setStatusLoading(true)
    setPending(null)
    setMutationError(null)
    setNotice(null)
    setConfirmation(null)
    setBranchPickerOpen(false)
    setBranchQuery('')
    setBranches([])
    setBranchesLoading(false)
    setSelectedBranch('')
    setCommitMessage('')
    messageRevision.current += 1
    generationSequence.current += 1
    setGeneratingMessage(false)
    setPrState({ kind: 'loading' })
    setPrError(null)
    setEligibility(null)
    setEligibilityError(null)
    setPrTitle('')
    setPrBody('')
    setPrBase('')
    setPrSuccess(null)
    setLinkPRNumber('')
    setLinkPRError(null)
    setHistory(null)
    setHistoryError(null)
    setHistoryLoading(false)
    setSelectedCommit(null)
    setCommitFiles(null)
    setCommitFilesError(null)
    setSelectedCommitPath('')
    setCommitDiff(null)
    setCommitDiffError(null)
    setCommitDiffLoading(false)
    setNotes([])
    setNotesError(null)
    setNotesLoading(false)
    setReviewState(EMPTY_REVIEW_STATE)
    reviewStateRef.current = EMPTY_REVIEW_STATE
    setReviewStorageLoading(true)
    setReviewStorageError(null)
    setReviewIndex(0)
    setSelectedSources({})
    setReviewDiff(null)
    setNoteDrafts({})
    setEditingNote(null)
    setEditingBody('')
    setNoteBusy(false)
    setNoteNotice(null)
    setTargets(null)
    setTargetsError(null)
    setTargetsLoading(false)
    setTargetChoice('')
    setLastTargetSession(null)
    setCopyBusy(false)
    targetLoadRouteKey.current = null
    requestSequence.current += 1
    pullRequestSequence.current += 1
    notesSequence.current += 1
    historySequence.current += 1
    targetsSequence.current += 1
    mutationSequence.current += 1
    noteOperationSequence.current += 1
    void refreshGit()
    void loadNotes()
    return () => {
      requestSequence.current += 1
      pullRequestSequence.current += 1
      notesSequence.current += 1
      historySequence.current += 1
      targetsSequence.current += 1
      mutationSequence.current += 1
      noteOperationSequence.current += 1
    }
  }, [routeKey, refreshGit, loadNotes])

  useEffect(() => {
    if (route.kind !== 'review' || !connected || targetLoadRouteKey.current === routeKey) return
    targetLoadRouteKey.current = routeKey
    void loadTargets()
  }, [connected, loadTargets, route.kind, routeKey])

  useEffect(() => {
    if (route.kind === 'source-control') setTab(route.tab ?? 'changes')
  }, [route.kind, route.kind === 'source-control' ? route.tab : undefined, routeKey])

  useEffect(() => {
    let alive = true
    setReviewStorageError(null)
    setReviewStorageLoading(true)
    void bridge.storage.get(reviewStorageKeyValue).then((raw) => {
      if (!alive) return
      let restored = EMPTY_REVIEW_STATE
      try {
        restored = normalizeReviewState(raw === null ? null : JSON.parse(raw))
      } catch {
        restored = EMPTY_REVIEW_STATE
      }
      reviewStateRef.current = restored
      setReviewState(restored)
    }).catch((error) => {
      if (alive) {
        reviewStateRef.current = EMPTY_REVIEW_STATE
        setReviewState(EMPTY_REVIEW_STATE)
        setReviewStorageError(messageOf(error))
      }
    }).finally(() => {
      if (alive) setReviewStorageLoading(false)
    })
    return () => { alive = false }
  }, [bridge, reviewStorageKeyValue])

  useEffect(() => {
    const off = bridge.onEvent((event) => {
      const worktree = (event.data as { worktreeId?: unknown } | null)?.worktreeId
      if (typeof worktree === 'string' && worktree !== worktreeId) return
      if (event.event === 'quirky.git/changed') void refreshGit()
      if (event.event === 'quirky.git/notesChanged') void loadNotes()
    })
    return off
  }, [bridge, loadNotes, refreshGit, worktreeId])

  useEffect(() => {
    if (status && connected && status.branch && status.head) void refreshPullRequest()
    else if (status && (!status.branch || !status.head)) setPrState({ kind: 'no-branch' })
  }, [connected, refreshPullRequest, status?.branch, status?.head])

  useEffect(() => {
    if (tab === 'commits' && route.kind === 'source-control') void loadHistory()
  }, [loadHistory, route.kind, tab])

  useEffect(() => {
    if (!selectedCommit || tab !== 'commits' || route.kind !== 'source-control' || !connected) {
      setCommitFiles(null)
      setSelectedCommitPath('')
      setCommitDiff(null)
      return
    }
    let alive = true
    setCommitFilesError(null)
    setCommitDiff(null)
    void bridge.call<CommitFilesResult>('quirky.git/commitFiles', { worktree: worktreeId, commit: selectedCommit.oid }).then((result) => {
      if (!alive) return
      setCommitFiles(result)
      setSelectedCommitPath(result.entries[0]?.path ?? '')
    }).catch((error) => {
      if (alive) setCommitFilesError(messageOf(error))
    })
    return () => { alive = false }
  }, [bridge, connected, selectedCommit?.oid, tab, route.kind, worktreeId])

  const reviewFiles = useMemo(
    () => collectReviewFiles(status?.entries ?? [], compare?.status === 'ready' ? compare.entries : []),
    [compare, status]
  )
  const reviewSignature = useMemo(() => reviewFiles.map((file) => `${file.path}\u0000${file.source}`).join('\n'), [reviewFiles])
  useEffect(() => {
    if (route.kind !== 'review') return
    const wanted = route.path ? reviewFiles.findIndex((file) => file.path === route.path) : -1
    setReviewIndex(wanted < 0 ? 0 : wanted)
    setReviewDiff(null)
  }, [reviewSignature, route.kind, route.kind === 'review' ? route.path : undefined])

  const currentReviewFile: ReviewFile | null = reviewFiles[reviewIndex] ?? null
  const activeNoteDraft = currentReviewFile ? noteDrafts[currentReviewFile.path] ?? EMPTY_REVIEW_NOTE_DRAFT : EMPTY_REVIEW_NOTE_DRAFT
  const editingOriginal = editingNote === null ? null : notes.find((note) => note.id === editingNote) ?? null
  const hasUnsavedReviewDraft = Object.values(noteDrafts).some((draft) => draft.body.trim() !== '') ||
    (editingNote !== null && editingBody !== (editingOriginal?.body ?? ''))
  const currentReviewSource: DiffSource | null = currentReviewFile
    ? activeReviewSource(currentReviewFile, selectedSources[currentReviewFile.path], compare)
    : null
  const currentReviewKey = currentReviewFile && currentReviewSource ? `${routeKey}\u0000${currentReviewFile.path}\u0000${currentReviewSource}\u0000${compare?.mergeBase ?? ''}\u0000${compare?.headOid ?? ''}` : ''

  useEffect(() => {
    if (route.kind !== 'review' || !currentReviewFile || !currentReviewSource) {
      setReviewDiff(null)
      return
    }
    let alive = true
    setReviewDiff({ key: currentReviewKey, loading: true })
    if (!connected) {
      setReviewDiff({ key: currentReviewKey, loading: false, error: 'Waiting for the desktop connection to read this diff.' })
      return () => { alive = false }
    }
    if (currentReviewSource === 'branch' && (compare?.status !== 'ready' || !compare.mergeBase || !compare.headOid)) {
      setReviewDiff({ key: currentReviewKey, loading: false, error: compare?.message ?? 'Branch comparison is unavailable.' })
      return () => { alive = false }
    }
    const params: Record<string, unknown> = {
      worktree: worktreeId,
      path: currentReviewFile.path,
      source: currentReviewSource
    }
    if (currentReviewFile.oldPath !== undefined) params.oldPath = currentReviewFile.oldPath
    if (currentReviewSource === 'branch' && compare?.mergeBase && compare.headOid) {
      params.mergeBase = compare.mergeBase
      params.head = compare.headOid
    }
    const request = currentReviewSource === 'conflict'
      ? bridge.call<ConflictFile>('quirky.git/conflictFile', { worktree: worktreeId, path: currentReviewFile.path })
      : bridge.call<GitDiff>('quirky.git/diff', params)
    void request.then((result) => {
      if (!alive) return
      if (currentReviewSource === 'conflict') setReviewDiff({ key: currentReviewKey, loading: false, conflict: result as ConflictFile })
      else setReviewDiff({ key: currentReviewKey, loading: false, diff: result as GitDiff })
    }).catch((error) => {
      if (alive) setReviewDiff({ key: currentReviewKey, loading: false, error: messageOf(error) })
    })
    return () => { alive = false }
  }, [bridge, compare, connected, currentReviewFile, currentReviewKey, currentReviewSource, route.kind, worktreeId])

  useEffect(() => {
    if (route.kind !== 'source-control' || tab !== 'commits' || !selectedCommit || !selectedCommitPath || !commitFiles || !connected) return
    let alive = true
    setCommitDiffLoading(true)
    setCommitDiffError(null)
    setCommitDiff(null)
    const selected = commitFiles.entries.find((entry) => entry.path === selectedCommitPath)
    const params: Record<string, unknown> = {
      worktree: worktreeId,
      path: selectedCommitPath,
      source: 'commit',
      commit: selectedCommit.oid
    }
    if (commitFiles.parent !== null) params.parent = commitFiles.parent
    if (selected?.oldPath !== undefined) params.oldPath = selected.oldPath
    void bridge.call<GitDiff>('quirky.git/diff', params).then((result) => {
      if (alive) setCommitDiff(result)
    }).catch((error) => {
      if (alive) setCommitDiffError(messageOf(error))
    }).finally(() => {
      if (alive) setCommitDiffLoading(false)
    })
    return () => { alive = false }
  }, [bridge, commitFiles, connected, route.kind, selectedCommit?.oid, selectedCommitPath, tab, worktreeId])

  const progress = reviewProgress(reviewFiles.map((file) => file.path), reviewState.reviewedPaths)
  const comparisonFileSetKnown = compare?.status === 'ready' || compare?.status === 'unborn-head'
  const reviewComplete = progress.complete && !reviewStorageLoading && status !== null && !statusStale && !status.capped && comparisonFileSetKnown
  const selectedTargetIsSendable = targetChoice.startsWith('agent:')
    ? targets?.agents.some((agent) => `agent:${agent.id}` === targetChoice) ?? false
    : targets?.sessions.some((session) => `session:${session.session}` === targetChoice && session.sendable) ?? false
  const changedCount = uniqueCount(status?.entries ?? [])
  const stagedCount = areaCount(status, 'staged')
  const stageableCount = uniqueCount(status?.entries.filter((entry) => entry.area === 'unstaged' || entry.area === 'untracked') ?? [])
  const branchCount = compare?.status === 'ready' ? compare.entries.length : 0
  const canWrite = connected && !statusStale && status !== null && status.busy === null && pending === null
  const canSwitchBranch = canWrite && status !== null && !status.capped && status.entries.length === 0 && status.operation === 'none'
  const activeCommitDisabled = status === null || status.busy !== null || status.capped || status.entries.some((entry) => entry.area === 'conflicts' && entry.conflict?.state === 'unresolved') || stagedCount === 0 || commitMessage.trim() === ''

  const updateReviewState = (update: (current: ReviewState) => ReviewState): void => {
    if (reviewStorageLoading) return
    const next = update(reviewStateRef.current)
    reviewStateRef.current = next
    setReviewState(next)
    void bridge.storage.set(reviewStorageKeyValue, JSON.stringify(next)).catch((error) => setReviewStorageError(messageOf(error)))
  }

  const updateNoteDraft = (path: string, patch: Partial<ReviewNoteDraft>): void => {
    setNoteDrafts((current) => ({
      ...current,
      [path]: { ...(current[path] ?? EMPTY_REVIEW_NOTE_DRAFT), ...patch }
    }))
  }

  const executeMutation = async (
    label: string,
    action: () => Promise<unknown>,
    after?: () => Promise<void>
  ): Promise<void> => {
    const key = routeKey
    if (!canWrite || connectionRef.current.phase !== 'connected' || activeRouteKey.current !== key) {
      setMutationError(connectionRef.current.phase === 'connected' ? 'Refresh Source Control before changing this worktree.' : 'Reconnect to the desktop before changing this worktree.')
      return
    }
    const sequence = ++mutationSequence.current
    setPending(label)
    setMutationError(null)
    setNotice(null)
    try {
      await action()
      if (activeRouteKey.current !== key || sequence !== mutationSequence.current) return
      if (connectionRef.current.phase !== 'connected') {
        setStatusStale(true)
        setMutationError(`${label} may have completed, but the connection was lost. Refresh to verify the current state.`)
        return
      }
      if (after) await after()
      else await refreshGit()
    } catch (error) {
      if (activeRouteKey.current !== key || sequence !== mutationSequence.current) return
      if (connectionRef.current.phase !== 'connected') setStatusStale(true)
      setMutationError(messageOf(error))
    } finally {
      if (activeRouteKey.current === key && sequence === mutationSequence.current) setPending(null)
    }
  }

  const askForConfirmation = async (
    title: string,
    description: string,
    button: string,
    danger: boolean,
    run: () => Promise<void>,
    expectedRouteKey = routeKey
  ): Promise<void> => {
    if (!canWrite || connectionRef.current.phase !== 'connected' || activeRouteKey.current !== expectedRouteKey) return
    setConfirmation({ title, message: description, button, danger, run })
  }

  const navigateWithDraftGuard = async (navigate: () => Promise<void>): Promise<void> => {
    const key = routeKey
    const continueNavigation = async (): Promise<void> => {
      if (activeRouteKey.current !== key) return
      if (hasUnsavedReviewDraft) {
        setNoteDrafts({})
        setEditingNote(null)
        setEditingBody('')
      }
      try {
        await navigate()
      } catch (error) {
        if (activeRouteKey.current === key) setMutationError(messageOf(error))
      }
    }
    if (!hasUnsavedReviewDraft) {
      await continueNavigation()
      return
    }
    setConfirmation({
      title: 'Unsaved Review Notes',
      message: 'Discard unsaved line-note drafts before leaving this review?',
      button: 'Discard Drafts and Continue',
      danger: true,
      run: continueNavigation
    })
  }

  const confirmDiscard = async (path: string): Promise<void> => {
    const key = routeKey
    try {
      const description = await bridge.call<string>('quirky.git/describeDiscard', { worktree: worktreeId, paths: [path] })
      if (activeRouteKey.current !== key) return
      await askForConfirmation('Discard change', description, 'Discard Change', true, () => executeMutation('Discard', () => bridge.call('quirky.git/discard', { worktree: worktreeId, paths: [path], yes: true })), key)
    } catch (error) {
      if (activeRouteKey.current === key) setMutationError(messageOf(error))
    }
  }

  const runRemote = (label: string, method: string): Promise<void> => executeMutation(label, () => bridge.call(method, { worktree: worktreeId }))

  const requestSwitchBranch = async (): Promise<void> => {
    const key = routeKey
    if (!canSwitchBranch || connectionRef.current.phase !== 'connected') return
    setBranchesLoading(true)
    setBranchQuery('')
    try {
      const result = await bridge.call<{ refs: { name: string; kind: 'local' | 'remote' }[]; current: string | null }>('quirky.git/branches', { worktree: worktreeId })
      if (activeRouteKey.current !== key) return
      setBranches(result.refs)
      setSelectedBranch('')
      setBranchPickerOpen(true)
    } catch (error) {
      if (activeRouteKey.current === key) setMutationError(messageOf(error))
    } finally {
      if (activeRouteKey.current === key) setBranchesLoading(false)
    }
  }

  const confirmBranchSwitch = async (): Promise<void> => {
    const key = routeKey
    if (!selectedBranch || !status) return
    try {
      const description = await bridge.call<string>('quirky.git/describeSwitchBranch', { worktree: worktreeId, branch: selectedBranch })
      if (activeRouteKey.current !== key) return
      setBranchPickerOpen(false)
      const params: Record<string, unknown> = { worktree: worktreeId, branch: selectedBranch, yes: true }
      if (status.branch !== null) params.expectedBranch = status.branch
      if (status.head !== null) params.expectedHead = status.head
      await askForConfirmation('Switch Branch', description, 'Switch Branch', true, () => executeMutation('Switch Branch', () => bridge.call('quirky.git/switchBranch', params)), key)
    } catch (error) {
      if (activeRouteKey.current === key) setMutationError(messageOf(error))
    }
  }

  const confirmForcePush = async (): Promise<void> => {
    const key = routeKey
    try {
      const description = await bridge.call<string>('quirky.git/describeForcePush', { worktree: worktreeId })
      if (activeRouteKey.current !== key) return
      await askForConfirmation('Force Push', description, 'Force Push', true, () => executeMutation('Force Push', () => bridge.call('quirky.git/forcePush', { worktree: worktreeId, yes: true })), key)
    } catch (error) {
      if (activeRouteKey.current === key) setMutationError(messageOf(error))
    }
  }

  const confirmAbort = async (): Promise<void> => {
    const key = routeKey
    try {
      const description = await bridge.call<string>('quirky.git/describeAbort', { worktree: worktreeId })
      if (activeRouteKey.current !== key) return
      await askForConfirmation('Abort Git operation', description, 'Abort', true, () => executeMutation('Abort', () => bridge.call('quirky.git/abort', { worktree: worktreeId, yes: true })), key)
    } catch (error) {
      if (activeRouteKey.current === key) setMutationError(messageOf(error))
    }
  }

  const commitChanges = (): Promise<void> => executeMutation('Commit', () => bridge.call('quirky.git/commit', { worktree: worktreeId, message: commitMessage }), async () => {
    setCommitMessage('')
    messageRevision.current += 1
    await refreshGit()
    if (tab === 'commits') await loadHistory()
  })

  const toggleGenerate = async (): Promise<void> => {
    const key = routeKey
    if (generatingMessage) {
      generationSequence.current += 1
      setGeneratingMessage(false)
      setMutationError(null)
      try {
        await bridge.call('quirky.git/cancelGenerate', { worktree: worktreeId })
      } catch (error) {
        if (activeRouteKey.current === key) setMutationError(messageOf(error))
      }
      return
    }
    if (!canWrite || connectionRef.current.phase !== 'connected' || stagedCount === 0) return
    const sequence = ++generationSequence.current
    const revision = messageRevision.current
    setGeneratingMessage(true)
    setMutationError(null)
    try {
      const generated = await bridge.call<{ message: string }>('quirky.git/generateCommitMessage', { worktree: worktreeId })
      if (activeRouteKey.current !== key || sequence !== generationSequence.current) return
      if (connectionRef.current.phase !== 'connected') {
        setStatusStale(true)
        return
      }
      if (messageRevision.current === revision) {
        setCommitMessage(generated.message)
        messageRevision.current += 1
      }
    } catch (error) {
      if (activeRouteKey.current !== key || sequence !== generationSequence.current) return
      if (connectionRef.current.phase !== 'connected') setStatusStale(true)
      else if (!messageOf(error).toLowerCase().includes('stopped')) setMutationError(messageOf(error))
    } finally {
      if (activeRouteKey.current === key && sequence === generationSequence.current) setGeneratingMessage(false)
    }
  }

  const stageReviewed = async (): Promise<void> => {
    if (reviewStorageLoading || !canWrite) return
    const paths = stageableReviewedPaths(reviewState.reviewedPaths, status?.entries ?? [])
    if (paths.length === 0) {
      setNotice('No reviewed unstaged or untracked files are available to stage.')
      return
    }
    await executeMutation('Stage Reviewed Files', () => bridge.call('quirky.git/stage', { worktree: worktreeId, paths }))
  }

  const markCurrentFilesUnreviewed = (): void => {
    if (reviewStorageLoading) return
    const current = new Set(reviewFiles.map((file) => file.path))
    updateReviewState((state) => ({ ...state, reviewedPaths: state.reviewedPaths.filter((path) => !current.has(path)) }))
  }

  const saveNote = async (): Promise<void> => {
    if (!canWrite || connectionRef.current.phase !== 'connected' || !currentReviewFile || !activeNoteDraft.body.trim()) return
    const key = routeKey
    const sequence = ++noteOperationSequence.current
    const path = currentReviewFile.path
    const startLine = Number(activeNoteDraft.start)
    const line = Number(activeNoteDraft.end)
    if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(line) || startLine < 1 || line < startLine) {
      setNotesError('Line ranges must be positive whole numbers, with the start at or before the end.')
      return
    }
    setNoteBusy(true)
    setNotesError(null)
    try {
      await bridge.call('quirky.git/addNote', { worktree: worktreeId, path, startLine, line, body: activeNoteDraft.body })
      if (activeRouteKey.current !== key || sequence !== noteOperationSequence.current) return
      updateNoteDraft(path, { body: '' })
      await loadNotes()
    } catch (error) {
      if (activeRouteKey.current === key && sequence === noteOperationSequence.current) setNotesError(messageOf(error))
    } finally {
      if (activeRouteKey.current === key && sequence === noteOperationSequence.current) setNoteBusy(false)
    }
  }

  const saveEditedNote = async (id: string): Promise<void> => {
    if (!canWrite || connectionRef.current.phase !== 'connected') return
    const key = routeKey
    const sequence = ++noteOperationSequence.current
    setNoteBusy(true)
    setNotesError(null)
    try {
      await bridge.call('quirky.git/editNote', { worktree: worktreeId, id, body: editingBody })
      if (activeRouteKey.current !== key || sequence !== noteOperationSequence.current) return
      setEditingNote(null)
      setEditingBody('')
      await loadNotes()
    } catch (error) {
      if (activeRouteKey.current === key && sequence === noteOperationSequence.current) setNotesError(messageOf(error))
    } finally {
      if (activeRouteKey.current === key && sequence === noteOperationSequence.current) setNoteBusy(false)
    }
  }

  const deleteReviewNote = async (id: string): Promise<void> => {
    if (!canWrite || connectionRef.current.phase !== 'connected') return
    const key = routeKey
    const sequence = ++noteOperationSequence.current
    setNoteBusy(true)
    setNotesError(null)
    try {
      await bridge.call('quirky.git/deleteNote', { worktree: worktreeId, id })
      if (activeRouteKey.current !== key || sequence !== noteOperationSequence.current) return
      await loadNotes()
    } catch (error) {
      if (activeRouteKey.current === key && sequence === noteOperationSequence.current) setNotesError(messageOf(error))
    } finally {
      if (activeRouteKey.current === key && sequence === noteOperationSequence.current) setNoteBusy(false)
    }
  }

  const copyNotes = async (): Promise<void> => {
    if (!connected || connectionRef.current.phase !== 'connected') return
    const key = routeKey
    setCopyBusy(true)
    setNoteNotice(null)
    try {
      const formatted = await bridge.call<{ text: string; count: number }>('quirky.git/formatNotes', { worktree: worktreeId })
      if (activeRouteKey.current !== key) return
      if (formatted.count === 0) {
        setNoteNotice('There are no unsent notes to copy.')
      } else {
        await bridge.native.clipboardWrite(formatted.text)
        setNoteNotice(`Copied ${formatted.count} unsent ${formatted.count === 1 ? 'note' : 'notes'}.`)
      }
    } catch (error) {
      if (activeRouteKey.current === key) setNotesError(messageOf(error))
    } finally {
      if (activeRouteKey.current === key) setCopyBusy(false)
    }
  }

  const sendReviewNotes = async (): Promise<void> => {
    if (!canWrite || connectionRef.current.phase !== 'connected' || reviewStorageLoading || !selectedTargetIsSendable || notes.length === 0) return
    const key = routeKey
    const sequence = ++noteOperationSequence.current
    const noteSnapshot = notes
    const [kind, ...parts] = targetChoice.split(':')
    const id = parts.join(':')
    const target = kind === 'session' ? targets?.sessions.find((item) => item.session === id) : targets?.agents.find((item) => item.id === id)
    if (!target || (kind === 'session' && !(target as NoteTargets['sessions'][number]).sendable)) return
    setNoteBusy(true)
    setNotesError(null)
    setNoteNotice(null)
    try {
      const current = await bridge.call<NotesResult>('quirky.git/notes', { worktree: worktreeId })
      if (activeRouteKey.current !== key || sequence !== noteOperationSequence.current) return
      const result = await bridge.call<{ sent: string[]; kept: string[]; target: { session: string }; delivery: string }>('quirky.git/sendNotes', {
        worktree: worktreeId,
        scope: 'all',
        ...(kind === 'session' ? { session: id } : { agent: id })
      })
      if (activeRouteKey.current !== key || sequence !== noteOperationSequence.current) return
      updateReviewState((state) => recordSentNotes(state, current.notes.length ? current.notes : noteSnapshot, result.sent, result.target.session, Date.now()))
      setLastTargetSession(result.target.session)
      setNoteNotice(result.sent.length ? `Sent ${result.sent.length} ${result.sent.length === 1 ? 'note' : 'notes'}.` : 'No notes were sent; the unsent notes remain available.')
      await loadNotes()
    } catch (error) {
      if (activeRouteKey.current === key && sequence === noteOperationSequence.current) setNotesError(messageOf(error))
    } finally {
      if (activeRouteKey.current === key && sequence === noteOperationSequence.current) setNoteBusy(false)
    }
  }

  const openSession = async (): Promise<void> => {
    if (!targetChoice) return
    const [kind, ...parts] = targetChoice.split(':')
    const id = parts.join(':')
    const key = routeKey
    const navigate = async (): Promise<void> => {
      if (kind === 'session') {
        await bridge.navigate({ kind: 'session', worktreeId, sessionId: id })
        return
      }
      if (kind !== 'agent' || !canWrite || connectionRef.current.phase !== 'connected' || activeRouteKey.current !== key) return
      const sequence = ++mutationSequence.current
      setPending('New Agent Session')
      setMutationError(null)
      try {
        const created = await bridge.call<SessionCreation>('quirky.session/create', { worktree: worktreeId, agent: id })
        if (activeRouteKey.current !== key || sequence !== mutationSequence.current) return
        if (connectionRef.current.phase !== 'connected') {
          setStatusStale(true)
          setMutationError('The session may have started, but the connection was lost before it could be opened.')
          return
        }
        await bridge.navigate({ kind: 'session', worktreeId, sessionId: created.id })
      } catch (error) {
        if (activeRouteKey.current === key && sequence === mutationSequence.current) {
          if (connectionRef.current.phase !== 'connected') setStatusStale(true)
          setMutationError(messageOf(error))
        }
      } finally {
        if (activeRouteKey.current === key && sequence === mutationSequence.current) setPending(null)
      }
    }
    await navigateWithDraftGuard(navigate)
  }

  const createPullRequest = async (): Promise<void> => {
    if (!eligibility?.eligible || !prTitle.trim()) return
    const key = routeKey
    await executeMutation('Create Pull Request', async () => {
      const result = await bridge.call<{ number: number; url: string; existing?: boolean }>('quirky.hosting/create', {
        worktree: worktreeId,
        title: prTitle.trim(),
        body: prBody,
        ...(prBase.trim() ? { base: prBase.trim() } : {}),
        ...(eligibility.head ? { head: eligibility.head } : {})
      })
      if (activeRouteKey.current !== key) return
      setPrSuccess(result.existing ? `Pull Request #${result.number} already exists.` : 'Pull Request Created')
      setNotice(result.url)
    }, refreshPullRequest)
  }


  const linkExistingPR = async (): Promise<void> => {
    const numberText = linkPRNumber.trim()
    const number = Number(numberText)
    if (!canWrite || connectionRef.current.phase !== 'connected' || !status?.branch || !status.head) return
    if (!/^[1-9]\d*$/.test(numberText) || !Number.isSafeInteger(number)) {
      setLinkPRError('Enter a positive pull request number.')
      return
    }
    const key = routeKey
    setLinkPRError(null)
    await executeMutation('Link Pull Request', async () => {
      const result = await bridge.call<{ linked: boolean; number: number; url: string; refreshed: boolean }>('quirky.reviews/checksLink', {
        worktree: worktreeId,
        number
      })
      if (!result.linked) throw new Error(`Pull request #${number} was not linked to this worktree.`)
      await bridge.storage.set(prLinkStorageKeyValue, String(result.number)).catch((error) => {
        if (activeRouteKey.current === key) setReviewStorageError(messageOf(error))
      })
      if (activeRouteKey.current !== key) return
      setLinkPRNumber('')
      setPrSuccess(result.refreshed ? 'Pull Request Linked' : `Pull Request #${result.number} linked, but review data could not be refreshed.`)
      setNotice(result.url)
    }, refreshPullRequest)
  }
  const openPullRequest = async (url: string): Promise<void> => {
    try {
      await bridge.native.openExternal(url)
    } catch (error) {
      setPrError(messageOf(error))
    }
  }

  const openReview = async (path?: string): Promise<void> => {
    await navigateWithDraftGuard(() => bridge.navigate({ kind: 'review', worktreeId, ...(path ? { path } : {}) }))
  }

  const isReviewRoute = route.kind === 'review'
  const remote = status?.upstreamStatus
  const hasUnresolvedConflicts = status?.entries.some((entry) => entry.area === 'conflicts' && entry.conflict?.state === 'unresolved') ?? false
  const hasConflictOperation = status?.operation !== undefined && status.operation !== 'none'
  const canRemote = canWrite && !hasConflictOperation && !hasUnresolvedConflicts
  const stagedPaths = [...new Set(status?.entries.filter((entry) => entry.area === 'staged').map((entry) => entry.path) ?? [])]
  const shouldLeaseForcePush = remote?.hasUpstream === true && remote.ahead > 0 && remote.behind > 0 && remote.behindPatchEquivalent === true

  const primaryAction = (() => {
    if (!status) return { label: 'Loading Source Control…', enabled: false, title: 'Wait for Git status.', run: () => {} }
    if (pending || status.busy) return { label: `${pending ?? status.busy} in progress…`, enabled: false, title: 'Wait for the current operation.', run: () => {} }
    if (status.operation !== 'none') {
      return hasUnresolvedConflicts
        ? { label: 'Resolve Conflicts', enabled: false, title: 'Resolve and stage every conflict before continuing.', run: () => {} }
        : { label: `Continue ${status.operation}`, enabled: canWrite, title: 'Continue the active Git operation.', run: () => void executeMutation('Continue', () => bridge.call('quirky.git/continue', { worktree: worktreeId })) }
    }
    if (hasUnresolvedConflicts) return { label: 'Resolve Conflicts', enabled: false, title: 'Resolve and stage every conflict before committing.', run: () => {} }
    if (stagedCount > 0) return { label: 'Commit', enabled: canWrite && !activeCommitDisabled, title: activeCommitDisabled ? 'Enter a commit message and refresh truncated status before committing.' : 'Commit staged changes.', run: () => void commitChanges() }
    if (stageableCount > 0) return { label: 'Stage All', enabled: canWrite, title: 'Stage all working-tree changes.', run: () => void executeMutation('Stage All', () => bridge.call('quirky.git/stage', { worktree: worktreeId, scope: 'all' })) }
    if (status.detached) return { label: 'Check Out a Branch', enabled: false, title: 'Check out a branch before publishing commits.', run: () => {} }
    if (!remote?.hasUpstream) return { label: 'Publish Branch', enabled: canRemote && status.head !== null, title: 'Publish this branch to its remote.', run: () => void runRemote('Publish Branch', 'quirky.git/push') }
    if (remote.ahead > 0 && remote.behind > 0) {
      return shouldLeaseForcePush
        ? { label: 'Force Push', enabled: canRemote, title: 'The remote only has patch-equivalent copies of local commits.', run: () => void confirmForcePush() }
        : { label: 'Sync', enabled: canRemote, title: `Pull ${remote.behind} and push ${remote.ahead} commits.`, run: () => void runRemote('Sync', 'quirky.git/sync') }
    }
    if (remote.behind > 0) return { label: 'Pull', enabled: canRemote, title: `Pull ${remote.behind} commit(s).`, run: () => void runRemote('Pull', 'quirky.git/pull') }
    if (remote.ahead > 0) return { label: 'Push', enabled: canRemote, title: `Push ${remote.ahead} commit(s).`, run: () => void runRemote('Push', 'quirky.git/push') }
    return { label: 'No staged files', enabled: false, title: 'The working tree is clean and the branch is up to date.', run: () => {} }
  })()

  const acceptConfirmation = async (): Promise<void> => {
    const pendingConfirmation = confirmation
    setConfirmation(null)
    if (!pendingConfirmation) return
    try {
      await pendingConfirmation.run()
    } catch (error) {
      setMutationError(messageOf(error))
    }
  }

  const renderPRCard = (compact = false) => {
    if (prState.kind === 'loading') return <p className="sc-muted" role="status">Loading pull request...</p>
    if (prState.kind === 'no-branch') return <p className="sc-muted">Check out a branch with a commit before linking a pull request.</p>
    if (prState.kind === 'unavailable') return <p className="sc-alert" role="alert">Pull request lookup unavailable: {prState.message ?? prState.reason ?? 'The GitHub hosting service could not complete this lookup.'}</p>
    if (prState.kind === 'found') {
      const review = prState.review
      const conflicts = review.mergeable === 'CONFLICTING' || review.mergeStateStatus === 'DIRTY'
      return (
        <div className="sc-pr-context">
          <div>
            <div className="sc-pr-title">#{review.number} {review.title}</div>
            <div className="sc-compact"><span className="sc-tag">{review.state}</span>{conflicts ? <span className="sc-tag sc-tag-conflict">Conflicts</span> : null}</div>
            <div className="sc-row-meta">{review.headRefName} → {review.baseRefName}{review.changedFiles === undefined ? '' : ` · ${review.changedFiles} files`}</div>
          </div>
          <button className="sc-button" type="button" onClick={() => void openPullRequest(review.url)}>{compact ? 'Open PR' : 'View Pull Request'}</button>
        </div>
      )
    }
    return <p className="sc-muted">No pull request found for this branch.</p>
  }

  const renderPRTab = () => (
    <section className="sc-section" aria-label="Pull Request">
      <div className="sc-card">
        <div className="sc-section-title"><span>Pull Request</span><button className="sc-button" type="button" disabled={!connected} onClick={() => void refreshPullRequest()}>Refresh</button></div>
        {prError ? <p className="sc-alert" role="alert">{prError}</p> : null}
        {prSuccess ? <p className="sc-info" role="status">{prSuccess}{typeof notice === 'string' && notice.startsWith('http') ? <> · <button className="sc-button" type="button" onClick={() => void openPullRequest(notice)}>Open</button></> : null}</p> : null}
        {prState.kind === 'found' ? renderPRCard() : null}
        {prState.kind === 'loading' || prState.kind === 'no-branch' || prState.kind === 'unavailable' ? renderPRCard() : null}
        {prState.kind === 'no-review' ? (
          <>
            <p className="sc-empty">No pull request is linked to this branch.</p>
            {eligibilityError ? <p className="sc-alert" role="alert">Creation eligibility could not be checked: {eligibilityError}</p> : null}
            {eligibility ? (
              <>
                {eligibility.blockers.length ? <div className="sc-alert"><strong>Cannot create a pull request yet</strong><ul>{eligibility.blockers.map((blocker) => <li key={`${blocker.reason}:${blocker.message}`}>{blocker.message} {blocker.nextAction}</li>)}</ul></div> : null}
                <div className="sc-form">
                  <label>Title<input value={prTitle} onChange={(event) => setPrTitle(event.currentTarget.value)} /></label>
                  <label>Base branch<input value={prBase} onChange={(event) => setPrBase(event.currentTarget.value)} placeholder={eligibility.defaultBase ?? 'No default base'} /></label>
                  <label>Description<textarea value={prBody} onChange={(event) => setPrBody(event.currentTarget.value)} rows={5} /></label>
                  <div className="sc-actions"><button className="sc-button sc-primary" type="button" disabled={!canWrite || !eligibility.eligible || !prTitle.trim()} onClick={() => void createPullRequest()}>Create Pull Request</button></div>
                </div>
              </>
            ) : null}
            <div className="sc-divider" />
            <section className="sc-form" aria-label="Link existing pull request">
              <h3>Link Existing Pull Request</h3>
              <p className="sc-row-meta">Enter a GitHub pull request number. The host validates it before linking this worktree.</p>
              {linkPRError ? <p className="sc-alert" role="alert">{linkPRError}</p> : null}
              <label>Pull request number<input inputMode="numeric" value={linkPRNumber} onChange={(event) => { setLinkPRNumber(event.currentTarget.value); setLinkPRError(null) }} /></label>
              <div className="sc-actions"><button className="sc-button" type="button" disabled={!canWrite || pending !== null} onClick={() => void linkExistingPR()}>Link Pull Request</button></div>
            </section>
          </>
        ) : null}
      </div>
    </section>
  )

  const renderChangeRow = (entry: GitStatus['entries'][number]) => (
    <div className="sc-row" key={`${entry.area}:${entry.path}`}>
      <div className="sc-row-main">
        <button className="sc-row-path" type="button" onClick={() => void openReview(entry.path)}>{entry.path}</button>
        <span className={`sc-tag${entry.area === 'conflicts' ? ' sc-tag-conflict' : ''}`}>{entry.area}</span>
      </div>
      <div className="sc-row-meta">
        {entry.oldPath ? `Renamed from ${entry.oldPath} · ` : ''}{entry.status}
        {entry.added === undefined ? '' : ` · +${entry.added}`}{entry.removed === undefined ? '' : ` −${entry.removed}`}
        {entry.conflict ? ` · ${entry.conflict.kind} (${entry.conflict.state})` : ''}
        {entry.binary ? ' · binary' : ''}
      </div>
      <div className="sc-actions">
        {entry.area === 'staged' ? <button className="sc-button" type="button" disabled={!canWrite} onClick={() => void executeMutation('Unstage', () => bridge.call('quirky.git/unstage', { worktree: worktreeId, paths: [entry.path] }))}>Unstage</button> : null}
        {entry.area === 'unstaged' || entry.area === 'untracked' || (entry.area === 'conflicts' && entry.conflict?.state === 'resolved_locally') ? <button className="sc-button" type="button" disabled={!canWrite || entry.area === 'conflicts' && hasUnresolvedConflicts} onClick={() => void executeMutation('Stage', () => bridge.call('quirky.git/stage', { worktree: worktreeId, paths: [entry.path] }))}>Stage</button> : null}
        {entry.area !== 'conflicts' ? <button className="sc-button sc-danger" type="button" disabled={!canWrite} onClick={() => void confirmDiscard(entry.path)}>Discard Change</button> : <button className="sc-button" type="button" onClick={() => void navigateWithDraftGuard(() => bridge.navigate({ kind: 'file-preview', worktreeId, path: entry.path }))}>Open conflict file</button>}
      </div>
    </div>
  )

  const renderChangesTab = () => {
    const sectionNames: { area: GitStatus['entries'][number]['area']; title: string }[] = [
      { area: 'conflicts', title: 'Conflicts' },
      { area: 'staged', title: 'Staged Changes' },
      { area: 'unstaged', title: 'Unstaged Changes' },
      { area: 'untracked', title: 'Untracked Files' }
    ]
    return (
      <>
        {renderPRCard(true)}
        {status?.capped ? <p className="sc-info" role="status">Showing the first 1,000 status entries. Refresh after reducing the change set to see all files.</p> : null}
        {status?.operation !== 'none' && status?.operation ? (
          <div className="sc-card">
            <h2>{status.operation} in progress</h2>
            <p>Resolve and stage conflicted files before continuing. You can also abort this operation.</p>
            <div className="sc-actions">
              <button className="sc-button sc-primary" type="button" disabled={!canWrite || hasUnresolvedConflicts} onClick={() => void executeMutation('Continue', () => bridge.call('quirky.git/continue', { worktree: worktreeId }))}>Continue {status.operation}</button>
              {status.operation === 'merge' || status.operation === 'rebase' ? <button className="sc-button sc-danger" type="button" disabled={!canWrite} onClick={() => void confirmAbort()}>Abort</button> : null}
            </div>
          </div>
        ) : null}
        <section className="sc-section" aria-label="Working tree changes">
          <div className="sc-section-title"><span>Working Tree</span><span>{changedCount} changed · {stagedCount} staged</span></div>
          <div className="sc-actions">
            <button className="sc-button" type="button" disabled={!canWrite || stageableCount === 0} onClick={() => void executeMutation('Stage All', () => bridge.call('quirky.git/stage', { worktree: worktreeId, scope: 'all' }))}>Stage All</button>
            <button className="sc-button" type="button" disabled={!canWrite || stagedPaths.length === 0 || status?.capped === true} onClick={() => void executeMutation('Unstage All', () => bridge.call('quirky.git/unstage', { worktree: worktreeId, paths: stagedPaths }))}>Unstage All</button>
            <button className="sc-button" type="button" onClick={() => void openReview()}>Review Changes</button>
          </div>
          {status?.entries.length === 0 ? <div className="sc-empty">No local changes. Working tree is clean.</div> : null}
          {sectionNames.map(({ area, title }) => {
            const rows = status?.entries.filter((entry) => entry.area === area) ?? []
            if (!rows.length) return null
            return <section className="sc-section" key={area}><h3 className="sc-section-title">{title}<span>{uniqueCount(rows)}</span></h3>{rows.map(renderChangeRow)}</section>
          })}
          {statusLoading && !status ? <p className="sc-muted" role="status">Loading Git status…</p> : null}
        </section>
        <section className="sc-section" aria-label="Committed branch changes">
          <div className="sc-section-title"><span>Committed on Branch</span><span>{compare?.status === 'ready' ? `${branchCount} files` : 'Compare'}</span></div>
          {compareError ? <p className="sc-alert" role="alert">Branch comparison unavailable: {compareError}</p> : null}
          {compare && compare.status !== 'ready' ? <p className="sc-info">{compare.message ?? 'The branch comparison is not available yet.'}</p> : null}
          {compare?.status === 'ready' && compare.entries.length === 0 ? <p className="sc-muted">No committed changes on this branch.</p> : null}
          {compare?.status === 'ready' ? compare.entries.map((entry) => (
            <div className="sc-row" key={`branch:${entry.path}`}>
              <div className="sc-row-main"><button className="sc-row-path" type="button" onClick={() => void openReview(entry.path)}>{entry.path}</button><span className="sc-tag">{entry.status}</span></div>
              <div className="sc-row-meta">{entry.oldPath ? `Renamed from ${entry.oldPath} · ` : ''}{entry.binary ? 'Binary change' : `+${entry.added ?? 0} −${entry.removed ?? 0}`}</div>
              <div className="sc-actions"><button className="sc-button" type="button" onClick={() => void openReview(entry.path)}>Review Diff</button></div>
            </div>
          )) : null}
          {compare?.base ? <p className="sc-row-meta">Compared with {compare.base}</p> : null}
        </section>
        <section className="sc-card" aria-label="Commit changes">
          <h2>Commit</h2>
          <label>Commit message<textarea value={commitMessage} onChange={(event) => { setCommitMessage(event.currentTarget.value); messageRevision.current += 1 }} rows={3} placeholder="Commit message" /></label>
          <div className="sc-actions">
            <button className="sc-button" type="button" disabled={generatingMessage ? !connected : !connected || stagedCount === 0 || status?.busy !== null || pending !== null} onClick={() => void toggleGenerate()}>{generatingMessage ? 'Cancel commit message generation' : 'Generate commit message with AI'}</button>
            <button className="sc-button sc-primary" type="button" disabled={!canWrite || activeCommitDisabled || generatingMessage} onClick={() => void commitChanges()}>Commit</button>
          </div>
        </section>
        <section className="sc-card" aria-label="Branch actions">
          <h2>Branch Actions</h2>
          <div className="sc-actions">
            <button className="sc-button" type="button" disabled={!canSwitchBranch || branchesLoading} onClick={() => void requestSwitchBranch()}>{branchesLoading ? 'Loading branches…' : 'Switch Branch'}</button>
            <button className="sc-button" type="button" disabled={!canRemote || !remote?.hasUpstream || remote.behind === 0} onClick={() => void runRemote('Pull', 'quirky.git/pull')}>Pull</button>
            <button className="sc-button" type="button" disabled={!canRemote || !remote?.hasUpstream || remote.ahead === 0} onClick={() => void runRemote('Push', 'quirky.git/push')}>Push</button>
            <button className="sc-button" type="button" disabled={!canRemote || status?.detached === true || remote?.hasUpstream === true} onClick={() => void runRemote('Publish Branch', 'quirky.git/push')}>Publish Branch</button>
            <button className="sc-button" type="button" disabled={!canRemote || !remote?.hasUpstream || remote.ahead === 0 || remote.behind === 0} onClick={() => void runRemote('Sync', 'quirky.git/sync')}>Sync</button>
            <button className="sc-button" type="button" disabled={!canWrite} onClick={() => void runRemote('Fetch', 'quirky.git/fetch')}>Fetch</button>
            <button className="sc-button" type="button" disabled={!canRemote || !remote?.hasUpstream || remote.behind === 0 || remote.ahead > 0} onClick={() => void runRemote('Fast-forward', 'quirky.git/fastForward')}>Fast-forward</button>
            <button className="sc-button sc-danger" type="button" disabled={!canRemote || !remote?.hasUpstream || remote.ahead === 0} onClick={() => void confirmForcePush()}>Force Push</button>
          </div>
          {status?.busy ? <p className="sc-busy" role="status">{status.busy} in progress…</p> : null}
          <details className="sc-details"><summary>More Git actions</summary><p>Remote actions use the selected worktree's configured upstream. Failures are shown without claiming success.</p></details>
        </section>
        <section className="sc-card" aria-label="Primary Git action">
          <div className="sc-section-title"><span>Primary Action</span><span>{primaryAction.title}</span></div>
          <button className="sc-button sc-primary" type="button" disabled={!primaryAction.enabled || !canWrite} title={primaryAction.title} onClick={primaryAction.run}>{primaryAction.label}</button>
        </section>
      </>
    )
  }

  const renderReviewActions = () => (
    <section className="sc-card" aria-label="Review Actions">
      <h2>Review Actions</h2>
      <p className="sc-review-progress" role="status">{reviewStorageLoading ? 'Loading review progress…' : reviewComplete ? 'Review Complete' : `${progress.reviewed} of ${progress.total} files reviewed`}</p>
      {status?.capped ? <p className="sc-info">The working-tree file list is truncated; review completion cannot be confirmed yet.</p> : null}
      <div className="sc-actions">
        <button className="sc-button" type="button" disabled={!canWrite || reviewStorageLoading || stageableReviewedPaths(reviewState.reviewedPaths, status?.entries ?? []).length === 0} onClick={() => void stageReviewed()}>Stage Reviewed Files</button>
        <button className="sc-button" type="button" disabled={reviewStorageLoading || !progress.reviewed} onClick={markCurrentFilesUnreviewed}>Mark Unreviewed</button>
        <button className="sc-button" type="button" disabled={!connected || notesLoading || notes.length === 0 || copyBusy} onClick={() => void copyNotes()}>{copyBusy ? 'Copying…' : 'Copy Notes'}</button>
        <button className="sc-button" type="button" disabled={!connected || targetsLoading} onClick={() => void loadTargets()}>{targetsLoading ? 'Loading sessions…' : 'Refresh Sessions'}</button>
        <button className="sc-button" type="button" onClick={() => void navigateWithDraftGuard(() => bridge.navigate({ kind: 'source-control', worktreeId, tab: 'pull-request' }))}>Pull Request</button>
      </div>
      {targetsError ? <p className="sc-alert" role="alert">Session targets unavailable: {targetsError}</p> : null}
      {targets ? (
        <div className="sc-form">
          <label>Agent session or new agent
            <select value={targetChoice} onChange={(event) => setTargetChoice(event.currentTarget.value)}>
              <option value="">Choose a target</option>
              {targets.sessions.length ? <optgroup label="Existing sessions">{targets.sessions.map((session) => <option key={session.session} value={`session:${session.session}`}>{session.label} · {session.title}{session.sendable ? '' : ` · ${session.reason ?? 'not sendable'}`}</option>)}</optgroup> : null}
              {targets.agents.length ? <optgroup label="New agent session">{targets.agents.map((agent) => <option key={agent.id} value={`agent:${agent.id}`}>{agent.label}</option>)}</optgroup> : null}
            </select>
          </label>
          <div className="sc-actions">
            <button className="sc-button" type="button" disabled={!canWrite || reviewStorageLoading || !selectedTargetIsSendable || notes.length === 0 || noteBusy || !targetChoice} onClick={() => void sendReviewNotes()}>Send Unsent Notes</button>
            <button className="sc-button" type="button" disabled={!connected || pending !== null || !targetChoice || targetChoice.startsWith('agent:') && !canWrite} onClick={() => void openSession()}>{targetChoice.startsWith('agent:') ? 'New Agent Session' : 'Open in Session'}</button>
            {lastTargetSession ? <button className="sc-button" type="button" onClick={() => void navigateWithDraftGuard(() => bridge.navigate({ kind: 'session', worktreeId, sessionId: lastTargetSession }))}>Open sent-to session</button> : null}
          </div>
          {!targets.sessions.length && !targets.agents.length ? <p className="sc-muted">No agent sessions or enabled agents are available for this worktree.</p> : null}
        </div>
      ) : null}
      {notesError ? <p className="sc-alert" role="alert">{notesError}</p> : null}
      {noteNotice ? <p className="sc-info" role="status">{noteNotice}</p> : null}
      {reviewStorageError ? <p className="sc-alert" role="alert">Review progress could not be saved on this device: {reviewStorageError}</p> : null}
      <div className="sc-divider" />
      <div className="sc-section-title"><span>Sent Notes on This Device</span><button className="sc-button" type="button" disabled={reviewStorageLoading || reviewState.sentNotes.length === 0} onClick={() => updateReviewState(clearSentNotes)}>Clear Sent Notes</button></div>
      {reviewState.sentNotes.length === 0 ? <p className="sc-muted">No sent notes are retained on this device.</p> : reviewState.sentNotes.map((note) => (
        <article className="sc-note" key={`${note.id}:${note.sentAt}`}>
          <div className="sc-note-head"><strong>{note.path}</strong><span className="sc-note-range">{lineRange(note)} · sent {new Date(note.sentAt).toLocaleString()}</span></div>
          <p className="sc-note-body">{note.body}</p>
        </article>
      ))}
    </section>
  )

  const renderReview = () => {
    const file = currentReviewFile
    const source = currentReviewSource
    const selectedDiff = reviewDiff?.key === currentReviewKey ? reviewDiff : null
    const localNotes = file ? notes.filter((note) => note.path === file.path) : []
    const sourceOptions = file ? sourcesForReviewFile(file, compare) : []
    const allowNote = Boolean(file && selectedDiff?.diff && !selectedDiff.diff.binary && selectedDiff.diff.kind === 'text' && !selectedDiff.diff.tooLarge && !selectedDiff.diff.modifiedDeleted && !['renamed', 'deleted', 'copied'].includes(file.status) && !file.binary)
    return (
      <>
        <div className="sc-card">
          <div className="sc-pr-context"><div><h2>Diff Review</h2><p className="sc-muted">{reviewStorageLoading ? 'Loading review progress…' : reviewComplete ? 'Review Complete' : `${progress.reviewed} of ${progress.total} files reviewed`}</p></div><button className="sc-button" type="button" onClick={() => void navigateWithDraftGuard(() => bridge.navigate({ kind: 'source-control', worktreeId, tab: 'changes' }))}>Source Control</button></div>
          <div className="sc-details"><strong>Pull Request</strong>{renderPRCard(true)}</div>
        </div>
        {renderReviewActions()}
        <section className="sc-card" aria-label="File diff review">
          <div className="sc-file-nav">
            <button className="sc-button" type="button" disabled={!file || reviewIndex <= 0} onClick={() => setReviewIndex((current) => moveDiffIndex(current, reviewFiles.length, -1) ?? 0)}>Previous File</button>
            <span className="sc-muted">{file ? `${reviewIndex + 1} of ${reviewFiles.length}` : 'No files to review'}</span>
            <button className="sc-button" type="button" disabled={!file || reviewIndex >= reviewFiles.length - 1} onClick={() => setReviewIndex((current) => moveDiffIndex(current, reviewFiles.length, 1) ?? 0)}>Next File</button>
          </div>
          {file ? (
            <>
              <div className="sc-section-title"><span className="sc-row-path">{file.path}</span><span className="sc-tag">{file.status}</span></div>
              {file.oldPath ? <p className="sc-row-meta">Renamed from {file.oldPath}</p> : null}
              {sourceOptions.length > 1 ? <label>Diff source<select value={source ?? file.source} onChange={(event) => setSelectedSources((current) => ({ ...current, [file.path]: event.currentTarget.value as DiffSource }))}>{sourceOptions.map((option) => <option key={option} value={option}>{option === 'conflict' ? 'Conflict' : option === 'branch' ? 'Committed on branch' : option}</option>)}</select></label> : null}
              <div className="sc-actions">
                <button className="sc-button" type="button" disabled={!canWrite || !file.areas.includes('staged')} onClick={() => void executeMutation('Unstage', () => bridge.call('quirky.git/unstage', { worktree: worktreeId, paths: [file.path] }))}>Unstage</button>
                <button className="sc-button" type="button" disabled={!canWrite || !file.areas.some((area) => area === 'unstaged' || area === 'untracked')} onClick={() => void executeMutation('Stage', () => bridge.call('quirky.git/stage', { worktree: worktreeId, paths: [file.path] }))}>Stage</button>
                <button className="sc-button sc-danger" type="button" disabled={!canWrite || file.areas.length === 0 || file.areas.includes('conflicts')} onClick={() => void confirmDiscard(file.path)}>Discard</button>
                <button className="sc-button" type="button" disabled={reviewStorageLoading} aria-pressed={reviewState.reviewedPaths.includes(file.path)} onClick={() => updateReviewState((state) => ({ ...state, reviewedPaths: toggleReviewedPath(state.reviewedPaths, file.path) }))}>{reviewState.reviewedPaths.includes(file.path) ? 'Reviewed' : 'Mark Reviewed'}</button>
              </div>
              {selectedDiff?.loading ? <p className="sc-muted" role="status">Loading diff…</p> : null}
              {selectedDiff?.error ? <p className="sc-alert" role="alert">Diff unavailable: {selectedDiff.error}</p> : null}
              {selectedDiff?.diff ? <DiffSides diff={selectedDiff.diff} /> : null}
              {selectedDiff?.conflict ? (
                <div className="sc-info">
                  <strong>{selectedDiff.conflict.kind} conflict · {selectedDiff.conflict.state}</strong>
                  {selectedDiff.conflict.content === null ? <p>The conflicted file is missing. Resolve the operation or restore the file before continuing.</p> : <div className="sc-diff-side"><h4>Conflict File</h4><pre>{selectedDiff.conflict.content}</pre></div>}
                  <div className="sc-actions"><button className="sc-button" type="button" onClick={() => void navigateWithDraftGuard(() => bridge.navigate({ kind: 'file-preview', worktreeId, path: file.path }))}>Open in Files to Resolve</button></div>
                </div>
              ) : null}
              {allowNote ? (
                <div className="sc-section">
                  <h3>Review Notes</h3>
                  {localNotes.map((note) => (
                    <article className="sc-note" key={note.id}>
                      <div className="sc-note-head"><span className="sc-note-range">{lineRange(note)}</span><div className="sc-actions"><button className="sc-button" type="button" disabled={!canWrite || noteBusy} onClick={() => { setEditingNote(note.id); setEditingBody(note.body) }}>Edit Note</button><button className="sc-button sc-danger" type="button" disabled={!canWrite || noteBusy} onClick={() => void deleteReviewNote(note.id)}>Delete</button></div></div>
                      {editingNote === note.id ? <div className="sc-form"><textarea value={editingBody} onChange={(event) => setEditingBody(event.currentTarget.value)} aria-label="Edit review note" /><div className="sc-actions"><button className="sc-button sc-primary" type="button" disabled={!canWrite || noteBusy || !editingBody.trim()} onClick={() => void saveEditedNote(note.id)}>Save Note</button><button className="sc-button" type="button" onClick={() => { setEditingNote(null); setEditingBody('') }}>Cancel</button></div></div> : <p className="sc-note-body">{note.body}</p>}
                    </article>
                  ))}
                  <div className="sc-form">
                    <div className="sc-grid-two">
                      <label>Start line<input className="sc-small-input" type="number" min={1} step={1} value={activeNoteDraft.start} onChange={(event) => updateNoteDraft(file.path, { start: event.currentTarget.value })} /></label>
                      <label>End line<input className="sc-small-input" type="number" min={1} step={1} value={activeNoteDraft.end} onChange={(event) => updateNoteDraft(file.path, { end: event.currentTarget.value })} /></label>
                    </div>
                    <p className="sc-row-meta">Line numbers refer to the modified side of this diff.</p>
                    <label>Note<textarea value={activeNoteDraft.body} onChange={(event) => updateNoteDraft(file.path, { body: event.currentTarget.value })} rows={3} placeholder="Add a note to this line or range" /></label>
                    <div className="sc-actions"><button className="sc-button sc-primary" type="button" disabled={!canWrite || noteBusy || !activeNoteDraft.body.trim()} onClick={() => void saveNote()}>Add Note</button></div>
                  </div>
                </div>
              ) : file.status === 'renamed' || file.status === 'deleted' || file.status === 'copied' || file.binary || selectedDiff?.diff?.binary || selectedDiff?.diff?.kind === 'image' ? <p className="sc-info">This file change is not editable as text, so line notes are unavailable.</p> : null}
            </>
          ) : <p className="sc-empty">No changed files are available to review.</p>}
        </section>
      </>
    )
  }

  const renderCommits = () => (
    <div className="sc-grid-two">
      <section className="sc-section" aria-label="Commit history">
        <div className="sc-section-title"><span>Commits</span><button className="sc-button" type="button" disabled={!connected || historyLoading} onClick={() => void loadHistory()}>Refresh</button></div>
        {historyError ? <p className="sc-alert" role="alert">Commit history unavailable: {historyError}</p> : null}
        {historyLoading && !history ? <p className="sc-muted" role="status">Loading commits…</p> : null}
        {history?.commits.length === 0 ? <p className="sc-empty">No commits on this branch.</p> : null}
        {history?.commits.map((commit) => (
          <button className="sc-commit-row sc-button" type="button" key={commit.oid} aria-pressed={selectedCommit?.oid === commit.oid} onClick={() => setSelectedCommit(commit)}>
            <span className="sc-commit-main"><strong>{commit.subject}</strong></span>
            <span className="sc-row-meta">{commit.oid.slice(0, 8)} · {commit.author} · {new Date(commit.committedAt).toLocaleString()}</span>
            {commit.refs.length ? <span className="sc-tag">{commit.refs.join(', ')}</span> : null}
          </button>
        ))}
        {history?.hasMore ? <p className="sc-muted">Showing the latest 50 commits.</p> : null}
      </section>
      <section className="sc-card" aria-label="Commit file diff">
        <h2>{selectedCommit ? selectedCommit.subject : 'Select a commit'}</h2>
        {commitFilesError ? <p className="sc-alert" role="alert">Commit files unavailable: {commitFilesError}</p> : null}
        {commitFiles ? <div className="sc-actions">{commitFiles.entries.map((entry) => <button className="sc-button" type="button" key={entry.path} aria-pressed={entry.path === selectedCommitPath} onClick={() => setSelectedCommitPath(entry.path)}>{entry.path} · {entry.status}</button>)}</div> : null}
        {commitDiffLoading ? <p className="sc-muted" role="status">Loading file diff…</p> : null}
        {commitDiffError ? <p className="sc-alert" role="alert">Commit diff unavailable: {commitDiffError}</p> : null}
        {commitDiff ? <DiffSides diff={commitDiff} /> : null}
        {commitFiles && !commitFiles.entries.length ? <p className="sc-empty">This commit has no file changes.</p> : null}
      </section>
    </div>
  )

  if (!supportedRoute) return null
  const busyLabel = pending ?? (status?.busy ? `${status.busy} in progress…` : null)
  const connectionLabel = connection.phase === 'connected' ? null : connection.message ?? `Desktop is ${connection.phase.replaceAll('-', ' ')}.`

  return (
    <main className="sc-root">
      <style>{PAGE_STYLE}</style>
      <div className="sc-shell">
        <header className="sc-header">
          <div><span className="sc-eyebrow">{bridge.init.host.name}</span><h1>{isReviewRoute ? 'Diff Review' : 'Source Control'}</h1><p className="sc-subtitle">{worktreeId}</p></div>
          <div className="sc-actions">
            <button className="sc-button" type="button" onClick={() => void navigateWithDraftGuard(() => bridge.navigate({ kind: 'workspaces' }))}>Back to Workspaces</button>
            <button className="sc-button" type="button" disabled={!connected || statusLoading} onClick={() => { void refreshGit(); void loadNotes(); void refreshPullRequest(); if (tab === 'commits') void loadHistory() }}>{statusLoading ? 'Refreshing…' : 'Refresh'}</button>
          </div>
        </header>
        {connectionLabel ? <div className="sc-info" role="status">{connectionLabel} {status ? 'Showing stale data; actions are disabled until the host reconnects and refresh succeeds.' : 'Waiting for the desktop connection.'}</div> : null}
        {statusStale && connected ? <div className="sc-info" role="status">Source Control data is stale. Refresh successfully before making changes.</div> : null}
        {statusError ? <p className="sc-alert" role="alert">Git status unavailable: {statusError}</p> : null}
        {mutationError ? <p className="sc-alert" role="alert">{mutationError}</p> : null}
        {busyLabel ? <p className="sc-busy" role="status">{busyLabel}</p> : null}
        {status ? (
          <section className="sc-card" aria-label="Branch status">
            <div className="sc-branch"><strong>{status.branch ?? 'Detached HEAD'}</strong>{status.detached ? <span className="sc-tag">detached</span> : null}</div>
            <div className="sc-stats">
              {remote?.hasUpstream ? <span>{remote.ahead} ahead · {remote.behind} behind</span> : <span>No upstream branch</span>}
              <span>{changedCount} changed</span><span>{stagedCount} staged</span><span>{branchCount} on branch</span>
            </div>
            <div className="sc-divider" />
            {renderPRCard(true)}
          </section>
        ) : statusLoading ? <section className="sc-card"><p role="status">Loading Git status…</p></section> : null}
        {!isReviewRoute ? (
          <>
            <nav className="sc-tabs" role="tablist" aria-label="Source Control sections">
              {(['changes', 'pull-request', 'commits'] as const).map((name) => <button type="button" role="tab" aria-selected={tab === name} key={name} onClick={() => setTab(name)}>{name === 'pull-request' ? 'Pull Request' : name === 'commits' ? 'Commits' : 'Changes'}</button>)}
            </nav>
            {tab === 'changes' ? renderChangesTab() : tab === 'pull-request' ? renderPRTab() : renderCommits()}
          </>
        ) : renderReview()}
      </div>
      {branchPickerOpen ? (
        <div className="sc-confirm-overlay" role="presentation">
          <section className="sc-confirm" role="dialog" aria-modal="true" aria-labelledby="sc-branch-title">
            <h2 id="sc-branch-title">Switch Branch</h2>
            <label>Filter branches<input value={branchQuery} onChange={(event) => setBranchQuery(event.currentTarget.value)} autoFocus /></label>
            <label>Target branch<select value={selectedBranch} onChange={(event) => setSelectedBranch(event.currentTarget.value)}><option value="">Choose a branch</option>{branches.filter((branch) => branch.name.toLowerCase().includes(branchQuery.toLowerCase())).map((branch) => <option key={`${branch.kind}:${branch.name}`} value={branch.name}>{branch.name} · {branch.kind}</option>)}</select></label>
            <div className="sc-footer"><button className="sc-button" type="button" onClick={() => setBranchPickerOpen(false)}>Cancel</button><button className="sc-button sc-primary" type="button" disabled={!selectedBranch || !canSwitchBranch} onClick={() => void confirmBranchSwitch()}>Continue</button></div>
          </section>
        </div>
      ) : null}
      {confirmation ? (
        <div className="sc-confirm-overlay" role="presentation">
          <section className="sc-confirm" role="dialog" aria-modal="true" aria-labelledby="sc-confirm-title">
            <h2 id="sc-confirm-title">{confirmation.title}</h2>
            <p>{confirmation.message}</p>
            <div className="sc-footer"><button className="sc-button" type="button" onClick={() => setConfirmation(null)}>Cancel</button><button className={`sc-button ${confirmation.danger ? 'sc-danger' : 'sc-primary'}`} type="button" disabled={pending !== null} onClick={() => void acceptConfirmation()}>{confirmation.button}</button></div>
          </section>
        </div>
      ) : null}
    </main>
  )
}
