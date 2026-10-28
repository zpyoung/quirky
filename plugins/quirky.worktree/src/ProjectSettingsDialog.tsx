import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { HookScript, ProjectSettings, Repo, RepoDetails, UiPluginContext } from '@quirky/protocol'
import { Badge, Button, Dialog, FormRow, SectionHeader, TextField } from '@quirky/ui'
import { FolderPickerUnavailableError, messageOf, pickNativeFolder } from './actions'
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
    <div className="ui-stack">
      <div className="ui-cluster">
        <strong>{label}</strong>
        <Badge>{script.badge}</Badge>
      </div>
      <p className="ui-text-muted">Source: {source} · shared version: {trust}</p>
      <pre className="ui-text-mono ui-scroll">{shared.text}</pre>
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
    <Dialog open title={title} onClose={onClose} size="wide">
      {!form || !details ? (
        <p className="ui-text-muted" role="status">Loading…</p>
      ) : (
        <form className="ui-stack" onSubmit={save}>
          <TextField
            label="Display Name"
            id="project-display-name"
            autoFocus
            value={form.displayName}
            onChange={(event) => set('displayName', event.target.value)}
            placeholder={repo.name}
          />
          <TextField
            label="Project icon"
            id="project-icon"
            value={form.icon}
            onChange={(event) => set('icon', event.target.value)}
            maxLength={32}
            placeholder="Emoji or symbol"
            help="Plain-text emoji or symbols only; URLs, SVG and HTML are rejected."
          />
          <TextField
            label="Project color"
            id="project-color"
            value={form.color}
            onChange={(event) => set('color', event.target.value)}
            placeholder="Optional project color"
            help="Stored as project metadata; blank uses the shared default appearance."
          />
          <FormRow
            label="Tracker project"
            htmlFor="project-tracker-project"
            help="Choose an accessible provider project; the provider verifies the saved identity."
            error={trackerProjectError || undefined}
          >
            <select id="project-tracker-project" className="ui-text-field__input" value={form.trackerProject} onChange={(event) => set('trackerProject', event.target.value)}>
              <option value="">No default tracker project</option>
              {form.trackerProject && !trackerProjects.some((project) => project.url === form.trackerProject) &&
                <option value={form.trackerProject}>Saved project unavailable from provider</option>}
              {trackerProjects.map((project) => <option key={project.id} value={project.url}>{project.title}</option>)}
            </select>
          </FormRow>
          <FormRow label="External worktrees" htmlFor="project-external-visibility">
            <select id="project-external-visibility" className="ui-text-field__input" value={form.externalVisibility} onChange={(event) => set('externalVisibility', event.target.value as ExternalVisibility)}>
              <option value="inherit">Use global default</option>
              <option value="show">Show</option>
              <option value="hide">Hide</option>
            </select>
          </FormRow>
          <TextField label="Default Worktree Base" id="project-default-base" value={form.defaultBase} onChange={(event) => set('defaultBase', event.target.value)} placeholder="Default branch" />
          <TextField label="Worktree Location" id="project-worktree-location" value={form.worktreeLocation} onChange={(event) => set('worktreeLocation', event.target.value)} placeholder="Global worktrees folder" />
          <Button type="button" disabled={busy} onClick={() => void browseLocation()}>
            Browse worktree location
          </Button>
          {repo.kind === 'git' && (
            <FormRow
              label="Shared directories"
              htmlFor="project-shared-directories"
              help="Ignored relative directories linked from the primary checkout into each new worktree. One path per line."
            >
              <textarea
                id="project-shared-directories"
                rows={3}
                className="ui-text-field__input"
                value={form.sharedDirectories}
                onChange={(event) => set('sharedDirectories', event.target.value)}
                placeholder=".env.local&#10;config/private"
              />
            </FormRow>
          )}
          <FormRow label="Setup Script" htmlFor="project-setup-script">
            <textarea
              id="project-setup-script"
              rows={3}
              className="ui-text-field__input"
              value={form.setupScript}
              onChange={(event) => set('setupScript', event.target.value)}
              placeholder="Runs in each new workspace (local)"
            />
          </FormRow>
          <FormRow label="When to run" htmlFor="project-setup-policy">
            <select id="project-setup-policy" className="ui-text-field__input" value={form.setupPolicy} onChange={(event) => set('setupPolicy', event.target.value as Form['setupPolicy'])}>
              {POLICIES.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </FormRow>
          <label className="ui-checkbox-label">
            <input type="checkbox" checked={form.waitForSetup} onChange={(event) => set('waitForSetup', event.target.checked)} />
            <span>Wait for setup to complete before starting agent</span>
          </label>
          <FormRow label="Archive Script" htmlFor="project-archive-script">
            <textarea
              id="project-archive-script"
              rows={3}
              className="ui-text-field__input"
              value={form.archiveScript}
              onChange={(event) => set('archiveScript', event.target.value)}
              placeholder="Runs before a workspace is deleted (local)"
            />
          </FormRow>
          <FormRow
            label="Custom GitHub issue command"
            htmlFor="project-issue-command"
            help={`Use {{issue}} and {{artifact_url}}; shared commands require trust before running.`}
          >
            <textarea
              id="project-issue-command"
              rows={3}
              className="ui-text-field__input"
              value={form.issueCommand}
              onChange={(event) => set('issueCommand', event.target.value)}
              placeholder="Runs for GitHub issue worktrees only (local)"
            />
          </FormRow>
          <FormRow label="Command Source" htmlFor="project-command-source">
            <select id="project-command-source" className="ui-text-field__input" value={form.commandSource} onChange={(event) => set('commandSource', event.target.value)}>
              {SOURCES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </FormRow>
          {repo.kind === 'git' && (
            <section className="ui-stack" aria-label="Ledger Staleness">
              <div ref={ledgerSettingsMount} />
              {ledgerMountError && <p className="ui-error-text" role="alert">{ledgerMountError}</p>}
            </section>
          )}
          <section className="ui-stack" aria-label="Shared hooks">
            <SectionHeader title={details.hooks.file ? `Shared hooks (${details.hooks.file})` : 'Shared hooks'} />
            {!details.hooks.setup?.shared && !details.hooks.archive?.shared && !details.hooks.issueCommand?.shared && <p className="ui-text-muted">No shared scripts.</p>}
            <SharedScript label="Setup" script={details.hooks.setup} />
            <SharedScript label="Archive" script={details.hooks.archive} />
            <SharedScript label="GitHub issue command" script={details.hooks.issueCommand ?? null} />
            {details.hooks.warnings.length > 0 && (
              <ul className="ui-tree">
                {details.hooks.warnings.map((warning) => (
                  <li className="ui-tree-item" key={warning}>{warning}</li>
                ))}
              </ul>
            )}
          </section>
          <div className="ui-actions">
            <Button type="button" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={busy}>
              Save
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  )
}
