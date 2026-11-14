import { useEffect, useId, useState, useSyncExternalStore } from 'react'
import type { UiPluginContext } from '@quirky/protocol'
import {
  Button,
  Dialog as SharedDialog,
  EmptyState,
  InlineError,
  ListRow,
  NoticeLine,
  SectionHeader,
  SelectField,
  TextArea,
  TextField
} from '@quirky/ui'
import { TEMPLATE_BODY_MAX, TEMPLATE_NAME_MAX } from '../core/template'
import {
  canStartOf,
  RELATIONSHIPS,
  visibleCandidates,
  warningsOf,
  type HandoffDialog,
  type Snapshot
} from './model'
import {
  AGENTS_EMPTY,
  AGENTS_FAILED,
  AGENTS_LOADING,
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
const COMMAND_SET = 'command:quirky.handoff/set'
const COMMAND_REGENERATE = 'command:quirky.handoff/regenerate'
const COMMAND_WAIT_IDLE = 'command:quirky.handoff/wait-idle'
const COMMAND_CAPTURE = 'command:quirky.handoff/capture'
const COMMAND_SAVE_TEMPLATE = 'command:quirky.handoff/save-template'
const COMMAND_START = 'command:quirky.handoff/start'
const COMMAND_CANCEL = 'command:quirky.handoff/cancel'

const relationshipLabel = (value: string) => `${value[0]!.toUpperCase()}${value.slice(1).replace('-', ' ')}`

function WorktreeCombobox({
  dialog,
  snapshot,
  disabled,
  context,
  open,
  onToggleWorktree,
  onCloseWorktree
}: {
  dialog: HandoffDialog
  snapshot: Snapshot
  disabled: boolean
  context: UiPluginContext
  open: boolean
  onToggleWorktree: () => void
  onCloseWorktree: () => void
}) {
  const listboxId = useId()
  const shown = visibleCandidates(snapshot)
  const selected = snapshot.candidates.find((candidate) => candidate.id === snapshot.worktree)
  const selectedLabel = selected
    ? selected.remote ? `${selected.hostName ?? selected.remote.owner.hostId} · ${selected.name}` : selected.name
    : snapshot.target && 'remote' in snapshot.target ? `${snapshot.target.remote.owner.hostId} · unavailable workspace` : null

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
        onClick={onToggleWorktree}
      >
        {selectedLabel ?? 'Select a worktree'}
      </Button>
      {selected && <ListRow title={<span className="ui-text-muted">{selected.path}{selected.connected === false ? ' · Unavailable' : ''}</span>} />}
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
                    void context.executeCommand(COMMAND_SET, { field: 'worktree', value: candidate.id })
                    onCloseWorktree()
                  }}
                >
                  <span>{candidate.id === snapshot.worktree ? '✓ ' : ''}{candidate.remote ? `${candidate.hostName ?? candidate.remote.owner.hostId} · ` : ''}{candidate.name}</span>
                  <span className="ui-text-muted">{candidate.path}{candidate.connected === false ? ' · Unavailable' : ''}</span>
                </Button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function Destination({ dialog, snapshot, context, worktreeOpen, onToggleWorktree, onCloseWorktree }: {
  dialog: HandoffDialog
  snapshot: Snapshot
  context: UiPluginContext
  worktreeOpen: boolean
  onToggleWorktree: () => void
  onCloseWorktree: () => void
}) {
  const creating = snapshot.mode === 'create'
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
        <WorktreeCombobox dialog={dialog} snapshot={snapshot} context={context} disabled={disabled} open={worktreeOpen} onToggleWorktree={onToggleWorktree} onCloseWorktree={onCloseWorktree} />
      )}
      {snapshot.source?.canCreateWorktree && (
        <Button type="button" disabled={disabled} onClick={() => void context.executeCommand(COMMAND_SET, { field: 'create', value: !creating })}>
          {creating ? 'Use an existing worktree' : 'Create a new worktree'}
        </Button>
      )}
      <SelectField
        label="Agent"
        aria-label="Agent"
        value={snapshot.agent ?? ''}
        disabled={disabled || snapshot.agents.list.length === 0}
        onChange={(event) => void context.executeCommand(COMMAND_SET, { field: 'agent', value: event.target.value })}
      >
        {snapshot.agents.list.map((agent) => (
          <option key={agent.id} value={agent.id}>{agent.label}</option>
        ))}
      </SelectField>
      {snapshot.agents.state === 'loading' && <NoticeLine>{AGENTS_LOADING}</NoticeLine>}
      {snapshot.agents.state === 'failed' && <InlineError message={AGENTS_FAILED} />}
      {snapshot.agents.state === 'ready' && snapshot.agents.list.length === 0 && <EmptyState message={AGENTS_EMPTY} />}
      <SelectField
        label="Relationship"
        aria-label="Relationship"
        value={snapshot.relationship}
        disabled={disabled}
        onChange={(event) => void context.executeCommand(COMMAND_SET, { field: 'relationship', value: event.target.value })}
      >
        {RELATIONSHIPS.map((value) => (
          <option key={value} value={value}>{relationshipLabel(value)}</option>
        ))}
      </SelectField>
    </section>
  )
}

function Content({ snapshot, context }: { snapshot: Snapshot; context: UiPluginContext }) {
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
          <input type="radio" name="hf-context" checked={snapshot.context === 'focused'} disabled={disabled} onChange={() => void context.executeCommand(COMMAND_SET, { field: 'context', value: 'focused' })} />
          <span>Focused handoff (Recommended)</span>
        </label>
        <small className="ui-text-muted">Carries status hints and reads older transcript details only when needed.</small>
        <label className="ui-cluster">
          <input
            type="radio"
            name="hf-context"
            checked={snapshot.context === 'full'}
            disabled={disabled || !usable}
            onChange={() => void context.executeCommand(COMMAND_SET, { field: 'context', value: 'full' })}
          />
          <span>Full session transcript</span>
        </label>
        {!usable && snapshot.analysis !== null && <small className="ui-text-muted">{reason}</small>}
      </div>
      <div className="ui-stack">
        <span>Include in brief</span>
        <label className="ui-cluster">
          <input type="checkbox" checked={include.repoState} disabled={disabled} onChange={(event) => void context.executeCommand(COMMAND_SET, { field: 'repoState', value: event.target.checked })} />
          <span>Git status and changed file paths</span>
        </label>
        <label className="ui-cluster">
          <input
            type="checkbox"
            checked={include.diffBodies}
            disabled={disabled || !include.repoState}
            onChange={(event) => void context.executeCommand(COMMAND_SET, { field: 'diffBodies', value: event.target.checked })}
          />
          <span>Diff bodies</span>
        </label>
        <small className="ui-text-muted">Opt-in and capped at 12,000 characters.</small>
        <label className="ui-cluster">
          <input type="checkbox" checked={include.openEditorTabs} disabled={disabled} onChange={(event) => void context.executeCommand(COMMAND_SET, { field: 'openEditorTabs', value: event.target.checked })} />
          <span>Open editor tabs</span>
        </label>
      </div>
    </section>
  )
}

function Notes({ dialog, snapshot, context }: { dialog: HandoffDialog; snapshot: Snapshot; context: UiPluginContext }) {
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
          void context.executeCommand(COMMAND_SET, { field: 'template', value: value === NEW_TEMPLATE ? 'new' : value === '' ? null : value })
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
          <Button type="button" disabled={disabled || !dialog.canSaveTemplate()} onClick={() => void context.executeCommand(COMMAND_SAVE_TEMPLATE)}>
            Save template
          </Button>
          {snapshot.note.length > TEMPLATE_BODY_MAX && <small className="ui-text-muted">The note is over {TEMPLATE_BODY_MAX.toLocaleString('en-US')} characters.</small>}
        </div>
      )}
    </section>
  )
}

function Preview({ dialog, snapshot, context }: { dialog: HandoffDialog; snapshot: Snapshot; context: UiPluginContext }) {
  const { analysis } = snapshot
  const secrets = analysis?.secrets ?? []
  return (
    <section className="ui-stack" aria-label="Brief preview">
      <SectionHeader title="Brief preview" />
      <div className="ui-cluster ui-text-muted" aria-live="polite">
        {analysis ? `${analysis.characters} characters · about ${analysis.tokens} tokens` : ' '}
      </div>
      {snapshot.analysis === null && snapshot.previewing && <NoticeLine>Composing handoff preview…</NoticeLine>}
      <PreviewEditor text={snapshot.text} secrets={secrets} onEdit={(text) => dialog.edit(text)} />
      {secrets.length > 0 && <ListRow title={secretsMarkerLine(secrets.length)} status="failing" />}
      {snapshot.detached && (
        <ListRow
          title={DETACHED_NOTICE}
          status="needs-you"
          trailing={<Button type="button" onClick={() => void context.executeCommand(COMMAND_REGENERATE)}>Regenerate from controls</Button>}
        />
      )}
      <section className="ui-stack" aria-label="Locked safety note">
        <SectionHeader title="Locked safety note · always appended last" />
        <pre className="ui-readout">{analysis?.notice ?? ''}</pre>
      </section>
    </section>
  )
}

function Strip({ snapshot, context }: { snapshot: Snapshot; context: UiPluginContext }) {
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
                <Button type="button" disabled={snapshot.waiting} onClick={() => void context.executeCommand(COMMAND_WAIT_IDLE)}>Wait for idle</Button>
                <Button type="button" onClick={() => void context.executeCommand(COMMAND_CAPTURE)}>Capture anyway</Button>
              </div>
            )}
          />
        </div>
      )}
      {snapshot.error !== null && <InlineError message={snapshot.error} />}
    </div>
  )
}

/** Continue in New Session: all lifecycle state and reporting remain owned by HandoffDialog. */
export function Dialog({ dialog, context }: { dialog: HandoffDialog; context: UiPluginContext }) {
  const snapshot = useSyncExternalStore(dialog.subscribe, dialog.getSnapshot)
  const [worktreeOpen, setWorktreeOpen] = useState(false)
  useEffect(() => {
    if (!snapshot.shown) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      if (worktreeOpen) {
        setWorktreeOpen(false)
        dialog.search('')
        return
      }
      void context.executeCommand(COMMAND_CANCEL)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [snapshot.shown, worktreeOpen, dialog, context])

  return (
    <SharedDialog
      open={snapshot.shown}
      title={DIALOG_TITLE}
      closeOnBackdrop={false}
      onClose={() => void context.executeCommand(COMMAND_CANCEL)}
      actions={(
        <>
          <Button type="button" disabled={snapshot.starting} onClick={() => void context.executeCommand(COMMAND_CANCEL, { via: 'button' })}>Cancel</Button>
          <Button type="button" variant="primary" disabled={!canStartOf(snapshot)} onClick={() => void context.executeCommand(COMMAND_START)}>
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
          <Destination
            dialog={dialog}
            snapshot={snapshot}
            context={context}
            worktreeOpen={worktreeOpen}
            onToggleWorktree={() => {
              setWorktreeOpen(!worktreeOpen)
              if (worktreeOpen) dialog.search('')
            }}
            onCloseWorktree={() => {
              setWorktreeOpen(false)
              dialog.search('')
            }}
          />
          <Content snapshot={snapshot} context={context} />
          <Notes dialog={dialog} snapshot={snapshot} context={context} />
          <Preview dialog={dialog} snapshot={snapshot} context={context} />
        </div>
        <Strip snapshot={snapshot} context={context} />
      </div>
    </SharedDialog>
  )
}
