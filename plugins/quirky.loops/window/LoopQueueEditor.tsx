import type { FormEvent } from 'react'
import type { QueueItem } from '../src/types'

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
  onAction(command: QueueEditorCommand): Promise<unknown>
}

export function LoopQueueEditor({ items, state, disabled = false, onAction }: LoopQueueEditorProps) {
  const orderedItems = items.slice().sort((left, right) => left.position - right.position)

  const submitAdd = (event: FormEvent) => {
    event.preventDefault()
    if (disabled || !state.addDraft.trim()) return
    void onAction({ action: 'queue-add', params: { body: state.addDraft } }).catch(() => {})
  }

  const submitEdit = (event: FormEvent, item: QueueItem) => {
    event.preventDefault()
    if (disabled || !state.editingBody.trim()) return
    void onAction({ action: 'queue-edit', params: { id: item.id, body: state.editingBody } }).catch(() => {})
  }

  return (
    <section className="loop-queue" aria-label="Loop queue">
      <h3>Queue</h3>
      {orderedItems.length === 0 ? <p className="loop-muted">No prompts queued.</p> : (
        <ol className="loop-queue-list">
          {orderedItems.map((item, index) => {
            const inFlight = item.state === 'in-flight'
            const editing = state.editingId === item.id && !inFlight
            const anotherEditActive = state.editingId !== null && state.editingId !== item.id
            return (
              <li className={`loop-queue-item loop-queue-${item.state}`} data-queue-id={item.id} key={item.id}>
                <div className="loop-queue-item-heading">
                  <span className="loop-queue-state" role="img" aria-label={item.state === 'done' ? 'Done' : inFlight ? 'In progress' : 'Pending'}>
                    {item.state === 'done' ? '✓' : inFlight ? '→' : '○'}
                  </span>
                  <span className="loop-queue-state-label">{inFlight ? 'In progress' : item.state === 'done' ? 'Done' : 'Pending'}</span>
                  <span className="loop-queue-position">{index + 1}</span>
                </div>
                {editing ? (
                  <form className="loop-queue-edit" onSubmit={(event) => submitEdit(event, item)}>
                    <label>
                      Prompt for queue item {index + 1}
                      <textarea
                        aria-label={`Prompt for queue item ${index + 1}`}
                        value={state.editingBody}
                        onChange={(event) => { void onAction({ action: 'queue-edit-update', params: { body: event.currentTarget.value } }).catch(() => {}) }}
                        disabled={disabled}
                      />
                    </label>
                    <div className="loop-queue-actions">
                      <button type="submit" disabled={disabled || !state.editingBody.trim()}>Save</button>
                      <button type="button" disabled={disabled} onClick={() => { void onAction({ action: 'queue-edit-cancel', params: {} }).catch(() => {}) }}>Cancel</button>
                    </div>
                  </form>
                ) : <p className="loop-queue-body">{item.body}</p>}
                {!inFlight && !editing && (
                  <div className="loop-queue-actions">
                    <button
                      type="button"
                      aria-label={`Move up ${item.id}`}
                      disabled={disabled || anotherEditActive || index === 0}
                      onClick={() => { void onAction({ action: 'queue-move', params: { id: item.id, position: index - 1 } }).catch(() => {}) }}
                    >Move up</button>
                    <button
                      type="button"
                      aria-label={`Move down ${item.id}`}
                      disabled={disabled || anotherEditActive || index === orderedItems.length - 1}
                      onClick={() => { void onAction({ action: 'queue-move', params: { id: item.id, position: index + 1 } }).catch(() => {}) }}
                    >Move down</button>
                    <button
                      type="button"
                      aria-label={`Edit ${item.id}`}
                      disabled={disabled || anotherEditActive}
                      onClick={() => { void onAction({ action: 'queue-edit-open', params: { id: item.id } }).catch(() => {}) }}
                    >Edit</button>
                    <button
                      type="button"
                      aria-label={`Remove ${item.id}`}
                      disabled={disabled || anotherEditActive}
                      onClick={() => { void onAction({ action: 'queue-remove', params: { id: item.id } }).catch(() => {}) }}
                    >Remove</button>
                  </div>
                )}
              </li>
            )
          })}
        </ol>
      )}
      <form className="loop-queue-add" onSubmit={submitAdd}>
        <label>
          Describe the next task
          <textarea
            aria-label="Describe the next task"
            placeholder="Describe the next task"
            value={state.addDraft}
            onChange={(event) => { void onAction({ action: 'queue-draft', params: { body: event.currentTarget.value } }).catch(() => {}) }}
            disabled={disabled}
          />
        </label>
        <button type="submit" disabled={disabled || !state.addDraft.trim()}>Add prompt</button>
      </form>
    </section>
  )
}
