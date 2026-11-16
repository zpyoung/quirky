import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Markdown, MarkdownComposer } from '@quirky/plugin-tasks/markdown'
import { Badge, Button, EmptyState, FormRow, InlineError, ListRow, Menu, NoticeLine, SectionHeader, Tabs, TextField } from '@quirky/ui'
import type { JsonRecord, ReviewsSurfaceProps, ReviewData } from '../contracts'
import { copyReviewsText, registerReviewsUiControl, requestReviewsUiControl, type ReviewsUiControlRequest, type ReviewsUiControlResult } from '../checks/data'
import { isRecord, reviewContext, safeHttpUrl, workspaceLinkFor, type RepoIdentity, type ReviewContext, type WorkspaceLink } from './data'
import { ReviewActions } from './Actions'
import { ChecksList } from './ChecksList'
import { Comments } from './Comments'
import { FilesChanged } from './FilesChanged'
import { useReviewLinkRouting } from '../link-routing'
import { createDraftVersions, useDraftField, useTargetGuard, type DraftAction } from '../draft-field'
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
type ReviewsControlAction = { action: string; enabled: boolean }
type ReviewsControlAcceptance = { accepted: true }
type ReviewsControlLease = { target: string; identity: string; generation: number; changed(): void; dispose(): void }
type ReviewsControlOptions = {
  context: ReviewsSurfaceProps['context']
  surface: string
  slot: string
  owner: ReviewContext | null
  session: string
  active: boolean
  actions(): ReviewsControlAction[]
  run(request: ReviewsUiControlRequest, isCurrent: () => boolean, accept: (operation: Promise<unknown>) => ReviewsControlAcceptance): void | ReviewsControlAcceptance
  onError?(message: string): void
}

function reviewsControlTarget(surface: string, slot: string, owner: ReviewContext | null, resource: string | null = null): string {
  const repo = owner === null || owner.repo === null
    ? null
    : { host: owner.repo.host, owner: owner.repo.owner, repo: owner.repo.repo }
  return JSON.stringify([
    surface,
    slot,
    owner?.worktree ?? null,
    repo,
    owner?.number ?? null,
    owner?.review?.headRefOid ?? null,
    resource,
  ])
}

function ownerBoundary(owner: ReviewContext | null): string {
  return owner === null
    ? 'none'
    : JSON.stringify([owner.worktree, owner.number, owner.generation, owner.repo, owner.review?.headRefOid ?? null])
}

function deliveryError(result: Extract<ReviewsUiControlResult, { delivered: false }>): string {
  if (result.reason === 'disabled') return 'This action is not currently available.'
  if (result.reason === 'unknown-action') return 'This action is no longer supported by the mounted view.'
  return 'This control is no longer available.'
}

function controlValue(request: ReviewsUiControlRequest, allowed: readonly string[]): JsonRecord {
  if (request.value === undefined) return {}
  if (!isRecord(request.value) || Object.keys(request.value).some((key) => !allowed.includes(key))) {
    throw new Error('Invalid Reviews control arguments.')
  }
  return request.value
}

function requireNoControlValue(request: ReviewsUiControlRequest): void {
  if (request.value !== undefined && Object.keys(request.value).length > 0) {
    throw new Error('This Reviews control does not accept arguments.')
  }
}

function useReviewsControl(options: ReviewsControlOptions) {
  const target = reviewsControlTarget(options.surface, options.slot, options.owner)
  const identity = `${ownerBoundary(options.owner)}|${options.session}`
  const actionsRef = useRef(options.actions)
  const runRef = useRef(options.run)
  const errorRef = useRef(options.onError)
  useLayoutEffect(() => {
    actionsRef.current = options.actions
    runRef.current = options.run
    errorRef.current = options.onError
  })
  const registrationRef = useRef<ReviewsControlLease | null>(null)
  const [reported, setReported] = useState<{ target: string; generation: number } | null>(null)
  const actionsKey = JSON.stringify(options.actions())

  useLayoutEffect(() => {
    if (!options.active) {
      registrationRef.current = null
      setReported(null)
      return
    }
    const registration = registerReviewsUiControl(options.context, {
      surface: options.surface,
      slot: options.slot,
      target,
      actions: () => actionsRef.current(),
      run: (request, isCurrent) => {
        try {
          return runRef.current(request, isCurrent, (operation) => {
            void operation.catch((error) => {
              if (isCurrent()) errorRef.current?.(errorText(error))
            })
            return { accepted: true }
          })
        } catch (error) {
          if (isCurrent()) errorRef.current?.(errorText(error))
          throw error
        }
      },
    })
    const lease = { target, identity, generation: registration.generation, changed: registration.changed, dispose: registration.dispose }
    registrationRef.current = lease
    setReported({ target, generation: registration.generation })
    return () => {
      registration.dispose()
      if (registrationRef.current === lease) registrationRef.current = null
    }
  }, [options.active, options.context, options.slot, options.surface, target, identity])

  useEffect(() => {
    const lease = registrationRef.current
    if (options.active && lease?.target === target) lease.changed()
  }, [actionsKey, options.active, target])

  async function request(action: string, value?: Record<string, unknown>): Promise<ReviewsUiControlResult | null> {
    const lease = registrationRef.current
    const generation = reported?.target === target ? reported.generation : null
    if (!options.active || lease === null || lease.target !== target || lease.identity !== identity
      || generation === null || lease.generation !== generation) return null
    try {
      const result = await requestReviewsUiControl(options.context, {
        target,
        generation,
        action,
        ...(value === undefined ? {} : { value }),
      })
      if (!result.delivered && registrationRef.current === lease) errorRef.current?.(deliveryError(result))
      return result
    } catch (error) {
      if (registrationRef.current === lease) errorRef.current?.(errorText(error))
      return null
    }
  }

  const currentLease = registrationRef.current
  const generation = reported !== null && options.active && reported.target === target
    && currentLease !== null && currentLease.identity === identity && currentLease.generation === reported.generation
    ? reported.generation
    : undefined
  return {
    target,
    generation,
    request,
  }
}

function AssignmentPanels(props: { context: ReviewsSurfaceProps['context']; state: ReviewsSurfaceProps['state']; owner: ReviewContext }) {
  const { context, state, owner } = props
  const review = owner.review
  const details = owner.surface === 'detail' ? state.detail.details : null
  const item = itemDetails(details)
  const assignees = listOfLogins(review?.assignees ?? item?.assignees)
  const reviewers = reviewerList(review, details)
  const reviews = reviewedBy(details, review)
  const identity = ownerBoundary(owner)
  const identityRef = useRef(identity)
  identityRef.current = identity
  const ownerGuard = useTargetGuard(identity)
  const [assigneeOpen, setAssigneeOpen] = useState(false)
  const [reviewerOpen, setReviewerOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [reviewerText, setReviewerText] = useState('')
  const [selectedAssignees, setSelectedAssignees] = useState<string[]>([])
  const [assigneeSession, setAssigneeSession] = useState(0)
  const [reviewerSession, setReviewerSession] = useState(0)
  const assigneeSessionRef = useRef(assigneeSession)
  const reviewerSessionRef = useRef(reviewerSession)
  assigneeSessionRef.current = assigneeSession
  reviewerSessionRef.current = reviewerSession
  const [catalog, setCatalog] = useState<{
    status: 'idle' | 'loading' | 'ready' | 'error'
    options: UserOption[]
    error: string | null
  }>({ status: 'idle', options: [], error: null })
  const [catalogRetry, setCatalogRetry] = useState(0)
  const catalogRequest = useRef(0)
  const [writeError, setWriteError] = useState<string | null>(null)
  const [pendingId, setPendingId] = useState<number | null>(null)
  const pendingRef = useRef<{ id: number; identity: string } | null>(null)
  const writeGeneration = useRef(0)
  const previousIdentity = useRef(identity)
  const pending = pendingId !== null || pendingRef.current !== null
  const target = {
    surface: owner.surface,
    worktree: owner.worktree,
    number: owner.number,
    ...(owner.repo === null ? {} : { prRepo: owner.repo }),
  }
  const requestReviewers = splitReviewers(reviewerText)
  const filteredSuggestions = catalog.options
    .filter((option) => option.login.toLowerCase().startsWith(query.toLowerCase()))
    .slice(0, 100)
  const assignmentError = (logins: unknown): string | null => {
    if (!Array.isArray(logins) || !logins.every((login) => typeof login === 'string')) return 'Assignee logins must be text.'
    const unique = [...new Set(logins)]
    if (unique.length > 100) return 'Assignees are limited to 100 users.'
    if (unique.some((login) => login.trim() === '' || login.length > 256)) return 'Assignee logins must be 1 to 256 characters.'
    return null
  }
  const normalizeAssignees = (logins: unknown): string[] => {
    if (!Array.isArray(logins) || !logins.every((login): login is string => typeof login === 'string')) {
      throw new Error('Assignee logins must be text.')
    }
    const unique = [...new Set(logins)]
    const error = assignmentError(unique)
    if (error !== null) throw new Error(error)
    return unique
  }
  const allowedAssignee = (login: string) =>
    login.length > 0 && login.length <= 256 && login.trim() !== ''
    && (assignees?.includes(login) === true || catalog.options.some((option) => option.login === login))

  useLayoutEffect(() => {
    if (previousIdentity.current === identity) return
    previousIdentity.current = identity
    catalogRequest.current += 1
    assigneeSessionRef.current += 1
    reviewerSessionRef.current += 1
    setAssigneeSession(assigneeSessionRef.current)
    setReviewerSession(reviewerSessionRef.current)
    setAssigneeOpen(false)
    setReviewerOpen(false)
    setQuery('')
    setReviewerText('')
    setSelectedAssignees([])
    setCatalog({ status: 'idle', options: [], error: null })
    setWriteError(null)
    if (pendingRef.current?.identity !== identity) {
      pendingRef.current = null
      setPendingId(null)
    }
  }, [identity])

  useEffect(() => {
    const request = ++catalogRequest.current
    if (!assigneeOpen && !reviewerOpen) {
      setCatalog({ status: 'idle', options: [], error: null })
      return () => {
        if (catalogRequest.current === request) catalogRequest.current += 1
      }
    }
    const ownerIsCurrent = ownerGuard()
    const session = `${assigneeSessionRef.current}:${reviewerSessionRef.current}`
    setCatalog({ status: 'loading', options: [], error: null })
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const value = await context.call('quirky.hosting/assignees', { worktree: owner.worktree, query })
          if (request !== catalogRequest.current || !ownerIsCurrent() || identityRef.current !== identity
            || session !== `${assigneeSessionRef.current}:${reviewerSessionRef.current}`) return
          const parsed = assignableOptions(value)
          if (parsed === null) {
            setCatalog({ status: 'error', options: [], error: 'The hosting API returned invalid reviewer suggestions.' })
            return
          }
          setCatalog({ status: 'ready', options: parsed.slice(0, 100), error: null })
        } catch (error) {
          if (request === catalogRequest.current && ownerIsCurrent() && identityRef.current === identity
            && session === `${assigneeSessionRef.current}:${reviewerSessionRef.current}`) {
            setCatalog({ status: 'error', options: [], error: errorText(error) })
          }
        }
      })()
    }, 120)
    return () => {
      clearTimeout(timer)
      if (catalogRequest.current === request) catalogRequest.current += 1
    }
  }, [assigneeOpen, reviewerOpen, query, context, owner.worktree, identity, catalogRetry])

  const writeAssignees = (logins: string[], stillCurrent: () => boolean): Promise<unknown> => {
    if (pendingRef.current !== null) throw new Error('An assignment change is already in progress.')
    const token = { id: ++writeGeneration.current, identity }
    pendingRef.current = token
    setPendingId(token.id)
    setWriteError(null)
    return (async () => {
      try {
        const result = await context.call('quirky.reviews/detailUpdateAssignees', {
          ...target,
          action: 'set',
          logins,
        })
        if (stillCurrent() && pendingRef.current === token) {
          setAssigneeOpen(false)
          assigneeSessionRef.current += 1
          setAssigneeSession(assigneeSessionRef.current)
          setSelectedAssignees([])
        }
        return result
      } catch (error) {
        if (stillCurrent() && pendingRef.current === token) setWriteError(errorText(error))
        throw error
      } finally {
        if (pendingRef.current === token) {
          pendingRef.current = null
          setPendingId(null)
        }
      }
    })()
  }

  const writeReviewers = (action: 'add' | 'remove', logins: string[], stillCurrent: () => boolean): Promise<unknown> => {
    if (pendingRef.current !== null) throw new Error('An assignment change is already in progress.')
    if (logins.length === 0) throw new Error('Enter at least one reviewer.')
    const token = { id: ++writeGeneration.current, identity }
    pendingRef.current = token
    setPendingId(token.id)
    setWriteError(null)
    return (async () => {
      try {
        const result = await context.call('quirky.reviews/detailUpdateReviewers', {
          ...target,
          action,
          logins,
        })
        if (stillCurrent() && pendingRef.current === token && action === 'add') {
          setReviewerText('')
          setReviewerOpen(false)
          reviewerSessionRef.current += 1
          setReviewerSession(reviewerSessionRef.current)
        }
        return result
      } catch (error) {
        if (stillCurrent() && pendingRef.current === token) setWriteError(errorText(error))
        throw error
      } finally {
        if (pendingRef.current === token) {
          pendingRef.current = null
          setPendingId(null)
        }
      }
    })()
  }

  const currentOwner = (isCurrent: () => boolean) => {
    const guard = ownerGuard()
    return () => isCurrent() && guard() && identityRef.current === identity
  }

  const assignmentsControl = useReviewsControl({
    context,
    surface: 'view:quirky.reviews/review',
    slot: 'assignments',
    owner,
    session: 'assignments',
    active: true,
    actions: () => [
      { action: 'assignees-open', enabled: !pending && assignees !== null && !assigneeOpen },
      { action: 'reviewers-open', enabled: !pending && !reviewerOpen },
      { action: 'reviewer-remove', enabled: !pending && (reviewers?.length ?? 0) > 0 },
    ],
    run: (request, isCurrent, accept) => {
      const value = controlValue(request, request.action === 'reviewer-remove' ? ['login'] : [])
      const current = currentOwner(isCurrent)
      if (!current()) return
      if (request.action === 'assignees-open') {
        if (assignees === null) throw new Error('Assignee data is unavailable.')
        setSelectedAssignees(assignees)
        setQuery('')
        setWriteError(null)
        setCatalog({ status: 'loading', options: [], error: null })
        assigneeSessionRef.current += 1
        setAssigneeSession(assigneeSessionRef.current)
        setAssigneeOpen(true)
        return
      }
      if (request.action === 'reviewers-open') {
        setQuery('')
        setWriteError(null)
        setCatalog({ status: 'loading', options: [], error: null })
        reviewerSessionRef.current += 1
        setReviewerSession(reviewerSessionRef.current)
        setReviewerOpen(true)
        return
      }
      if (request.action === 'reviewer-remove') {
        const login = value.login
        if (typeof login !== 'string' || !reviewers?.includes(login)) {
          throw new Error('That reviewer is no longer requested.')
        }
        return accept(writeReviewers('remove', [login], current))
      }
      throw new Error('Unknown assignment control.')
    },
    onError: setWriteError,
  })

  const assigneeControl = useReviewsControl({
    context,
    surface: 'view:quirky.reviews/review',
    slot: 'assignee-form',
    owner,
    session: String(assigneeSession),
    active: assigneeOpen,
    actions: () => [
      { action: 'assignees-close', enabled: !pending },
      { action: 'assignees-retry', enabled: catalog.status === 'error' },
      { action: 'assignee-select', enabled: !pending },
      { action: 'assignees-save', enabled: !pending && assignees !== null && assignmentError(selectedAssignees) === null },
    ],
    run: (request, isCurrent, accept) => {
      const current = currentOwner(isCurrent)
      const session = assigneeSession
      const sessionIsCurrent = () => current() && assigneeSessionRef.current === session
      if (!sessionIsCurrent()) return
      if (request.action === 'assignees-close') {
        requireNoControlValue(request)
        setAssigneeOpen(false)
        assigneeSessionRef.current += 1
        setAssigneeSession(assigneeSessionRef.current)
        if (!reviewerOpen) setCatalog({ status: 'idle', options: [], error: null })
        return
      }
      if (request.action === 'assignees-retry') {
        requireNoControlValue(request)
        setCatalog({ status: 'loading', options: [], error: null })
        setCatalogRetry((retry) => retry + 1)
        return
      }
      if (request.action === 'assignee-select') {
        const value = controlValue(request, ['login', 'selected'])
        if (typeof value.login !== 'string' || typeof value.selected !== 'boolean'
          || !allowedAssignee(value.login) || !sessionIsCurrent()) {
          throw new Error('Choose a current assigned user or suggestion.')
        }
        const login = value.login
        setSelectedAssignees((selected) => {
          const next = value.selected
            ? [...new Set([...selected, login])]
            : selected.filter((currentLogin) => currentLogin !== login)
          if (assignmentError(next) !== null) return selected
          return next
        })
        return
      }
      if (request.action === 'assignees-save') {
        const value = controlValue(request, ['logins'])
        const explicit = Object.hasOwn(value, 'logins')
        const selected = explicit ? normalizeAssignees(value.logins) : normalizeAssignees(selectedAssignees)
        if (assignees === null) throw new Error('Assignee data is unavailable.')
        if (explicit && selected.some((login) => !allowedAssignee(login))) {
          throw new Error('Choose only current assignees or assignable users.')
        }
        if (!sessionIsCurrent()) return
        if (explicit) setSelectedAssignees(selected)
        return accept(writeAssignees(selected, sessionIsCurrent))
      }
      throw new Error('Unknown assignee form control.')
    },
    onError: setWriteError,
  })

  const reviewerControl = useReviewsControl({
    context,
    surface: 'view:quirky.reviews/review',
    slot: 'reviewer-form',
    owner,
    session: String(reviewerSession),
    active: reviewerOpen,
    actions: () => [
      { action: 'reviewers-close', enabled: !pending },
      { action: 'reviewers-retry', enabled: catalog.status === 'error' },
      { action: 'reviewer-select', enabled: !pending && catalog.status === 'ready' && filteredSuggestions.length > 0 },
      { action: 'reviewers-add', enabled: !pending },
    ],
    run: (request, isCurrent, accept) => {
      const current = currentOwner(isCurrent)
      const session = reviewerSession
      const sessionIsCurrent = () => current() && reviewerSessionRef.current === session
      if (!sessionIsCurrent()) return
      if (request.action === 'reviewers-close') {
        requireNoControlValue(request)
        setReviewerOpen(false)
        reviewerSessionRef.current += 1
        setReviewerSession(reviewerSessionRef.current)
        setReviewerText('')
        if (!assigneeOpen) setCatalog({ status: 'idle', options: [], error: null })
        return
      }
      if (request.action === 'reviewers-retry') {
        requireNoControlValue(request)
        setCatalog({ status: 'loading', options: [], error: null })
        setCatalogRetry((retry) => retry + 1)
        return
      }
      if (request.action === 'reviewer-select') {
        const value = controlValue(request, ['login'])
        if (typeof value.login !== 'string'
          || !filteredSuggestions.some((option) => option.login === value.login)
          || !sessionIsCurrent()) throw new Error('Choose a current reviewer suggestion.')
        const logins = [...new Set([...requestReviewers.logins, value.login])]
        setReviewerText(logins.map((login) => `@${login}`).join(', '))
        return
      }
      if (request.action === 'reviewers-add') {
        const value = controlValue(request, ['text'])
        const text = Object.hasOwn(value, 'text') ? value.text : reviewerText
        if (typeof text !== 'string') throw new Error('Reviewer text must be a string.')
        if (Object.hasOwn(value, 'text')) setReviewerText(text)
        const parsed = splitReviewers(text)
        if (parsed.error !== null) throw new Error(parsed.error)
        if (parsed.logins.length === 0) throw new Error('Enter at least one reviewer.')
        if (!sessionIsCurrent()) return
        return accept(writeReviewers('add', parsed.logins, sessionIsCurrent))
      }
      throw new Error('Unknown reviewer form control.')
    },
    onError: setWriteError,
  })

  const reviewStatus = reviews === null
    ? null
    : reviews.length === 0 ? 'No reviews submitted yet.' : reviews.map((entry) => `${entry.author ?? 'Unknown reviewer'}: ${entry.state}`).join(' · ')
  const selectedAssigneeError = assignmentError(selectedAssignees)

  return <div
    className="ui-stack"
    data-review-control-target={assignmentsControl.target}
    data-review-control-generation={assignmentsControl.generation}
  >
    <section className="ui-stack" aria-label="Assignees">
      <SectionHeader title="Assignees" actions={<Button disabled={assignees === null || pending || assigneeOpen} onClick={() => { void assignmentsControl.request('assignees-open') }}>Edit assignees</Button>} />
      {assignees === null ? <InlineError message="Assignee data is unavailable." /> : assignees.length === 0 ? <EmptyState message="No one assigned." /> : <ul className="ui-stack" style={{ listStyle: 'none', padding: 0 }}>
        {assignees.map((login) => <li key={login}><ListRow title={login} /></li>)}
      </ul>}
      {assigneeOpen ? <div
        className="ui-stack"
        data-review-control-target={assigneeControl.target}
        data-review-control-generation={assigneeControl.generation}
      >
        <TextField label="Find assignable users" value={query} onChange={(event) => setQuery(event.currentTarget.value)} />
        {catalog.status === 'loading' ? <NoticeLine>Finding assignable users…</NoticeLine> : null}
        {catalog.error ? <InlineError message={catalog.error} action={{ label: 'Retry', onAction: () => { void assigneeControl.request('assignees-retry') } }} /> : null}
        {catalog.status === 'ready' && filteredSuggestions.length === 0 ? <EmptyState message="No matching assignable users." /> : null}
        <ul className="ui-stack" style={{ listStyle: 'none', padding: 0 }}>{filteredSuggestions.map((option) => <li key={option.login}>
          <FormRow label={option.login} htmlFor={`review-assignee-${option.login}`}>
            <input
              id={`review-assignee-${option.login}`}
              type="checkbox"
              style={{ accentColor: 'var(--ui-accent)' }}
              checked={selectedAssignees.includes(option.login)}
              disabled={pending || !allowedAssignee(option.login)}
              onChange={(event) => setSelectedAssignees((selected) => {
                const next = event.currentTarget.checked
                  ? [...new Set([...selected, option.login])]
                  : selected.filter((login) => login !== option.login)
                return assignmentError(next) === null ? next : selected
              })}
            />
          </FormRow>
        </li>)}</ul>
        {selectedAssigneeError !== null ? <InlineError message={selectedAssigneeError} /> : null}
        <div className="ui-cluster">
          <Button disabled={pending || selectedAssigneeError !== null} onClick={() => { void assigneeControl.request('assignees-save') }}>{pending ? 'Saving…' : 'Save assignees'}</Button>
          <Button disabled={pending} onClick={() => { void assigneeControl.request('assignees-close') }}>Done</Button>
        </div>
      </div> : null}
    </section>
    <section className="ui-stack" aria-label="Reviewers">
      <SectionHeader title="Reviewers" actions={<Button disabled={pending || reviewerOpen} onClick={() => { void assignmentsControl.request('reviewers-open') }}>Request reviewers</Button>} />
      {reviewers === null ? <InlineError message="Requested reviewer data is unavailable." /> : reviewers.length === 0 ? <EmptyState message="No reviewers requested." /> : <ul className="ui-stack" style={{ listStyle: 'none', padding: 0 }}>
        {reviewers.map((login) => <li key={login}><ListRow title={login} trailing={<Button disabled={pending} aria-label={`Unrequest reviewer ${login}`} onClick={() => { void assignmentsControl.request('reviewer-remove', { login }) }}>Remove</Button>} /></li>)}
      </ul>}
      {reviews === null ? <InlineError message="Review status is unavailable." /> : reviews.length === 0 ? <EmptyState message={reviewStatus ?? 'No reviews submitted yet.'} /> : <p className="ui-text-muted">{reviewStatus}</p>}
      {reviewerOpen ? <div
        className="ui-stack"
        data-review-control-target={reviewerControl.target}
        data-review-control-generation={reviewerControl.generation}
      >
        <TextField label="Type or choose a user" value={reviewerText} onChange={(event) => setReviewerText(event.currentTarget.value)} />
        {requestReviewers.error ? <InlineError message={requestReviewers.error} /> : null}
        {catalog.status === 'loading' ? <NoticeLine>Finding assignable users…</NoticeLine> : null}
        {catalog.error ? <InlineError message={catalog.error} action={{ label: 'Retry', onAction: () => { void reviewerControl.request('reviewers-retry') } }} /> : null}
        {catalog.status === 'ready' && filteredSuggestions.length === 0 ? <EmptyState message="No matching assignable users." /> : null}
        <ul className="ui-stack" style={{ listStyle: 'none', padding: 0 }}>{filteredSuggestions.slice(0, 8).map((option) => <li key={option.login}>
          <Button onClick={() => { void reviewerControl.request('reviewer-select', { login: option.login }) }}>@{option.login}</Button>
        </li>)}</ul>
        <div className="ui-cluster">
          <Button disabled={pending || requestReviewers.error !== null || requestReviewers.logins.length === 0} onClick={() => { void reviewerControl.request('reviewers-add') }}>{pending ? 'Requesting…' : 'Request reviewers'}</Button>
          <Button disabled={pending} onClick={() => { void reviewerControl.request('reviewers-close') }}>Done</Button>
        </div>
      </div> : null}
    </section>
    {writeError ? <InlineError message={writeError} /> : null}
  </div>
}

export function ReviewPage(props: ReviewsSurfaceProps) {
  const routing = useReviewLinkRouting(props.context)
  const owner = reviewContext(props.state, 'detail')
  const review = props.state.detail.review
  const detail = props.state.detail
  const url = review === null ? null : safeHttpUrl(review.url)
  const repo = targetRepo(detail.target, review, owner?.repo ?? null)
  const identity = ownerBoundary(owner)
  const identityRef = useRef(identity)
  identityRef.current = identity
  const ownerRef = useRef(owner)
  ownerRef.current = owner
  const urlRef = useRef(url)
  urlRef.current = url
  const repoRef = useRef(repo)
  repoRef.current = repo
  const detailRef = useRef(detail)
  detailRef.current = detail
  const ownerGuard = useTargetGuard(identity)
  const [workspace, setWorkspace] = useState<WorkspaceUi>({ status: 'loading', link: null, error: null })
  const workspaceRef = useRef(workspace)
  workspaceRef.current = workspace
  const [workspaceBusyId, setWorkspaceBusyId] = useState<number | null>(null)
  const workspaceOperation = useRef<{ id: number; identity: string } | null>(null)
  const workspaceRequest = useRef(0)
  const workspaceGeneration = useRef(0)
  const workspaceBusy = workspaceBusyId !== null && workspaceOperation.current?.identity === identity
  const [pageError, setPageError] = useState<string | null>(null)
  const [pendingPageActions, setPendingPageActions] = useState<string[]>([])
  const pendingPageActionsRef = useRef(new Set<string>())
  const pageActionPending = (action: string) =>
    pendingPageActions.includes(action) || pendingPageActionsRef.current.has(action)
  const releasePageAction = (action: string) => {
    if (pendingPageActionsRef.current.delete(action)) {
      setPendingPageActions([...pendingPageActionsRef.current])
    }
  }
  const ownPageOperation = (action: string, start: () => Promise<unknown>): Promise<unknown> => {
    if (pendingPageActionsRef.current.has(action)) throw new Error('This action is already in progress.')
    pendingPageActionsRef.current.add(action)
    setPendingPageActions([...pendingPageActionsRef.current])
    let operation: Promise<unknown>
    try {
      operation = start()
    } catch (error) {
      releasePageAction(action)
      throw error
    }
    return operation.finally(() => releasePageAction(action))
  }
  const [bodyEditing, setBodyEditing] = useState(false)
  const [bodySaveError, setBodySaveError] = useState<string | null>(null)
  const [bodySession, setBodySession] = useState(0)
  const bodySessionRef = useRef(bodySession)
  bodySessionRef.current = bodySession
  const bodyOperation = useRef<{ id: number; identity: string; session: number } | null>(null)
  const bodyGeneration = useRef(0)
  const [bodyBusy, setBodyBusy] = useState<{ id: number; identity: string; session: number } | null>(null)
  const bodySaveAction = useRef<DraftAction<string | null> | null>(null)
  const bodyIdentity = identity
  const bodyGuard = useTargetGuard(bodyIdentity)
  const [bodyVersions] = useState(() => createDraftVersions())
  const bodyField = useDraftField<string | null>({
    identity: bodyIdentity,
    remote: detail.bodyDraft,
    snapshot: props.snapshot,
    write: async (value) => {
      if (owner === null) return false
      const isCurrent = bodyGuard()
      const params = {
        worktree: owner.worktree,
        number: owner.number,
        generation: owner.generation,
        ...(owner.repo === null ? {} : { prRepo: owner.repo }),
        body: value,
      }
      const first = await props.context.call('quirky.reviews/detailSetBodyDraft', {
        ...params,
        draftVersion: bodyVersions.next(),
      })
      if (!isCurrent() || identityRef.current !== bodyIdentity) return false
      if (isRecord(first) && first.applied === false) {
        bodyVersions.rebase()
        const retry = await props.context.call('quirky.reviews/detailSetBodyDraft', {
          ...params,
          draftVersion: bodyVersions.next(),
        })
        if (!isCurrent() || identityRef.current !== bodyIdentity) return false
        return isRecord(retry) && typeof retry.applied === 'boolean' ? retry.applied : undefined
      }
      return isRecord(first) && typeof first.applied === 'boolean' ? first.applied : undefined
    },
    refresh: props.refresh,
    resend: true,
  })
  const canEditBody = itemDetails(detail.details)?.viewerCanUpdate === true
  const bodyBusyForSession = (bodyBusy?.identity === identity && bodyBusy.session === bodySession)
    || (bodyOperation.current?.identity === identity && bodyOperation.current.session === bodySession)
  const previousIdentity = useRef(identity)

  useLayoutEffect(() => {
    if (previousIdentity.current === identity) return
    previousIdentity.current = identity
    workspaceRequest.current += 1
    if (workspaceOperation.current?.identity !== identity) {
      workspaceOperation.current = null
      setWorkspaceBusyId(null)
    }
    if (bodyOperation.current?.identity !== identity) {
      bodyOperation.current = null
      bodySaveAction.current = null
      setBodyBusy(null)
    }
    bodySessionRef.current += 1
    setBodySession(bodySessionRef.current)
    setBodyEditing(false)
    setBodySaveError(null)
    setPageError(null)
    setWorkspace({ status: 'loading', link: null, error: null })
  }, [identity])

  useEffect(() => {
    if (owner === null || !identity
      || (review !== null && detail.fetchedAt > 0 && Date.now() - detail.fetchedAt < 30_000)) return
    void props.context.call('quirky.reviews/detailRefresh', {
      surface: 'detail',
      worktree: owner.worktree,
      number: owner.number,
      ...(owner.repo === null ? {} : { prRepo: owner.repo }),
    }).catch(() => undefined)
  }, [props.context, identity])

  const loadWorkspaceRef = useRef<(isCurrent?: () => boolean) => Promise<void>>(async () => {})
  loadWorkspaceRef.current = (isCurrent = () => true) => {
    const currentOwner = ownerRef.current
    const currentUrl = urlRef.current
    const currentIdentity = identityRef.current
    const ownerIsCurrent = ownerGuard()
    const request = ++workspaceRequest.current
    if (currentOwner === null || currentUrl === null) {
      setWorkspace({
        status: currentOwner === null ? 'loading' : 'error',
        link: null,
        error: currentOwner === null ? null : 'The pull request URL is unavailable.',
      })
      return Promise.resolve()
    }
    setWorkspace({ status: 'loading', link: null, error: null })
    let operation: Promise<unknown>
    try {
      operation = props.context.call('quirky.tasks/state')
    } catch (error) {
      if (isCurrent() && ownerIsCurrent() && request === workspaceRequest.current
        && identityRef.current === currentIdentity) {
        setWorkspace({ status: 'error', link: null, error: errorText(error) })
      }
      return Promise.resolve()
    }
    return operation.then((value) => {
      if (!isCurrent() || !ownerIsCurrent() || request !== workspaceRequest.current
        || identityRef.current !== currentIdentity) return
      if (!isRecord(value)) throw new Error('Tasks state is unavailable; workspace attachment cannot be verified.')
      setWorkspace({ status: 'ready', link: workspaceLinkFor(value, currentUrl), error: null })
    }).catch((error) => {
      if (isCurrent() && ownerIsCurrent() && request === workspaceRequest.current
        && identityRef.current === currentIdentity) {
        setWorkspace({ status: 'error', link: null, error: errorText(error) })
      }
    })
  }

  useEffect(() => {
    void loadWorkspaceRef.current()
    return () => { workspaceRequest.current += 1 }
  }, [props.context, identity, url])

  const currentWorkspaceTarget = () => {
    const currentOwner = ownerRef.current
    const currentUrl = urlRef.current
    const currentRepo = repoRef.current
    if (currentOwner === null) return null
    return {
      worktree: currentOwner.worktree,
      kind: 'pullRequest' as const,
      number: currentOwner.number,
      ...(currentUrl === null ? {} : { url: currentUrl }),
      ...(currentRepo === null ? {} : {
        host: currentRepo.host,
        owner: currentRepo.owner,
        repo: currentRepo.repo,
      }),
    }
  }

  const openWorkspace = (action: 'start' | 'resume', newWorkspace: boolean, isCurrent: () => boolean): Promise<unknown> => {
    const currentOwner = ownerRef.current
    const currentIdentity = identityRef.current
    const currentWorkspace = workspaceRef.current
    const currentTarget = currentWorkspaceTarget()
    const ownerIsCurrent = ownerGuard()
    if (currentOwner === null || currentTarget === null || currentWorkspace.status !== 'ready') {
      throw new Error('Workspace link status is not ready.')
    }
    if (action === 'resume' && currentWorkspace.link === null) throw new Error('There is no linked workspace to resume.')
    if (action === 'start' && newWorkspace && currentWorkspace.link === null) throw new Error('A new workspace is available only when a workspace is linked.')
    if (action === 'start' && !newWorkspace && currentWorkspace.link !== null) throw new Error('A workspace is already linked.')
    if (workspaceOperation.current?.identity === currentIdentity) throw new Error('A workspace operation is already in progress.')
    const operation = { id: ++workspaceGeneration.current, identity: currentIdentity }
    workspaceOperation.current = operation
    setWorkspaceBusyId(operation.id)
    setPageError(null)
    const stillCurrent = () => isCurrent() && ownerIsCurrent()
      && identityRef.current === currentIdentity && workspaceOperation.current === operation
    return (async () => {
      try {
        const result: unknown = await props.context.call('quirky.tasks/workspace', {
          action,
          target: currentTarget,
          ...(newWorkspace ? { newWorkspace: true } : {}),
        })
        if (!stillCurrent()) return
        if (action === 'start' && (!isRecord(result) || result.kind !== 'composer')) {
          throw new Error('The Tasks API did not open the hosted-review workspace composer.')
        }
        if (action === 'resume') {
          props.context.toast('Workspace resumed', `Activated ${currentWorkspace.link?.name ?? `the workspace for PR #${currentOwner.number}`}.`)
        }
        return result
      } catch (error) {
        if (stillCurrent()) setPageError(errorText(error))
        throw error
      } finally {
        if (workspaceOperation.current === operation) {
          workspaceOperation.current = null
          setWorkspaceBusyId(null)
        }
      }
    })()
  }

  const pageControl = useReviewsControl({
    context: props.context,
    surface: 'view:quirky.reviews/review',
    slot: 'review-page',
    owner,
    session: 'page',
    active: true,
    actions: () => [
      { action: 'back', enabled: owner !== null && !pageActionPending('back') },
      { action: 'refresh', enabled: owner !== null && !detail.loading && !pageActionPending('refresh') },
      { action: 'tab-set', enabled: owner !== null && !pageActionPending('tab-set') },
      { action: 'copy-link', enabled: url !== null && !pageActionPending('copy-link') },
      { action: 'open-link', enabled: owner !== null && url !== null && !pageActionPending('open-link') },
      { action: 'workspace-retry', enabled: owner !== null && url !== null && workspace.status === 'error' && !pageActionPending('workspace-retry') },
      { action: 'workspace-start', enabled: owner !== null && url !== null && workspace.status === 'ready' && workspace.link === null && !workspaceBusy && workspaceOperation.current?.identity !== identity },
      { action: 'workspace-resume', enabled: owner !== null && url !== null && workspace.status === 'ready' && workspace.link !== null && !workspaceBusy && workspaceOperation.current?.identity !== identity },
      { action: 'workspace-start-new', enabled: owner !== null && url !== null && workspace.status === 'ready' && workspace.link !== null && !workspaceBusy && workspaceOperation.current?.identity !== identity },
      { action: 'body-open', enabled: canEditBody && review !== null && !bodyEditing },
    ],
    run: (request, isCurrent, accept) => {
      const ownerIsCurrent = ownerGuard()
      const current = () => isCurrent() && ownerIsCurrent() && identityRef.current === identity
      if (!current()) return
      if (request.action === 'back') {
        requireNoControlValue(request)
        if (ownerRef.current === null) throw new Error('No pull request is selected.')
        return accept(ownPageOperation('back', () =>
          props.context.call('quirky.reviews/close', {}).then((result) => {
            if (current()) setPageError(null)
            return result
          }),
        ))
      }
      if (request.action === 'refresh') {
        requireNoControlValue(request)
        const currentOwner = ownerRef.current
        if (currentOwner === null) throw new Error('No pull request is selected.')
        if (detailRef.current.loading) throw new Error('Pull request details are already loading.')
        return accept(ownPageOperation('refresh', () =>
          props.context.call('quirky.reviews/detailRefresh', {
            surface: 'detail',
            worktree: currentOwner.worktree,
            number: currentOwner.number,
            ...(currentOwner.repo === null ? {} : { prRepo: currentOwner.repo }),
          }).then((result) => {
            if (current()) setPageError(null)
            return result
          }),
        ))
      }
      if (request.action === 'tab-set') {
        const value = controlValue(request, ['tab'])
        if (value.tab !== 'conversation' && value.tab !== 'checks' && value.tab !== 'files') {
          throw new Error('Choose a valid pull request section.')
        }
        const currentOwner = ownerRef.current
        if (currentOwner === null) throw new Error('No pull request is selected.')
        return accept(ownPageOperation('tab-set', () =>
          props.context.call('quirky.reviews/detailSetTab', {
            worktree: currentOwner.worktree,
            number: currentOwner.number,
            ...(currentOwner.repo === null ? {} : { prRepo: currentOwner.repo }),
            tab: value.tab,
          }).then((result) => {
            if (current()) setPageError(null)
            return result
          }),
        ))
      }
      if (request.action === 'copy-link') {
        requireNoControlValue(request)
        const currentUrl = urlRef.current
        if (currentUrl === null) throw new Error('The pull request link is unavailable.')
        return accept(ownPageOperation('copy-link', () =>
          copyReviewsText(currentUrl).then(() => {
            if (current()) {
              setPageError(null)
              props.context.toast('Link copied', currentUrl)
            }
            return { copied: true }
          }),
        ))
      }
      if (request.action === 'open-link') {
        const value = controlValue(request, ['invert'])
        if (Object.hasOwn(value, 'invert') && typeof value.invert !== 'boolean') {
          throw new Error('The link modifier must be a boolean.')
        }
        const currentOwner = ownerRef.current
        const currentUrl = urlRef.current
        if (currentOwner === null || currentUrl === null) throw new Error('The pull request link is unavailable.')
        return accept(ownPageOperation('open-link', () =>
          props.context.call('quirky.reviews/openLink', {
            url: currentUrl,
            worktree: currentOwner.worktree,
            ...(value.invert === true ? { invert: true } : {}),
          }).then((result) => {
            if (current()) setPageError(null)
            return result
          }).catch((error) => {
            if (current()) props.context.toast('Could not open pull request link', errorText(error), { kind: 'error' })
            throw error
          }),
        ))
      }
      if (request.action === 'workspace-retry') {
        requireNoControlValue(request)
        if (workspaceRef.current.status !== 'error') throw new Error('Workspace link status is already available.')
        if (ownerRef.current === null) throw new Error('No pull request is selected.')
        if (urlRef.current === null) throw new Error('The pull request URL is unavailable.')
        setPageError(null)
        return accept(ownPageOperation('workspace-retry', () => loadWorkspaceRef.current(isCurrent)))
      }
      if (request.action === 'workspace-start' || request.action === 'workspace-resume' || request.action === 'workspace-start-new') {
        requireNoControlValue(request)
        return accept(openWorkspace(request.action === 'workspace-resume' ? 'resume' : 'start', request.action === 'workspace-start-new', isCurrent))
      }
      if (request.action === 'body-open') {
        requireNoControlValue(request)
        const currentOwner = ownerRef.current
        if (itemDetails(detailRef.current.details)?.viewerCanUpdate !== true || currentOwner === null || currentOwner.review === null) {
          throw new Error('You cannot edit this pull request description.')
        }
        bodySessionRef.current += 1
        setBodySession(bodySessionRef.current)
        bodyField.edit(currentOwner.review.body ?? '')
        setBodySaveError(null)
        setBodyEditing(true)
        return
      }
      throw new Error('Unknown review page control.')
    },
    onError: setPageError,
  })

  const updateBodyDraft = (value: string | null) => {
    bodyField.edit(value)
    setBodySaveError(null)
  }

  const cancelBody = () => {
    bodySessionRef.current += 1
    setBodySession(bodySessionRef.current)
    setBodyEditing(false)
    setBodySaveError(null)
    bodyField.edit(null)
    const canceled = bodyField.begin()
    canceled.take()
    canceled.succeed(null)
  }

  const saveBody = (isCurrent: () => boolean): Promise<unknown> => {
    const currentOwner = ownerRef.current
    const session = bodySessionRef.current
    if (currentOwner === null || currentOwner.review === null) throw new Error('No pull request is selected.')
    if (itemDetails(detailRef.current.details)?.viewerCanUpdate !== true) {
      throw new Error('You can no longer edit this pull request description.')
    }
    if (bodyOperation.current?.identity === identity && bodyOperation.current.session === session) {
      throw new Error('The description is already being saved.')
    }
    const ownerIsCurrent = bodyGuard()
    const operation = { id: ++bodyGeneration.current, identity, session }
    bodyOperation.current = operation
    setBodyBusy(operation)
    let action: DraftAction<string | null>
    try {
      action = bodyField.begin()
    } catch (error) {
      if (bodyOperation.current === operation) {
        bodyOperation.current = null
        setBodyBusy(null)
      }
      throw error
    }
    bodySaveAction.current = action
    setBodySaveError(null)
    const stillCurrent = () => isCurrent() && ownerIsCurrent()
      && identityRef.current === identity && bodySessionRef.current === session
      && bodyOperation.current === operation
    return (async () => {
      try {
        await bodyField.settled()
        if (!stillCurrent() || action.status() === 'gone') return
        if (itemDetails(detailRef.current.details)?.viewerCanUpdate !== true) {
          throw new Error('You can no longer edit this pull request description.')
        }
        const value = action.take()
        if (value === null) throw new Error('The description draft is unavailable.')
        const latestOwner = ownerRef.current
        if (latestOwner === null || latestOwner.review === null) throw new Error('No pull request is selected.')
        const result = await props.context.call('quirky.reviews/detailUpdateBody', {
          surface: 'detail',
          worktree: latestOwner.worktree,
          number: latestOwner.number,
          ...(latestOwner.repo === null ? {} : { prRepo: latestOwner.repo }),
          body: value,
        })
        if (!stillCurrent() || action.status() === 'gone') return result
        const unchanged = action.status() === 'same'
        action.succeed(null)
        if (unchanged) {
          setBodyEditing(false)
          bodySessionRef.current += 1
          setBodySession(bodySessionRef.current)
        }
        return result
      } catch (error) {
        if (stillCurrent() && action.status() !== 'gone') {
          action.fail()
          setBodySaveError(errorText(error))
        }
        throw error
      } finally {
        if (bodySaveAction.current === action) bodySaveAction.current = null
        if (bodyOperation.current === operation) {
          bodyOperation.current = null
          setBodyBusy(null)
        }
      }
    })()
  }

  const bodyControl = useReviewsControl({
    context: props.context,
    surface: 'view:quirky.reviews/review',
    slot: 'review-body',
    owner,
    session: String(bodySession),
    active: bodyEditing,
    actions: () => [
      { action: 'body-save', enabled: bodyEditing && canEditBody && !bodyBusyForSession },
      { action: 'body-cancel', enabled: bodyEditing },
    ],
    run: (request, isCurrent, accept) => {
      if (request.action === 'body-save') {
        requireNoControlValue(request)
        if (!isCurrent() || bodySessionRef.current !== bodySession) return
        return accept(saveBody(isCurrent))
      }
      if (request.action === 'body-cancel') {
        requireNoControlValue(request)
        if (!isCurrent() || bodySessionRef.current !== bodySession) return
        cancelBody()
        return
      }
      throw new Error('Unknown description control.')
    },
    onError: setBodySaveError,
  })

  const checksCount = isRecord(detail.checks) && Array.isArray(detail.checks.checks) ? detail.checks.checks.length : null
  const filesCount = isRecord(detail.files) && Array.isArray(detail.files.files) ? detail.files.files.length : null
  const commentsCount = isRecord(detail.comments) && Array.isArray(detail.comments.comments) ? detail.comments.comments.length : null
  const body = review?.body ?? ''
  const attached = workspace.link
  const workspaceReady = workspace.status === 'ready' && owner !== null && url !== null
  const workspaceAction = (action: 'start' | 'resume', newWorkspace = false) =>
    pageControl.request(newWorkspace ? 'workspace-start-new' : action === 'resume' ? 'workspace-resume' : 'workspace-start')

  if (owner === null) return <main
    className="ui-stack"
    aria-label="Pull request detail"
    data-review-control-target={pageControl.target}
    data-review-control-generation={pageControl.generation}
  >
    <EmptyState message="No pull request selected. Open a pull request from Tasks or the Checks panel to view its details." />
    {pageError ? <InlineError message={pageError} /> : null}
  </main>

  return <main
    className="ui-stack"
    aria-label="Pull request detail"
    data-review-control-target={pageControl.target}
    data-review-control-generation={pageControl.generation}
  >
    <header className="ui-stack">
      <div className="ui-cluster" style={{ justifyContent: 'space-between' }}>
        <Button onClick={() => { void pageControl.request('back') }}>Back to pull requests</Button>
        <nav className="ui-cluster" aria-label="Pull request repository">
          {repo ? <span>{repo.owner} / {repo.repo}</span> : <span>Repository unavailable</span>}
          <span>#{owner.number}</span>
        </nav>
        <div className="ui-cluster">
          <Button disabled={url === null} onClick={() => { void pageControl.request('copy-link') }}>Copy pull request link</Button>
          <Button
            disabled={url === null}
            title={routing.title}
            onClick={(event) => { void pageControl.request('open-link', { invert: routing.invert(event) }) }}
          >Open on host</Button>
        </div>
      </div>
      {review === null ? <div className="ui-stack">
        <SectionHeader title={`Pull request #${owner.number}`} />
        {detail.loading
          ? <div aria-live="polite"><NoticeLine>Loading pull request…</NoticeLine></div>
          : <InlineError message={detail.error ?? 'Pull request details are unavailable.'} action={{ label: 'Retry', onAction: () => { void pageControl.request('refresh') } }} />}
      </div> : <>
        <div className="ui-cluster" style={{ justifyContent: 'space-between', alignItems: 'start' }}>
          <div className="ui-stack">
            <h1>{review.title} <span>#{review.number}</span></h1>
            <Badge tone={review.state === 'open' ? 'working' : review.state === 'merged' ? 'accent' : 'neutral'}>{review.state === 'open' ? 'Open' : review.state === 'draft' ? 'Draft' : review.state === 'closed' ? 'Closed' : 'Merged'}</Badge>
          </div>
          <div className="ui-cluster">
            <Button
              disabled={!workspaceReady || workspaceBusy}
              onClick={() => { void workspaceAction(attached ? 'resume' : 'start') }}
            >{workspaceBusy ? 'Opening…' : attached ? `Resume workspace · ${attached.name}` : 'Start workspace'}</Button>
            {attached ? <Menu label="Workspace options" items={[{
              id: 'start-new-workspace',
              label: 'Start new workspace',
              disabled: !workspaceReady || workspaceBusy,
              onAction: () => { void workspaceAction('start', true) },
            }]} /> : null}
          </div>
        </div>
        {workspace.status === 'loading' ? <div aria-live="polite"><NoticeLine>Checking linked workspace…</NoticeLine></div> : null}
        {workspace.status === 'error' ? <InlineError
          message={`Workspace link status unavailable: ${workspace.error ?? 'Workspace attachment could not be checked.'}. Start and Resume are disabled until the link can be checked.`}
          action={{ label: 'Retry', onAction: () => { void pageControl.request('workspace-retry') } }}
        /> : null}
        <div className="ui-cluster ui-text-muted">
          <span>by {itemAuthor(detail.details) ?? 'Unknown author'}</span>
          <span>{review.baseRefName} ← {review.headRefName}</span>
          {relativeUpdated(itemUpdated(detail.details)) ? <time>{relativeUpdated(itemUpdated(detail.details))}</time> : null}
          {attached ? <span>Workspace: {attached.name}</span> : workspace.status === 'ready' ? <span>No linked workspace</span> : null}
        </div>
      </>}
    </header>

    {review !== null && detail.error ? <InlineError
      message={detail.error}
      action={{ label: 'Retry', onAction: () => { void pageControl.request('refresh') } }}
    /> : null}
    {pageError ? <InlineError message={pageError} /> : null}
    {review === null ? null : <div className="ui-stack">
      <Tabs label="Pull request sections" items={[
        { id: 'conversation', label: `Conversation${commentsCount === null ? '' : ` (${commentsCount})`}` },
        { id: 'checks', label: `Checks${checksCount === null ? '' : ` (${checksCount})`}` },
        { id: 'files', label: `Files changed${filesCount === null ? '' : ` (${filesCount})`}` },
      ]} value={detail.tab} onChange={(tab) => { void pageControl.request('tab-set', { tab }) }} />
      <div className="ui-cluster" style={{ justifyContent: 'flex-end' }}>
        <Button disabled={detail.loading} onClick={() => { void pageControl.request('refresh') }}>
          {detail.loading ? 'Refreshing…' : 'Refresh pull request'}
        </Button>
      </div>
    </div>}

    {review === null ? null : <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)', gap: 'var(--ui-space-16)', alignItems: 'start' }}>
      <div className="ui-stack" style={{ minWidth: 0 }}>
        {detail.tab === 'conversation' ? <>
          <section
            className="ui-stack"
            aria-label="Pull request description"
            data-review-control-target={bodyControl.target}
            data-review-control-generation={bodyControl.generation}
          >
            <SectionHeader title="Description" actions={canEditBody && !bodyEditing
              ? <Button onClick={() => { void pageControl.request('body-open') }}>Edit description</Button>
              : undefined} />
            {bodyEditing ? <div className="ui-stack">
              <MarkdownComposer
                value={bodyField.value ?? body}
                onChange={updateBodyDraft}
                label="Pull request description"
                minRows={8}
                disabled={!canEditBody}
                onSubmit={() => { void bodyControl.request('body-save') }}
              />
              {bodySaveError ?? bodyField.error ? <InlineError message={bodySaveError ?? bodyField.error ?? ''} /> : null}
              <div className="ui-cluster">
                <Button variant="primary" disabled={!canEditBody || bodyBusyForSession} onClick={() => { void bodyControl.request('body-save') }}>
                  {bodyBusyForSession ? 'Saving…' : 'Save description'}
                </Button>
                <Button onClick={() => { void bodyControl.request('body-cancel') }}>Cancel</Button>
              </div>
            </div> : body === '' ? <EmptyState message="No description." /> : <div><Markdown source={body} /></div>}
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
          <Button onClick={() => { void pageControl.request('tab-set', { tab: 'checks' }) }}>Open Checks tab</Button>
        </section>}
      </aside>
    </div>}
  </main>
}