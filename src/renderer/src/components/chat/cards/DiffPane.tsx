import { useState } from 'react'
import { MessageSquarePlus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { parsePatchLines, type PatchLine } from './patch-lines'
import { addTurnComment, removeTurnComment, type TurnLineComment } from './turn-comment-store'

type Numbered = Extract<PatchLine, { kind: 'context' | 'added' | 'removed' }>

/** The line a comment names: the new file's line, or the old file's for a removed line. */
const commentLine = (line: Numbered): number => line.newLine ?? line.oldLine ?? 0

function CommentForm({
  onSave,
  onCancel
}: {
  onSave: (text: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const [text, setText] = useState('')
  return (
    <div className="flex flex-col gap-2 border-y border-border bg-card px-3 py-2">
      <Textarea
        autoFocus
        rows={2}
        aria-label="Comment on this line"
        placeholder="Comment for the agent"
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="xs" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="button"
          size="xs"
          disabled={text.trim() === ''}
          onClick={() => onSave(text.trim())}
        >
          Add comment
        </Button>
      </div>
    </div>
  )
}

/**
 * A patch drawn read-only. With `commentKey` the owner can hang a comment on any line; the
 * comments for `path` show under their lines and can be removed again.
 */
export function DiffPane({
  patch,
  path,
  commentKey,
  comments
}: {
  patch: string
  path: string
  commentKey: string | null
  comments: readonly TurnLineComment[]
}): React.JSX.Element {
  const [composing, setComposing] = useState<number | null>(null)
  const lines = parsePatchLines(patch)
  const own = comments.filter((comment) => comment.path === path)
  return (
    <div
      role="table"
      aria-label={`Changes to ${path}`}
      className="chat-diff max-h-96 overflow-auto border-t border-border font-mono text-chat-code scrollbar-sleek"
    >
      {lines.map((line, index) => {
        if (line.kind === 'hunk') {
          return (
            <div
              key={index}
              role="row"
              className="chat-diff-hunk px-3 py-0.5 text-muted-foreground"
            >
              {line.text}
            </div>
          )
        }
        const number = commentLine(line)
        const attached = own.filter(
          (comment) => comment.line === number && lineOwnsComment(lines, index)
        )
        return (
          <div key={index}>
            <div
              role="row"
              data-diff-line={line.kind}
              className={cn(
                'group/line flex min-w-0 items-start',
                line.kind === 'added' && 'chat-diff-added',
                line.kind === 'removed' && 'chat-diff-removed'
              )}
            >
              <span className="w-10 shrink-0 select-none pr-2 text-right text-muted-foreground">
                {number}
              </span>
              <span className="min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere]">
                {line.text}
              </span>
              {commentKey !== null && (
                <button
                  type="button"
                  aria-label={`Comment on line ${number}`}
                  onClick={() => setComposing(index)}
                  className="mr-2 shrink-0 rounded-md p-0.5 text-muted-foreground opacity-0 hover:bg-accent focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover/line:opacity-100"
                >
                  <MessageSquarePlus className="size-3.5" />
                </button>
              )}
            </div>
            {attached.map((comment) => (
              <div
                key={comment.id}
                className="flex items-start gap-2 border-y border-border bg-card px-3 py-1.5 font-sans text-sm"
              >
                <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{comment.text}</span>
                {commentKey !== null && (
                  <button
                    type="button"
                    aria-label="Remove comment"
                    onClick={() => removeTurnComment(commentKey, comment.id)}
                    className="shrink-0 rounded-md p-0.5 text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <X className="size-3.5" />
                  </button>
                )}
              </div>
            ))}
            {composing === index && commentKey !== null && (
              <CommentForm
                onCancel={() => setComposing(null)}
                onSave={(text) => {
                  addTurnComment(commentKey, { path, line: number, text })
                  setComposing(null)
                }}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

/** A removed and an added line can share a number; the comment belongs to the first line drawn with it. */
function lineOwnsComment(lines: readonly PatchLine[], index: number): boolean {
  const line = lines[index]
  if (!line || line.kind === 'hunk') {
    return false
  }
  const number = commentLine(line)
  return (
    lines.findIndex((other) => other.kind !== 'hunk' && commentLine(other) === number) === index
  )
}
