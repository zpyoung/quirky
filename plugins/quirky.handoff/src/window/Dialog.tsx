import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { TEMPLATE_BODY_MAX, TEMPLATE_NAME_MAX } from '../core/template'
import {
  agentsMessage,
  canStartOf,
  RELATIONSHIPS,
  visibleCandidates,
  warningsOf,
  type HandoffDialog,
  type Snapshot
} from './model'
import {
  BUSY_MESSAGE,
  DETACHED_NOTICE,
  DIALOG_DESCRIPTION,
  DIALOG_TITLE,
  FULL_UNREACHABLE,
  FULL_UNVERIFIABLE,
  secretsMarkerLine,
  WAITING_MESSAGE
} from './copy'
import { PreviewEditor } from './PreviewEditor'

const NEW_TEMPLATE = '__new__'

const relationshipLabel = (value: string) => `${value[0]!.toUpperCase()}${value.slice(1).replace('-', ' ')}`

function WorktreeCombobox({ dialog, snapshot, onOpenChange }: { dialog: HandoffDialog; snapshot: Snapshot; onOpenChange: (open: boolean) => void }) {
  const [open, setOpen] = useState(false)
  const shown = visibleCandidates(snapshot)
  const selected = snapshot.candidates.find((candidate) => candidate.id === snapshot.worktree)
  const toggle = (next: boolean) => {
    setOpen(next)
    onOpenChange(next)
    if (!next) dialog.search('')
  }
  return (
    <div className="hf-combo">
      <button
        type="button"
        role="combobox"
        aria-label="Worktree"
        aria-expanded={open}
        aria-haspopup="listbox"
        className="hf-combo-button"
        onClick={() => toggle(!open)}
      >
        {selected ? selected.name : 'Select a worktree'}
      </button>
      {selected && <div className="muted hf-path">{selected.path}</div>}
      {open && (
        <div className="hf-combo-pop">
          <input
            type="text"
            aria-label="Search worktrees"
            placeholder="Search worktrees…"
            autoFocus
            value={snapshot.search}
            onChange={(event) => dialog.search(event.target.value)}
          />
          <div role="listbox" aria-label="Worktrees">
            {shown.length === 0 ? (
              <div className="muted hf-empty">No matching worktrees.</div>
            ) : (
              shown.map((candidate) => (
                <button
                  key={candidate.id}
                  type="button"
                  role="option"
                  aria-selected={candidate.id === snapshot.worktree}
                  className="hf-option"
                  onClick={() => {
                    dialog.set('worktree', candidate.id)
                    toggle(false)
                  }}
                >
                  <span>{candidate.id === snapshot.worktree ? '✓ ' : ''}{candidate.name}</span>
                  <span className="muted hf-path">{candidate.path}</span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function Destination({ dialog, snapshot, onOpenChange }: { dialog: HandoffDialog; snapshot: Snapshot; onOpenChange: (open: boolean) => void }) {
  const creating = snapshot.mode === 'create'
  const message = agentsMessage(snapshot.agents)
  return (
    <fieldset className="form-group" disabled={snapshot.detached} aria-label="Destination">
      <legend>Destination</legend>
      {creating ? (
        <>
          <label>
            <span>Worktree name</span>
            <input
              type="text"
              aria-label="Worktree name"
              placeholder="handoff-follow-up"
              value={snapshot.createName}
              onChange={(event) => dialog.set('createName', event.target.value)}
            />
          </label>
          <label>
            <span>Base branch (optional)</span>
            <input
              type="text"
              aria-label="Base branch (optional)"
              placeholder="Current branch"
              value={snapshot.createBase}
              onChange={(event) => dialog.set('createBase', event.target.value)}
            />
          </label>
        </>
      ) : (
        <div>
          <span>Worktree</span>
          <WorktreeCombobox dialog={dialog} snapshot={snapshot} onOpenChange={onOpenChange} />
        </div>
      )}
      {snapshot.source?.canCreateWorktree && (
        <button type="button" onClick={() => dialog.set('create', !creating)}>
          {creating ? 'Use an existing worktree' : 'Create a new worktree'}
        </button>
      )}
      <label>
        <span>Agent</span>
        <select
          aria-label="Agent"
          value={snapshot.agent ?? ''}
          disabled={snapshot.agents.list.length === 0}
          onChange={(event) => dialog.set('agent', event.target.value)}
        >
          {snapshot.agents.list.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.label}
            </option>
          ))}
        </select>
      </label>
      {message !== null && (
        <small className="muted" data-agents-state={snapshot.agents.state}>
          {message}
        </small>
      )}
      <label>
        <span>Relationship</span>
        <select aria-label="Relationship" value={snapshot.relationship} onChange={(event) => dialog.set('relationship', event.target.value)}>
          {RELATIONSHIPS.map((value) => (
            <option key={value} value={value}>
              {relationshipLabel(value)}
            </option>
          ))}
        </select>
      </label>
    </fieldset>
  )
}

function Content({ dialog, snapshot }: { dialog: HandoffDialog; snapshot: Snapshot }) {
  const usable = snapshot.analysis?.probe.verdict === 'usable'
  const reason = snapshot.analysis?.probe.verdict === 'unverifiable' ? FULL_UNVERIFIABLE : FULL_UNREACHABLE
  const { include } = snapshot
  return (
    <fieldset className="form-group" disabled={snapshot.detached} aria-label="Content">
      <legend>Content</legend>
      <div role="radiogroup" aria-label="Session context" className="hf-radios">
        <span>Session context</span>
        <label>
          <input type="radio" name="hf-context" checked={snapshot.context === 'focused'} onChange={() => dialog.set('context', 'focused')} />
          <span>Focused handoff (Recommended)</span>
        </label>
        <small className="muted">Carries status hints and reads older transcript details only when needed.</small>
        <label>
          <input
            type="radio"
            name="hf-context"
            checked={snapshot.context === 'full'}
            disabled={!usable}
            onChange={() => dialog.set('context', 'full')}
          />
          <span>Full session transcript</span>
        </label>
        {!usable && snapshot.analysis !== null && <small className="muted">{reason}</small>}
      </div>
      <div className="hf-checks">
        <span>Include in brief</span>
        <label>
          <input type="checkbox" checked={include.repoState} onChange={(event) => dialog.set('repoState', event.target.checked)} />
          <span>Git status and changed file paths</span>
        </label>
        <label>
          <input
            type="checkbox"
            checked={include.diffBodies}
            disabled={!include.repoState}
            onChange={(event) => dialog.set('diffBodies', event.target.checked)}
          />
          <span>Diff bodies</span>
        </label>
        <small className="muted">Opt-in and capped at 12,000 characters.</small>
        <label>
          <input type="checkbox" checked={include.openEditorTabs} onChange={(event) => dialog.set('openEditorTabs', event.target.checked)} />
          <span>Open editor tabs</span>
        </label>
      </div>
    </fieldset>
  )
}

function Notes({ dialog, snapshot }: { dialog: HandoffDialog; snapshot: Snapshot }) {
  const editor = snapshot.templateEditor
  const name = editor?.name ?? ''
  return (
    <fieldset className="form-group" disabled={snapshot.detached} aria-label="Notes">
      <legend>Notes</legend>
      <label>
        <span>Reusable template</span>
        <select
          aria-label="Reusable template"
          value={editor ? NEW_TEMPLATE : (snapshot.templateId ?? '')}
          onChange={(event) => {
            const value = event.target.value
            dialog.set('template', value === NEW_TEMPLATE ? 'new' : value === '' ? null : value)
          }}
        >
          <option value="">No template</option>
          <option value={NEW_TEMPLATE}>New Template</option>
          {snapshot.templates.map((template) => (
            <option key={template.id} value={template.id}>
              {template.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Steering note</span>
        <textarea
          aria-label="Steering note"
          rows={4}
          placeholder="What should the new Agent focus on?"
          value={snapshot.note}
          onChange={(event) => dialog.set('note', event.target.value)}
        />
      </label>
      {editor && (
        <div className="hf-template-save">
          <label>
            <span>Template name</span>
            <input
              type="text"
              aria-label="Template name"
              maxLength={TEMPLATE_NAME_MAX}
              value={name}
              onChange={(event) => dialog.set('templateName', event.target.value)}
            />
          </label>
          <button type="button" disabled={!dialog.canSaveTemplate()} onClick={() => void dialog.saveTemplate()}>
            Save template
          </button>
          {snapshot.note.length > TEMPLATE_BODY_MAX && <small className="muted">The note is over {TEMPLATE_BODY_MAX.toLocaleString('en-US')} characters.</small>}
        </div>
      )}
    </fieldset>
  )
}

function Preview({ dialog, snapshot }: { dialog: HandoffDialog; snapshot: Snapshot }) {
  const { analysis } = snapshot
  const secrets = analysis?.secrets ?? []
  return (
    <div className="hf-right">
      <h3>Brief preview</h3>
      <div className="muted hf-cost" aria-live="polite">
        {analysis ? `${analysis.characters} characters · about ${analysis.tokens} tokens` : ' '}
      </div>
      <PreviewEditor text={snapshot.text} secrets={secrets} onEdit={(text) => dialog.edit(text)} />
      {secrets.length > 0 && <div className="hf-secrets-line">{secretsMarkerLine(secrets.length)}</div>}
      {snapshot.detached && (
        <div className="hf-detached">
          <span>{DETACHED_NOTICE}</span>
          <button type="button" onClick={() => void dialog.regenerate()}>
            Regenerate from controls
          </button>
        </div>
      )}
      <div className="hf-locked">
        <div className="muted hf-locked-title">Locked safety note · always appended last</div>
        <pre>{analysis?.notice ?? ''}</pre>
      </div>
    </div>
  )
}

function Strip({ dialog, snapshot }: { dialog: HandoffDialog; snapshot: Snapshot }) {
  const warnings = warningsOf(snapshot)
  return (
    <div className="hf-strips">
      {warnings.map((warning) => (
        <div key={warning.code} className="hf-warning" data-warning={warning.code}>
          {warning.message}
        </div>
      ))}
      {snapshot.working && (
        <div className="hf-warning hf-busy" data-busy>
          <span>{snapshot.waiting ? WAITING_MESSAGE : BUSY_MESSAGE}</span>
          <span className="hf-busy-actions">
            <button type="button" disabled={snapshot.waiting} onClick={() => dialog.waitIdle()}>
              Wait for idle
            </button>
            <button type="button" onClick={() => void dialog.capture()}>
              Capture anyway
            </button>
          </span>
        </div>
      )}
      {snapshot.error !== null && (
        <div className="hf-warning hf-error" role="alert">
          {snapshot.error}
        </div>
      )}
    </div>
  )
}

/**
 * Continue in New Session: destination, content and notes on the left, the editable brief on
 * the right, a strip of warnings above Cancel and Start New Session. Draws nothing while closed.
 */
export function Dialog({ dialog }: { dialog: HandoffDialog }) {
  const snapshot = useSyncExternalStore(dialog.subscribe, dialog.getSnapshot)
  const comboOpen = useRef(false)

  useEffect(() => {
    if (!snapshot.shown) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      if (comboOpen.current) return
      void dialog.cancel()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [snapshot.shown, dialog])

  if (!snapshot.shown) return null
  const { source } = snapshot
  return (
    <div className="overlay hf-overlay">
      <div className="dialog dialog-wide hf-dialog" role="dialog" aria-label={DIALOG_TITLE}>
        <h2>{DIALOG_TITLE}</h2>
        <p className="muted">{DIALOG_DESCRIPTION}</p>
        {source && (
          <div className="hf-source" data-source>
            <div>{source.title ?? source.session ?? 'Archived session'}</div>
            <div className="muted">{`Original Agent: ${source.agent}`}</div>
          </div>
        )}
        <div className="hf-columns">
          <div className="hf-left">
            <Destination dialog={dialog} snapshot={snapshot} onOpenChange={(open) => {
                comboOpen.current = open
              }} />
            <Content dialog={dialog} snapshot={snapshot} />
            <Notes dialog={dialog} snapshot={snapshot} />
          </div>
          <Preview dialog={dialog} snapshot={snapshot} />
        </div>
        <Strip dialog={dialog} snapshot={snapshot} />
        <div className="dialog-actions">
          <button type="button" disabled={snapshot.starting} onClick={() => void dialog.cancel()}>
            Cancel
          </button>
          <button type="button" className="primary" disabled={!canStartOf(snapshot)} onClick={() => void dialog.start()}>
            {snapshot.starting ? 'Starting…' : 'Start New Session'}
          </button>
        </div>
      </div>
    </div>
  )
}
