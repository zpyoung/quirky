import { useEffect, useSyncExternalStore } from 'react'
import { TEMPLATE_BODY_MAX, TEMPLATE_NAME_MAX } from '../core/template'
import { BODY_COUNTER, SETTINGS_SUBTITLE, VARIABLES_HINT } from './copy'
import { canSaveEditor, type TemplatesStore } from './templates'

function EditorDialog({ store }: { store: TemplatesStore }) {
  const { editor } = useSyncExternalStore(store.subscribe, store.getSnapshot)

  useEffect(() => {
    if (!editor) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      store.closeEditor()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [editor !== null, store])

  if (!editor) return null
  return (
    <div className="overlay hf-overlay">
      <div className="dialog dialog-wide" role="dialog" aria-label={editor.id === null ? 'Add template' : 'Edit template'}>
        <h2>{editor.id === null ? 'Add template' : 'Edit template'}</h2>
        <div className="form">
          <label>
            <span>Name</span>
            <input
              type="text"
              aria-label="Name"
              maxLength={TEMPLATE_NAME_MAX}
              value={editor.name}
              onChange={(event) => store.setEditor({ name: event.target.value })}
            />
          </label>
          <label>
            <span>Instructions</span>
            <textarea
              aria-label="Instructions"
              rows={8}
              maxLength={TEMPLATE_BODY_MAX}
              value={editor.body}
              onChange={(event) => store.setEditor({ body: event.target.value })}
            />
          </label>
          <small className="muted hf-counter">{BODY_COUNTER(editor.body.length, TEMPLATE_BODY_MAX)}</small>
          <small className="muted">{VARIABLES_HINT}</small>
        </div>
        <div className="dialog-actions">
          <button type="button" onClick={() => store.closeEditor()}>
            Cancel
          </button>
          <button type="button" className="primary" disabled={!canSaveEditor(editor)} onClick={() => void store.saveEditor()}>
            Save template
          </button>
        </div>
      </div>
    </div>
  )
}

/** Settings > Session handoff: the template list with edit and remove, the count, add and reset. */
export function SettingsView({ store }: { store: TemplatesStore }) {
  const { templates, custom, limit, warning } = useSyncExternalStore(store.subscribe, store.getSnapshot)
  return (
    <div className="hf-settings">
      <header>
        <h1>Session handoff</h1>
        <p className="muted">{SETTINGS_SUBTITLE}</p>
      </header>
      {warning !== null && (
        <p className="hf-warning" role="status">
          {warning}
        </p>
      )}
      <ul className="hf-templates">
        {templates.map((template) => (
          <li key={template.id} data-template={template.id}>
            <div className="hf-template-text">
              <div className="hf-template-name">{template.name}</div>
              <div className="muted hf-template-body">{template.body}</div>
            </div>
            <div className="hf-template-actions">
              <button type="button" aria-label={`Edit ${template.name}`} onClick={() => store.editExisting(template.id)}>
                Edit
              </button>
              <button type="button" aria-label={`Remove ${template.name}`} onClick={() => void store.remove(template.id)}>
                Remove
              </button>
            </div>
          </li>
        ))}
      </ul>
      <div className="hf-settings-foot">
        <span className="muted">{`${templates.length} of ${limit} templates`}</span>
        <div className="hf-template-actions">
          <button type="button" disabled={!custom} onClick={() => void store.reset()}>
            Reset to defaults
          </button>
          <button type="button" className="primary" disabled={templates.length >= limit} onClick={() => store.editNew()}>
            Add template
          </button>
        </div>
      </div>
      <EditorDialog store={store} />
    </div>
  )
}
