import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createDraftVersions, useDraftField, useTargetGuard, type DraftAction } from '../draft-field'
import { Badge, Button, EmptyState, InlineError, NoticeLine, SectionHeader, Tabs, TextField } from '@quirky/ui'
import { Markdown, MarkdownComposer } from '@quirky/plugin-tasks/markdown'
import type { ReviewsSurfaceProps } from '../contracts'
import { isRecord, parseCommentsResult, reviewContext, safeHttpUrl, type ReviewComment, type ReviewContext } from './data'
import { registerReviewsUiControl, requestReviewsUiControl, type ReviewsUiControlRequest } from '../checks/data'

export type CommentsProps = ReviewsSurfaceProps & { surface: 'detail' | 'checks' }

type CommentThread = { id: string; comments: ReviewComment[]; resolved: boolean | null; updatedAt: number }
type MentionOption = { login: string; avatarUrl: string | null }

const reactionChoices = ['+1', '-1', 'laugh', 'confused', 'heart', 'hooray', 'rocket', 'eyes'] as const
const knownBots = new Set(['qodo', 'coderabbit', 'sonar', 'snyk', 'codecov', 'greptile', 'graphite', 'dependabot', 'renovate', 'github-actions'])

function surfaceData(props: CommentsProps) {
  if (props.surface === 'detail') {
    return {
      review: props.state.detail.review,
      worktree: props.state.detail.target?.worktree ?? null,
      number: props.state.detail.target?.number ?? null,
      value: props.state.detail.comments,
      audience: props.state.detail.audience,
      grouping: props.state.detail.grouping,
      queued: props.state.detail.queuedComments,
      draft: props.state.detail.commentDraft,
      details: props.state.detail.details,
      loading: props.state.detail.loading,
      error: props.state.detail.error,
    }
  }
  return {
    review: props.state.checks.review,
    worktree: props.state.checks.worktree,
    number: props.state.checks.review?.number ?? null,
    value: props.state.checks.comments,
    audience: props.state.checks.audience,
    grouping: props.state.checks.grouping,
    queued: props.state.checks.queuedComments,
    draft: props.state.checks.commentDraft,
    details: null,
    loading: props.state.checks.loading,
    error: props.state.checks.error,
  }
}

function isBotAuthor(comment: ReviewComment, overrides: string[]): boolean {
  if (comment.isBot === true) return true
  const author = comment.author?.trim()
  if (!author) return false
  if (overrides.some((login) => login.toLowerCase() === author.toLowerCase())) return true
  const lower = author.toLowerCase()
  if (knownBots.has(lower) || /\[bot\]$/i.test(author)) return true
  return /(?:bot|automation|actions|renovate|dependabot)/i.test(author)
}

function displayTime(value: string | null): string | null {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function threadKey(comment: ReviewComment): string {
  return comment.threadId ?? `${comment.kind}:${String(comment.id)}`
}

function groupThreads(comments: ReviewComment[]): CommentThread[] {
  const groups = new Map<string, ReviewComment[]>()
  for (const comment of comments) {
    const key = threadKey(comment)
    const group = groups.get(key)
    if (group) group.push(comment)
    else groups.set(key, [comment])
  }
  return [...groups].map(([id, items]) => {
    items.sort((left, right) => (Date.parse(left.createdAt ?? '') || 0) - (Date.parse(right.createdAt ?? '') || 0))
    const latest = items.at(-1)
    return {
      id,
      comments: items,
      resolved: items.find((comment) => comment.isResolved !== null)?.isResolved ?? null,
      updatedAt: Date.parse(latest?.createdAt ?? '') || 0,
    }
  })
}

function participants(details: unknown): MentionOption[] {
  if (!isRecord(details) || !Array.isArray(details.participants)) return []
  const options: MentionOption[] = []
  for (const participant of details.participants) {
    if (!isRecord(participant) || typeof participant.login !== 'string' || participant.login.trim() === '') continue
    options.push({ login: participant.login, avatarUrl: typeof participant.avatarUrl === 'string' ? participant.avatarUrl : null })
  }
  return options
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function controlValue(request: ReviewsUiControlRequest, keys: string[]): Record<string, unknown> {
  const value = request.value ?? {}
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new Error('Invalid Reviews control arguments.')
  return value
}

function useCommentControl(options: {
  context: ReviewsSurfaceProps['context']
  surface: string
  slot: string
  owner: ReviewContext | null
  identity: string
  session?: string
  active: boolean
  actions(): Array<{ action: string; enabled: boolean }>
  run(request: ReviewsUiControlRequest, isCurrent: () => boolean): unknown | Promise<unknown>
  onError(message: string): void
}) {
  const owner = options.owner
  const repo = owner?.repo
  const target = JSON.stringify([options.surface, options.slot, owner?.worktree ?? null,
    repo ? { host: repo.host, owner: repo.owner, repo: repo.repo } : null,
    owner?.number ?? null, owner?.review?.headRefOid ?? null, null])
  const current = useRef(options)
  const registration = useRef<{ target: string; generation: number; changed(): void; dispose(): void } | null>(null)
  const [reported, setReported] = useState<{ target: string; generation: number } | null>(null)
  useLayoutEffect(() => { current.current = options })
  useLayoutEffect(() => {
    if (!options.active) { setReported(null); return }
    const lease = registerReviewsUiControl(options.context, {
      surface: options.surface, slot: options.slot, target,
      actions: () => current.current.actions(),
      run: async (request, isCurrent) => {
        try { return await current.current.run(request, isCurrent) }
        catch (error) { if (isCurrent()) current.current.onError(errorText(error)); throw error }
      },
    })
    const entry = { target, ...lease }
    registration.current = entry
    setReported({ target, generation: lease.generation })
    return () => { lease.dispose(); if (registration.current === entry) registration.current = null }
  }, [options.active, options.context, options.surface, options.slot, options.identity, options.session, target])
  const actionKey = JSON.stringify(options.actions())
  useEffect(() => { registration.current?.changed() }, [actionKey])
  async function request(action: string, value?: Record<string, unknown>) {
    const lease = registration.current
    if (!lease || lease.target !== target || reported?.generation !== lease.generation) return
    try {
      const result = await requestReviewsUiControl(options.context, {
        target, generation: lease.generation, action, ...(value === undefined ? {} : { value }),
      })
      if (!result.delivered && registration.current === lease) {
        current.current.onError(result.reason === 'disabled' ? 'This action is not currently available.' : 'This control is no longer available.')
      }
      return result
    } catch (error) { if (registration.current === lease) current.current.onError(errorText(error)) }
  }
  return { target, generation: options.active && reported?.target === target ? reported.generation : undefined, request }
}

export function Comments(props: CommentsProps) {
  const owner = reviewContext(props.state, props.surface)
  const data = surfaceData(props)
  const targetParams = owner === null ? null : {
    surface: props.surface, worktree: owner.worktree, number: owner.number,
    ...(owner.repo === null ? {} : { prRepo: owner.repo }),
  }
  const identity = JSON.stringify([props.surface, owner?.worktree, owner?.repo, owner?.number, owner?.generation, owner?.review?.headRefOid])
  const targetGuard = useTargetGuard(identity)
  const parsed = data.value === null || owner === null ? null : parseCommentsResult(data.value, owner.number)
  const comments = parsed?.comments ?? []
  const filtered = useMemo(() => comments.filter((comment) => data.audience === 'all'
    || isBotAuthor(comment, props.state.botOverrides) === (data.audience === 'bots')), [comments, data.audience, props.state.botOverrides])
  const allThreads = useMemo(() => groupThreads(filtered), [filtered])
  const timeline = useMemo(() => [...filtered].sort((left, right) =>
    (Date.parse(left.createdAt ?? '') || 0) - (Date.parse(right.createdAt ?? '') || 0)), [filtered])
  const latest = useRef({ filtered, review: data.review })
  useLayoutEffect(() => { latest.current = { filtered, review: data.review } })
  const [replyTo, setReplyTo] = useState<number | null>(null)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const [composerSession, setComposerSession] = useState(0)
  const [editSession, setEditSession] = useState(0)
  const [imageSession, setImageSession] = useState(0)
  const [pending, setPending] = useState(false)
  const pendingRef = useRef<symbol | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [mentionOptions, setMentionOptions] = useState<MentionOption[]>([])
  const [mentionError, setMentionError] = useState<string | null>(null)
  const [mentionPending, setMentionPending] = useState(false)
  const [imageUrl, setImageUrl] = useState('')
  const [imageInsertOpen, setImageInsertOpen] = useState(false)
  const [imageError, setImageError] = useState<string | null>(null)
  const suggestionRequest = useRef(0)
  const [draftVersions] = useState(() => createDraftVersions())
  const draftField = useDraftField<string>({
    identity, remote: data.draft, snapshot: props.snapshot,
    write: async (value) => {
      if (owner === null || targetParams === null) return false
      const here = targetGuard()
      const base = { ...targetParams, generation: owner.generation, body: value }
      const first = await props.context.call('quirky.reviews/detailSetCommentDraft', { ...base, draftVersion: draftVersions.next() })
      if (!here()) return false
      if (isRecord(first) && first.applied === false) {
        draftVersions.rebase()
        const retry = await props.context.call('quirky.reviews/detailSetCommentDraft', { ...base, draftVersion: draftVersions.next() })
        if (!here()) return false
        return isRecord(retry) && typeof retry.applied === 'boolean' ? retry.applied : undefined
      }
      return isRecord(first) && typeof first.applied === 'boolean' ? first.applied : undefined
    },
    refresh: props.refresh, resend: true,
  })
  const draft = draftField.value
  useLayoutEffect(() => {
    pendingRef.current = null
    setPending(false); setReplyTo(null); setEditingId(null); setEditDraft('')
    setImageInsertOpen(false); setImageUrl(''); setImageError(null); setActionError(null)
    setComposerSession((value) => value + 1); setEditSession((value) => value + 1); setImageSession((value) => value + 1)
  }, [identity])

  const mentionMatch = /(?:^|\s)@([A-Za-z0-9-]*)$/.exec(draft)
  const mentionPrefix = mentionMatch?.[1]?.toLowerCase() ?? null
  const localParticipants = useMemo(() => participants(data.details), [data.details])
  useEffect(() => {
    const request = ++suggestionRequest.current
    const here = targetGuard()
    setMentionError(null)
    if (mentionPrefix === null || owner === null) {
      setMentionOptions([]); setMentionPending(false)
      return () => { suggestionRequest.current++ }
    }
    const combine = (remote: MentionOption[]) => {
      const combined = new Map<string, MentionOption>()
      for (const option of [...localParticipants, ...remote]) {
        if (option.login.toLowerCase().startsWith(mentionPrefix)) combined.set(option.login.toLowerCase(), option)
      }
      return [...combined.values()].slice(0, 8)
    }
    setMentionOptions(combine([])); setMentionPending(true)
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const value = await props.context.call('quirky.hosting/assignees', { worktree: owner.worktree, query: mentionPrefix })
          if (!here() || request !== suggestionRequest.current) return
          if (!isRecord(value) || !Array.isArray(value.assignees)) throw new Error('The hosting API returned invalid mention suggestions.')
          const remote: MentionOption[] = []
          for (const item of value.assignees) {
            if (isRecord(item) && typeof item.login === 'string' && item.login.trim() !== '') remote.push({
              login: item.login, avatarUrl: typeof item.avatarUrl === 'string' ? item.avatarUrl : null,
            })
          }
          setMentionOptions(combine(remote))
        } catch (error) {
          if (here() && request === suggestionRequest.current) { setMentionOptions(combine([])); setMentionError(errorText(error)) }
        } finally { if (here() && request === suggestionRequest.current) setMentionPending(false) }
      })()
    }, 180)
    return () => { clearTimeout(timer); suggestionRequest.current++ }
  }, [mentionPrefix, identity, props.context, localParticipants])

  const setSharedDraft = (value: string) => { draftField.edit(value); setActionError(null) }
  const topLevel = (comment: ReviewComment) => comment.kind === 'issue_comment' && typeof comment.id === 'number'
    && comment.path === null && comment.threadId === null
  const resolveComment = (value: unknown): ReviewComment => {
    if (!isRecord(value) || Object.keys(value).some((key) => !['kind', 'id'].includes(key))
      || typeof value.kind !== 'string' || !['issue_comment', 'review', 'review_comment'].includes(value.kind)
      || !(typeof value.id === 'number' && Number.isSafeInteger(value.id) && value.id > 0 || typeof value.id === 'string' && value.id.length > 0)) {
      throw new Error('Choose a valid current comment.')
    }
    const comment = latest.current.filtered.find((item) => item.kind === value.kind && item.id === value.id)
    if (!comment) throw new Error('This comment is no longer visible. Refresh comments and try again.')
    return comment
  }
  const requireBody = (body: unknown): string => {
    if (typeof body !== 'string' || body.trim() === '') throw new Error('Enter a nonblank comment.')
    if (bytes(body) > 65536) throw new Error('Comment body must be no longer than 64 KiB.')
    return body
  }
  const submit = async (isCurrent: () => boolean) => {
    if (pendingRef.current || targetParams === null || latest.current.review === null || draftField.value.trim() === '') return
    const here = targetGuard()
    const action: DraftAction<string> = draftField.begin()
    const token = Symbol()
    pendingRef.current = token; setPending(true); setActionError(null)
    try {
      await draftField.settled()
      if (!here() || !isCurrent() || pendingRef.current !== token || latest.current.review === null || action.status() === 'gone') { action.fail(); return }
      const body = requireBody(action.take())
      await props.context.call('quirky.reviews/detailPostComment', { ...targetParams, body, ...(replyTo === null ? {} : { replyToId: replyTo }) })
      if (!here() || !isCurrent() || pendingRef.current !== token || action.status() === 'gone') { action.fail(); return }
      action.succeed('', { send: true })
      setReplyTo(null); setComposerSession((value) => value + 1)
      props.context.toast('Comment posted', 'The comment was confirmed by the hosting provider.')
    } catch (error) { action.fail(); throw error }
    finally { if (here() && pendingRef.current === token) { pendingRef.current = null; setPending(false) } }
  }
  const mutate = async (isCurrent: () => boolean, operation: (current: () => boolean) => Promise<void>) => {
    if (pendingRef.current || targetParams === null) return
    const here = targetGuard()
    const token = Symbol()
    pendingRef.current = token; setPending(true); setActionError(null)
    const current = () => here() && isCurrent() && pendingRef.current === token
    try { await operation(current) }
    finally { if (here() && pendingRef.current === token) { pendingRef.current = null; setPending(false) } }
  }
  const surface = props.surface === 'detail' ? 'view:quirky.reviews/review' : 'panel:quirky.reviews/checks'
  const common = { context: props.context, owner, identity, surface, onError: setActionError }
  const commentsControl = useCommentControl({
    ...common, slot: 'comments', active: true,
    actions: () => ['comments-retry', 'audience-set', 'grouping-set', 'reply-open', 'edit-open', 'comment-delete',
      'thread-set', 'queue-set', 'bot-set', 'comment-open', 'queue-send'].map((action) => ({
      action, enabled: action === 'queue-send' ? data.queued.length > 0 : owner !== null
        && !(pending && ['reply-open', 'edit-open', 'comment-delete'].includes(action)),
    })),
    run: async (request, isCurrent) => {
      const allowed: Record<string, string[]> = { 'comments-retry': [], 'audience-set': ['audience'], 'grouping-set': ['grouping'],
        'reply-open': ['comment'], 'edit-open': ['comment'], 'comment-delete': ['comment'], 'thread-set': ['comment', 'resolved'],
        'queue-set': ['comment', 'queued'], 'bot-set': ['comment', 'bot'], 'comment-open': ['comment'], 'queue-send': [] }
      const value = controlValue(request, allowed[request.action] ?? [])
      if (request.action === 'queue-send') {
        if (owner === null) throw new Error('No pull request is selected.')
        await props.context.call('quirky.reviews/checksSetAgentDialog', { surface: props.surface,
          ...(props.surface === 'checks' ? { worktree: owner.worktree } : {}), action: 'comments' })
        return
      }
      if (targetParams === null) return
      if (request.action === 'comments-retry') { await props.context.call('quirky.reviews/detailRefresh', targetParams); return }
      if (request.action === 'audience-set') {
        if (typeof value.audience !== 'string' || !['all', 'humans', 'bots'].includes(value.audience)) throw new Error('Choose a valid comment audience.')
        await props.context.call('quirky.reviews/detailSetAudience', { ...targetParams, audience: value.audience }); return
      }
      if (request.action === 'grouping-set') {
        if (typeof value.grouping !== 'string' || !['grouped', 'timeline'].includes(value.grouping)) throw new Error('Choose a valid comment ordering.')
        await props.context.call('quirky.reviews/detailSetGrouping', { ...targetParams, grouping: value.grouping }); return
      }
      const comment = resolveComment(value.comment)
      if (request.action === 'reply-open') {
        if (comment.kind !== 'review_comment' || typeof comment.id !== 'number') throw new Error('Choose a current review comment to reply to.')
        if (pendingRef.current) return
        setReplyTo(comment.id); setComposerSession((value) => value + 1); return
      }
      if (request.action === 'edit-open') {
        if (!topLevel(comment)) throw new Error('Only top-level issue comments can be edited.')
        if (pendingRef.current) return
        setEditingId(comment.id as number); setEditDraft(comment.body); setEditSession((value) => value + 1); return
      }
      if (request.action === 'comment-delete') {
        if (!topLevel(comment)) throw new Error('Only top-level issue comments can be deleted.')
        await mutate(isCurrent, async (current) => {
          const confirmed = await props.context.confirm({ title: 'Delete comment?',
            body: `This will permanently remove comment #${comment.id} from pull request #${owner!.number}.`, confirmLabel: 'Delete comment' })
          if (!confirmed || !current()) return
          const present = latest.current.filtered.find((item) => item.kind === comment.kind && item.id === comment.id)
          if (!present || !topLevel(present)) return
          await props.context.call('quirky.reviews/detailDeleteComment', { ...targetParams, commentId: present.id, yes: true })
        }); return
      }
      if (request.action === 'thread-set') {
        if (typeof value.resolved !== 'boolean' || !comment.threadId) throw new Error('Choose a current comment thread and resolved state.')
        await props.context.call('quirky.reviews/detailResolveThread', { ...targetParams, threadId: comment.threadId, resolved: value.resolved }); return
      }
      if (request.action === 'queue-set') {
        if (typeof value.queued !== 'boolean') throw new Error('Choose whether to queue this comment.')
        await props.context.call('quirky.reviews/detailQueueComment', { ...targetParams, commentId: comment.threadId ?? String(comment.id), queued: value.queued }); return
      }
      if (request.action === 'bot-set') {
        if (typeof value.bot !== 'boolean' || !comment.author) throw new Error('Choose a comment with an author and bot state.')
        await props.context.call('quirky.reviews/detailSetBotOverride', { author: comment.author, bot: value.bot }); return
      }
      if (request.action === 'comment-open') {
        const url = safeHttpUrl(comment.url)
        if (url === null) throw new Error('This comment has no safe HTTP or HTTPS link.')
        await props.context.call('quirky.reviews/openLink', { url, worktree: owner!.worktree })
      }
    },
  })
  const composerControl = useCommentControl({
    ...common, slot: 'comment-composer', session: String(composerSession), active: owner !== null,
    actions: () => [
      { action: 'comment-send', enabled: !pending && data.review !== null && draft.trim() !== '' },
      { action: 'reply-cancel', enabled: !pending && replyTo !== null },
      { action: 'mention-select', enabled: mentionPrefix !== null },
      { action: 'image-open', enabled: true },
    ],
    run: async (request, isCurrent) => {
      const value = controlValue(request, request.action === 'mention-select' ? ['login'] : [])
      if (request.action === 'comment-send') return submit(isCurrent)
      if (request.action === 'reply-cancel') { if (!pendingRef.current) { setReplyTo(null); setComposerSession((value) => value + 1) }; return }
      if (request.action === 'image-open') { setImageInsertOpen(true); setImageSession((value) => value + 1); return }
      const currentPrefix = /(?:^|\s)@([A-Za-z0-9-]*)$/.exec(draftField.value)?.[1]?.toLowerCase() ?? null
      if (currentPrefix === null || currentPrefix !== mentionPrefix || typeof value.login !== 'string'
        || !mentionOptions.some((option) => option.login === value.login && option.login.toLowerCase().startsWith(currentPrefix))) {
        throw new Error('Choose a current mention suggestion.')
      }
      setSharedDraft(draftField.value.replace(/@[A-Za-z0-9-]*$/, `@${value.login} `)); setMentionOptions([])
    },
  })
  const editControl = useCommentControl({
    ...common, slot: editingId === null ? 'comment-edit' : `comment-edit:issue_comment:${editingId}`,
    session: String(editSession), active: owner !== null && editingId !== null,
    actions: () => [{ action: 'edit-save', enabled: !pending }, { action: 'edit-cancel', enabled: !pending }],
    run: async (request, isCurrent) => {
      const value = controlValue(request, request.action === 'edit-save' ? ['body'] : [])
      if (request.action === 'edit-cancel') { setEditingId(null); setEditDraft(''); setEditSession((value) => value + 1); return }
      const comment = resolveComment({ kind: 'issue_comment', id: editingId })
      if (!topLevel(comment)) throw new Error('Only top-level issue comments can be edited.')
      const body = requireBody(value.body === undefined ? editDraft : value.body)
      if (Object.hasOwn(value, 'body')) setEditDraft(body)
      await mutate(isCurrent, async (current) => {
        await props.context.call('quirky.reviews/detailEditComment', { ...targetParams, commentId: comment.id, body })
        if (current()) { setEditingId(null); setEditDraft(''); setEditSession((value) => value + 1) }
      })
    },
  })
  const imageControl = useCommentControl({
    ...common, slot: 'comment-image', session: `${composerSession}:${imageSession}`, active: owner !== null && imageInsertOpen,
    onError: setImageError,
    actions: () => [{ action: 'image-close', enabled: true }, { action: 'image-insert', enabled: true }],
    run: (request) => {
      const value = controlValue(request, request.action === 'image-insert' ? ['url'] : [])
      if (request.action === 'image-close') { setImageInsertOpen(false); setImageUrl(''); setImageError(null); setImageSession((value) => value + 1); return }
      const input = value.url === undefined ? imageUrl : value.url
      if (typeof input !== 'string') throw new Error('Enter an HTTP or HTTPS image URL.')
      if (bytes(input) > 8192) throw new Error('Image URL must be no longer than 8 KiB.')
      const url = safeHttpUrl(input)
      if (url === null) throw new Error('Enter an HTTP or HTTPS image URL.')
      const current = draftField.value
      setSharedDraft(`${current}${current.endsWith('\n') || current === '' ? '' : '\n'}![image](<${url}>)`)
      setImageUrl(''); setImageError(null)
    },
  })
  const toggleReaction = async (comment: ReviewComment, content: typeof reactionChoices[number]) => {
    if (targetParams === null || comment.reactionSubjectId === null) return
    const here = targetGuard()
    const existing = comment.reactions.find((reaction) => reaction.content === content)
    try { await props.context.call('quirky.reviews/detailReact', { ...targetParams, subjectId: comment.reactionSubjectId, content, add: existing?.viewerHasReacted !== true }) }
    catch (error) { if (here()) setActionError(errorText(error)) }
  }
  const emptyText = data.audience === 'humans' ? 'No human comments.' : data.audience === 'bots' ? 'No bot comments.' : 'No comments yet.'
  const countFor = (audience: 'all' | 'humans' | 'bots') => audience === 'all' ? comments.length
    : comments.filter((comment) => isBotAuthor(comment, props.state.botOverrides) === (audience === 'bots')).length
  const renderComment = (comment: ReviewComment) => {
    const key = { kind: comment.kind, id: comment.id }
    const bot = isBotAuthor(comment, props.state.botOverrides)
    const timestamp = displayTime(comment.createdAt)
    const queueId = comment.threadId ?? String(comment.id)
    const authorIsManuallyMarked = props.state.botOverrides.some((login) => login.toLowerCase() === (comment.author ?? '').toLowerCase())
    return <article className="ui-stack" key={`${comment.kind}:${String(comment.id)}`}>
      <header className="ui-cluster">
        <strong>{comment.author ?? 'Unknown author'}</strong>
        {bot ? <Badge>Bot</Badge> : null}
        {timestamp ? <time dateTime={comment.createdAt ?? undefined} className="ui-text-muted">{timestamp}</time> : null}
        {comment.isOutdated === true ? <Badge tone="needs-you">Outdated thread</Badge> : null}
        {comment.state ? <Badge>{comment.state}</Badge> : null}
      </header>
      {editingId === comment.id && topLevel(comment) ? <div className="ui-stack" data-review-control-target={editControl.target} data-review-control-generation={editControl.generation}>
        <MarkdownComposer value={editDraft} onChange={setEditDraft} label={`Edit comment #${editingId}`} minRows={3} disabled={pending} onSubmit={() => void editControl.request('edit-save')} />
        <div className="ui-cluster">
          <Button variant="primary" disabled={pending || editDraft.trim() === ''} onClick={() => void editControl.request('edit-save')}>Save edit</Button>
          <Button disabled={pending} onClick={() => void editControl.request('edit-cancel')}>Cancel edit</Button>
        </div>
      </div> : <div><Markdown source={comment.body} /></div>}
      <div className="ui-cluster">
        {comment.threadId ? <Button onClick={() => void commentsControl.request('thread-set', { comment: key, resolved: comment.isResolved !== true })}>{comment.isResolved === true ? 'Unresolve' : 'Resolve'}</Button> : null}
        {comment.kind === 'review_comment' && typeof comment.id === 'number' ? <Button disabled={pending} onClick={() => void commentsControl.request('reply-open', { comment: key })}>Reply</Button> : null}
        {safeHttpUrl(comment.url) && owner ? <Button onClick={() => void commentsControl.request('comment-open', { comment: key })}>Go to comment</Button> : null}
        <Button aria-pressed={data.queued.includes(queueId)} onClick={() => void commentsControl.request('queue-set', { comment: key, queued: !data.queued.includes(queueId) })}>{data.queued.includes(queueId) ? 'Unqueue for agent' : 'Queue for agent'}</Button>
        {comment.author ? <Button onClick={() => void commentsControl.request('bot-set', { comment: key, bot: !authorIsManuallyMarked })}>{authorIsManuallyMarked ? 'Unmark author as bot' : 'Mark author as bot'}</Button> : null}
        {topLevel(comment) ? <>
          {editingId === comment.id ? null : <Button disabled={pending} onClick={() => void commentsControl.request('edit-open', { comment: key })}>Edit</Button>}
          <Button variant="destructive" disabled={pending} onClick={() => void commentsControl.request('comment-delete', { comment: key })}>Delete</Button>
        </> : null}
      </div>
    </article>
  }
  const renderThread = (thread: CommentThread) => <section className="ui-stack" key={thread.id}>
    <SectionHeader title={thread.resolved === true ? 'Resolved thread' : 'Needs review'}
      actions={thread.id.startsWith('issue_comment:') || thread.id.startsWith('review:') ? undefined : <Badge>{thread.comments.length} comments</Badge>} />
    {thread.comments.map(renderComment)}
  </section>
  const retry = () => void commentsControl.request('comments-retry')
  const content = owner === null
    ? <EmptyState message="No pull request selected." />
    : data.value !== null && parsed === null
      ? <InlineError message="The comments response is invalid." action={{ label: 'Retry', onAction: retry }} />
      : parsed === null
        ? data.error
          ? <InlineError message={data.error} action={{ label: 'Retry', onAction: retry }} />
          : data.loading
            ? <NoticeLine>Loading comments…</NoticeLine>
            : <EmptyState message="Comments have not been loaded yet." action={{ label: 'Load comments', onAction: retry }} />
        : filtered.length === 0
          ? <EmptyState message={emptyText} />
          : data.grouping === 'timeline'
            ? <div className="ui-stack">{timeline.map(renderComment)}</div>
            : <div className="ui-stack">
              {allThreads.some((thread) => thread.resolved !== true) ? <section className="ui-stack" aria-label="Needs review">
                <SectionHeader title="Needs review" />
                {allThreads.filter((thread) => thread.resolved !== true).sort((left, right) => right.updatedAt - left.updatedAt).map(renderThread)}
              </section> : null}
              {allThreads.some((thread) => thread.resolved === true) ? <section className="ui-stack" aria-label="Resolved">
                <SectionHeader title="Resolved" />
                {allThreads.filter((thread) => thread.resolved === true).sort((left, right) => right.updatedAt - left.updatedAt).map(renderThread)}
              </section> : null}
            </div>
  return <section className="ui-stack" aria-label="Pull request comments" data-review-control-target={commentsControl.target} data-review-control-generation={commentsControl.generation}>
    <SectionHeader title={`Comments${parsed ? ` (${comments.length})` : ''}`} actions={<div className="ui-cluster">
      <Tabs label="Comment audience" items={[
        { id: 'all', label: `All (${countFor('all')})`, disabled: owner === null },
        { id: 'humans', label: `Humans (${countFor('humans')})`, disabled: owner === null },
        { id: 'bots', label: `Bots (${countFor('bots')})`, disabled: owner === null },
      ]} value={data.audience} onChange={(audience) => void commentsControl.request('audience-set', { audience })} />
      <Tabs label="Comment ordering" items={[
        { id: 'grouped', label: 'Grouped', disabled: owner === null },
        { id: 'timeline', label: 'Timeline', disabled: owner === null },
      ]} value={data.grouping} onChange={(grouping) => void commentsControl.request('grouping-set', { grouping })} />
    </div>} />
    {parsed !== null && data.error ? <InlineError message={`${data.error} Showing the last available comments where present.`} action={{ label: 'Retry', onAction: retry }} /> : null}
    {(actionError ?? draftField.error) ? <InlineError message={actionError ?? draftField.error!} /> : null}
    {parsed?.partial === true ? <p role="status" className="ui-text-muted">Showing the first 100 comments per source{parsed.partialFailures.length > 0 ? `; ${parsed.partialFailures.join(' ')}` : '.'}</p> : null}
    {content}
    {owner !== null ? <form className="ui-stack" data-review-control-target={composerControl.target} data-review-control-generation={composerControl.generation}
      onSubmit={(event) => { event.preventDefault(); void composerControl.request('comment-send') }}>
      <label htmlFor={`review-comment-${props.surface}`}>{replyTo === null ? 'Add a comment' : `Reply to comment #${replyTo}`}</label>
      <MarkdownComposer value={draft} onChange={setSharedDraft} label={replyTo === null ? 'Add a comment' : `Reply to comment #${replyTo}`}
        placeholder={replyTo === null ? 'Add a comment…' : 'Write a reply…'} minRows={4} disabled={pending || data.review === null}
        onSubmit={() => void composerControl.request('comment-send')} />
      {mentionPrefix !== null ? <div className="ui-stack" role="listbox" aria-label="Mention suggestions">
        {mentionPending ? <NoticeLine>Finding mention suggestions…</NoticeLine> : null}
        {!mentionPending && !mentionError && mentionOptions.length === 0 ? <EmptyState message="No matching participants." /> : null}
        {mentionOptions.map((option) => <Button key={option.login} role="option" onClick={() => void composerControl.request('mention-select', { login: option.login })}>@{option.login}</Button>)}
        {mentionError ? <InlineError message={`Some repository suggestions could not be loaded: ${mentionError}`} /> : null}
      </div> : null}
      <div className="ui-stack">
        <Button aria-expanded={imageInsertOpen} onClick={() => void (imageInsertOpen ? imageControl.request('image-close') : composerControl.request('image-open'))}>Insert image URL</Button>
        {imageInsertOpen ? <div className="ui-stack" data-review-control-target={imageControl.target} data-review-control-generation={imageControl.generation}>
          <TextField id={`review-image-${props.surface}`} label="HTTP or HTTPS image URL (8 KiB maximum)" type="url" value={imageUrl} onChange={(event) => setImageUrl(event.currentTarget.value)} maxLength={8192} />
          <Button disabled={imageUrl.trim() === ''} onClick={() => void imageControl.request('image-insert')}>Insert image</Button>
          {imageError ? <InlineError message={imageError} /> : null}
        </div> : null}
      </div>
      <div className="ui-cluster">
        {replyTo !== null ? <Button disabled={pending} onClick={() => void composerControl.request('reply-cancel')}>Cancel reply</Button> : null}
        <Button variant="primary" type="submit" aria-label="Send comment" disabled={pending || data.review === null || draft.trim() === ''}>{pending ? 'Sending…' : replyTo === null ? 'Send comment' : 'Send reply'}</Button>
      </div>
    </form> : null}
    {data.queued.length > 0 ? <footer className="ui-cluster">
      <span>{data.queued.length} queued comment{data.queued.length === 1 ? '' : 's'}</span>
      <Button variant="primary" onClick={() => void commentsControl.request('queue-send')}>Send {data.queued.length} queued comments to AI</Button>
    </footer> : null}
  </section>
}