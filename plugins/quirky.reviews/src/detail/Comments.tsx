import { useEffect, useMemo, useRef, useState } from 'react'
import { Markdown, MarkdownComposer } from '@quirky/plugin-tasks/markdown'
import type { ReviewsSurfaceProps } from '../contracts'
import { isRecord, parseCommentsResult, reviewContext, safeHttpUrl, type ReviewComment } from './data'

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

export function Comments(props: CommentsProps) {
  const owner = reviewContext(props.state, props.surface)
  const targetParams = owner === null ? null : {
    surface: props.surface,
    worktree: owner.worktree,
    number: owner.number,
    ...(owner.repo === null ? {} : { prRepo: owner.repo }),
  }
  const ownerVersion = owner === null ? '' : `${owner.worktree}:${owner.number}:${owner.generation}:${owner.repo?.host ?? ''}/${owner.repo?.owner ?? ''}/${owner.repo?.repo ?? ''}`
  const data = surfaceData(props)
  const number = data.number
  const selectedReview = data.review
  const worktree = data.worktree
  const parsed = data.value === null || number === null ? null : parseCommentsResult(data.value, number)
  const comments = parsed?.comments as unknown as ReviewComment[] | undefined ?? []
  const [draft, setDraft] = useState(data.draft)
  const [replyTo, setReplyTo] = useState<number | null>(null)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const [pending, setPending] = useState(false)
  const pendingRef = useRef(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [mentionOptions, setMentionOptions] = useState<MentionOption[]>([])
  const [mentionError, setMentionError] = useState<string | null>(null)
  const [imageUrl, setImageUrl] = useState('')
  const [imageError, setImageError] = useState<string | null>(null)
  const suggestionRequest = useRef(0)
  const draftRevision = useRef(Date.now() * 1000 + Math.floor(Math.random() * 1000))
  const filtered = useMemo(() => {
    const isBot = (comment: ReviewComment) => isBotAuthor(comment, props.state.botOverrides)
    if (data.audience === 'bots') return comments.filter(isBot)
    if (data.audience === 'humans') return comments.filter((comment) => !isBot(comment))
    return comments
  }, [comments, data.audience, props.state.botOverrides])
  const allThreads = useMemo(() => groupThreads(filtered), [filtered])
  const unresolvedThreads = useMemo(() => allThreads.filter((thread) => thread.resolved !== true), [allThreads])
  const resolvedThreads = useMemo(() => allThreads.filter((thread) => thread.resolved === true), [allThreads])
  const timeline = useMemo(() => [...filtered].sort((left, right) =>
    (Date.parse(left.createdAt ?? '') || 0) - (Date.parse(right.createdAt ?? '') || 0)), [filtered])
  const mentionMatch = /(?:^|\s)@([A-Za-z0-9-]*)$/.exec(draft)
  const mentionPrefix = mentionMatch?.[1]?.toLowerCase() ?? null
  const localParticipants = useMemo(() => participants(data.details), [data.details])

  useEffect(() => {
    setDraft(data.draft)
  }, [data.draft, props.surface, worktree, number])

  useEffect(() => {
    draftRevision.current = Date.now() * 1000 + Math.floor(Math.random() * 1000)
  }, [ownerVersion])

  useEffect(() => {
    if (mentionPrefix === null || !worktree) {
      setMentionOptions([])
      setMentionError(null)
      return
    }
    const request = ++suggestionRequest.current
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const value = await props.context.call('quirky.hosting/assignees', { worktree, query: mentionPrefix })
          if (request !== suggestionRequest.current) return
          if (!isRecord(value) || !Array.isArray(value.assignees)) throw new Error('The hosting API returned invalid mention suggestions.')
          const remote: MentionOption[] = []
          for (const item of value.assignees) {
            if (!isRecord(item) || typeof item.login !== 'string' || item.login.trim() === '') continue
            remote.push({ login: item.login, avatarUrl: typeof item.avatarUrl === 'string' ? item.avatarUrl : null })
          }
          const combined = new Map<string, MentionOption>()
          for (const option of [...localParticipants, ...remote]) {
            if (option.login.toLowerCase().startsWith(mentionPrefix)) combined.set(option.login.toLowerCase(), option)
          }
          setMentionOptions([...combined.values()].slice(0, 8))
          setMentionError(null)
        } catch (error) {
          if (request === suggestionRequest.current) {
            setMentionOptions(localParticipants.filter((option) => option.login.toLowerCase().startsWith(mentionPrefix)).slice(0, 8))
            setMentionError(errorText(error))
          }
        }
      })()
    }, 180)
    return () => clearTimeout(timer)
  }, [mentionPrefix, worktree, props.context, localParticipants])

  const setSharedDraft = (value: string) => {
    setDraft(value)
    if (targetParams === null || owner === null) return
    draftRevision.current += 1
    void props.context.call('quirky.reviews/detailSetCommentDraft', {
      ...targetParams,
      generation: owner.generation,
      body: value,
      draftVersion: draftRevision.current,
    }).catch((error: unknown) => setActionError(errorText(error)))
  }

  const submit = async () => {
    if (pendingRef.current || targetParams === null || draft.trim() === '') return
    pendingRef.current = true
    setPending(true)
    setActionError(null)
    try {
      await props.context.call('quirky.reviews/detailPostComment', {
        ...targetParams,
        body: draft,
        ...(replyTo === null ? {} : { replyToId: replyTo }),
      })
      setDraft('')
      setReplyTo(null)
      props.context.toast('Comment posted', 'The comment was confirmed by the hosting provider.')
    } catch (error) {
      setActionError(errorText(error))
    } finally {
      pendingRef.current = false
      setPending(false)
    }
  }

  const selectMention = (login: string) => {
    setSharedDraft(draft.replace(/@[A-Za-z0-9-]*$/, `@${login} `))
    setMentionOptions([])
  }

  const insertImage = () => {
    if (bytes(imageUrl) > 8192) {
      setImageError('Image URL must be no longer than 8 KiB.')
      return
    }
    const url = safeHttpUrl(imageUrl)
    if (url === null) {
      setImageError('Enter an HTTP or HTTPS image URL.')
      return
    }
    setSharedDraft(`${draft}${draft.endsWith('\n') || draft === '' ? '' : '\n'}![image](<${url}>)`)
    setImageUrl('')
    setImageError(null)
  }

  const editComment = async (commentId: number) => {
    if (pendingRef.current || targetParams === null || editDraft.trim() === '') return
    pendingRef.current = true
    setPending(true)
    setActionError(null)
    try {
      await props.context.call('quirky.reviews/detailEditComment', { ...targetParams, commentId, body: editDraft })
      setEditingId(null)
      setEditDraft('')
    } catch (error) {
      setActionError(errorText(error))
    } finally {
      pendingRef.current = false
      setPending(false)
    }
  }

  const deleteComment = async (commentId: number) => {
    if (targetParams === null || pendingRef.current) return
    const confirmed = await props.context.confirm({
      title: 'Delete comment?',
      body: `This will permanently remove comment #${commentId} from pull request #${number}.`,
      confirmLabel: 'Delete comment',
    })
    if (!confirmed) return
    pendingRef.current = true
    setPending(true)
    setActionError(null)
    try {
      await props.context.call('quirky.reviews/detailDeleteComment', { ...targetParams, commentId, yes: true })
    } catch (error) {
      setActionError(errorText(error))
    } finally {
      pendingRef.current = false
      setPending(false)
    }
  }

  const setBotOverride = async (author: string, bot: boolean) => {
    try {
      await props.context.call('quirky.reviews/detailSetBotOverride', { author, bot })
    } catch (error) {
      setActionError(errorText(error))
    }
  }

  const setQueued = async (commentId: string, queued: boolean) => {
    if (targetParams === null) return
    try {
      await props.context.call('quirky.reviews/detailQueueComment', { ...targetParams, commentId, queued })
    } catch (error) {
      setActionError(errorText(error))
    }
  }

  const resolveThread = async (threadId: string, resolved: boolean) => {
    if (targetParams === null) return
    try {
      await props.context.call('quirky.reviews/detailResolveThread', { ...targetParams, threadId, resolved })
    } catch (error) {
      setActionError(errorText(error))
    }
  }

  const toggleReaction = async (comment: ReviewComment, content: typeof reactionChoices[number]) => {
    if (targetParams === null || comment.reactionSubjectId === null) return
    const existing = comment.reactions.find((reaction) => reaction.content === content)
    try {
      await props.context.call('quirky.reviews/detailReact', {
        ...targetParams,
        subjectId: comment.reactionSubjectId,
        content,
        add: existing?.viewerHasReacted !== true,
      })
    } catch (error) {
      setActionError(errorText(error))
    }
  }

  const sendQueued = async () => {
    if (data.queued.length === 0) return
    try {
      await props.context.call('quirky.reviews/checksSetAgentDialog', { surface: props.surface, action: 'comments' })
    } catch (error) {
      setActionError(errorText(error))
    }
  }

  const emptyText = data.audience === 'humans' ? 'No human comments.' : data.audience === 'bots' ? 'No bot comments.' : 'No comments yet.'
  const countFor = (audience: 'all' | 'humans' | 'bots') => {
    if (audience === 'all') return comments.length
    return comments.filter((comment) => isBotAuthor(comment, props.state.botOverrides) === (audience === 'bots')).length
  }

  const renderComment = (comment: ReviewComment) => {
    const numericId = typeof comment.id === 'number' ? comment.id : null
    const topLevel = comment.kind === 'issue_comment' && comment.path === null && comment.threadId === null && numericId !== null
    const bot = isBotAuthor(comment, props.state.botOverrides)
    const safeUrl = safeHttpUrl(comment.url)
    const timestamp = displayTime(comment.createdAt)
    const queueId = comment.threadId ?? String(comment.id)
    const authorIsManuallyMarked = props.state.botOverrides.some((login) => login.toLowerCase() === (comment.author ?? '').toLowerCase())
    return <article className="review-comment" key={`${comment.kind}:${String(comment.id)}`}>
      <header className="review-comment-header">
        <strong>{comment.author ?? 'Unknown author'}</strong>
        {bot ? <span className="review-bot-badge">Bot</span> : null}
        {timestamp ? <time dateTime={comment.createdAt ?? undefined}>{timestamp}</time> : null}
        {comment.isOutdated === true ? <span>Outdated thread</span> : null}
        {comment.state ? <span>{comment.state}</span> : null}
      </header>
      {editingId === numericId && topLevel ? <div className="review-comment-edit">
        <MarkdownComposer value={editDraft} onChange={setEditDraft} label={`Edit comment #${numericId}`} minRows={3} disabled={pending} />
        <button type="button" disabled={pending || editDraft.trim() === ''} onClick={() => void editComment(numericId)}>Save edit</button>
        <button type="button" disabled={pending} onClick={() => { setEditingId(null); setEditDraft('') }}>Cancel edit</button>
      </div> : <div className="review-comment-body"><Markdown source={comment.body} /></div>}
      <div className="review-comment-actions">
        {comment.threadId ? <button type="button" onClick={() => void resolveThread(comment.threadId as string, comment.isResolved !== true)}>{comment.isResolved === true ? 'Unresolve' : 'Resolve'}</button> : null}
        {comment.kind === 'review_comment' && numericId !== null ? <button type="button" onClick={() => { setReplyTo(numericId); setDraft(data.draft) }}>Reply</button> : null}
        {safeUrl ? <button type="button" onClick={() => void props.context.call('quirky.reviews/openLink', { url: safeUrl }).catch((error: unknown) => setActionError(errorText(error)))}>Go to comment</button> : null}
        <button type="button" aria-pressed={data.queued.includes(queueId)} onClick={() => void setQueued(queueId, !data.queued.includes(queueId))}>{data.queued.includes(queueId) ? 'Unqueue for agent' : 'Queue for agent'}</button>
        {comment.author ? <button type="button" onClick={() => void setBotOverride(comment.author as string, !authorIsManuallyMarked)}>{authorIsManuallyMarked ? 'Unmark author as bot' : 'Mark author as bot'}</button> : null}
        {topLevel ? <>
          {editingId === numericId ? null : <button type="button" onClick={() => { setEditingId(numericId); setEditDraft(comment.body) }}>Edit</button>}
          <button type="button" disabled={pending} onClick={() => void deleteComment(numericId)}>Delete</button>
        </> : null}
      </div>
    </article>
  }

  const renderThread = (thread: CommentThread) => <section className="review-comment-thread" key={thread.id}>
    <header className="review-thread-header">
      <strong>{thread.resolved === true ? 'Resolved thread' : 'Needs review'}</strong>
      {thread.id.startsWith('issue_comment:') || thread.id.startsWith('review:') ? null : <span>{thread.comments.length} comments</span>}
    </header>
    {thread.comments.map(renderComment)}
  </section>

  const content = parsed === null
    ? data.loading ? <p role="status">Loading comments…</p> : <p role="status">{data.error ? 'Comments are unavailable.' : 'Comments have not been loaded yet.'}</p>
    : data.grouping === 'timeline'
      ? timeline.length === 0
        ? <p role="status">{emptyText}</p>
        : <div className="review-comment-timeline">{timeline.map(renderComment)}</div>
      : allThreads.length === 0
        ? <p role="status">{emptyText}</p>
        : <div className="review-comment-groups">
          {unresolvedThreads.length > 0 ? <section aria-label="Needs review">
            <h4>Needs review</h4>
            {[...unresolvedThreads].sort((left, right) => right.updatedAt - left.updatedAt).map(renderThread)}
          </section> : null}
          {resolvedThreads.length > 0 ? <section aria-label="Resolved">
            <h4>Resolved</h4>
            {[...resolvedThreads].sort((left, right) => right.updatedAt - left.updatedAt).map(renderThread)}
          </section> : null}
        </div>

  return <section className="review-comments" aria-label="Pull request comments">
    <header className="review-comments-heading">
      <h3>Comments{parsed ? ` (${comments.length})` : ''}</h3>
      <div role="group" aria-label="Comment audience">
        {(['all', 'humans', 'bots'] as const).map((audience) => <button
          key={audience}
          type="button"
          aria-pressed={data.audience === audience}
          disabled={targetParams === null}
          onClick={() => { if (targetParams !== null) void props.context.call('quirky.reviews/detailSetAudience', { ...targetParams, audience }).catch((error: unknown) => setActionError(errorText(error))) }}
        >{audience === 'all' ? 'All' : audience === 'humans' ? 'Humans' : 'Bots'} ({countFor(audience)})</button>)}
      </div>
      <div role="group" aria-label="Comment ordering">
        {(['grouped', 'timeline'] as const).map((grouping) => <button
          key={grouping}
          type="button"
          aria-pressed={data.grouping === grouping}
          disabled={targetParams === null}
          onClick={() => { if (targetParams !== null) void props.context.call('quirky.reviews/detailSetGrouping', { ...targetParams, grouping }).catch((error: unknown) => setActionError(errorText(error))) }}
        >{grouping === 'grouped' ? 'Grouped' : 'Timeline'}</button>)}
      </div>
    </header>

    {data.error ? <p className="review-error" role="alert">{data.error} Showing the last available comments where present.</p> : null}
    {actionError ? <p className="review-error" role="alert">{actionError}</p> : null}
    {parsed?.partial === true ? <p className="review-partial" role="status">Showing the first 100 comments per source{Array.isArray(parsed.partialFailures) && parsed.partialFailures.length > 0 ? `; ${parsed.partialFailures.join(' ')}` : '.'}</p> : null}

    {content}

    {number !== null ? <form className="review-comment-composer" onSubmit={(event) => { event.preventDefault(); void submit() }}>
      <label htmlFor={`review-comment-${props.surface}`}>{replyTo === null ? 'Add a comment' : `Reply to comment #${replyTo}`}</label>
      <MarkdownComposer
        value={draft}
        onChange={setSharedDraft}
        label={replyTo === null ? 'Add a comment' : `Reply to comment #${replyTo}`}
        placeholder={replyTo === null ? 'Add a comment…' : 'Write a reply…'}
        minRows={4}
        disabled={pending || selectedReview === null}
        onSubmit={() => void submit()}
      />
      {mentionPrefix !== null ? <div className="review-mention-suggestions" role="listbox" aria-label="Mention suggestions">
        {mentionOptions.length > 0 ? mentionOptions.map((option) => <button
          key={option.login}
          type="button"
          role="option"
          onClick={() => selectMention(option.login)}
        >@{option.login}</button>) : <span>No matching participants.</span>}
        {mentionError ? <span role="status">Some repository suggestions could not be loaded: {mentionError}</span> : null}
      </div> : null}
      <details className="review-image-insert">
        <summary>Insert image URL</summary>
        <label htmlFor={`review-image-${props.surface}`}>HTTP or HTTPS image URL (8 KiB maximum)</label>
        <input id={`review-image-${props.surface}`} type="url" value={imageUrl} onChange={(event) => setImageUrl(event.currentTarget.value)} maxLength={8192} />
        <button type="button" disabled={imageUrl.trim() === ''} onClick={insertImage}>Insert image</button>
        {imageError ? <p role="alert">{imageError}</p> : null}
      </details>
      <div className="review-comment-submit">
        {replyTo !== null ? <button type="button" disabled={pending} onClick={() => setReplyTo(null)}>Cancel reply</button> : null}
        <button type="submit" aria-label="Send comment" disabled={pending || selectedReview === null || draft.trim() === ''}>
          {pending ? 'Sending…' : replyTo === null ? 'Send comment' : 'Send reply'}
        </button>
      </div>
    </form> : null}

    {data.queued.length > 0 ? <footer className="review-queued-comments">
      <span>{data.queued.length} queued comment{data.queued.length === 1 ? '' : 's'}</span>
      <button type="button" onClick={() => void sendQueued()}>Send {data.queued.length} queued comments to AI</button>
    </footer> : null}
  </section>
}