import { useState } from 'react'
import { ArrowDown, ArrowUp, Pencil, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import type { LoopSnapshot, QueueOp } from '../../../shared/fork-loops/loop-types'

type QueueItem = NonNullable<LoopSnapshot['queue']>[number]

const SECTION_HEADING = 'text-[11px] font-semibold tracking-wider text-muted-foreground uppercase'
const ITEM_TONE: Record<QueueItem['state'], string> = {
  pending: 'text-foreground',
  'in-flight': 'text-foreground',
  done: 'text-muted-foreground'
}

function QueueItemBody({ item, tone }: { item: QueueItem; tone: string }): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      <p className={cn('text-xs break-words whitespace-pre-wrap', tone)}>{item.body}</p>
      {item.state === 'in-flight' ? (
        <span className="text-[11px] font-medium text-status-success">
          {translate('fork.loops.rail.queue.inFlight', 'In progress')}
        </span>
      ) : null}
      {item.state === 'done' ? (
        <span className="text-[11px] text-muted-foreground">
          {translate('fork.loops.rail.queue.done', 'Done')}
        </span>
      ) : null}
    </div>
  )
}

function QueueItemControls({
  busy,
  canMoveUp,
  canMoveDown,
  onEdit,
  onMove,
  onRemove
}: {
  busy: boolean
  canMoveUp: boolean
  canMoveDown: boolean
  onEdit: () => void
  onMove: (direction: -1 | 1) => void
  onRemove: () => void
}): React.JSX.Element {
  return (
    <div className="flex shrink-0 items-start gap-0.5">
      <Button
        variant="ghost"
        size="icon-xs"
        disabled={busy || !canMoveUp}
        aria-label={translate('fork.loops.rail.queue.moveUp', 'Move up')}
        onClick={() => onMove(-1)}
      >
        <ArrowUp aria-hidden />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        disabled={busy || !canMoveDown}
        aria-label={translate('fork.loops.rail.queue.moveDown', 'Move down')}
        onClick={() => onMove(1)}
      >
        <ArrowDown aria-hidden />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        disabled={busy}
        aria-label={translate('fork.loops.rail.action.edit', 'Edit')}
        onClick={onEdit}
      >
        <Pencil aria-hidden />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        disabled={busy}
        aria-label={translate('fork.loops.rail.queue.remove', 'Remove')}
        onClick={onRemove}
      >
        <Trash2 aria-hidden />
      </Button>
    </div>
  )
}

function QueueItemEditForm({
  initialBody,
  busy,
  onSave,
  onCancel
}: {
  initialBody: string
  busy: boolean
  onSave: (body: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const [body, setBody] = useState(initialBody)
  const trimmed = body.trim()
  return (
    <form
      className="w-full space-y-2"
      onSubmit={(event) => {
        event.preventDefault()
        if (trimmed) {
          onSave(trimmed)
        }
      }}
    >
      <Textarea
        aria-label={translate('fork.loops.rail.queue.editLabel', 'Edit queue item')}
        value={body}
        onChange={(event) => setBody(event.target.value)}
      />
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy || trimmed === ''}>
          {translate('fork.loops.rail.edit.save', 'Save')}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {translate('fork.loops.rail.action.cancel', 'Cancel')}
        </Button>
      </div>
    </form>
  )
}

/**
 * Queue controls for a loop driven by a prompt queue; renders nothing for any other loop.
 * The in-flight item is shown locked because the main process rejects ops that name it.
 */
export function LoopQueueEditor({ loop }: { loop: LoopSnapshot }): React.JSX.Element | null {
  const applyLoopSnapshot = useAppStore((state) => state.applyLoopSnapshot)
  const [newBody, setNewBody] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (loop.config.promptSource.kind !== 'queue') {
    return null
  }

  const items = (loop.queue ?? []).toSorted((a, b) => a.position - b.position)

  const send = async (op: QueueOp): Promise<boolean> => {
    setBusy(true)
    setError(null)
    try {
      applyLoopSnapshot(await window.api.loops.queue(loop.id, op))
      return true
    } catch (caught) {
      setError(
        caught instanceof Error && caught.message
          ? caught.message
          : translate('fork.loops.rail.actionFailed', 'That did not go through. Try again.')
      )
      return false
    } finally {
      setBusy(false)
    }
  }

  const trimmedNew = newBody.trim()

  return (
    <section className="space-y-2">
      <h3 className={SECTION_HEADING}>{translate('fork.loops.rail.queue.title', 'Queue')}</h3>
      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {translate('fork.loops.rail.queue.empty', 'The queue is empty')}
        </p>
      ) : (
        <ul className="space-y-1">
          {items.map((item, index) => {
            const neighbourMovable = (offset: number): boolean => {
              const neighbour = items[index + offset]
              return neighbour !== undefined && neighbour.state !== 'in-flight'
            }
            return (
              <li
                key={item.id}
                className="flex items-start gap-1 rounded-md border border-border bg-card p-2"
              >
                {editingId === item.id ? (
                  <QueueItemEditForm
                    initialBody={item.body}
                    busy={busy}
                    onCancel={() => setEditingId(null)}
                    onSave={(body) =>
                      void send({ op: 'edit', id: item.id, body }).then((ok) => {
                        if (ok) {
                          setEditingId(null)
                        }
                      })
                    }
                  />
                ) : (
                  <>
                    <QueueItemBody item={item} tone={ITEM_TONE[item.state]} />
                    {item.state !== 'in-flight' ? (
                      <QueueItemControls
                        busy={busy}
                        canMoveUp={neighbourMovable(-1)}
                        canMoveDown={neighbourMovable(1)}
                        onEdit={() => setEditingId(item.id)}
                        onMove={(direction) =>
                          void send({
                            op: 'move',
                            id: item.id,
                            position: items[index + direction].position
                          })
                        }
                        onRemove={() => void send({ op: 'remove', id: item.id })}
                      />
                    ) : null}
                  </>
                )}
              </li>
            )
          })}
        </ul>
      )}
      <form
        className="space-y-2"
        onSubmit={(event) => {
          event.preventDefault()
          if (trimmedNew) {
            void send({ op: 'add', body: trimmedNew }).then((ok) => {
              if (ok) {
                setNewBody('')
              }
            })
          }
        }}
      >
        <Textarea
          aria-label={translate('fork.loops.rail.queue.newLabel', 'New queue item')}
          placeholder={translate('fork.loops.rail.queue.placeholder', 'Describe the next task')}
          value={newBody}
          onChange={(event) => setNewBody(event.target.value)}
        />
        <Button type="submit" size="sm" disabled={busy || trimmedNew === ''}>
          {translate('fork.loops.rail.queue.add', 'Add')}
        </Button>
      </form>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  )
}
