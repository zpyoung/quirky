import { useState, type KeyboardEvent } from 'react'
import { CornerDownRight, GripVertical, ListEnd, Pencil, Play, Send, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { AGENT_SESSION_V1_CHAT_METHODS_RUNTIME_CAPABILITY } from '../../../../../shared/agent-session-runtime-capabilities'
import { useStructuredAgentSessionHostCapabilityState } from '@/runtime/structured-agent-session-host-capability'
import {
  moveStructuredAgentSessionQueuedMessage,
  queuedMessageMoveFailureText
} from '@/runtime/structured-agent-session-queue-move-client'
import { queuedMessageCardSteers } from '@/components/native-chat/structured-agent-session-queued-cards'
import type { ComposerQueue, ComposerQueueMove } from './composer-types'

/**
 * The rows attached above the composer card. While the agent works a row offers Steer now, Edit and
 * Delete; idle, the same action reads Send now. A row can be dragged to reorder only when the host
 * serves `queuedMessageMove`, and the order shown is always the host's: a refused move leaves it as it was.
 */
export function QueuedList({
  queue,
  working,
  steerHeld = false,
  move
}: {
  queue: ComposerQueue
  working: boolean
  /** A Stop is ending the turn, so nothing steers into it. */
  steerHeld?: boolean
  move?: ComposerQueueMove
}): React.JSX.Element | null {
  const [dragging, setDragging] = useState<string | null>(null)
  const hostMoves =
    useStructuredAgentSessionHostCapabilityState(
      move?.target ?? null,
      AGENT_SESSION_V1_CHAT_METHODS_RUNTIME_CAPABILITY
    ) === 'supported'
  const { cards, editor, pause } = queue
  if (cards.length === 0) {
    return null
  }
  const canReorder = hostMoves && move !== undefined && cards.length > 1 && editor === undefined

  const reorder = (messageId: string, toIndex: number) => {
    if (!move || toIndex < 0 || toIndex >= cards.length) {
      return
    }
    if (cards.findIndex((card) => card.messageId === messageId) === toIndex) {
      return
    }
    void moveStructuredAgentSessionQueuedMessage({ ...move, messageId, toIndex }).then(
      (outcome) => {
        if (!outcome.ok) {
          toast.error(queuedMessageMoveFailureText(outcome))
        }
      }
    )
  }

  const onHandleKey = (event: KeyboardEvent, messageId: string, index: number) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') {
      return
    }
    event.preventDefault()
    reorder(messageId, index + (event.key === 'ArrowUp' ? -1 : 1))
  }

  return (
    <div
      className="overflow-hidden rounded-t-xl border border-b-0 border-chat-composer-border bg-muted text-sm"
      aria-live="polite"
    >
      <div className="flex items-center gap-1 py-1 pr-1 pl-2.5 text-xs text-muted-foreground">
        <p className={cn('flex-1 truncate', pause && 'font-medium text-foreground')}>
          {pause ? 'Paused' : 'Queued'} <span aria-hidden>·</span> {cards.length}
        </p>
        {pause ? (
          <>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={!queue.clearCapable || queue.queuePending !== null}
              onClick={() => void queue.clear()}
            >
              <Trash2 />
              Clear all
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={queue.queuePending !== null}
              onClick={() => void queue.resume()}
            >
              <Play />
              Resume
            </Button>
          </>
        ) : null}
      </div>
      <ul
        className="scrollbar-sleek max-h-40 divide-y divide-border overflow-y-auto"
        aria-label="Queued messages"
      >
        {cards.map((card, index) => {
          const pending = queue.pending(card.messageId)
          const busy = pending !== null
          const steers = queuedMessageCardSteers(card)
          const editing = editor?.messageId === card.messageId ? editor : undefined
          const caption =
            card.state === 'returned'
              ? (card.returnedReason ?? 'Not sent')
              : card.hold === 'sending'
                ? 'Sending'
                : card.hold === 'behind-returned'
                  ? 'Waiting on a message ahead'
                  : card.hold === 'paused'
                    ? 'Paused'
                    : null
          return (
            <li
              key={card.messageId}
              data-queued-message-id={card.messageId}
              className={cn('px-2.5 py-1.5', dragging === card.messageId && 'opacity-50')}
              draggable={canReorder && card.hold !== 'sending'}
              onDragStart={(event) => {
                setDragging(card.messageId)
                event.dataTransfer.setData('text/plain', card.messageId)
              }}
              onDragOver={(event) => {
                if (dragging !== null) {
                  event.preventDefault()
                }
              }}
              onDrop={(event) => {
                event.preventDefault()
                if (dragging !== null) {
                  reorder(dragging, index)
                }
                setDragging(null)
              }}
              onDragEnd={() => setDragging(null)}
            >
              {editing ? (
                <QueuedEdit editor={editing} />
              ) : (
                <div className="flex items-center gap-2">
                  {canReorder && card.hold !== 'sending' ? (
                    <button
                      type="button"
                      className="cursor-grab text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                      aria-label="Reorder queued message (drag, or Up and Down arrows)"
                      title="Drag to reorder"
                      onKeyDown={(event) => onHandleKey(event, card.messageId, index)}
                    >
                      <GripVertical className="size-3.5" aria-hidden />
                    </button>
                  ) : (
                    <ListEnd className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate" title={card.text}>
                      {card.text || (card.images ? `${card.images.length} image(s)` : '')}
                    </p>
                    {caption ? (
                      <p
                        className={cn(
                          'truncate text-xs',
                          card.state === 'returned' ? 'text-destructive' : 'text-muted-foreground'
                        )}
                      >
                        {caption}
                      </p>
                    ) : null}
                  </div>
                  {card.hold === 'sending' ? null : (
                    <>
                      {card.waitsForAgent ? null : (
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          disabled={(steers && steerHeld) || busy}
                          onClick={() => void queue.steer(card.messageId)}
                        >
                          {steers ? <CornerDownRight /> : <Send />}
                          {steers && working ? 'Steer now' : 'Send now'}
                        </Button>
                      )}
                      {queue.editCapable && !card.command ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          aria-label="Edit queued message"
                          disabled={busy || queue.editor !== undefined}
                          onClick={() => void queue.edit(card.messageId)}
                        >
                          <Pencil />
                        </Button>
                      ) : null}
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        aria-label="Delete queued message"
                        disabled={busy}
                        onClick={() => void queue.remove(card.messageId)}
                      >
                        <X />
                      </Button>
                    </>
                  )}
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function QueuedEdit({
  editor
}: {
  editor: NonNullable<ComposerQueue['editor']>
}): React.JSX.Element {
  return (
    <div data-queued-message-editor className="flex flex-col gap-1.5">
      <Textarea
        autoFocus
        rows={2}
        aria-label="Edit queued message"
        value={editor.text}
        readOnly={editor.acquiring}
        onChange={(event) => editor.change(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            editor.cancel()
          }
        }}
      />
      <div className="flex justify-end gap-1">
        <Button type="button" variant="ghost" size="xs" onClick={editor.cancel}>
          Cancel
        </Button>
        <Button
          type="button"
          size="xs"
          disabled={!editor.canSave || editor.saving}
          onClick={editor.save}
        >
          Save
        </Button>
      </div>
    </div>
  )
}
