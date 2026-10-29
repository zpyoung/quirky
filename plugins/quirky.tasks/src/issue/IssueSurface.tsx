import { Badge, Button, EmptyState, TextField } from '@quirky/ui'
import { useEffect, useRef, useState } from 'react'
import type { ItemTarget, TaskItem, TasksSurfaceProps } from '../contracts'
import { Markdown, MarkdownComposer, safeHttpUrl } from './Markdown'

type RecordValue = Record<string, unknown>
type IssueComment = {
  id: number | string | null
  issueNumber: number
  body: string
  author: string | null
  createdAt: string | null
  updatedAt: string | null
  url: string | null
  kind: 'issue'
}
type IssueEvent = {
  event: string
  createdAt: string | null
  actor: string | null
  label: string | null
  state: string | null
  body: string | null
  commitId: string | null
}
type IssueDetail = {
  item: TaskItem
  viewerCanUpdate: boolean | null
  comments: IssueComment[]
  participants: { login: string; name: string | null; url: string | null }[]
  timeline: IssueEvent[]
  partialFailures: string[]
  truncated: boolean
  source: 'repository' | 'project'
}
type IssueChoices = {
  available: boolean
  labels: string[]
  assignees: { login: string; avatarUrl: string | null }[]
  message: string | null
}


function record(value: unknown): RecordValue | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as RecordValue
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function mapIssueDetail(value: unknown): IssueDetail | null {
  const raw = record(value)
  const itemRaw = record(raw?.item)
  if (!raw || !itemRaw || itemRaw.kind !== 'issue' || typeof itemRaw.number !== 'number' || typeof itemRaw.title !== 'string') return null
  const item: TaskItem = {
    kind: 'issue',
    number: itemRaw.number,
    title: itemRaw.title,
    body: typeof itemRaw.body === 'string' ? itemRaw.body : '',
    state: itemRaw.state === 'open' || itemRaw.state === 'closed' ? itemRaw.state : 'unknown',
    url: typeof itemRaw.url === 'string' ? itemRaw.url : '',
    createdAt: text(itemRaw.createdAt),
    updatedAt: text(itemRaw.updatedAt),
    author: text(itemRaw.author),
    labels: array(itemRaw.labels).flatMap((label) => typeof label === 'string' ? [label] : []),
    assignees: array(itemRaw.assignees).flatMap((assignee) => typeof assignee === 'string' ? [assignee] : []),
    isDraft: false,
    ...(typeof itemRaw.stateReason === 'string' ? { stateReason: itemRaw.stateReason } : {}),
    ...(typeof itemRaw.duplicateOf === 'number' ? { duplicateOf: itemRaw.duplicateOf } : {})
  }
  const comments = array(raw.comments).flatMap((value) => {
    const comment = record(value)
    if (!comment || typeof comment.body !== 'string') return []
    return [{
      id: typeof comment.id === 'string' || typeof comment.id === 'number' ? comment.id : null,
      issueNumber: item.number,
      body: comment.body,
      author: text(comment.author),
      createdAt: text(comment.createdAt),
      updatedAt: text(comment.updatedAt),
      url: text(comment.url),
      kind: 'issue' as const
    }]
  })
  const participants = array(raw.participants).flatMap((value) => {
    const participant = record(value)
    const login = text(participant?.login)
    return login ? [{ login, name: text(participant?.name), url: text(participant?.url) }] : []
  })
  const timeline = array(raw.timeline).flatMap((value) => {
    const event = record(value)
    const name = text(event?.event)
    return event && name ? [{
      event: name,
      createdAt: text(event.createdAt),
      actor: text(event.actor),
      label: text(event.label),
      state: text(event.state),
      body: typeof event.body === 'string' ? event.body : null,
      commitId: text(event.commitId)
    }] : []
  })
  return {
    item,
    comments: comments.slice(0, 100),
    participants: participants.slice(0, 100),
    timeline: timeline.slice(0, 300),
    partialFailures: array(raw.partialFailures).flatMap((value) => typeof value === 'string' ? [value] : []).slice(0, 10),
    truncated: raw.truncated === true,
    viewerCanUpdate: typeof raw.viewerCanUpdate === 'boolean' ? raw.viewerCanUpdate : null,
    source: raw.source === 'project' ? 'project' : 'repository'
  }
}

function commentKey(comment: IssueComment): string {
  return comment.id !== null ? String(comment.id) : `${comment.author ?? ''}\0${comment.createdAt ?? ''}\0${comment.body}`
}

function mergeConfirmedComments(detail: IssueDetail, confirmed: IssueComment[]): IssueDetail {
  if (confirmed.length === 0) return detail
  const comments = [...detail.comments]
  const seen = new Set(comments.map(commentKey))
  for (const comment of confirmed) {
    const key = commentKey(comment)
    if (!seen.has(key)) {
      seen.add(key)
      comments.push(comment)
    }
  }
  return { ...detail, comments }
}

function targetKey(target: ItemTarget): string {
  const identity = target.url ?? `${target.host ?? 'github.com'}/${target.owner ?? ''}/${target.repo ?? ''}/issues/${target.number}`
  return `${identity}\0${target.worktree}\0${target.projectId ?? ''}\0${target.itemId ?? ''}`
}

function issueContext(target: ItemTarget): string {
  if (target.host && target.owner && target.repo) return `${target.host} · ${target.owner}/${target.repo}`
  if (target.url) {
    try {
      const url = new URL(target.url)
      const path = url.pathname.split('/').filter(Boolean)
      return `${url.host} · ${path.slice(0, 2).join('/')}`
    } catch {
      return target.url
    }
  }
  return 'GitHub issue'
}

function safeIssueUrl(item: TaskItem | null, target: ItemTarget): string | null {
  const candidate = item?.url || target.url
  if (!candidate || candidate !== candidate.trim() || !safeHttpUrl(candidate)) return null
  try {
    const url = new URL(candidate)
    const parts = /^\/([^/]+)\/([^/]+)\/issues\/([1-9][0-9]*)\/?$/.exec(url.pathname)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !parts?.[1] || !parts[2] || Number(parts[3]) !== target.number) return null
    if (target.host && url.host.toLowerCase() !== target.host.toLowerCase()) return null
    if (target.owner && parts[1]?.toLowerCase() !== target.owner.toLowerCase()) return null
    if (target.repo && parts[2]?.toLowerCase() !== target.repo.toLowerCase()) return null
    return candidate
  } catch {
    return null
  }
}

function relativeTime(value: string | null): string {
  if (!value) return 'unknown time'
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) return value
  const delta = parsed - Date.now()
  const absolute = Math.abs(delta)
  const unit = absolute < 60_000 ? 'second' : absolute < 3_600_000 ? 'minute' : absolute < 86_400_000 ? 'hour' : absolute < 2_592_000_000 ? 'day' : 'month'
  const divisor = unit === 'second' ? 1000 : unit === 'minute' ? 60_000 : unit === 'hour' ? 3_600_000 : unit === 'day' ? 86_400_000 : 2_592_000_000
  return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(Math.round(delta / divisor), unit)
}

function timelineLabel(event: IssueEvent): string {
  const actor = event.actor ?? 'Someone'
  switch (event.event.toLowerCase()) {
    case 'assigned': return `${actor} assigned this issue${event.label ? ` to ${event.label}` : ''}.`
    case 'unassigned': return `${actor} unassigned this issue${event.label ? ` from ${event.label}` : ''}.`
    case 'closed': return `${actor} closed this issue.`
    case 'reopened': return `${actor} reopened this issue.`
    case 'labeled': return `${actor} added label ${event.label ?? 'to this issue'}.`
    case 'unlabeled': return `${actor} removed label ${event.label ?? 'from this issue'}.`
    case 'mentioned': return `${actor} mentioned this issue.`
    default: return `${actor} · ${event.event.replace(/[-_]/g, ' ')}.`
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function eventData(error: unknown): RecordValue | null {
  return record(record(error)?.data)
}

function initialChoices(): IssueChoices {
  return { available: false, labels: [], assignees: [], message: null }
}

export function IssueSurface(props: TasksSurfaceProps) {
  const target = props.state.navigation.detail
  const currentKey = target ? targetKey(target) : null
  const [storedDetail, setStoredDetail] = useState<{ key: string; value: IssueDetail } | null>(null)
  const detail = storedDetail?.key === currentKey ? storedDetail.value : null
  const [loading, setLoading] = useState(true)
  const [reloadToken, setReloadToken] = useState(0)
  const [loadError, setLoadError] = useState('')
  const [editError, setEditError] = useState('')
  const [linkError, setLinkError] = useState('')
  const [bodyEditing, setBodyEditing] = useState(false)
  const [bodyDraft, setBodyDraft] = useState('')
  const bodyDraftDirty = useRef(false)
  const [commentDraft, setCommentDraft] = useState('')
  const [commentError, setCommentError] = useState('')
  const [duplicateOpen, setDuplicateOpen] = useState(false)
  const [duplicateNumber, setDuplicateNumber] = useState('')
  const [choices, setChoices] = useState<IssueChoices>(initialChoices)
  const [choiceError, setChoiceError] = useState('')
  const [issueSourceLabel, setIssueSourceLabel] = useState('')
  const [newLabel, setNewLabel] = useState('')
  const [newAssignee, setNewAssignee] = useState('')
  const [busy, setBusy] = useState(false)
  const [workspaceBusy, setWorkspaceBusy] = useState(false)
  const generation = useRef(0)
  const refreshRequested = useRef(false)
  const choiceGeneration = useRef(0)
  const mutationPending = useRef(false)
  const workspacePending = useRef(false)
  const confirmedByTarget = useRef(new Map<string, IssueComment[]>())
  const lastTargetKey = useRef<string | null>(null)

  useEffect(() => {
    const request = ++generation.current
    const forceRefresh = refreshRequested.current
    refreshRequested.current = false
    if (lastTargetKey.current !== currentKey) {
      lastTargetKey.current = currentKey
      bodyDraftDirty.current = false
      setBodyEditing(false)
      setBodyDraft('')
      setCommentDraft('')
      setCommentError('')
      setDuplicateOpen(false)
      setDuplicateNumber('')
      setNewLabel('')
      setNewAssignee('')
      setEditError('')
      setLinkError('')
    }
    if (!target || !currentKey) {
      setLoading(false)
      setLoadError('Select a GitHub issue to view its details.')
      return () => { generation.current += 1 }
    }
    setLoading(forceRefresh || storedDetail?.key !== currentKey)
    setLoadError('')
    void props.context.call('quirky.tasks/issue', forceRefresh ? { refresh: true } : {}).then((value) => {
      if (generation.current !== request) return
      const received = mapIssueDetail(value)
      if (!received) throw new Error('Issue detail response was not a normalized issue.')
      const confirmed = confirmedByTarget.current.get(currentKey) ?? []
      const next = mergeConfirmedComments(received, confirmed)
      setStoredDetail({ key: currentKey, value: next })
      if (!bodyDraftDirty.current) setBodyDraft(next.item.body)
    }).catch((error: unknown) => {
      if (generation.current === request) setLoadError(errorText(error))
    }).finally(() => {
      if (generation.current === request) setLoading(false)
    })
    return () => { generation.current += 1 }
  }, [props.context, currentKey, reloadToken])

  useEffect(() => {
    const request = ++choiceGeneration.current
    if (!target) {
      setChoices(initialChoices())
      setIssueSourceLabel('')
      return () => { choiceGeneration.current += 1 }
    }
    setChoiceError('')
    const sourceRequest = target.projectId && target.itemId
      ? Promise.resolve(null)
      : props.context.call('quirky.tasks/issueChoices', { kind: 'source' })
    void Promise.all([
      props.context.call('quirky.tasks/issueChoices', { kind: 'labels' }),
      props.context.call('quirky.tasks/issueChoices', { kind: 'assignees' }),
      sourceRequest
    ]).then((values) => {
      if (choiceGeneration.current !== request) return
      const labels = record(values[0])
      const assignees = record(values[1])
      const source = record(values[2])
      const sourceOption = array(source?.sources).flatMap((value) => {
        const option = record(value)
        return option !== null && option.id === source?.source && typeof option.label === 'string' ? [option.label] : []
      })[0]
      setIssueSourceLabel(sourceOption ?? '')
      const available = labels?.available === true && assignees?.available === true
      setChoices({
        available,
        labels: array(labels?.labels).flatMap((label) => typeof label === 'string' ? [label] : []).slice(0, 100),
        assignees: array(assignees?.assignees).flatMap((value) => {
          const user = record(value)
          return typeof user?.login === 'string' ? [{ login: user.login, avatarUrl: text(user.avatarUrl) }] : []
        }).slice(0, 100),
        message: typeof labels?.message === 'string' ? labels.message : typeof assignees?.message === 'string' ? assignees.message : null
      })
    }).catch((error: unknown) => {
      if (choiceGeneration.current === request) setChoiceError(errorText(error))
    })
    return () => { choiceGeneration.current += 1 }
  }, [props.context, currentKey])

  const safeUrl = target ? safeIssueUrl(detail?.item ?? null, target) : null
  const commentTooLarge = new TextEncoder().encode(commentDraft).byteLength > 65_536
  const linkedWorkspace = target?.url
    ? Object.values(props.state.links).find((link) => link.url === target.url) ?? null
    : null

  const refreshDetails = () => {
    refreshRequested.current = true
    setLoading(true)
    setReloadToken((value) => value + 1)
  }
  const navigateBack = async () => {
    try {
      await props.context.call('quirky.tasks/navigate', { detail: null })
    } catch (error: unknown) {
      setLoadError(errorText(error))
    }
  }

  const updateIssue = async (changes: RecordValue, optimistic: Partial<TaskItem>) => {
    if (!target || !currentKey || !detail || mutationPending.current) return
    if (changes.body !== undefined && detail.viewerCanUpdate !== true) {
      setEditError(detail.viewerCanUpdate === false ? 'This issue description is read-only.' : 'Editability could not be confirmed. Refresh issue details before editing.')
      return
    }
    mutationPending.current = true
    setBusy(true)
    setEditError('')
    const key = currentKey
    const request = generation.current
    const previous = detail
    setStoredDetail({ key, value: { ...detail, item: { ...detail.item, ...optimistic } } })
    try {
      const result = record(await props.context.call('quirky.tasks/issueEdit', changes))
      if (generation.current !== request || currentKey !== key) return
      const updated = mapIssueDetail({ ...previous, item: result?.item, comments: previous.comments, participants: previous.participants, timeline: previous.timeline, partialFailures: previous.partialFailures, truncated: previous.truncated, source: previous.source })
      if (!updated) throw new Error('GitHub did not return a confirmed issue after the edit.')
      setStoredDetail({ key, value: updated })
      if (typeof result?.refreshError === 'string') setEditError(`Saved, but could not reload the confirmed issue: ${result.refreshError}`)
      if (changes.body !== undefined) {
        const returnedItem = record(result?.item)
        if (typeof result?.refreshError === 'string') {
          setBodyDraft(String(changes.body))
          bodyDraftDirty.current = true
          setBodyEditing(true)
        } else {
          setBodyDraft(typeof returnedItem?.body === 'string' ? returnedItem.body : String(changes.body))
          bodyDraftDirty.current = false
          setBodyEditing(false)
        }
      }
      try {
        await props.refresh()
      } catch (error: unknown) {
        setEditError(`Saved issue, but the list could not refresh: ${errorText(error)}`)
      }
    } catch (error: unknown) {
      if (generation.current === request && currentKey === key) {
        setStoredDetail({ key, value: previous })
        setEditError(errorText(error))
        if (eventData(error)?.partial === true) refreshDetails()
      }
    } finally {
      mutationPending.current = false
      setBusy(false)
    }
  }

  const submitDuplicate = async () => {
    const value = duplicateNumber.trim()
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0 || Number(value) === target?.number) {
      setEditError('Enter a positive whole issue number different from this issue.')
      return
    }
    await updateIssue({ state: 'closed', duplicateOf: Number(value) }, { state: 'closed', duplicateOf: Number(value) })
    setDuplicateOpen(false)
  }

  const sendComment = async () => {
    if (!target || !currentKey || !detail || commentDraft.trim().length === 0 || mutationPending.current) return
    if (commentTooLarge) {
      setCommentError('Comments are limited to 65,536 UTF-8 bytes.')
      return
    }
    mutationPending.current = true
    setBusy(true)
    setCommentError('')
    const request = generation.current
    const key = currentKey
    const body = commentDraft
    try {
      const result = record(await props.context.call('quirky.tasks/issueComment', { body }))
      const raw = record(result?.comment)
      if (!raw || typeof raw.body !== 'string') throw new Error('GitHub did not confirm the posted comment.')
      const comment: IssueComment = {
        id: typeof raw.id === 'number' || typeof raw.id === 'string' ? raw.id : null,
        issueNumber: typeof raw.issueNumber === 'number' ? raw.issueNumber : detail.item.number,
        body: raw.body,
        author: text(raw.author),
        createdAt: text(raw.createdAt),
        updatedAt: text(raw.updatedAt),
        url: text(raw.url),
        kind: 'issue'
      }
      const confirmed = confirmedByTarget.current.get(key) ?? []
      const byId = new Map(confirmed.map((entry) => [commentKey(entry), entry]))
      byId.set(commentKey(comment), comment)
      const nextConfirmed = [...byId.values()].slice(-100)
      confirmedByTarget.current.delete(key)
      confirmedByTarget.current.set(key, nextConfirmed)
      while (confirmedByTarget.current.size > 32) {
        const oldest = confirmedByTarget.current.keys().next().value
        if (oldest === undefined) break
        confirmedByTarget.current.delete(oldest)
      }
      if (generation.current === request && currentKey === key) {
        setStoredDetail({ key, value: mergeConfirmedComments({ ...detail, comments: [...detail.comments, comment] }, nextConfirmed) })
        setCommentDraft('')
      }
      try {
        await props.refresh()
      } catch (error: unknown) {
        if (generation.current === request && currentKey === key) setCommentError(`Comment posted, but the issue list could not refresh: ${errorText(error)}`)
      }
    } catch (error: unknown) {
      if (generation.current === request) setCommentError(errorText(error))
    } finally {
      mutationPending.current = false
      setBusy(false)
    }
  }

  const handoffWorkspace = async (action: 'start' | 'resume' | 'link' | 'unlink', newWorkspace = false) => {
    if (!target || workspacePending.current) return
    workspacePending.current = true
    setWorkspaceBusy(true)
    setLinkError('')
    try {
      await props.context.call('quirky.tasks/workspace', {
        target,
        action,
        ...(action === 'link' ? { worktree: target.worktree } : {}),
        ...(newWorkspace ? { newWorkspace: true } : {})
      })
      await props.refresh()
    } catch (error: unknown) {
      setLinkError(errorText(error))
    } finally {
      workspacePending.current = false
      setWorkspaceBusy(false)
    }
  }

  const runLinkCommand = async (command: 'copy-link' | 'open-link') => {
    if (!safeUrl) {
      setLinkError('This issue does not have a safe HTTPS URL.')
      return
    }
    setLinkError('')
    try {
      await props.context.executeCommand(`command:quirky.tasks/${command}`, { url: safeUrl })
    } catch (error: unknown) {
      setLinkError(errorText(error))
    }
  }

  if (!target) return <main className="quirky-tasks-issue quirky-tasks-issue--empty"><div role="status"><EmptyState message="Select an issue from Tasks or a Project view." /></div></main>
  const item = detail?.item ?? null
  const canEditDescription = detail?.viewerCanUpdate === true
  const descriptionPermissionMessage = detail?.viewerCanUpdate === false
    ? 'This issue description is read-only.'
    : detail && detail.viewerCanUpdate === null
      ? 'Editability could not be confirmed. Refresh issue details before editing.'
      : null
  const initialUrl = safeIssueUrl(item, target)
  const projectOrigin = props.state.navigation.project !== null
  const title = item?.title ?? `Issue #${target.number}`
  const author = item?.author ?? 'unknown author'
  const stateLabel = item?.state === 'open' ? 'Open' : item?.state === 'closed' ? 'Closed' : 'Unknown state'
  const workspaceLabel = linkedWorkspace?.name ?? null

  return <main className="quirky-tasks-issue">
    <header className="quirky-tasks-issue__toolbar">
      <Button type="button" onClick={() => void navigateBack()}>{projectOrigin ? 'Back to Project' : 'Back to GitHub list'}</Button>
      <span className="quirky-tasks-issue__context">{issueContext(target)} · #{target.number}</span>
      <Button type="button" onClick={refreshDetails} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh'}</Button>
      <Button type="button" onClick={() => void runLinkCommand('copy-link')} disabled={!initialUrl}>Copy link</Button>
      <Button type="button" onClick={() => void runLinkCommand('open-link')} disabled={!initialUrl}>Open on GitHub</Button>
    </header>

    {linkError && <p className="quirky-tasks-issue__error" role="alert">{linkError}</p>}

    <section className="quirky-tasks-issue__summary">
      <div className="quirky-tasks-issue__summary-heading">
        <div className="quirky-tasks-issue__title-group">
          <h1 className="quirky-tasks-issue__title">{title}</h1>
          <div className="quirky-tasks-issue__meta">
            <Badge tone={item?.state === 'closed' ? 'neutral' : 'working'} label={`Issue state: ${stateLabel}`}>{stateLabel}</Badge>
            <span>{author} opened this issue</span>
            <span aria-hidden="true">·</span>
            <span title={item?.updatedAt ?? undefined}>updated {relativeTime(item?.updatedAt ?? null)}</span>
            <span aria-hidden="true">·</span>
            <span>{detail?.source === 'project' ? 'GitHub Project item' : issueSourceLabel || 'GitHub issue source'}</span>
          </div>
        </div>
        <div className="quirky-tasks-issue__actions">
          <Button type="button" variant="primary" onClick={() => void handoffWorkspace(linkedWorkspace ? 'resume' : 'start')} disabled={workspaceBusy}>
            {workspaceBusy ? 'Working…' : linkedWorkspace ? 'Open workspace' : 'Start workspace from issue'}
          </Button>
          {linkedWorkspace && <Button type="button" onClick={() => void handoffWorkspace('start', true)} disabled={workspaceBusy}>Start new workspace</Button>}
        </div>
      </div>
      <div className="quirky-tasks-issue__workspace">
        <span>{workspaceLabel ? <>Workspace: <strong>{workspaceLabel}</strong></> : 'No workspace attached'}</span>
        {workspaceLabel
          ? <Button type="button" onClick={() => void handoffWorkspace('unlink')} disabled={workspaceBusy}>Unlink</Button>
          : <Button type="button" onClick={() => void handoffWorkspace('link')} disabled={workspaceBusy}>Link current local workspace</Button>}
      </div>
    </section>

    {loading && !detail && <p className="quirky-tasks-issue__status" role="status">Loading issue details…</p>}
    {loadError && <div className="quirky-tasks-issue__error-panel" role="alert">
      <span>{detail ? `Couldn't refresh issue details. Showing the last confirmed data: ${loadError}` : `Couldn't load issue details: ${loadError}`}</span>
      <Button type="button" onClick={refreshDetails}>Retry</Button>
    </div>}

    {detail && <>
      <section className="quirky-tasks-issue__section" aria-labelledby="issue-edit-heading">
        <h2 id="issue-edit-heading" className="quirky-tasks-issue__section-title">Issue fields</h2>
        <div className="quirky-tasks-issue__field-row">
          <label className="quirky-tasks-issue__field">Status
            <select aria-label="Issue status" value={item?.state === 'closed' ? 'closed' : 'open'} disabled={busy || item === null} onChange={(event) => {
              const selected = event.currentTarget.value
              if (selected === 'closed' || selected === 'closed-completed') void updateIssue({ state: 'closed', stateReason: 'completed' }, { state: 'closed' })
              else if (selected === 'closed-not-planned') void updateIssue({ state: 'closed', stateReason: 'not_planned' }, { state: 'closed' })
              else if (selected === 'closed-duplicate') setDuplicateOpen(true)
              else if (selected === 'open') void updateIssue({ state: 'open' }, { state: 'open', stateReason: undefined, duplicateOf: undefined })
            }} className="quirky-tasks-control">
              <option value="open">Open / reopen</option>
              <option value="closed">Closed</option>
              <option value="closed-completed">Close as completed</option>
              <option value="closed-not-planned">Close as not planned</option>
              <option value="closed-duplicate" disabled={Boolean(target.projectId && target.itemId)}>Close as duplicate</option>
            </select>
          </label>
          {duplicateOpen && <form onSubmit={(event) => { event.preventDefault(); void submitDuplicate() }} className="quirky-tasks-issue__inline-form">
            <TextField label="Duplicate issue number" inputMode="numeric" value={duplicateNumber} onChange={(event) => setDuplicateNumber(event.currentTarget.value)} />
            <Button type="submit" disabled={busy}>Close as duplicate</Button>
            <Button type="button" onClick={() => setDuplicateOpen(false)}>Cancel</Button>
          </form>}
          <div className="quirky-tasks-issue__labels">
            <span className="ui-text-muted">Labels</span>
            {detail.item.labels.map((label) => <Button key={label} type="button" aria-label={`Remove label ${label}`} disabled={busy} onClick={() => {
              const labels = detail.item.labels.filter((entry) => entry !== label)
              void updateIssue({ labels }, { labels })
            }}>{label} ×</Button>)}
            {choices.available && choices.labels.filter((label) => !detail.item.labels.includes(label)).slice(0, 8).map((label) => <Button key={label} type="button" disabled={busy} onClick={() => {
              const labels = [...detail.item.labels, label]
              void updateIssue({ labels }, { labels })
            }}>+ {label}</Button>)}
            <TextField label="Add label" value={newLabel} onChange={(event) => setNewLabel(event.currentTarget.value)} placeholder="Add label" disabled={busy} />
            <Button type="button" disabled={busy || newLabel.trim().length === 0} onClick={() => {
              const labels = [...new Set([...detail.item.labels, newLabel.trim()])]
              setNewLabel('')
              void updateIssue({ labels }, { labels })
            }}>Add</Button>
          </div>
        </div>
        <div className="quirky-tasks-issue__assignee-section">
          <strong>Assignees</strong>
          <div className="quirky-tasks-issue__assignees">
            {detail.item.assignees.length === 0 && <span className="ui-text-muted">No one assigned</span>}
            {detail.item.assignees.map((login) => <label key={login} className="quirky-tasks-issue__assignee">
              <input type="checkbox" checked disabled={busy} onChange={() => void updateIssue({ assignees: detail.item.assignees.filter((entry) => entry !== login) }, { assignees: detail.item.assignees.filter((entry) => entry !== login) })} />{login}
            </label>)}
            {choices.available && choices.assignees.filter((user) => !detail.item.assignees.includes(user.login)).slice(0, 8).map((user) => <Button key={user.login} type="button" disabled={busy} onClick={() => {
              const assignees = [...detail.item.assignees, user.login]
              void updateIssue({ assignees }, { assignees })
            }}>+ {user.login}</Button>)}
            <TextField label="Add assignee login" value={newAssignee} onChange={(event) => setNewAssignee(event.currentTarget.value)} placeholder="Add assignee" disabled={busy} />
            <Button type="button" disabled={busy || newAssignee.trim().length === 0} onClick={() => {
              const assignees = [...new Set([...detail.item.assignees, newAssignee.trim()])]
              setNewAssignee('')
              void updateIssue({ assignees }, { assignees })
            }}>Add</Button>
          </div>
          {choices.message && <p className="quirky-tasks-issue__muted">{choices.message}</p>}
          {choiceError && <p className="quirky-tasks-issue__error" role="alert">{choiceError}</p>}
        </div>
        {editError && <p className="quirky-tasks-issue__error" role="alert">{editError}</p>}
      </section>

      <section className="quirky-tasks-issue__section" aria-labelledby="issue-description-heading">
        <div className="quirky-tasks-issue__section-heading">
          <h2 id="issue-description-heading" className="quirky-tasks-issue__section-title">Description</h2>
          {!bodyEditing && canEditDescription && <Button type="button" onClick={() => { setBodyDraft(detail.item.body); bodyDraftDirty.current = false; setBodyEditing(true) }} disabled={busy}>Edit description</Button>}
          {descriptionPermissionMessage && <span role="status" className="ui-text-muted">{descriptionPermissionMessage}</span>}
        </div>
        {bodyEditing
          ? <>
              <MarkdownComposer value={bodyDraft} onChange={(value) => { setBodyDraft(value); bodyDraftDirty.current = true }} label="Issue description" placeholder="Describe the issue…" disabled={busy || !canEditDescription} minRows={9} onSubmit={() => void updateIssue({ body: bodyDraft }, { body: bodyDraft })} />
              <div className="quirky-tasks-issue__edit-actions">
                <Button type="button" variant="primary" onClick={() => void updateIssue({ body: bodyDraft }, { body: bodyDraft })} disabled={busy || !canEditDescription}>{busy ? 'Saving…' : 'Save description'}</Button>
                <Button type="button" onClick={() => { setBodyDraft(detail.item.body); bodyDraftDirty.current = false; setBodyEditing(false) }} disabled={busy}>Cancel</Button>
                <span className="ui-text-muted">Cmd+Enter to save</span>
              </div>
            </>
          : <div className="quirky-tasks-issue__markdown"><Markdown source={detail.item.body || ''} /></div>}
      </section>

      <section className="quirky-tasks-issue__section" aria-labelledby="issue-activity-heading">
        <h2 id="issue-activity-heading" className="quirky-tasks-issue__section-title">Activity</h2>
        {detail.timeline.length === 0 && <p className="quirky-tasks-issue__muted">No timeline events.</p>}
        {detail.timeline.map((event, index) => <article key={`${event.event}-${event.createdAt ?? ''}-${index}`} className="quirky-tasks-issue__activity-event">
          <p>{timelineLabel(event)}</p>
          <time className="ui-text-muted" title={event.createdAt ?? undefined}>{relativeTime(event.createdAt)}</time>
          {event.body && <div className="quirky-tasks-issue__markdown"><Markdown source={event.body} /></div>}
        </article>)}
        {detail.truncated && <p className="quirky-tasks-issue__muted">Activity was truncated at the public API limit.</p>}
      </section>

      <section className="quirky-tasks-issue__section" aria-labelledby="issue-comments-heading">
        <h2 id="issue-comments-heading" className="quirky-tasks-issue__section-title">Comments ({detail.comments.length})</h2>
        {detail.comments.length === 0 && <p className="quirky-tasks-issue__muted">No comments yet.</p>}
        {detail.comments.map((comment) => <article key={commentKey(comment)} className="quirky-tasks-issue__comment">
          <div className="quirky-tasks-issue__comment-meta"><strong>{comment.author ?? 'unknown author'}</strong><time className="ui-text-muted" title={comment.createdAt ?? undefined}>{relativeTime(comment.createdAt)}</time></div>
          <Markdown source={comment.body} />
        </article>)}
        <MarkdownComposer value={commentDraft} onChange={setCommentDraft} label="Add a comment" placeholder="Add a comment…" disabled={busy} minRows={5} onSubmit={() => void sendComment()} />
        {commentTooLarge && <p className="quirky-tasks-issue__muted" role="status">Comments are limited to 65,536 UTF-8 bytes.</p>}
        <div className="quirky-tasks-issue__edit-actions">
          <Button type="button" variant="primary" onClick={() => void sendComment()} disabled={busy || commentDraft.trim().length === 0 || commentTooLarge}>{busy ? 'Posting…' : 'Comment'}</Button>
          <span className="ui-text-muted">Cmd+Enter to submit</span>
          {commentError && <p className="quirky-tasks-issue__error" role="alert">{commentError}</p>}
        </div>
      </section>

      {detail.partialFailures.length > 0 && <div className="quirky-tasks-issue__partial-failures" role="status">
        {detail.partialFailures.map((failure, index) => <p key={`${index}-${failure}`} className="quirky-tasks-issue__muted">Some issue data is unavailable: {failure}</p>)}
        <Button type="button" onClick={refreshDetails}>Retry unavailable sources</Button>
      </div>}
    </>}
  </main>
}
