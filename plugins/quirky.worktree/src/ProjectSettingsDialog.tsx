import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { HookScript, ProjectSettings, Repo, RepoDetails, UiPluginContext } from '@quirky/protocol'
import { FolderPickerUnavailableError, messageOf, pickNativeFolder } from './actions'
import { Dialog } from './Dialog'
import { repoLabel } from './report'
import type { ExternalVisibility, WorktreeProjectIdentity } from './parity-types'
import { parseSharedDirectoriesText } from './shared-paths'
import { isSafeIcon } from './safe-icon'

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
  icon: string
  color: string
  trackerProject: string
  externalVisibility: ExternalVisibility
  defaultBase: string
  worktreeLocation: string
  sharedDirectories: string
  setupScript: string
  setupPolicy: ProjectSettings['setupPolicy']
  waitForSetup: boolean
  archiveScript: string
  issueCommand: string
  commandSource: string
}

type ProjectMetadata = {
  identity: WorktreeProjectIdentity
  externalVisibility: ExternalVisibility
  sharedDirectories: string[]
}
type TrackerProjectOption = { id: string; title: string; url: string }

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function trackerProjectOptionsOf(value: unknown): TrackerProjectOption[] | null {
  const response = recordOf(value)
  if (!Array.isArray(response?.projects)) return null
  const projects: TrackerProjectOption[] = []
  for (const raw of response.projects) {
    const project = recordOf(raw)
    if (!project || typeof project.id !== 'string' || typeof project.title !== 'string' || typeof project.url !== 'string') continue
    let url: URL
    try {
      url = new URL(project.url)
    } catch {
      continue
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) continue
    projects.push({ id: project.id, title: project.title, url: url.href })
  }
  return projects
}

function toForm(details: RepoDetails, project: ProjectMetadata): Form {
  const { settings, repo } = details
  return {
    displayName: repo.displayName ?? '',
    icon: project.identity.icon ?? '',
    color: project.identity.color ?? '',
    trackerProject: project.identity.trackerProject ?? '',
    externalVisibility: project.externalVisibility,
    defaultBase: settings.defaultBase ?? '',
    worktreeLocation: settings.worktreeLocation ?? '',
    sharedDirectories: project.sharedDirectories.join('\n'),
    setupScript: settings.setupScript,
    setupPolicy: settings.setupPolicy,
    waitForSetup: settings.agentStartup === 'wait-for-setup',
    archiveScript: settings.archiveScript,
    issueCommand: settings.issueCommand ?? '',
    commandSource: settings.commandSource ?? ''
  }
}

const TEXT_FIELDS = ['displayName', 'defaultBase', 'worktreeLocation', 'setupScript', 'archiveScript', 'issueCommand', 'setupPolicy', 'commandSource'] as const
const SCRIPT_FIELDS: Partial<Record<keyof Form, true>> = { setupScript: true, archiveScript: true, issueCommand: true }

/** The `quirky.repo/set` params for what differs from `before`; an emptied field is sent as '' to clear it. */
function changes(before: Form, after: Form): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of TEXT_FIELDS) {
    const next = SCRIPT_FIELDS[key] === true ? after[key] : after[key].trim()
    if (next !== before[key]) out[key] = next
  }
  if (after.waitForSetup !== before.waitForSetup) out.agentStartup = after.waitForSetup ? 'wait-for-setup' : 'start-immediately'
  return out
}

function SharedScript({ label, script }: { label: string; script: HookScript | null }) {
  const shared = script?.shared
  if (!script || !shared?.text) return null
  const source = script.source === 'both' ? 'Shared and local' : script.source === 'shared' ? 'Shared' : 'Local'
  const trust = shared.changed ? 'Changed since last trust' : shared.trusted ? 'Trusted' : 'Not trusted'
  return (
    <div className="shared-script">
      <div className="setup-heading">
        <span>{label}</span>
        <span className="setup-badge">{script.badge}</span>
      </div>
      <p className="muted">Source: {source} · shared version: {trust}</p>
      <pre className="script-preview">{shared.text}</pre>
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
  const ledgerSettingsMount = useRef<HTMLDivElement>(null)
  const [ledgerMountError, setLedgerMountError] = useState('')
  const formReady = form !== null
  const [trackerProjects, setTrackerProjects] = useState<TrackerProjectOption[]>([])
  const [trackerProjectError, setTrackerProjectError] = useState('')

  useEffect(() => {
    let live = true
    Promise.all([
      context.call('quirky.repo/show', { repo: repo.id }),
      context.call('quirky.worktree/projectMetadata', { repo: repo.id })
    ]).then(([result, projectResult]) => {
      if (!live) return
      const loaded = result as RepoDetails
      const project = projectResult as ProjectMetadata
      setDetails(loaded)
      setInitial(toForm(loaded, project))
      setForm(toForm(loaded, project))
    }).catch((error: unknown) => {
      if (!live) return
      context.toast('Could not load project settings', messageOf(error))
      close.current()
    })
    return () => {
      live = false
    }
  }, [context, repo.id])
  useEffect(() => {
    let live = true
    void context.call('quirky.hosting/projects', { worktree: repo.path }).then((value: unknown) => {
      if (!live) return
      const projects = trackerProjectOptionsOf(value)
      if (projects === null) setTrackerProjectError('The provider returned an invalid project catalog.')
      else setTrackerProjects(projects)
    }).catch((error: unknown) => {
      if (live) setTrackerProjectError(`Provider-backed tracker projects are unavailable: ${messageOf(error)}`)
    })
    return () => { live = false }
  }, [context, repo.id, repo.path])
  useEffect(() => {
    const element = ledgerSettingsMount.current
    if (repo.kind !== 'git' || !formReady || !element) return
    setLedgerMountError('')
    try {
      const unmount = context.mountView('view:quirky.ledger/settings', element, { repoId: repo.id })
      // Let the dialog's unmount commit finish before tearing down the embedded React root.
      return () => { queueMicrotask(unmount) }
    } catch (error) {
      setLedgerMountError(`Ledger Staleness is unavailable: ${messageOf(error)}`)
    }
  }, [context, repo.id, formReady])

  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((prev) => (prev ? { ...prev, [key]: value } : prev))

  const browseLocation = async () => {
    if (!form) return
    try {
      const selected = await pickNativeFolder(context, 'Choose worktree location', form.worktreeLocation.trim() || repo.path)
      if (selected !== null) set('worktreeLocation', selected)
    } catch (error) {
      context.toast(
        error instanceof FolderPickerUnavailableError ? 'Native folder picker unavailable' : 'Could not choose worktree location',
        messageOf(error)
      )
    }
  }

  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (!form || !initial || !details) return
    let sharedDirectories: string[]
    try {
      sharedDirectories = parseSharedDirectoriesText(form.sharedDirectories)
    } catch (error) {
      context.toast('Invalid shared directories', messageOf(error))
      return
    }
    const patch = changes(initial, form)
    if (!isSafeIcon(form.icon)) {
      context.toast('Invalid project icon', 'Use a plain-text emoji or symbol; URLs, SVG and HTML are not allowed.')
      return
    }
    const identityChanged = form.icon !== initial.icon || form.color !== initial.color || form.trackerProject !== initial.trackerProject ||
      form.externalVisibility !== initial.externalVisibility
    const sharedDirectoriesChanged = JSON.stringify(sharedDirectories) !== JSON.stringify(parseSharedDirectoriesText(initial.sharedDirectories))
    if (Object.keys(patch).length === 0 && !identityChanged && !sharedDirectoriesChanged) return onClose()
    setBusy(true)
    try {
      if (Object.keys(patch).length > 0) await context.call('quirky.repo/set', { repo: repo.id, ...patch })
      if (identityChanged || sharedDirectoriesChanged) await context.call('quirky.worktree/setProjectMetadata', {
        repo: repo.id,
        ...(identityChanged ? {
          identity: {
            icon: form.icon.trim() || null,
            color: form.color.trim() || null,
            trackerProject: form.trackerProject.trim() || null
          },
          externalVisibility: form.externalVisibility
        } : {}),
        ...(sharedDirectoriesChanged ? { sharedDirectories } : {})
      })
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
            <span>Project icon</span>
            <input value={form.icon} onChange={(event) => set('icon', event.target.value)} maxLength={32} placeholder="Emoji or symbol" />
            <small className="muted">Plain-text emoji or symbols only; URLs, SVG and HTML are rejected.</small>
          </label>
          <label>
            <span>Project color</span>
            <input value={form.color} onChange={(event) => set('color', event.target.value)} placeholder="#RRGGBB" />
          </label>
          <label>
            <span>Tracker project</span>
            <select value={form.trackerProject} onChange={(event) => set('trackerProject', event.target.value)}>
              <option value="">No default tracker project</option>
              {form.trackerProject && !trackerProjects.some((project) => project.url === form.trackerProject) &&
                <option value={form.trackerProject}>Saved project unavailable from provider</option>}
              {trackerProjects.map((project) => <option key={project.id} value={project.url}>{project.title}</option>)}
            </select>
            <small className="muted">{trackerProjectError || 'Choose an accessible provider project; the provider verifies the saved identity.'}</small>
          </label>
          <label>
            <span>External worktrees</span>
            <select value={form.externalVisibility} onChange={(event) => set('externalVisibility', event.target.value as ExternalVisibility)}>
              <option value="inherit">Use global default</option>
              <option value="show">Show</option>
              <option value="hide">Hide</option>
            </select>
          </label>
          <label>
            <span>Default Worktree Base</span>
            <input value={form.defaultBase} onChange={(event) => set('defaultBase', event.target.value)} placeholder="Default branch" />
          </label>
          <label>
            <span>Worktree Location</span>
            <input value={form.worktreeLocation} onChange={(event) => set('worktreeLocation', event.target.value)} placeholder="Global worktrees folder" />
          </label>
          <button type="button" disabled={busy} onClick={() => void browseLocation()}>
            Browse worktree location
          </button>
          {repo.kind === 'git' && (
            <label>
              <span>Shared directories</span>
              <textarea
                rows={3}
                value={form.sharedDirectories}
                onChange={(event) => set('sharedDirectories', event.target.value)}
                placeholder=".env.local&#10;config/private"
              />
              <small className="muted">Ignored relative directories linked from the primary checkout into each new worktree. One path per line.</small>
            </label>
          )}
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
            <span>Custom GitHub issue command</span>
            <textarea
              rows={3}
              value={form.issueCommand}
              onChange={(event) => set('issueCommand', event.target.value)}
              placeholder="Runs for GitHub issue worktrees only (local)"
            />
            <small className="muted">Use {'{{issue}}'} and {'{{artifact_url}}'}; shared commands require trust before running.</small>
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
          {repo.kind === 'git' && <section className="form-group" aria-label="Ledger Staleness">
            <div ref={ledgerSettingsMount} />
            {ledgerMountError && <p className="error" role="alert">{ledgerMountError}</p>}
          </section>}
          <section className="form-group shared-hooks" aria-label="Shared hooks">
            <h3>{details.hooks.file ? `Shared hooks (${details.hooks.file})` : 'Shared hooks'}</h3>
            {!details.hooks.setup?.shared && !details.hooks.archive?.shared && !details.hooks.issueCommand?.shared && <p className="muted">No shared scripts.</p>}
            <SharedScript label="Setup" script={details.hooks.setup} />
            <SharedScript label="Archive" script={details.hooks.archive} />
            <SharedScript label="GitHub issue command" script={details.hooks.issueCommand ?? null} />
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
