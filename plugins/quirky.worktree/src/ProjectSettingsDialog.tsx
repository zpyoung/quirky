import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { HookScript, ProjectSettings, Repo, RepoDetails, UiPluginContext } from '@quirky/protocol'
import { messageOf } from './actions'
import { Dialog } from './Dialog'
import { repoLabel } from './report'

type Props = { context: UiPluginContext; repo: Repo; onClose(): void }

const POLICIES: { value: ProjectSettings['setupPolicy']; label: string }[] = [
  { value: 'ask', label: 'Ask every time' },
  { value: 'run-by-default', label: 'Run by default' },
  { value: 'skip-by-default', label: 'Skip by default' }
]

const SOURCES: { value: string; label: string }[] = [
  { value: '', label: 'Inherit' },
  { value: 'shared-only', label: 'orca.yaml/quirky.yaml only' },
  { value: 'local-only', label: 'Local only' },
  { value: 'run-both', label: 'Run both' }
]

/** The editable fields, as the form holds them: text fields never null. */
type Form = {
  displayName: string
  defaultBase: string
  worktreeLocation: string
  setupScript: string
  setupPolicy: ProjectSettings['setupPolicy']
  waitForSetup: boolean
  archiveScript: string
  commandSource: string
}

function toForm(details: RepoDetails): Form {
  const { settings, repo } = details
  return {
    displayName: repo.displayName ?? '',
    defaultBase: settings.defaultBase ?? '',
    worktreeLocation: settings.worktreeLocation ?? '',
    setupScript: settings.setupScript,
    setupPolicy: settings.setupPolicy,
    waitForSetup: settings.agentStartup === 'wait-for-setup',
    archiveScript: settings.archiveScript,
    commandSource: settings.commandSource ?? ''
  }
}

const TEXT_FIELDS = ['displayName', 'defaultBase', 'worktreeLocation', 'setupScript', 'archiveScript', 'setupPolicy', 'commandSource'] as const
const SCRIPT_FIELDS = new Set<string>(['setupScript', 'archiveScript'])

/** The `quirky.repo/set` params for what differs from `before`; an emptied field is sent as '' to clear it. */
function changes(before: Form, after: Form): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of TEXT_FIELDS) {
    const next = SCRIPT_FIELDS.has(key) ? after[key] : after[key].trim()
    if (next !== before[key]) out[key] = next
  }
  if (after.waitForSetup !== before.waitForSetup) out.agentStartup = after.waitForSetup ? 'wait-for-setup' : 'start-immediately'
  return out
}

function SharedScript({ label, script }: { label: string; script: HookScript | null }) {
  const text = script?.shared?.text
  if (!text) return null
  return (
    <div className="shared-script">
      <div className="setup-heading">
        <span>{label}</span>
        <span className="setup-badge">{script!.badge}</span>
      </div>
      <pre className="script-preview">{text}</pre>
    </div>
  )
}

/** Edits a project's settings and shows, read-only, the scripts its shared hooks file provides. */
export function ProjectSettingsDialog({ context, repo, onClose }: Props) {
  const [details, setDetails] = useState<RepoDetails | null>(null)
  const [initial, setInitial] = useState<Form | null>(null)
  const [form, setForm] = useState<Form | null>(null)
  const [busy, setBusy] = useState(false)
  const close = useRef(onClose)
  close.current = onClose
  const title = `Project Settings > ${repoLabel(repo)}`

  useEffect(() => {
    let live = true
    context
      .call('quirky.repo/show', { repo: repo.id })
      .then((result) => {
        if (!live) return
        const loaded = result as RepoDetails
        setDetails(loaded)
        setInitial(toForm(loaded))
        setForm(toForm(loaded))
      })
      .catch((error: unknown) => {
        if (!live) return
        context.toast('Could not load project settings', messageOf(error))
        close.current()
      })
    return () => {
      live = false
    }
  }, [context, repo.id])

  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((prev) => (prev ? { ...prev, [key]: value } : prev))

  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (!form || !initial || !details) return
    const patch = changes(initial, form)
    if (Object.keys(patch).length === 0) return onClose()
    setBusy(true)
    try {
      await context.call('quirky.repo/set', { repo: repo.id, ...patch })
      onClose()
    } catch (error) {
      context.toast('Could not save project settings', messageOf(error))
      setBusy(false)
    }
  }

  return (
    <Dialog title={title} onClose={onClose} wide>
      {!form || !details ? (
        <p className="muted">Loading…</p>
      ) : (
        <form className="form" onSubmit={save}>
          <label>
            <span>Display Name</span>
            <input autoFocus value={form.displayName} onChange={(event) => set('displayName', event.target.value)} placeholder={repo.name} />
          </label>
          <label>
            <span>Default Worktree Base</span>
            <input value={form.defaultBase} onChange={(event) => set('defaultBase', event.target.value)} placeholder="Default branch" />
          </label>
          <label>
            <span>Worktree Location</span>
            <input value={form.worktreeLocation} onChange={(event) => set('worktreeLocation', event.target.value)} placeholder="Global worktrees folder" />
          </label>
          <label>
            <span>Setup Script</span>
            <textarea rows={3} value={form.setupScript} onChange={(event) => set('setupScript', event.target.value)} placeholder="Runs in each new workspace (local)" />
          </label>
          <label>
            <span>When to run</span>
            <select value={form.setupPolicy} onChange={(event) => set('setupPolicy', event.target.value as Form['setupPolicy'])}>
              {POLICIES.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <label className="check-row">
            <input type="checkbox" checked={form.waitForSetup} onChange={(event) => set('waitForSetup', event.target.checked)} />
            <span>Wait for setup to complete before starting agent</span>
          </label>
          <label>
            <span>Archive Script</span>
            <textarea rows={3} value={form.archiveScript} onChange={(event) => set('archiveScript', event.target.value)} placeholder="Runs before a workspace is deleted (local)" />
          </label>
          <label>
            <span>Command Source</span>
            <select value={form.commandSource} onChange={(event) => set('commandSource', event.target.value)}>
              {SOURCES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <section className="form-group shared-hooks" aria-label="Shared hooks">
            <h3>{details.hooks.file ? `Shared hooks (${details.hooks.file})` : 'Shared hooks'}</h3>
            {!details.hooks.setup?.shared && !details.hooks.archive?.shared && <p className="muted">No shared scripts.</p>}
            <SharedScript label="Setup" script={details.hooks.setup} />
            <SharedScript label="Archive" script={details.hooks.archive} />
            {details.hooks.warnings.length > 0 && (
              <ul className="hook-warnings">
                {details.hooks.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            )}
          </section>
          <div className="dialog-actions">
            <button type="button" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="primary" disabled={busy}>
              Save
            </button>
          </div>
        </form>
      )}
    </Dialog>
  )
}
