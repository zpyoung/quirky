import { useCallback, useEffect, useSyncExternalStore } from 'react'
import type { UiPluginContext } from '@quirky/protocol'
import { Button, Dialog as SharedDialog, EmptyState, InlineError, ListRow, SectionHeader, TextArea, TextField } from '@quirky/ui'
import { TEMPLATE_BODY_MAX, TEMPLATE_NAME_MAX } from '../core/template'
import { BODY_COUNTER, SETTINGS_SUBTITLE, VARIABLES_HINT } from './copy'
import { canSaveEditor, type TemplatesStore } from './templates'

const COMMAND_TEMPLATE_ADD = 'command:quirky.handoff/template-add'
const COMMAND_TEMPLATE_EDIT = 'command:quirky.handoff/template-edit'
const COMMAND_TEMPLATE_REMOVE = 'command:quirky.handoff/template-remove'
const COMMAND_TEMPLATES_RESET = 'command:quirky.handoff/templates-reset'

function EditorDialog({ store, onCancelEditor }: { store: TemplatesStore; onCancelEditor: () => void }) {
  const { editor } = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const title = editor === null || editor.id === null ? 'Add template' : 'Edit template'
  useEffect(() => {
    if (!editor) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onCancelEditor()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [editor !== null, onCancelEditor])

  return (
    <SharedDialog
      open={editor !== null}
      title={title}
      closeOnBackdrop={false}
      onClose={onCancelEditor}
      actions={(
        <>
          <Button type="button" onClick={onCancelEditor}>Cancel</Button>
          <Button type="button" variant="primary" disabled={!editor || !canSaveEditor(editor)} onClick={() => void store.saveEditor()}>
            Save template
          </Button>
        </>
      )}
    >
      {editor && (
        <div className="ui-stack">
          <TextField
            label="Name"
            aria-label="Name"
            type="text"
            maxLength={TEMPLATE_NAME_MAX}
            value={editor.name}
            onChange={(event) => store.setEditor({ name: event.target.value })}
          />
          <TextArea
            label="Instructions"
            aria-label="Instructions"
            rows={8}
            maxLength={TEMPLATE_BODY_MAX}
            value={editor.body}
            onChange={(event) => store.setEditor({ body: event.target.value })}
          />
          <small className="ui-text-muted">{BODY_COUNTER(editor.body.length, TEMPLATE_BODY_MAX)}</small>
          <small className="ui-text-muted">{VARIABLES_HINT}</small>
        </div>
      )}
    </SharedDialog>
  )
}

/** Settings > Session handoff: the template list with edit and remove, the count, add and reset. */
export function SettingsView({ store, context }: { store: TemplatesStore; context: UiPluginContext }) {
  const { templates, custom, limit, warning, phase, loadError } = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const onCancelEditor = useCallback(() => store.closeEditor(), [store])
  return (
    <div className="ui-stack" style={{ padding: 'var(--ui-space-16)' }}>
      <div className="ui-stack">
        <SectionHeader title="Session handoff" />
        <p className="ui-text-muted">{SETTINGS_SUBTITLE}</p>
      </div>
      {warning !== null && (
        <div role="status">
          <ListRow title={warning} status="needs-you" />
        </div>
      )}
      {phase === 'loading' && <EmptyState message="Loading handoff templates…" />}
      {phase === 'failed' && (
        <InlineError
          message={`Could not load handoff templates: ${loadError ?? ''}`}
          action={{ label: 'Retry', onAction: () => { void store.load() } }}
        />
      )}
      {phase === 'ready' && templates.length === 0 && <EmptyState message="No handoff templates yet." />}
      <div role="list" className="ui-stack">
        {templates.map((template) => (
          <div key={template.id} role="listitem" data-template={template.id}>
            <ListRow
              title={template.name}
              description={template.body}
              trailing={(
                <div className="ui-cluster">
                  <Button type="button" aria-label={`Edit ${template.name}`} onClick={() => void context.executeCommand(COMMAND_TEMPLATE_EDIT, { id: template.id })}>
                    Edit
                  </Button>
                  <Button type="button" variant="destructive" aria-label={`Remove ${template.name}`} onClick={() => void context.executeCommand(COMMAND_TEMPLATE_REMOVE, { id: template.id })}>
                    Remove
                  </Button>
                </div>
              )}
            />
          </div>
        ))}
      </div>
      <div className="ui-cluster" style={{ justifyContent: 'space-between' }}>
        {phase === 'ready' && <span className="ui-text-muted">{`${templates.length} of ${limit} templates`}</span>}
        <div className="ui-cluster">
          <Button type="button" disabled={phase !== 'ready' || !custom} onClick={() => void context.executeCommand(COMMAND_TEMPLATES_RESET)}>
            Reset to defaults
          </Button>
          <Button type="button" variant="primary" disabled={phase !== 'ready' || templates.length >= limit} onClick={() => void context.executeCommand(COMMAND_TEMPLATE_ADD)}>
            Add template
          </Button>
        </div>
      </div>
      <EditorDialog store={store} onCancelEditor={onCancelEditor} />
    </div>
  )
}
