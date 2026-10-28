import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import {
  Button,
  Dialog as SharedDialog,
  EmptyState,
  ListRow,
  SectionHeader,
  SelectField,
  TextArea,
  TextField
} from '@quirky/ui'
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

function WorktreeCombobox({
  dialog,
  snapshot,
  disabled,
  onOpenChange
}: {
  dialog: HandoffDialog
  snapshot: Snapshot
  disabled: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [open, setOpen] = useState(false)
  const listboxId = useId()
  const shown = visibleCandidates(snapshot)
  const selected = snapshot.candidates.find((candidate) => candidate.id === snapshot.worktree)
  const toggle = (next: boolean) => {
    setOpen(next)
    onOpenChange(next)
    if (!next) dialog.search('')
  }

  return (
    <div className="ui-stack">
      <span>Worktree</span>
      <Button
        type="button"
        role="combobox"
        aria-label="Worktree"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={listboxId}
        disabled={disabled}
        onClick={() => toggle(!open)}
      >
        {selected ? selected.name : 'Select a worktree'}
      </Button>
      {selected && <ListRow title={<span className="ui-text-muted">{selected.path}</span>} />}
      {open && (
        <div className="ui-stack">
          <TextField
            label="Search worktrees"
            aria-label="Search worktrees"
            placeholder="Search worktrees…"
            autoFocus
            value={snapshot.search}
            disabled={disabled}
            onChange={(event) => dialog.search(event.target.value)}
          />
          <div id={listboxId} role="listbox" aria-label="Worktrees" className="ui-option-list ui-stack">
            {shown.length === 0 ? (
              <EmptyState message="No matching worktrees." />
            ) : (
              shown.map((candidate) => (
                <Button
                  key={candidate.id}
                  type="button"
                  role="option"
                  aria-selected={candidate.id === snapshot.worktree}
                  disabled={disabled}
                  onClick={() => {
                    dialog.set('worktree', candidate.id)
                    toggle(false)
                  }}
                >
                  <span>{candidate.id === snapshot.worktree ? '✓ ' : ''}{candidate.name}</span>
                  <span className="ui-text-muted">{candidate.path}</span>
                </Button>
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
  const disabled = snapshot.detached

  return (
    <section role="group" aria-label="Destination" aria-disabled={disabled || undefined} className="ui-stack">
      <SectionHeader title="Destination" />
      {creating ? (
        <div className="ui-stack">
          <TextField
            label="Worktree name"
            aria-label="Worktree name"
            type="text"
            placeholder="handoff-follow-up"
            value={snapshot.createName}
            disabled={disabled}
            onChange={(event) => dialog.set('createName', event.target.value)}
          />
          <TextField
            label="Base branch (optional)"
            aria-label="Base branch (optional)"
            type="text"
            placeholder="Current branch"
            value={snapshot.createBase}
            disabled={disabled}
            onChange={(event) => dialog.set('createBase', event.target.value)}
          />
        </div>
      ) : (
        <WorktreeCombobox dialog={dialog} snapshot={snapshot} disabled={disabled} onOpenChange={onOpenChange} />
      )}
      {snapshot.source?.canCreateWorktree && (
        <Button type="button" disabled={disabled} onClick={() => dialog.set('create', !creating)}>
          {creating ? 'Use an existing worktree' : 'Create a new worktree'}
        </Button>
      )}
      <SelectField
        label="Agent"
        aria-label="Agent"
        value={snapshot.agent ?? ''}
        disabled={disabled || snapshot.agents.list.length === 0}
        onChange={(event) => dialog.set('agent', event.target.value)}
      >
        {snapshot.agents.list.map((agent) => (
          <option key={agent.id} value={agent.id}>{agent.label}</option>
        ))}
      </SelectField>
      {message !== null && <p className="ui-text-muted" data-agents-state={snapshot.agents.state}>{message}</p>}
      <SelectField
        label="Relationship"
        aria-label="Relationship"
        value={snapshot.relationship}
        disabled={disabled}
        onChange={(event) => dialog.set('relationship', event.target.value)}
      >
        {RELATIONSHIPS.map((value) => (
          <option key={value} value={value}>{relationshipLabel(value)}</option>
        ))}
      </SelectField>
    </section>
  )
}

function Content({ dialog, snapshot }: { dialog: HandoffDialog; snapshot: Snapshot }) {
  const usable = snapshot.analysis?.probe.verdict === 'usable'
  const reason = snapshot.analysis?.probe.verdict === 'unverifiable' ? FULL_UNVERIFIABLE : FULL_UNREACHABLE
  const { include } = snapshot
  const disabled = snapshot.detached

  return (
    <section role="group" aria-label="Content" aria-disabled={disabled || undefined} className="ui-stack">
      <SectionHeader title="Content" />
      <div role="radiogroup" aria-label="Session context" className="ui-stack">
        <span>Session context</span>
        <label className="ui-cluster">
          <input type="radio" name="hf-context" checked={snapshot.context === 'focused'} disabled={disabled} onChange={() => dialog.set('context', 'focused')} />
          <span>Focused handoff (Recommended)</span>
        </label>
        <small className="ui-text-muted">Carries status hints and reads older transcript details only when needed.</small>
        <label className="ui-cluster">
          <input
            type="radio"
            name="hf-context"
            checked={snapshot.context === 'full'}
            disabled={disabled || !usable}
            onChange={() => dialog.set('context', 'full')}
          />
          <span>Full session transcript</span>
        </label>
        {!usable && snapshot.analysis !== null && <small className="ui-text-muted">{reason}</small>}
      </div>
      <div className="ui-stack">
        <span>Include in brief</span>
        <label className="ui-cluster">
          <input type="checkbox" checked={include.repoState} disabled={disabled} onChange={(event) => dialog.set('repoState', event.target.checked)} />
          <span>Git status and changed file paths</span>
        </label>
        <label className="ui-cluster">
          <input
            type="checkbox"
            checked={include.diffBodies}
            disabled={disabled || !include.repoState}
            onChange={(event) => dialog.set('diffBodies', event.target.checked)}
          />
          <span>Diff bodies</span>
        </label>
        <small className="ui-text-muted">Opt-in and capped at 12,000 characters.</small>
        <label className="ui-cluster">
          <input type="checkbox" checked={include.openEditorTabs} disabled={disabled} onChange={(event) => dialog.set('openEditorTabs', event.target.checked)} />
          <span>Open editor tabs</span>
        </label>
      </div>
    </section>
  )
}

function Notes({ dialog, snapshot }: { dialog: HandoffDialog; snapshot: Snapshot }) {
  const editor = snapshot.templateEditor
  const name = editor?.name ?? ''
  const disabled = snapshot.detached

  return (
    <section role="group" aria-label="Notes" aria-disabled={disabled || undefined} className="ui-stack">
      <SectionHeader title="Notes" />
      <SelectField
        label="Reusable template"
        aria-label="Reusable template"
        value={editor ? NEW_TEMPLATE : (snapshot.templateId ?? '')}
        disabled={disabled}
        onChange={(event) => {
          const value = event.target.value
          dialog.set('template', value === NEW_TEMPLATE ? 'new' : value === '' ? null : value)
        }}
      >
        <option value="">No template</option>
        <option value={NEW_TEMPLATE}>New Template</option>
        {snapshot.templates.map((template) => (
          <option key={template.id} value={template.id}>{template.name}</option>
        ))}
      </SelectField>
      <TextArea
        label="Steering note"
        aria-label="Steering note"
        rows={4}
        placeholder="What should the new Agent focus on?"
        value={snapshot.note}
        disabled={disabled}
        onChange={(event) => dialog.set('note', event.target.value)}
      />
      {editor && (
        <div className="ui-stack">
          <TextField
            label="Template name"
            aria-label="Template name"
            type="text"
            maxLength={TEMPLATE_NAME_MAX}
            value={name}
            disabled={disabled}
            onChange={(event) => dialog.set('templateName', event.target.value)}
          />
          <Button type="button" disabled={disabled || !dialog.canSaveTemplate()} onClick={() => void dialog.saveTemplate()}>
            Save template
          </Button>
          {snapshot.note.length > TEMPLATE_BODY_MAX && <small className="ui-text-muted">The note is over {TEMPLATE_BODY_MAX.toLocaleString('en-US')} characters.</small>}
        </div>
      )}
    </section>
  )
}

function Preview({ dialog, snapshot }: { dialog: HandoffDialog; snapshot: Snapshot }) {
  const { analysis } = snapshot
  const secrets = analysis?.secrets ?? []
  return (
    <section className="ui-stack" aria-label="Brief preview">
      <SectionHeader title="Brief preview" />
      <div className="ui-cluster ui-text-muted" aria-live="polite">
        {analysis ? `${analysis.characters} characters · about ${analysis.tokens} tokens` : ' '}
      </div>
      <PreviewEditor text={snapshot.text} secrets={secrets} onEdit={(text) => dialog.edit(text)} />
      {secrets.length > 0 && <ListRow title={secretsMarkerLine(secrets.length)} status="failing" />}
      {snapshot.detached && (
        <ListRow
          title={DETACHED_NOTICE}
          status="needs-you"
          trailing={<Button type="button" onClick={() => void dialog.regenerate()}>Regenerate from controls</Button>}
        />
      )}
      <section className="ui-stack" aria-label="Locked safety note">
        <SectionHeader title="Locked safety note · always appended last" />
        <pre className="ui-readout">{analysis?.notice ?? ''}</pre>
      </section>
    </section>
  )
}

function Strip({ dialog, snapshot }: { dialog: HandoffDialog; snapshot: Snapshot }) {
  const warnings = warningsOf(snapshot)
  return (
    <div className="ui-stack">
      {warnings.map((warning) => (
        <div key={warning.code} data-warning={warning.code}>
          <ListRow title={warning.message} status="needs-you" />
        </div>
      ))}
      {snapshot.working && (
        <div data-busy>
          <ListRow
            title={snapshot.waiting ? WAITING_MESSAGE : BUSY_MESSAGE}
            status="working"
            trailing={(
              <div className="ui-cluster">
                <Button type="button" disabled={snapshot.waiting} onClick={() => dialog.waitIdle()}>Wait for idle</Button>
                <Button type="button" onClick={() => void dialog.capture()}>Capture anyway</Button>
              </div>
            )}
          />
        </div>
      )}
      {snapshot.error !== null && <div role="alert"><ListRow title={snapshot.error} status="failing" /></div>}
    </div>
  )
}

/** Continue in New Session: all lifecycle state and reporting remain owned by HandoffDialog. */
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

  return (
    <SharedDialog
      open={snapshot.shown}
      title={DIALOG_TITLE}
      closeOnBackdrop={false}
      onClose={() => void dialog.cancel()}
      actions={(
        <>
          <Button type="button" disabled={snapshot.starting} onClick={() => void dialog.cancel()}>Cancel</Button>
          <Button type="button" variant="primary" disabled={!canStartOf(snapshot)} onClick={() => void dialog.start()}>
            {snapshot.starting ? 'Starting…' : 'Start New Session'}
          </Button>
        </>
      )}
    >
      <div className="ui-stack">
        <p className="ui-text-muted">{DIALOG_DESCRIPTION}</p>
        {snapshot.source && (
          <div data-source>
            <ListRow
              title={snapshot.source.title ?? snapshot.source.session ?? 'Archived session'}
              description={`Original Agent: ${snapshot.source.agent}`}
            />
          </div>
        )}
        <div className="ui-stack">
          <Destination dialog={dialog} snapshot={snapshot} onOpenChange={(open) => { comboOpen.current = open }} />
          <Content dialog={dialog} snapshot={snapshot} />
          <Notes dialog={dialog} snapshot={snapshot} />
          <Preview dialog={dialog} snapshot={snapshot} />
        </div>
        <Strip dialog={dialog} snapshot={snapshot} />
      </div>
    </SharedDialog>
  )
}
