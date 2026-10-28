import { useEffect, useMemo, useRef, useState } from 'react'
import { Markdown, MarkdownComposer } from '@quirky/plugin-tasks/markdown'
import type { JsonRecord, ReviewsSurfaceProps, ReviewData } from '../contracts'
import { isRecord, reviewContext, safeHttpUrl, workspaceLinkFor, type RepoIdentity, type ReviewContext, type WorkspaceLink } from './data'
import { ReviewActions } from './Actions'
import { ChecksList } from './ChecksList'
import { Comments } from './Comments'
import { FilesChanged } from './FilesChanged'

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
    <section className="review-assignees" aria-label="Assignees">
      <header className="review-assignment-header">
        <h3>Assignees</h3>
        <button type="button" disabled={assignees === null || pending} onClick={() => {
          setSelectedAssignees(assignees ?? [])
          setAssigneeOpen(!assigneeOpen)
          setQuery('')
        }}>{assigneeOpen ? 'Done' : 'Edit assignees'}</button>
      </header>
      {assignees === null ? <p role="status">Assignee data is unavailable.</p> : assignees.length === 0 ? <p>No one assigned.</p> : <ul>{assignees.map((login) => <li key={login}>{login}</li>)}</ul>}
      {assigneeOpen ? <div className="review-assignee-picker">
        <label>Find assignable users<input value={query} onChange={(event) => setQuery(event.currentTarget.value)} /></label>
        {suggestionError ? <p role="alert">{suggestionError}</p> : null}
        <ul>{suggestions.map((option) => <li key={option.login}>
          <label><input type="checkbox" checked={selectedAssignees.includes(option.login)} onChange={(event) => {
            setSelectedAssignees(event.currentTarget.checked
              ? [...new Set([...selectedAssignees, option.login])]
              : selectedAssignees.filter((login) => login !== option.login))
          }} />{option.login}</label>
        </li>)}</ul>
        <button type="button" disabled={pending || selectedAssignees.length > 100} onClick={() => void writeAssignees()}>{pending ? 'Saving…' : 'Save assignees'}</button>
      </div> : null}
    </section>
    <section className="review-reviewers" aria-label="Reviewers">
      <header className="review-assignment-header">
        <h3>Reviewers</h3>
        <button type="button" disabled={pending} onClick={() => { setReviewerOpen(!reviewerOpen); setQuery('') }}>{reviewerOpen ? 'Done' : 'Request reviewers'}</button>
      </header>
      {reviewers === null ? <p role="status">Requested reviewer data is unavailable.</p> : reviewers.length === 0 ? <p>No reviewers requested.</p> : <ul>{reviewers.map((login) => <li key={login}>
        {login} <button type="button" disabled={pending} aria-label={`Unrequest reviewer ${login}`} onClick={() => void writeReviewers('remove', [login])}>Remove</button>
      </li>)}</ul>}
      <p className="review-reviewed-state">{reviewStatus}</p>
      {reviewerOpen ? <div className="review-reviewer-picker">
        <label>Type or choose a user<input value={reviewerText} onChange={(event) => setReviewerText(event.currentTarget.value)} /></label>
        {requestReviewers.error ? <p role="alert">{requestReviewers.error}</p> : null}
        {suggestionError ? <p role="alert">{suggestionError}</p> : null}
        <ul>{suggestions.filter((option) => option.login.toLowerCase().startsWith(query.toLowerCase())).slice(0, 8).map((option) => <li key={option.login}>
          <button type="button" onClick={() => setReviewerText([...new Set([...requestReviewers.logins, option.login])].map((login) => `@${login}`).join(', '))}>@{option.login}</button>
        </li>)}</ul>
        <button type="button" disabled={pending || requestReviewers.error !== null || requestReviewers.logins.length === 0} onClick={() => void writeReviewers('add', requestReviewers.logins)}>{pending ? 'Requesting…' : 'Request reviewers'}</button>
      </div> : null}
    </section>
    {writeError ? <p role="alert" className="review-error">{writeError}</p> : null}
  </>
}

export function ReviewPage(props: ReviewsSurfaceProps) {
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
  const item = itemDetails(detail.details)
  const body = review?.body ?? ''
  const attached = workspace.link
  const workspaceReady = workspace.status === 'ready' && owner !== null && url !== null

  if (owner === null) return <main className="review-page review-page-empty" aria-label="Pull request detail">
    <button type="button" onClick={() => void back()}>Back to pull requests</button>
    <h1>No pull request selected</h1>
    <p>Open a pull request from Tasks or the Checks panel to view its details.</p>
  </main>

  return <main className="review-page" aria-label="Pull request detail">
    <header className="review-page-header">
      <div className="review-page-header-top">
        <button type="button" onClick={() => void back()}>Back to pull requests</button>
        <nav aria-label="Pull request repository">
          {repo ? <span>{repo.owner} / {repo.repo}</span> : <span>Repository unavailable</span>}
          <span>#{owner.number}</span>
        </nav>
        <div className="review-link-actions">
          <button type="button" disabled={url === null} onClick={() => void copyLink()}>Copy pull request link</button>
          <button type="button" disabled={url === null} title="Open pull request" onClick={(event) => void openLink(event.shiftKey && (event.metaKey || event.ctrlKey))}>Open on host</button>
        </div>
      </div>
      {review === null ? <div className="review-page-loading">
        <h1>Pull request #{owner.number}</h1>
        {detail.loading ? <p role="status">Loading pull request…</p> : <p role="alert">Pull request details are unavailable.</p>}
      </div> : <>
        <div className="review-title-block">
          <div>
            <h1>{review.title} <span>#{review.number}</span></h1>
            <span className={`review-state review-state-${review.state}`}>{review.state === 'open' ? 'Open' : review.state === 'draft' ? 'Draft' : review.state === 'closed' ? 'Closed' : 'Merged'}</span>
          </div>
          <div className="review-workspace-action">
            <button type="button" disabled={!workspaceReady || workspaceBusy} onClick={() => void openWorkspace(attached ? 'resume' : 'start')}>
              {workspaceBusy ? 'Opening…' : attached ? `Resume workspace · ${attached.name}` : 'Start workspace'}
            </button>
            {attached ? <details>
              <summary>Workspace options</summary>
              <button type="button" disabled={!workspaceReady || workspaceBusy} onClick={() => void openWorkspace('start', true)}>Start new workspace</button>
            </details> : null}
          </div>
        </div>
        {workspace.status === 'loading' ? <p role="status">Checking linked workspace…</p> : null}
        {workspace.error ? <p className="review-error" role="alert">Workspace link status unavailable: {workspace.error}. Start and Resume are disabled until the link can be checked.</p> : null}
        {workspaceError ? <p className="review-error" role="alert">{workspaceError}</p> : null}
        <div className="review-meta">
          <span>by {author ?? 'Unknown author'}</span>
          <span>{review.baseRefName} ← {review.headRefName}</span>
          {updated ? <time>{updated}</time> : null}
          {attached ? <span>Workspace: {attached.name}</span> : workspace.status === 'ready' ? <span>No linked workspace</span> : null}
        </div>
      </>}
    </header>

    {detail.error ? <div className="review-error" role="alert">
      <span>{detail.error}</span><button type="button" onClick={() => void refresh()}>Retry</button>
    </div> : null}
    {review === null ? null : <div className="review-tabs" role="tablist" aria-label="Pull request sections">
      {tabs.map((tab) => <button
        key={tab}
        type="button"
        role="tab"
        aria-selected={detail.tab === tab}
        onClick={() => void selectTab(tab)}
      >{tab === 'conversation' ? `Conversation${commentsCount === null ? '' : ` (${commentsCount})`}` : tab === 'checks' ? `Checks${checksCount === null ? '' : ` (${checksCount})`}` : `Files changed${filesCount === null ? '' : ` (${filesCount})`}`}</button>)}
      <button type="button" disabled={detail.loading} onClick={() => void refresh()}>{detail.loading ? 'Refreshing…' : 'Refresh pull request'}</button>
    </div>}

    {review === null ? null : <div className="review-page-content">
      <div className="review-page-main">
        {detail.tab === 'conversation' ? <>
          <section className="review-description" aria-label="Pull request description">
            <header><h2>Description</h2>{canEditBody && !bodyEditing ? <button type="button" onClick={() => { updateBodyDraft(body); setBodyEditing(true) }}>Edit description</button> : null}</header>
            {bodyEditing ? <div className="review-description-editor">
              <MarkdownComposer value={bodyDraft} onChange={updateBodyDraft} label="Pull request description" minRows={8} onSubmit={() => void saveBody()} />
              {bodySaveError ? <p role="alert">{bodySaveError}</p> : null}
              <button type="button" onClick={() => void saveBody()}>Save description</button>
              <button type="button" onClick={() => { setBodyEditing(false); updateBodyDraft(null) }}>Cancel</button>
            </div> : <div className="review-description-body"><Markdown source={body} /></div>}
          </section>
          <Comments {...props} surface="detail" />
        </> : detail.tab === 'checks' ? <ChecksList {...props} surface="detail" /> : <FilesChanged {...props} />}
      </div>
      <aside className="review-page-rail" aria-label="Review actions and assignments">
        <ReviewActions {...props} surface="detail" />
        <AssignmentPanels context={props.context} state={props.state} owner={owner} />
        {detail.tab === 'conversation' && <section aria-label="Checks summary"><h3>Checks</h3><ChecksList {...props} surface="detail" compact /><button type="button" onClick={() => void selectTab('checks')}>Open Checks tab</button></section>}
      </aside>
    </div>}
  </main>
}