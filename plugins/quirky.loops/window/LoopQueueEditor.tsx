import { Badge, Button, EmptyState, SectionHeader, TextArea } from '@quirky/ui'
import type { FormEvent } from 'react'
import type { QueueItem } from '../src/types'
import type { UiPluginContext } from '@quirky/protocol'

export type QueueEditorState = {
  addDraft: string
  editingId: string | null
  editingBody: string
}

export type QueueEditorCommand =
  | { action: 'queue-draft'; params: { body: string } }
  | { action: 'queue-edit-open'; params: { id: string } }
  | { action: 'queue-edit-update'; params: { body: string } }
  | { action: 'queue-edit-cancel'; params: Record<string, never> }
  | { action: 'queue-add'; params: { body: string } }
  | { action: 'queue-edit'; params: { id: string; body: string } }
  | { action: 'queue-move'; params: { id: string; position: number } }
  | { action: 'queue-remove'; params: { id: string } }

export type LoopQueueEditorProps = {
  items: readonly QueueItem[]
  state: QueueEditorState
  disabled?: boolean
  context: UiPluginContext
  loopId: string
  onError(error: unknown): void
}

export function LoopQueueEditor({ items, state, disabled = false, context, loopId, onError }: LoopQueueEditorProps) {
  const orderedItems = items.slice().sort((left, right) => left.position - right.position)
  const executeQueueCommand = async (command: QueueEditorCommand): Promise<void> => {
    try {
      await context.executeCommand('command:quirky.loops/action', {
        loopId,
        action: command.action,
        params: command.params
      })
    } catch (error) {
      onError(error)
    }
  }

  const submitAdd = (event: FormEvent) => {
    event.preventDefault()
    if (disabled || !state.addDraft.trim()) return
    void executeQueueCommand({ action: 'queue-add', params: { body: state.addDraft } })
  }

  const submitEdit = (event: FormEvent, item: QueueItem) => {
    event.preventDefault()
    if (disabled || !state.editingBody.trim()) return
    void executeQueueCommand({ action: 'queue-edit', params: { id: item.id, body: state.editingBody } })
  }

  return (
    <section className="ui-stack" aria-label="Loop queue">
      <SectionHeader title="Queue" />
      {orderedItems.length === 0 ? <EmptyState message="No prompts queued." /> : (
        <ol className="ui-stack">
          {orderedItems.map((item, index) => {
            const inFlight = item.state === 'in-flight'
            const editing = state.editingId === item.id && !inFlight
            const anotherEditActive = state.editingId !== null && state.editingId !== item.id
            const itemState = inFlight ? 'In progress' : item.state === 'done' ? 'Done' : 'Pending'
            const stateTone = inFlight ? 'working' : item.state === 'done' ? 'accent' : 'neutral'
            return (
              <li className="ui-stack" data-queue-id={item.id} key={item.id}>
                <div className="ui-cluster">
                  <Badge tone={stateTone}>{itemState}</Badge>
                  <span>{index + 1}</span>
                </div>
                {editing ? (
                  <form className="ui-stack" onSubmit={(event) => submitEdit(event, item)}>
                    <TextArea
                      label={`Prompt for queue item ${index + 1}`}
                      aria-label={`Prompt for queue item ${index + 1}`}
                      value={state.editingBody}
                      onChange={(event) => { void executeQueueCommand({ action: 'queue-edit-update', params: { body: event.currentTarget.value } }) }}
                      disabled={disabled}
                    />
                    <div className="ui-cluster">
                      <Button type="submit" disabled={disabled || !state.editingBody.trim()}>Save</Button>
                      <Button type="button" disabled={disabled} onClick={() => { void executeQueueCommand({ action: 'queue-edit-cancel', params: {} }) }}>Cancel</Button>
                    </div>
                  </form>
                ) : <p>{item.body}</p>}
                {!inFlight && !editing && (
                  <div className="ui-cluster">
                    <Button
                      type="button"
                      aria-label={`Move up ${item.id}`}
                      disabled={disabled || anotherEditActive || index === 0}
                      onClick={() => { void executeQueueCommand({ action: 'queue-move', params: { id: item.id, position: index - 1 } }) }}
                    >Move up</Button>
                    <Button
                      type="button"
                      aria-label={`Move down ${item.id}`}
                      disabled={disabled || anotherEditActive || index === orderedItems.length - 1}
                      onClick={() => { void executeQueueCommand({ action: 'queue-move', params: { id: item.id, position: index + 1 } }) }}
                    >Move down</Button>
                    <Button
                      type="button"
                      aria-label={`Edit ${item.id}`}
                      disabled={disabled || anotherEditActive}
                      onClick={() => { void executeQueueCommand({ action: 'queue-edit-open', params: { id: item.id } }) }}
                    >Edit</Button>
                    <Button
                      type="button"
                      variant="destructive"
                      aria-label={`Remove ${item.id}`}
                      disabled={disabled || anotherEditActive}
                      onClick={() => { void executeQueueCommand({ action: 'queue-remove', params: { id: item.id } }) }}
                    >Remove</Button>
                  </div>
                )}
              </li>
            )
          })}
        </ol>
      )}
      <form className="ui-stack" onSubmit={submitAdd}>
        <TextArea
          label="Describe the next task"
          aria-label="Describe the next task"
          placeholder="Describe the next task"
          value={state.addDraft}
          onChange={(event) => { void executeQueueCommand({ action: 'queue-draft', params: { body: event.currentTarget.value } }) }}
          disabled={disabled}
        />
        <Button type="submit" disabled={disabled || !state.addDraft.trim()}>Add prompt</Button>
      </form>
    </section>
  )
}
