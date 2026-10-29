import { useEffect, useMemo, useRef, useState } from 'react'
import { Markdown, MarkdownComposer } from '@quirky/plugin-tasks/markdown'
import { Badge, Button, FormRow, ListRow, Menu, SectionHeader, StatusDot, Tabs, TextField } from '@quirky/ui'
import type { JsonRecord, ReviewsSurfaceProps, ReviewData } from '../contracts'
import { isRecord, reviewContext, safeHttpUrl, workspaceLinkFor, type RepoIdentity, type ReviewContext, type WorkspaceLink } from './data'
import { ReviewActions } from './Actions'
import { ChecksList } from './ChecksList'
import { Comments } from './Comments'
import { FilesChanged } from './FilesChanged'
import { useReviewLinkRouting } from '../link-routing'
const tabs = ['conversation', 'checks', 'files'] as const
const reviewerPattern = /^[A-Za-z0-9-]{1,39}$/

type WorkspaceUi = { status: 'loading' | 'ready' | 'error'; link: WorkspaceLink | null; error: string | null }
type UserOption = { login: string; avatarUrl: string | null }

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function targetRepo(target: unknown, review: ReviewData | null, fallback: RepoIdentity | null): RepoIdentity | null {
  if (isRecord(target) && target.prRepo !== undefined && isRecord(target.prRepo)
    && typeof target.prRepo.host === 'string' && typeof target.prRepo.owner === 'string' && typeof target.prRepo.repo === 'string') {
    return { host: target.prRepo.host, owner: target.prRepo.owner, repo: target.prRepo.repo }
  }
  if (review !== null) {
    const url = safeHttpUrl(review.url)
    if (!url) return fallback
    try {
      const parsed = new URL(url)
      const match = /^\/([^/]+)\/([^/]+)\/pull\/[1-9][0-9]*\/?$/.exec(parsed.pathname)
      if (match?.[1] && match[2]) return { host: parsed.host, owner: match[1], repo: match[2] }
    } catch {
      return fallback
    }
  }
  return fallback
}

function relativeUpdated(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const time = Date.parse(value)
  if (!Number.isFinite(time)) return value
  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000))
  if (seconds < 60) return 'updated just now'
  if (seconds < 3600) return `updated ${Math.floor(seconds / 60)}m ago`
  if (seconds < 86_400) return `updated ${Math.floor(seconds / 3600)}h ago`
  return `updated ${Math.floor(seconds / 86_400)}d ago`
}

function itemDetails(details: JsonRecord | null): JsonRecord | null {
  return details && isRecord(details.item) ? details.item : null
}

function itemAuthor(details: JsonRecord | null): string | null {
  const item = itemDetails(details)
  const author = item?.author
  if (typeof author === 'string') return author
  return isRecord(author) && typeof author.login === 'string' ? author.login : null
}

function itemUpdated(details: JsonRecord | null): string | null {
  const item = itemDetails(details)
  return item && typeof item.updatedAt === 'string' ? item.updatedAt : null
}

function listOfLogins(value: unknown): string[] | null {
  if (value === null) return null
  if (!Array.isArray(value) || !value.every((login) => typeof login === 'string')) return null
  return [...new Set(value)]
}

function reviewerList(review: ReviewData | null, details: JsonRecord | null): string[] | null {
  const reviewList = listOfLogins(review?.requestedReviewers)
  if (reviewList !== null) return reviewList
  return listOfLogins(itemDetails(details)?.requestedReviewers)
}

function reviewedBy(details: JsonRecord | null, review: ReviewData | null): { author: string | null; state: string }[] | null {
  const source = review?.reviews ?? itemDetails(details)?.reviews
  if (source === null) return null
  if (!Array.isArray(source)) return null
  const rows: { author: string | null; state: string }[] = []
  for (const row of source) {
    if (!isRecord(row) || typeof row.state !== 'string' || !(row.author === null || typeof row.author === 'string')) return null
    rows.push({ author: row.author, state: row.state })
  }
  return rows
}


function splitReviewers(value: string): { logins: string[]; error: string | null } {
  if (new TextEncoder().encode(value).byteLength > 2048) return { logins: [], error: 'Reviewer input is limited to 2 KiB.' }
  const logins = [...new Set(value.split(/[\s,]+/).map((login) => login.trim().replace(/^@+/, '')).filter(Boolean))]
  if (logins.length > 15) return { logins: [], error: 'Request up to 15 reviewers.' }
  if (logins.some((login) => !reviewerPattern.test(login))) return { logins: [], error: 'Reviewer logins may contain letters, numbers, and hyphens only.' }
  return { logins, error: null }
}

function assignableOptions(value: unknown): UserOption[] | null {
  if (!isRecord(value) || !Array.isArray(value.assignees)) return null
  const options: UserOption[] = []
  for (const item of value.assignees) {
    if (!isRecord(item) || typeof item.login !== 'string' || item.login.trim() === '') return null
    options.push({ login: item.login, avatarUrl: typeof item.avatarUrl === 'string' ? item.avatarUrl : null })
  }
  return options
}

function AssignmentPanels(props: { context: ReviewsSurfaceProps['context']; state: ReviewsSurfaceProps['state']; owner: ReviewContext }) {
  const { context, state, owner } = props
  const review = owner.review
  const details = owner.surface === 'detail' ? state.detail.details : null
  const item = itemDetails(details)
  const assignees = listOfLogins(review?.assignees ?? item?.assignees)
  const reviewers = reviewerList(review, details)
  const reviews = reviewedBy(details, review)
  const [assigneeOpen, setAssigneeOpen] = useState(false)
  const [reviewerOpen, setReviewerOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [reviewerText, setReviewerText] = useState('')
  const [selectedAssignees, setSelectedAssignees] = useState<string[]>([])
  const [suggestions, setSuggestions] = useState<UserOption[]>([])
  const [suggestionError, setSuggestionError] = useState<string | null>(null)
  const [writeError, setWriteError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const queryGeneration = useRef(0)
  const pendingRef = useRef(false)
  const target = {
    surface: owner.surface,
    worktree: owner.worktree,
    number: owner.number,
    ...(owner.repo === null ? {} : { prRepo: owner.repo }),
  }

  useEffect(() => {
    if (!assigneeOpen && !reviewerOpen) return
    const request = ++queryGeneration.current
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const value = await context.call('quirky.hosting/assignees', { worktree: owner.worktree, query })
          const parsed = assignableOptions(value)
          if (parsed === null) throw new Error('The hosting API returned invalid reviewer suggestions.')
          if (queryGeneration.current !== request) return
          setSuggestions(parsed.slice(0, 100))
          setSuggestionError(null)
        } catch (error) {
          if (queryGeneration.current === request) setSuggestionError(errorText(error))
        }
      })()
    }, 120)
    return () => clearTimeout(timer)
  }, [assigneeOpen, reviewerOpen, query, context, owner.worktree])

  const writeAssignees = async () => {
    if (pendingRef.current) return
    pendingRef.current = true
    setPending(true)
    setWriteError(null)
    try {
      await context.call('quirky.reviews/detailUpdateAssignees', { ...target, action: 'set', logins: selectedAssignees })
      setAssigneeOpen(false)
    } catch (error) {
      setWriteError(errorText(error))
    } finally {
      pendingRef.current = false
      setPending(false)
    }
  }

  const writeReviewers = async (action: 'add' | 'remove', logins: string[]) => {
    if (pendingRef.current || logins.length === 0) return
    pendingRef.current = true
    setPending(true)
    setWriteError(null)
    try {
      await context.call('quirky.reviews/detailUpdateReviewers', { ...target, action, logins })
      setReviewerText('')
      setReviewerOpen(false)
    } catch (error) {
      setWriteError(errorText(error))
    } finally {
      pendingRef.current = false
      setPending(false)
    }
  }

  const requestReviewers = splitReviewers(reviewerText)
  const reviewStatus = reviews === null
    ? 'Review status is unavailable.'
    : reviews.length === 0 ? 'No reviews submitted yet.' : reviews.map((entry) => `${entry.author ?? 'Unknown reviewer'}: ${entry.state}`).join(' · ')

  return <>
    <section className="ui-stack" aria-label="Assignees">
      <SectionHeader title="Assignees" actions={<Button disabled={assignees === null || pending} onClick={() => {
        setSelectedAssignees(assignees ?? [])
        setAssigneeOpen(!assigneeOpen)
        setQuery('')
      }}>{assigneeOpen ? 'Done' : 'Edit assignees'}</Button>} />
      {assignees === null ? <p role="status" className="ui-text-muted">Assignee data is unavailable.</p> : assignees.length === 0 ? <p>No one assigned.</p> : <ul className="ui-stack" style={{ listStyle: 'none', padding: 0 }}>
        {assignees.map((login) => <li key={login}><ListRow title={login} /></li>)}
      </ul>}
      {assigneeOpen ? <div className="ui-stack">
        <TextField label="Find assignable users" value={query} onChange={(event) => setQuery(event.currentTarget.value)} />
        {suggestionError ? <p role="alert"><StatusDot status="failing" label="Error" /> {suggestionError}</p> : null}
        <ul className="ui-stack" style={{ listStyle: 'none', padding: 0 }}>{suggestions.map((option) => <li key={option.login}>
          <FormRow label={option.login} htmlFor={`review-assignee-${option.login}`}>
            <input id={`review-assignee-${option.login}`} type="checkbox" style={{ accentColor: 'var(--ui-accent)' }} checked={selectedAssignees.includes(option.login)} onChange={(event) => {
              setSelectedAssignees(event.currentTarget.checked
                ? [...new Set([...selectedAssignees, option.login])]
                : selectedAssignees.filter((login) => login !== option.login))
            }} />
          </FormRow>
        </li>)}</ul>
        <Button disabled={pending || selectedAssignees.length > 100} onClick={() => void writeAssignees()}>{pending ? 'Saving…' : 'Save assignees'}</Button>
      </div> : null}
    </section>
    <section className="ui-stack" aria-label="Reviewers">
      <SectionHeader title="Reviewers" actions={<Button disabled={pending} onClick={() => { setReviewerOpen(!reviewerOpen); setQuery('') }}>{reviewerOpen ? 'Done' : 'Request reviewers'}</Button>} />
      {reviewers === null ? <p role="status" className="ui-text-muted">Requested reviewer data is unavailable.</p> : reviewers.length === 0 ? <p>No reviewers requested.</p> : <ul className="ui-stack" style={{ listStyle: 'none', padding: 0 }}>
        {reviewers.map((login) => <li key={login}><ListRow title={login} trailing={<Button disabled={pending} aria-label={`Unrequest reviewer ${login}`} onClick={() => void writeReviewers('remove', [login])}>Remove</Button>} /></li>)}
      </ul>}
      <p className="ui-text-muted">{reviewStatus}</p>
      {reviewerOpen ? <div className="ui-stack">
        <TextField label="Type or choose a user" value={reviewerText} onChange={(event) => setReviewerText(event.currentTarget.value)} />
        {requestReviewers.error ? <p role="alert"><StatusDot status="failing" label="Error" /> {requestReviewers.error}</p> : null}
        {suggestionError ? <p role="alert"><StatusDot status="failing" label="Error" /> {suggestionError}</p> : null}
        <ul className="ui-stack" style={{ listStyle: 'none', padding: 0 }}>{suggestions.filter((option) => option.login.toLowerCase().startsWith(query.toLowerCase())).slice(0, 8).map((option) => <li key={option.login}>
          <Button onClick={() => setReviewerText([...new Set([...requestReviewers.logins, option.login])].map((login) => `@${login}`).join(', '))}>@{option.login}</Button>
        </li>)}</ul>
        <Button disabled={pending || requestReviewers.error !== null || requestReviewers.logins.length === 0} onClick={() => void writeReviewers('add', requestReviewers.logins)}>{pending ? 'Requesting…' : 'Request reviewers'}</Button>
      </div> : null}
    </section>
    {writeError ? <p role="alert"><StatusDot status="failing" label="Error" /> {writeError}</p> : null}
  </>
}

export function ReviewPage(props: ReviewsSurfaceProps) {
  const routing = useReviewLinkRouting(props.context)
  const owner = reviewContext(props.state, 'detail')
  const review = props.state.detail.review
  const detail = props.state.detail
  const url = review === null ? null : safeHttpUrl(review.url)
  const repo = targetRepo(detail.target, review, owner?.repo ?? null)
  const targetKey = owner === null ? '' : `${owner.worktree}\\u0000${owner.number}\\u0000${owner.generation}`
  const [workspace, setWorkspace] = useState<WorkspaceUi>({ status: 'loading', link: null, error: null })
  const [workspaceBusy, setWorkspaceBusy] = useState(false)
  const [workspaceError, setWorkspaceError] = useState<string | null>(null)
  const workspaceRequest = useRef(0)
  const workspaceBusyRef = useRef(false)
  const [bodyEditing, setBodyEditing] = useState(false)
  const [bodyDraft, setBodyDraft] = useState(detail.bodyDraft ?? review?.body ?? '')
  const [bodySaveError, setBodySaveError] = useState<string | null>(null)
  const bodyRevision = useRef(Date.now() * 1000 + Math.floor(Math.random() * 1000))
  const author = itemAuthor(detail.details)
  const updated = relativeUpdated(itemUpdated(detail.details))
  const canEditBody = itemDetails(detail.details)?.viewerCanUpdate === true

  useEffect(() => {
    if (owner === null || !targetKey || (review !== null && detail.fetchedAt > 0 && Date.now() - detail.fetchedAt < 30_000)) return
    void props.context.call('quirky.reviews/detailRefresh', {
      surface: 'detail',
      worktree: owner.worktree,
      number: owner.number,
      ...(owner.repo === null ? {} : { prRepo: owner.repo }),
    }).catch(() => undefined)
  }, [props.context, targetKey])

  useEffect(() => {
    const request = ++workspaceRequest.current
    if (owner === null || url === null) {
      setWorkspace({ status: owner === null ? 'loading' : 'error', link: null, error: owner === null ? null : 'The pull request URL is unavailable.' })
      return
    }
    setWorkspace({ status: 'loading', link: null, error: null })
    void (async () => {
      try {
        const value = await props.context.call('quirky.tasks/state')
        if (request !== workspaceRequest.current) return
        if (!isRecord(value)) throw new Error('Tasks state is unavailable; workspace attachment cannot be verified.')
        setWorkspace({ status: 'ready', link: workspaceLinkFor(value, url), error: null })
      } catch (error) {
        if (request === workspaceRequest.current) {
          setWorkspace({ status: 'error', link: null, error: errorText(error) })
        }
      }
    })()
  }, [props.context, targetKey, url])

  useEffect(() => {
    setBodyDraft(detail.bodyDraft ?? review?.body ?? '')
    setBodySaveError(null)
  }, [targetKey, detail.bodyDraft, review?.body])

  useEffect(() => {
    bodyRevision.current = Date.now() * 1000 + Math.floor(Math.random() * 1000)
  }, [targetKey])

  const requestContext = () => {
    if (owner === null) return null
    return {
      worktree: owner.worktree,
      kind: 'pullRequest' as const,
      number: owner.number,
      ...(url === null ? {} : { url }),
      ...(repo === null ? {} : { host: repo.host, owner: repo.owner, repo: repo.repo }),
    }
  }

  const openWorkspace = async (action: 'start' | 'resume', newWorkspace = false) => {
    const target = requestContext()
    if (workspaceBusyRef.current || workspace.status !== 'ready' || owner === null || target === null) return
    workspaceBusyRef.current = true
    setWorkspaceBusy(true)
    setWorkspaceError(null)
    try {
      const result: unknown = await props.context.call('quirky.tasks/workspace', {
        action,
        target,
        ...(newWorkspace ? { newWorkspace: true } : {}),
      })
      if (action === 'start' && (!isRecord(result) || result.kind !== 'composer')) {
        throw new Error('The Tasks API did not open the hosted-review workspace composer.')
      }
      if (action === 'resume') props.context.toast('Workspace resumed', `Activated ${workspace.link?.name ?? `the workspace for PR #${owner.number}`}.`)
    } catch (error) {
      setWorkspaceError(errorText(error))
    } finally {
      workspaceBusyRef.current = false
      setWorkspaceBusy(false)
    }
  }

  const back = async () => {
    try {
      await props.context.call('quirky.reviews/close', {})
    } catch (error) {
      props.context.toast('Could not go back', errorText(error))
    }
  }

  const copyLink = async () => {
    if (url === null) return
    try {
      await props.context.call('quirky.reviews/copyText', { text: url })
      props.context.toast('Link copied', url)
    } catch (error) {
      props.context.toast('Could not copy link', errorText(error))
    }
  }

  const openLink = async (invert: boolean) => {
    if (owner === null || url === null) return
    try {
      await props.context.call('quirky.reviews/openLink', { url, worktree: owner.worktree, ...(invert ? { invert: true } : {}) })
    } catch (error) {
      props.context.toast('Could not open pull request link', errorText(error))
    }
  }

  const selectTab = async (tab: typeof tabs[number]) => {
    if (owner === null) return
    try {
      await props.context.call('quirky.reviews/detailSetTab', {
        worktree: owner.worktree,
        number: owner.number,
        ...(owner.repo === null ? {} : { prRepo: owner.repo }),
        tab,
      })
    } catch (error) {
      props.context.toast('Could not change review tab', errorText(error))
    }
  }

  const updateBodyDraft = (value: string | null) => {
    if (owner === null) return
    setBodyDraft(value ?? '')
    bodyRevision.current += 1
    void props.context.call('quirky.reviews/detailSetBodyDraft', {
      worktree: owner.worktree,
      number: owner.number,
      generation: owner.generation,
      ...(owner.repo === null ? {} : { prRepo: owner.repo }),
      body: value,
      draftVersion: bodyRevision.current,
    }).catch((error: unknown) => setBodySaveError(errorText(error)))
  }

  const saveBody = async () => {
    if (owner === null || review === null) return
    setBodySaveError(null)
    try {
      await props.context.call('quirky.reviews/detailUpdateBody', {
        surface: 'detail',
        worktree: owner.worktree,
        number: owner.number,
        ...(owner.repo === null ? {} : { prRepo: owner.repo }),
        body: bodyDraft,
      })
      setBodyEditing(false)
    } catch (error) {
      setBodySaveError(errorText(error))
    }
  }

  const refresh = async () => {
    if (owner === null) return
    try {
      await props.context.call('quirky.reviews/detailRefresh', {
        surface: 'detail',
        worktree: owner.worktree,
        number: owner.number,
        ...(owner.repo === null ? {} : { prRepo: owner.repo }),
      })
    } catch (error) {
      props.context.toast('Could not refresh pull request', errorText(error))
    }
  }

  const checksCount = isRecord(detail.checks) && Array.isArray(detail.checks.checks) ? detail.checks.checks.length : null
  const filesCount = isRecord(detail.files) && Array.isArray(detail.files.files) ? detail.files.files.length : null
  const commentsCount = isRecord(detail.comments) && Array.isArray(detail.comments.comments) ? detail.comments.comments.length : null
  const body = review?.body ?? ''
  const attached = workspace.link
  const workspaceReady = workspace.status === 'ready' && owner !== null && url !== null

  if (owner === null) return <main className="ui-stack" aria-label="Pull request detail">
    <Button onClick={() => void back()}>Back to pull requests</Button>
    <SectionHeader title="No pull request selected" />
    <p>Open a pull request from Tasks or the Checks panel to view its details.</p>
  </main>

  return <main className="ui-stack" aria-label="Pull request detail">
    <header className="ui-stack">
      <div className="ui-cluster" style={{ justifyContent: 'space-between' }}>
        <Button onClick={() => void back()}>Back to pull requests</Button>
        <nav className="ui-cluster" aria-label="Pull request repository">
          {repo ? <span>{repo.owner} / {repo.repo}</span> : <span>Repository unavailable</span>}
          <span>#{owner.number}</span>
        </nav>
        <div className="ui-cluster">
          <Button disabled={url === null} onClick={() => void copyLink()}>Copy pull request link</Button>
          <Button disabled={url === null} title={routing.title} onClick={(event) => void openLink(routing.invert(event))}>Open on host</Button>
        </div>
      </div>
      {review === null ? <div className="ui-stack">
        <SectionHeader title={`Pull request #${owner.number}`} />
        {detail.loading ? <p role="status" className="ui-text-muted">Loading pull request…</p> : <p role="alert"><StatusDot status="failing" label="Error" /> Pull request details are unavailable.</p>}
      </div> : <>
        <div className="ui-cluster" style={{ justifyContent: 'space-between', alignItems: 'start' }}>
          <div className="ui-stack">
            <h1>{review.title} <span>#{review.number}</span></h1>
            <Badge tone={review.state === 'open' ? 'working' : review.state === 'merged' ? 'accent' : 'neutral'}>{review.state === 'open' ? 'Open' : review.state === 'draft' ? 'Draft' : review.state === 'closed' ? 'Closed' : 'Merged'}</Badge>
          </div>
          <div className="ui-cluster">
            <Button disabled={!workspaceReady || workspaceBusy} onClick={() => void openWorkspace(attached ? 'resume' : 'start')}>
              {workspaceBusy ? 'Opening…' : attached ? `Resume workspace · ${attached.name}` : 'Start workspace'}
            </Button>
            {attached ? <Menu label="Workspace options" items={[{
              id: 'start-new-workspace',
              label: 'Start new workspace',
              disabled: !workspaceReady || workspaceBusy,
              onAction: () => { void openWorkspace('start', true) },
            }]} /> : null}
          </div>
        </div>
        {workspace.status === 'loading' ? <p role="status" className="ui-text-muted">Checking linked workspace…</p> : null}
        {workspace.error ? <p role="alert"><StatusDot status="failing" label="Error" /> Workspace link status unavailable: {workspace.error}. Start and Resume are disabled until the link can be checked.</p> : null}
        {workspaceError ? <p role="alert"><StatusDot status="failing" label="Error" /> {workspaceError}</p> : null}
        <div className="ui-cluster ui-text-muted">
          <span>by {author ?? 'Unknown author'}</span>
          <span>{review.baseRefName} ← {review.headRefName}</span>
          {updated ? <time>{updated}</time> : null}
          {attached ? <span>Workspace: {attached.name}</span> : workspace.status === 'ready' ? <span>No linked workspace</span> : null}
        </div>
      </>}
    </header>

    {detail.error ? <div role="alert" className="ui-cluster">
      <StatusDot status="failing" label="Error" /><span>{detail.error}</span><Button onClick={() => void refresh()}>Retry</Button>
    </div> : null}
    {review === null ? null : <div className="ui-stack">
      <Tabs label="Pull request sections" items={[
        { id: 'conversation', label: `Conversation${commentsCount === null ? '' : ` (${commentsCount})`}` },
        { id: 'checks', label: `Checks${checksCount === null ? '' : ` (${checksCount})`}` },
        { id: 'files', label: `Files changed${filesCount === null ? '' : ` (${filesCount})`}` },
      ]} value={detail.tab} onChange={(tab) => void selectTab(tab as typeof tabs[number])} />
      <div className="ui-cluster" style={{ justifyContent: 'flex-end' }}>
        <Button disabled={detail.loading} onClick={() => void refresh()}>{detail.loading ? 'Refreshing…' : 'Refresh pull request'}</Button>
      </div>
    </div>}

    {review === null ? null : <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)', gap: 'var(--ui-space-16)', alignItems: 'start' }}>
      <div className="ui-stack" style={{ minWidth: 0 }}>
        {detail.tab === 'conversation' ? <>
          <section className="ui-stack" aria-label="Pull request description">
            <SectionHeader title="Description" actions={canEditBody && !bodyEditing ? <Button onClick={() => { updateBodyDraft(body); setBodyEditing(true) }}>Edit description</Button> : undefined} />
            {bodyEditing ? <div className="ui-stack">
              <MarkdownComposer value={bodyDraft} onChange={updateBodyDraft} label="Pull request description" minRows={8} onSubmit={() => void saveBody()} />
              {bodySaveError ? <p role="alert"><StatusDot status="failing" label="Error" /> {bodySaveError}</p> : null}
              <div className="ui-cluster">
                <Button variant="primary" onClick={() => void saveBody()}>Save description</Button>
                <Button onClick={() => { setBodyEditing(false); updateBodyDraft(null) }}>Cancel</Button>
              </div>
            </div> : <div><Markdown source={body} /></div>}
          </section>
          <Comments {...props} surface="detail" />
        </> : detail.tab === 'checks' ? <ChecksList {...props} surface="detail" /> : <FilesChanged {...props} />}
      </div>
      <aside className="ui-stack" aria-label="Review actions and assignments">
        <ReviewActions {...props} surface="detail" />
        <AssignmentPanels context={props.context} state={props.state} owner={owner} />
        {detail.tab === 'conversation' && <section className="ui-stack" aria-label="Checks summary">
          <SectionHeader title="Checks" />
          <ChecksList {...props} surface="detail" compact />
          <Button onClick={() => void selectTab('checks')}>Open Checks tab</Button>
        </section>}
      </aside>
    </div>}
  </main>
}