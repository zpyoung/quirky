import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import type { EffectiveHooks, ProjectSettings, Repo, RepoDetails, UiPluginContext, Worktree } from '@quirky/protocol'
import { createWorkspace, type CreateHooks } from './actions'
import { Dialog } from './Dialog'
import { repoLabel, workspaceOption } from './report'

/** Offered when `quirky.agents` isn't there to say which agents are installed. */
const FALLBACK_AGENTS = [
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
  { id: 'opencode', label: 'OpenCode' },
  { id: 'gemini', label: 'Gemini' }
]

type AgentChoice = { id: string; label: string }

/** The installed, enabled agents `quirky.agents` reports, else the fallback list. */
async function loadAgents(context: UiPluginContext): Promise<AgentChoice[]> {
  try {
    const listed = (await context.call('quirky.agents/list')) as { agents?: { id: string; label: string; installed: boolean; enabled: boolean }[] }
    return (listed.agents ?? []).filter((a) => a.installed && a.enabled).map((a) => ({ id: a.id, label: a.label }))
  } catch {
    return FALLBACK_AGENTS
  }
}

type Props = {
  context: UiPluginContext
  repos: Repo[]
  worktrees: Worktree[]
  repoId: string
  onRepoChange(repoId: string): void
  onClose(): void
  /** Shows a pending row for `name` under the project until the returned function is called. */
  onPending(repoId: string, name: string): () => void
  hooks: CreateHooks
}

type Project = { settings: ProjectSettings | null; hooks: EffectiveHooks | null }

/** The project facts the form depends on; a project that can't report them (a folder) simply has no setup. */
async function loadProject(context: UiPluginContext, repoId: string): Promise<Project> {
  const [details, hooks] = await Promise.all([
    context.call('quirky.repo/show', { repo: repoId }).catch(() => null) as Promise<RepoDetails | null>,
    context.call('quirky.repo/hooks', { repo: repoId }).catch(() => null) as Promise<EffectiveHooks | null>
  ])
  return { settings: details?.settings ?? null, hooks }
}

/**
 * The full create form for a workspace: project, name, where it starts from, an optional agent and
 * the Advanced options. The setup choice, when the project asks for one, gates Create.
 */
export function CreateDialog({ context, repos, worktrees, repoId, onRepoChange, onClose, onPending, hooks }: Props) {
  const repo = repos.find((r) => r.id === repoId)
  const [name, setName] = useState('')
  const [base, setBase] = useState('')
  const [branch, setBranch] = useState('')
  const [agent, setAgent] = useState('')
  const [agents, setAgents] = useState<AgentChoice[]>([])
  const [prompt, setPrompt] = useState('')
  const [advanced, setAdvanced] = useState(false)
  const [displayName, setDisplayName] = useState('')
  const [branchName, setBranchName] = useState('')
  const [parent, setParent] = useState('')
  const [note, setNote] = useState('')
  const [setupChoice, setSetupChoice] = useState<'run' | 'skip' | null>(null)
  const [createMore, setCreateMore] = useState(false)
  const [busy, setBusy] = useState(false)
  const [placeholder, setPlaceholder] = useState('')
  const [suggestion, setSuggestion] = useState(0)
  const [project, setProject] = useState<Project | null>(null)
  const baseEdited = useRef(false)

  useEffect(() => {
    let live = true
    setProject(null)
    setSetupChoice(null)
    baseEdited.current = false
    setBase('')
    void loadProject(context, repoId).then((loaded) => {
      if (!live) return
      setProject(loaded)
      if (!baseEdited.current) setBase(loaded.settings?.defaultBase ?? '')
    })
    return () => {
      live = false
    }
  }, [context, repoId])

  useEffect(() => {
    let live = true
    void loadAgents(context).then((loaded) => live && setAgents(loaded))
    return () => {
      live = false
    }
  }, [context])

  useEffect(() => {
    let live = true
    context
      .call('quirky.worktree/suggestName', { repo: repoId })
      .then((result) => live && setPlaceholder((result as { name?: string }).name ?? ''))
      .catch(() => live && setPlaceholder(''))
    return () => {
      live = false
    }
  }, [context, repoId, suggestion])

  const folder = repo?.kind === 'folder'
  const setup = project?.hooks?.setup ?? null
  const asksForSetup = setup !== null && project?.settings?.setupPolicy === 'ask'
  const waitsForSetup = project?.hooks?.agentStartup === 'wait-for-setup'
  const defaultBase = project?.settings?.defaultBase ?? ''
  const fromBranch = branch.trim() !== ''
  const blocked = !repo || busy || (asksForSetup && setupChoice === null)

  const fields = (): Record<string, unknown> => {
    const typedBase = base.trim()
    return {
      repo: repoId,
      ...(name.trim() ? { name: name.trim() } : {}),
      ...(fromBranch ? { branch: branch.trim() } : typedBase && typedBase !== defaultBase ? { base: typedBase } : {}),
      ...(agent ? { agent, ...(prompt.trim() ? { prompt: prompt.trim() } : {}) } : {}),
      ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
      ...(branchName.trim() && !fromBranch ? { branchName: branchName.trim() } : {}),
      ...(parent ? { parent } : {}),
      ...(note.trim() ? { comment: note.trim() } : {}),
      ...(asksForSetup && setupChoice ? { setup: setupChoice } : {})
    }
  }

  const submit = async () => {
    if (blocked) return
    setBusy(true)
    const label = name.trim() || (fromBranch ? branch.trim() : placeholder) || 'new workspace'
    const clearPending = onPending(repoId, label)
    const result = await createWorkspace(context, fields(), hooks)
    clearPending()
    setBusy(false)
    if (!result) return
    if (!createMore) return onClose()
    setName('')
    setAgent('')
    setPrompt('')
    setSetupChoice(null)
    setSuggestion((n) => n + 1)
  }

  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    void submit()
  }
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      void submit()
    }
  }

  return (
    <Dialog title="New workspace" onClose={onClose} wide>
      <form className="form" onSubmit={onSubmit} onKeyDown={onKeyDown}>
        <label>
          <span>Project</span>
          <select value={repoId} onChange={(event) => onRepoChange(event.target.value)}>
            {repos.map((r) => (
              <option key={r.id} value={r.id}>
                {repoLabel(r)}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Name</span>
          <input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder={placeholder} />
        </label>
        {!folder && (
          <fieldset className="form-group">
            <legend>Create from</legend>
            {!fromBranch && (
              <label>
                <span>Base</span>
                <input
                  value={base}
                  onChange={(event) => {
                    baseEdited.current = true
                    setBase(event.target.value)
                  }}
                  placeholder="Default branch"
                />
              </label>
            )}
            <label>
              <span>Existing branch</span>
              <input value={branch} onChange={(event) => setBranch(event.target.value)} placeholder="Check out a branch that already exists" />
            </label>
          </fieldset>
        )}
        <label>
          <span>Agent</span>
          <select value={agent} onChange={(event) => setAgent(event.target.value)}>
            <option value="">None</option>
            {agents.map((choice) => (
              <option key={choice.id} value={choice.id}>
                {choice.label}
              </option>
            ))}
          </select>
        </label>
        {agent && (
          <label>
            <span>Prompt</span>
            <textarea rows={3} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="What should the agent do first?" />
          </label>
        )}
        <button type="button" className="disclosure" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>
          Advanced
        </button>
        {advanced && (
          <div className="form-advanced">
            <label>
              <span>Display name</span>
              <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
            </label>
            {!folder && !fromBranch && (
              <label>
                <span>Branch name</span>
                <input value={branchName} onChange={(event) => setBranchName(event.target.value)} placeholder="Generated from the name" />
              </label>
            )}
            <label>
              <span>Parent worktree</span>
              <select value={parent} onChange={(event) => setParent(event.target.value)}>
                <option value="">No parent</option>
                {worktrees.map((w) => (
                  <option key={w.id} value={w.id}>
                    {workspaceOption(w, repos)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Note</span>
              <textarea rows={2} value={note} onChange={(event) => setNote(event.target.value)} />
            </label>
            {setup && (
              <div className="setup-block">
                <div className="setup-heading">
                  <span>Setup script</span>
                  <span className="setup-badge">{setup.badge}</span>
                </div>
                <label className="check-row">
                  <input type="checkbox" checked={waitsForSetup} disabled readOnly title="Set in the project's settings" />
                  <span>Wait for setup to complete before starting agent</span>
                </label>
                {asksForSetup && (
                  <div className="setup-choice" role="group" aria-label="Run setup now?">
                    <span>Run setup now?</span>
                    <button type="button" className={setupChoice === 'run' ? 'primary' : ''} aria-pressed={setupChoice === 'run'} onClick={() => setSetupChoice('run')}>
                      Run setup now
                    </button>
                    <button type="button" className={setupChoice === 'skip' ? 'primary' : ''} aria-pressed={setupChoice === 'skip'} onClick={() => setSetupChoice('skip')}>
                      Skip for now
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
        <div className="dialog-actions dialog-actions-spread">
          <label className="check-row">
            <input type="checkbox" checked={createMore} onChange={(event) => setCreateMore(event.target.checked)} />
            <span>Create more</span>
          </label>
          {asksForSetup && setupChoice === null && <span className="muted">Choose whether to run setup, under Advanced.</span>}
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={blocked}>
            Create
          </button>
        </div>
      </form>
    </Dialog>
  )
}
