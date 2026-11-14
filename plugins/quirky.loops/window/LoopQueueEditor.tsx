import { Badge, Button, EmptyState, SectionHeader, TextArea } from '@quirky/ui'
import { useEffect, useRef, useState, type FormEvent } from 'react'
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
type DraftOverlay = { version: object; value: string; acknowledged: boolean; itemId?: string }

export function LoopQueueEditor({ items, state, disabled = false, context, loopId, onError }: LoopQueueEditorProps) {
  const [addOverlay, setAddOverlay] = useState<DraftOverlay | null>(null)
  const [editOverlay, setEditOverlay] = useState<DraftOverlay | null>(null)
  const addOverlayRef = useRef(addOverlay)
  const editOverlayRef = useRef(editOverlay)
  const draftCommandQueueRef = useRef<Promise<void>>(Promise.resolve())
  const generationRef = useRef(0)
  addOverlayRef.current = addOverlay
  editOverlayRef.current = editOverlay
  useEffect(() => {
    generationRef.current += 1
    addOverlayRef.current = null
    editOverlayRef.current = null
    draftCommandQueueRef.current = Promise.resolve()
    setAddOverlay(null)
    setEditOverlay(null)
  }, [context, loopId])
  const addDraft = addOverlay?.value ?? state.addDraft
  const editingBody = editOverlay?.itemId === state.editingId ? editOverlay.value : state.editingBody

  useEffect(() => {
    const current = addOverlayRef.current
    if (current?.acknowledged && state.addDraft === current.value) {
      addOverlayRef.current = null
      setAddOverlay(null)
    }
  }, [addOverlay, state.addDraft])

  useEffect(() => {
    const current = editOverlayRef.current
    if (current !== null && (state.editingId !== current.itemId ||
      (current.acknowledged && state.editingBody === current.value))) {
      editOverlayRef.current = null
      setEditOverlay(null)
    }
  }, [editOverlay, state.editingBody, state.editingId])

  const waitForDraftWrites = async (): Promise<void> => {
    await draftCommandQueueRef.current
  }

  const acknowledgeDraft = (target: 'add' | 'edit', version: object) => {
    const current = target === 'add' ? addOverlayRef.current : editOverlayRef.current
    if (current?.version !== version) return
    const next = { ...current, acknowledged: true }
    if (target === 'add') {
      addOverlayRef.current = next
      setAddOverlay(next)
    } else {
      editOverlayRef.current = next
      setEditOverlay(next)
    }
  }

  const clearAddedDraft = (body: string, version: object | undefined) => {
    const current = addOverlayRef.current
    if (current === null || current.version !== version || current.value !== body) return
    const cleared = { version: {}, value: '', acknowledged: true }
    addOverlayRef.current = cleared
    setAddOverlay(cleared)
  }

  const executeQueueCommand = async (
    command: QueueEditorCommand,
    onSuccess?: () => void
  ): Promise<void> => {
    const generation = generationRef.current
    const execute = async () => {
      if (generation !== generationRef.current) return
      try {
        await context.executeCommand('command:quirky.loops/action', {
          loopId,
          action: command.action,
          params: command.params
        })
        if (generation === generationRef.current) onSuccess?.()
      } catch (error) {
        if (generation === generationRef.current) onError(error)
      }
    }
    const draftWrite = command.action === 'queue-draft' || command.action === 'queue-edit-update'
    if (draftWrite) {
      const pending = draftCommandQueueRef.current.then(execute, execute)
      draftCommandQueueRef.current = pending.then(() => undefined, () => undefined)
      await pending
      return
    }
    if (command.action === 'queue-add' || command.action === 'queue-edit' || command.action === 'queue-edit-cancel') {
      await waitForDraftWrites()
    }
    await execute()
  }

  const updateAddDraft = (body: string) => {
    const overlay = { version: {}, value: body, acknowledged: false }
    addOverlayRef.current = overlay
    setAddOverlay(overlay)
    void executeQueueCommand(
      { action: 'queue-draft', params: { body } },
      () => acknowledgeDraft('add', overlay.version)
    )
  }

  const updateEditingBody = (body: string) => {
    if (state.editingId === null) return
    const overlay = { version: {}, value: body, acknowledged: false, itemId: state.editingId }
    editOverlayRef.current = overlay
    setEditOverlay(overlay)
    void executeQueueCommand(
      { action: 'queue-edit-update', params: { body } },
      () => acknowledgeDraft('edit', overlay.version)
    )
  }

  const orderedItems = items.slice().sort((left, right) => left.position - right.position)

  const submitAdd = (event: FormEvent) => {
    event.preventDefault()
    if (disabled || !addDraft.trim()) return
    const body = addDraft
    const version = addOverlayRef.current?.value === body ? addOverlayRef.current.version : undefined
    void executeQueueCommand(
      { action: 'queue-add', params: { body } },
      () => clearAddedDraft(body, version)
    )
  }

  const submitEdit = (event: FormEvent, item: QueueItem) => {
    event.preventDefault()
    if (disabled || !editingBody.trim()) return
    const body = editingBody
    const version = editOverlayRef.current?.value === body ? editOverlayRef.current.version : undefined
    void executeQueueCommand(
      { action: 'queue-edit', params: { id: item.id, body } },
      () => {
        if (version !== undefined) acknowledgeDraft('edit', version)
      }
    )
  }

  const cancelEdit = () => {
    void executeQueueCommand({ action: 'queue-edit-cancel', params: {} }, () => {
      const current = editOverlayRef.current
      if (current === null) return
      const next = { ...current, acknowledged: true }
      editOverlayRef.current = next
      setEditOverlay(next)
    })
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
                      value={editingBody}
                      onChange={(event) => updateEditingBody(event.currentTarget.value)}
                      disabled={disabled}
                    />
                    <div className="ui-cluster">
                      <Button type="submit" disabled={disabled || !editingBody.trim()}>Save</Button>
                      <Button type="button" disabled={disabled} onClick={cancelEdit}>Cancel</Button>
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
          value={addDraft}
          onChange={(event) => updateAddDraft(event.currentTarget.value)}
          disabled={disabled}
        />
        <Button type="submit" disabled={disabled || !addDraft.trim()}>Add prompt</Button>
      </form>
    </section>
  )
}
