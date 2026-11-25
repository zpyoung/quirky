import { useCallback, useEffect, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import type { TurnChangesFile } from '../../../../../shared/agent-session-journal-v1-items'
import type { AgentSessionTurnDiffResult } from '../../../../../shared/rpc-contract/structured-agent-session-params'
import { Button } from '@/components/ui/button'
import { readStructuredAgentSessionTurnDiff } from '@/runtime/structured-agent-session-v1-chat-client'
import { cn } from '@/lib/utils'
import type { RenderItemOf } from '../chat-turns'
import { useChatTurnEnv } from '../turn/chat-turn-env'
import { Card, Delta } from './Card'
import { DiffPane } from './DiffPane'
import {
  clearTurnComments,
  composeCommentsMessage,
  turnCommentKey,
  useTurnComments
} from './turn-comment-store'

const STATUS_LETTERS: Record<TurnChangesFile['status'], string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R'
}

const STATUS_WORDS: Record<TurnChangesFile['status'], string> = {
  added: 'Added',
  modified: 'Modified',
  deleted: 'Deleted',
  renamed: 'Renamed'
}

const GONE_WORDS = {
  gone: 'This diff is no longer available.',
  'not-git': 'This workspace has no git history to diff.',
  failed: 'Could not load this diff.'
} as const

type Loaded =
  | { state: 'loading' }
  | { state: 'ready'; patch: string; truncated: boolean }
  | { state: 'unavailable'; reason: keyof typeof GONE_WORDS }

function FileRow({
  file,
  turnId,
  expandable,
  commentKey
}: {
  file: TurnChangesFile
  turnId: string
  expandable: boolean
  commentKey: string
}): React.JSX.Element {
  const { sessionId, target } = useChatTurnEnv()
  const comments = useTurnComments(commentKey)
  const [open, setOpen] = useState(false)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const load = useCallback(() => {
    setLoaded({ state: 'loading' })
    void readStructuredAgentSessionTurnDiff(target, sessionId, turnId, file.path).then(
      (result: AgentSessionTurnDiffResult) =>
        setLoaded(
          result.ok
            ? { state: 'ready', patch: result.patch, truncated: result.truncated }
            : { state: 'unavailable', reason: result.reason }
        )
    )
  }, [file.path, sessionId, target, turnId])
  useEffect(() => {
    if (open && loaded === null) {
      load()
    }
  }, [load, loaded, open])
  const count = comments.filter((comment) => comment.path === file.path).length
  const label = (
    <>
      <span
        className="w-4 shrink-0 text-center font-mono text-xs text-muted-foreground"
        title={STATUS_WORDS[file.status]}
        aria-label={STATUS_WORDS[file.status]}
      >
        {STATUS_LETTERS[file.status]}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-chat-code" title={file.path}>
        {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
      </span>
      {count > 0 && (
        <span className="shrink-0 text-xs text-muted-foreground">{`${count} ${count === 1 ? 'comment' : 'comments'}`}</span>
      )}
      <Delta
        {...(file.added !== undefined ? { added: file.added } : {})}
        {...(file.removed !== undefined ? { removed: file.removed } : {})}
      />
    </>
  )
  return (
    <li>
      {expandable ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((shown) => !shown)}
          className="flex w-full min-w-0 items-center gap-2 rounded-md px-1 py-1 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronRight
            className={cn(
              'size-3.5 shrink-0 transition-transform motion-reduce:transition-none',
              open && 'rotate-90'
            )}
            aria-hidden="true"
          />
          {label}
        </button>
      ) : (
        <div className="flex min-w-0 items-center gap-2 px-1 py-1">
          <span className="size-3.5 shrink-0" aria-hidden="true" />
          {label}
        </div>
      )}
      {open && loaded?.state === 'loading' && (
        <p className="px-6 py-2 text-xs text-muted-foreground">Loading diff</p>
      )}
      {open && loaded?.state === 'unavailable' && (
        <div className="flex items-center gap-2 px-6 py-2 text-xs text-muted-foreground">
          <span>{GONE_WORDS[loaded.reason]}</span>
          {loaded.reason === 'failed' && (
            <Button type="button" variant="outline" size="xs" onClick={load}>
              Retry
            </Button>
          )}
        </div>
      )}
      {open && loaded?.state === 'ready' && (
        <>
          <DiffPane
            patch={loaded.patch}
            path={file.path}
            commentKey={commentKey}
            comments={comments}
          />
          {loaded.truncated && (
            <p className="px-6 py-1 text-xs text-muted-foreground">
              This diff is cut short at the host&apos;s size limit.
            </p>
          )}
        </>
      )}
    </li>
  )
}

/**
 * What one turn changed. Rows of a git-snapshot card open to the file's patch when the host can
 * serve it; an edit-tools card only names the files. Comments on diff lines wait here until the
 * owner sends them to the agent in one message.
 */
export function ChangesCard({ item }: { item: RenderItemOf<'turn-changes'> }): React.JSX.Element {
  const { sessionId, hostServesV1ChatMethods, onSendComments } = useChatTurnEnv()
  const { turnId, source, files } = item.body
  const commentKey = turnCommentKey(sessionId, turnId)
  const comments = useTurnComments(commentKey)
  const expandable = source === 'git-tree' && hostServesV1ChatMethods
  const added = files.reduce((sum, file) => sum + (file.added ?? 0), 0)
  const removed = files.reduce((sum, file) => sum + (file.removed ?? 0), 0)
  const known = files.some((file) => file.added !== undefined || file.removed !== undefined)
  const send = (): void => {
    if (onSendComments === undefined || comments.length === 0) {
      return
    }
    if (onSendComments(composeCommentsMessage(comments))) {
      clearTurnComments(commentKey)
    }
  }
  return (
    <Card
      label="Changes"
      ariaLabel={`Changes: ${files.length} ${files.length === 1 ? 'file' : 'files'}`}
      header={
        <>
          <span className="text-xs text-muted-foreground">
            {`${files.length} ${files.length === 1 ? 'file' : 'files'}`}
          </span>
          {known && <Delta added={added} removed={removed} />}
        </>
      }
    >
      <ul className="-mx-2 flex flex-col">
        {files.map((file) => (
          <FileRow
            key={file.path}
            file={file}
            turnId={turnId}
            expandable={expandable}
            commentKey={commentKey}
          />
        ))}
      </ul>
      {comments.length > 0 && (
        <div className="mt-2 flex items-center justify-end gap-2 border-t border-border pt-2">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => clearTurnComments(commentKey)}
          >
            Discard
          </Button>
          <Button type="button" size="xs" disabled={onSendComments === undefined} onClick={send}>
            {`Send ${comments.length} ${comments.length === 1 ? 'comment' : 'comments'} to agent`}
          </Button>
        </div>
      )}
    </Card>
  )
}
