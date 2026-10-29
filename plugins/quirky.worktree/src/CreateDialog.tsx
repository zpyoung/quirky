import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import type { EffectiveHooks, GitHubWorktreeSource, ProjectSettings, Repo, RepoDetails, UiPluginContext, Worktree } from '@quirky/protocol'
import { Badge, Button, Dialog, FormRow, Tabs, TextField } from '@quirky/ui'
import { createWorkspace, messageOf, SETUP_CHOICE_NEEDED, type CreateHooks } from './actions'
import { isGitHubWorktreeReference, parseWorkItemsPage, parseWorktreeSource, type GitHubWorkItem } from './github'
import { repoLabel, workspaceOption } from './report'

/** Offered when `quirky.agents` isn't there to say which agents are installed. */
const FALLBACK_AGENTS = [
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
  { id: 'opencode', label: 'OpenCode' },
  { id: 'gemini', label: 'Gemini' }
]

type AgentChoice = { id: string; label: string }
type LaunchOption = {
  id: string
  label: string
  type: 'select' | 'boolean'
  choices: { value: string; label: string }[] | null
}
type AgentOptionsCatalog = {
  supported: boolean
  models: { id: string; label: string; options: LaunchOption[] }[]
  unlisted: 'accept' | 'refuse'
  unlistedOptions: LaunchOption[]
}
type AgentOptionsState = {
  agent: string
  status: 'loading' | 'ready' | 'error'
  catalog?: AgentOptionsCatalog
  error?: string
}

function optionOf(value: unknown): LaunchOption | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const option = value as Record<string, unknown>
  if (typeof option.id !== 'string' || typeof option.label !== 'string' || (option.type !== 'select' && option.type !== 'boolean')) return null
  if (option.choices !== null && (!Array.isArray(option.choices) || !option.choices.every((choice) =>
    typeof choice === 'object' && choice !== null && typeof (choice as Record<string, unknown>).value === 'string' &&
    typeof (choice as Record<string, unknown>).label === 'string'
  ))) return null
  return {
    id: option.id,
    label: option.label,
    type: option.type,
    choices: option.choices === null ? null : (option.choices as { value: string; label: string }[])
  }
}

function agentOptionsOf(value: unknown): AgentOptionsCatalog {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Agent returned an invalid option catalog.')
  const catalog = value as Record<string, unknown>
  if (
    typeof catalog.supported !== 'boolean' || !Array.isArray(catalog.models) ||
    (catalog.unlisted !== 'accept' && catalog.unlisted !== 'refuse') || !Array.isArray(catalog.unlistedOptions)
  ) throw new Error('Agent returned an invalid option catalog.')
  const models = catalog.models.flatMap((model) => {
    if (typeof model !== 'object' || model === null || Array.isArray(model)) return []
    const entry = model as Record<string, unknown>
    if (typeof entry.id !== 'string' || typeof entry.label !== 'string' || !Array.isArray(entry.options)) return []
    return [{ id: entry.id, label: entry.label, options: entry.options.map(optionOf).filter((option): option is LaunchOption => option !== null) }]
  })
  return {
    supported: catalog.supported,
    models,
    unlisted: catalog.unlisted,
    unlistedOptions: catalog.unlistedOptions.map(optionOf).filter((option): option is LaunchOption => option !== null)
  }
}

/** The installed, enabled agents `quirky.agents` reports, else the fallback list. */
async function loadAgents(context: UiPluginContext): Promise<AgentChoice[]> {
  try {
    const result = (await context.call('quirky.agents/list', {})) as {
      agents?: (AgentChoice & { installed: boolean; enabled: boolean })[]
    }
    const agents = result.agents?.filter((candidate) => candidate.installed && candidate.enabled)
    return agents?.length ? agents.map(({ id, label }) => ({ id, label })) : FALLBACK_AGENTS
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

type DefaultTabTemplate = { title?: string; color?: string; command?: string }
type CreateHooksInfo = EffectiveHooks & {
  defaultTabs?: DefaultTabTemplate[]
  environmentRecipes?: Array<{ id: string; name: string; create: string }>
  environmentRecipeDiagnostics?: Array<{ index: number; field?: string; message: string }>
}
type Project = { settings: ProjectSettings | null; hooks: CreateHooksInfo | null }
type HostChoice = { id: string; label: string; available: boolean; capabilities: string[] }
type Mode = 'smart' | 'github' | 'branch' | 'name'
const SOURCE_TABS = [
  { id: 'smart', label: 'Smart' },
  { id: 'github', label: 'GitHub' },
  { id: 'branch', label: 'Branch' },
  { id: 'name', label: 'Name' }
] as const
type SearchState = {
  repoId: string
  primaryId: string
  query: string
  status: 'loading' | 'ready' | 'error'
  items: GitHubWorkItem[]
  errors: string[]
  error?: string
}
type SelectedSource = { repoId: string; primaryId: string; source: GitHubWorktreeSource }
type BranchRef = { name: string; kind: 'local' | 'remote' }
type BranchSearchState = {
  repoId: string
  primaryId: string
  query: string
  status: 'loading' | 'ready' | 'error'
  refs: BranchRef[]
  error?: string
}
type ActiveInput = { repoId: string; primaryId: string | undefined; mode: Mode; smartInput: string; query: string; branch: string }

function isBranchRef(value: unknown): value is BranchRef {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const ref = value as Record<string, unknown>
  return typeof ref.name === 'string' && (ref.kind === 'local' || ref.kind === 'remote')
}

function parseBranchRefs(value: unknown): BranchRef[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || !('refs' in value) || !Array.isArray(value.refs)) {
    throw new Error('Git returned an invalid branch search response.')
  }
  return value.refs.filter(isBranchRef)
}

function hostChoicesOf(value: unknown): HostChoice[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || !('hosts' in value) || !Array.isArray(value.hosts)) {
    throw new Error('The authenticated peer owner returned an invalid host list.')
  }
  const hosts: HostChoice[] = []
  for (const raw of value.hosts) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('The authenticated peer owner returned an invalid host entry.')
    const host = raw as Record<string, unknown>
    if (typeof host.id !== 'string' || typeof host.label !== 'string' || typeof host.available !== 'boolean' ||
      !Array.isArray(host.capabilities) || !host.capabilities.every((capability) => typeof capability === 'string')) {
      throw new Error('The authenticated peer owner returned incomplete host identity evidence.')
    }
    hosts.push({ id: host.id, label: host.label, available: host.available, capabilities: host.capabilities })
  }
  return hosts
}
/** The project facts the form depends on; a project that can't report them (a folder) simply has no setup. */
async function loadProject(context: UiPluginContext, repoId: string): Promise<Project> {
  const [details, hooks] = await Promise.all([
    context.call('quirky.repo/show', { repo: repoId }).catch(() => null) as Promise<RepoDetails | null>,
    context.call('quirky.repo/hooks', { repo: repoId }).catch(() => null) as Promise<CreateHooksInfo | null>
  ])
  return { settings: details?.settings ?? null, hooks }
}

/**
 * The full create form for a workspace: project, a smart GitHub/name composer, an optional agent
 * and Advanced options. A setup choice, when the project asks for one, gates Create.
 */
export function CreateDialog({ context, repos, worktrees, repoId, onRepoChange, onClose, onPending, hooks }: Props) {
  const repo = repos.find((r) => r.id === repoId)
  const primary = worktrees.find((w) => w.repoId === repoId && w.isMain)
  const folder = repo?.kind === 'folder'
  const [mode, setMode] = useState<Mode>(folder ? 'name' : 'smart')
  const [name, setName] = useState('')
  const [base, setBase] = useState('')
  const [smartInput, setSmartInput] = useState('')
  const [query, setQuery] = useState('')
  const [branch, setBranch] = useState('')
  const [agent, setAgent] = useState('')
  const [agents, setAgents] = useState<AgentChoice[]>([])
  const [model, setModel] = useState('')
  const [launchPicks, setLaunchPicks] = useState<Record<string, string | boolean>>({})
  const [agentOptionsState, setAgentOptionsState] = useState<AgentOptionsState | null>(null)
  const [sparsePathsText, setSparsePathsText] = useState('')
  const [keepMain, setKeepMain] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [submitPrompt, setSubmitPrompt] = useState<boolean | null>(null)
  const [advanced, setAdvanced] = useState(false)
  const [displayName, setDisplayName] = useState('')
  const [branchName, setBranchName] = useState('')
  const [parent, setParent] = useState('')
  const [note, setNote] = useState('')
  const [setupChoice, setSetupChoice] = useState<'run' | 'skip' | null>(null)
  const [choiceDemanded, setChoiceDemanded] = useState(false)
  const [createMore, setCreateMore] = useState(false)
  const [busy, setBusy] = useState(false)
  const [placeholder, setPlaceholder] = useState('')
  const [suggestion, setSuggestion] = useState(0)
  const [project, setProject] = useState<Project | null>(null)
  const [selectedDefaultTabs, setSelectedDefaultTabs] = useState<string[]>([])
  const [hostChoices, setHostChoices] = useState<HostChoice[]>([])
  const [selectedHost, setSelectedHost] = useState('')
  const [hostError, setHostError] = useState('')
  const [search, setSearch] = useState<SearchState | null>(null)
  const [branchSearch, setBranchSearch] = useState<BranchSearchState | null>(null)
  const [selectedSource, setSelectedSource] = useState<SelectedSource | null>(null)
  const [sourceBusy, setSourceBusy] = useState(false)
  const [sourceError, setSourceError] = useState<string | null>(null)
  const baseEdited = useRef(false)
  const sourceRequest = useRef(0)
  const searchRequest = useRef(0)
  const branchRequest = useRef(0)
  const activeInput = useRef<ActiveInput>({ repoId, primaryId: primary?.id, mode, smartInput: '', query: '', branch: '' })
  activeInput.current = { repoId, primaryId: primary?.id, mode, smartInput: smartInput.trim(), query: query.trim(), branch: branch.trim() }

  useEffect(() => {
    let live = true
    sourceRequest.current += 1
    searchRequest.current += 1
    branchRequest.current += 1
    setSelectedDefaultTabs([])
    setSelectedHost('')
    setProject(null)
    setSetupChoice(null)
    setModel('')
    setLaunchPicks({})
    setSparsePathsText('')
    setKeepMain(false)
    setChoiceDemanded(false)
    setSelectedSource(null)
    setSubmitPrompt(null)
    setSourceBusy(false)
    setSourceError(null)
    setSearch(null)
    setBranchSearch(null)
    setSmartInput('')
    setQuery('')
    setMode(repo?.kind === 'folder' ? 'name' : 'smart')
    baseEdited.current = false
    setBase('')
    void loadProject(context, repoId).then((loaded) => {
      if (!live) return
      setProject(loaded)
      if (!baseEdited.current) setBase(loaded.settings?.defaultBase ?? '')
      setSelectedDefaultTabs(loaded.hooks?.defaultTabs?.map((_, index) => String(index + 1)) ?? [])
    })
    return () => {
      live = false
    }
  }, [context, repoId, repo?.kind])
  useEffect(() => {
    let live = true
    setHostChoices([])
    setHostError('')
    void context.call('quirky.worktree/availableHosts', {}).then((value: unknown) => {
      if (live) setHostChoices(hostChoicesOf(value))
    }).catch((error: unknown) => {
      if (live) setHostError(messageOf(error))
    })
    return () => { live = false }
  }, [context, repoId])
  useEffect(() => {
    if (!repo || folder || !project || selectedHost !== '' || sparsePathsText.trim() !== '' || selectedSource !== null ||
      mode === 'github' || (mode === 'branch' && branch.trim() !== '') || isGitHubWorktreeReference(smartInput.trim()) ||
      (project.hooks?.environmentRecipes?.length ?? 0) > 0) return
    const timer = setTimeout(() => {
      void context.call('quirky.worktree/prefetchCreate', {
        repo: repo.id,
        ...(base.trim() === '' ? {} : { base: base.trim() })
      }).catch((error: unknown) => context.log(`could not prefetch a worktree base for ${repo.id}: ${messageOf(error)}`))
    }, 200)
    return () => clearTimeout(timer)
  }, [context, repo, folder, project, selectedHost, sparsePathsText, selectedSource, mode, branch, smartInput, base])

  useEffect(() => {
    let live = true
    void loadAgents(context).then((loaded) => live && setAgents(loaded))
    return () => {
      live = false
    }
  }, [context])
  useEffect(() => {
    if (!agent) {
      setAgentOptionsState(null)
      return
    }
    let live = true
    setAgentOptionsState({ agent, status: 'loading' })
    void context.call('quirky.agents/options', { agent })
      .then((value) => {
        if (!live) return
        try {
          setAgentOptionsState({ agent, status: 'ready', catalog: agentOptionsOf(value) })
        } catch (error) {
          setAgentOptionsState({ agent, status: 'error', error: messageOf(error) })
        }
      })
      .catch((error: unknown) => {
        if (live) setAgentOptionsState({ agent, status: 'error', error: messageOf(error) })
      })
    return () => {
      live = false
    }
  }, [context, agent])

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

  const requestSource = useCallback(
    async (reference: string, expectedMode: 'smart' | 'github', expectedValue: string) => {
      if (!primary || repo?.kind !== 'git') {
        setSourceError('GitHub worktrees need a primary Git worktree.')
        return
      }
      const ticket = ++sourceRequest.current
      const requestedRepoId = repoId
      const requestedPrimaryId = primary.id
      const isCurrent = () => {
        const input = activeInput.current
        return sourceRequest.current === ticket &&
          input.repoId === requestedRepoId &&
          input.primaryId === requestedPrimaryId &&
          input.mode === expectedMode &&
          (expectedMode === 'smart' ? input.smartInput : input.query) === expectedValue
      }
      setSelectedSource(null)
      setSourceBusy(true)
      setSubmitPrompt(null)
      setSourceError(null)
      try {
        const result = parseWorktreeSource(await context.call('quirky.hosting/worktreeSource', { worktree: primary.id, reference }))
        if (isCurrent()) setSelectedSource({ repoId: requestedRepoId, primaryId: requestedPrimaryId, source: result })
      } catch (error) {
        if (isCurrent()) setSourceError(messageOf(error))
      } finally {
        if (isCurrent()) setSourceBusy(false)
      }
    },
    [context, primary?.id, repo?.kind, repoId]
  )

  useEffect(() => {
    const reference = smartInput.trim()
    if (mode !== 'smart' || folder || !isGitHubWorktreeReference(reference)) return
    void requestSource(reference, 'smart', reference)
    return () => {
      sourceRequest.current += 1
    }
  }, [mode, smartInput, folder, requestSource])

  useEffect(() => {
    if (mode !== 'github' || folder) {
      setSearch(null)
      return
    }
    if (!primary) {
      setSearch({ repoId, primaryId: '', query: query.trim(), status: 'error', items: [], errors: [], error: 'GitHub search needs a primary Git worktree.' })
      return
    }
    const ticket = ++searchRequest.current
    const requestedRepoId = repoId
    const requestedPrimaryId = primary.id
    const requestedQuery = query.trim()
    const isCurrent = () => {
      const input = activeInput.current
      return searchRequest.current === ticket && input.repoId === requestedRepoId && input.primaryId === requestedPrimaryId &&
        input.mode === 'github' && input.query === requestedQuery
    }
    setSearch({ repoId, primaryId: primary.id, query: requestedQuery, status: 'loading', items: [], errors: [] })
    void context
      .call('quirky.hosting/listWorkItems', { worktree: primary.id, query: requestedQuery, page: 1, limit: 30 })
      .then((raw) => {
        if (!isCurrent()) return
        const page = parseWorkItemsPage(raw)
        setSearch({ repoId, primaryId: primary.id, query: requestedQuery, status: 'ready', items: page.items, errors: page.errors })
      })
      .catch((error: unknown) => {
        if (isCurrent()) setSearch({ repoId, primaryId: primary.id, query: requestedQuery, status: 'error', items: [], errors: [], error: messageOf(error) })
      })
    return () => {
      if (searchRequest.current === ticket) searchRequest.current += 1
    }
  }, [context, mode, query, repoId, folder, primary?.id])

  useEffect(() => {
    if (mode !== 'branch' || folder) {
      setBranchSearch(null)
      return
    }
    if (!primary) {
      setBranchSearch({ repoId, primaryId: '', query: branch.trim(), status: 'error', refs: [], error: 'Branch search needs a primary Git worktree.' })
      return
    }
    const ticket = ++branchRequest.current
    const requestedRepoId = repoId
    const requestedPrimaryId = primary.id
    const requestedQuery = branch.trim()
    const isCurrent = () => {
      const input = activeInput.current
      return branchRequest.current === ticket && input.repoId === requestedRepoId && input.primaryId === requestedPrimaryId &&
        input.mode === 'branch' && input.branch === requestedQuery
    }
    setBranchSearch({ repoId, primaryId: primary.id, query: requestedQuery, status: 'loading', refs: [] })
    void context
      .call('quirky.git/branches', requestedQuery === '' ? { worktree: primary.id } : { worktree: primary.id, query: requestedQuery })
      .then((raw) => {
        if (isCurrent()) setBranchSearch({ repoId, primaryId: primary.id, query: requestedQuery, status: 'ready', refs: parseBranchRefs(raw) })
      })
      .catch((error: unknown) => {
        if (isCurrent()) setBranchSearch({ repoId, primaryId: primary.id, query: requestedQuery, status: 'error', refs: [], error: messageOf(error) })
      })
    return () => {
      if (branchRequest.current === ticket) branchRequest.current += 1
    }
  }, [context, mode, branch, repoId, folder, primary?.id])

  const invalidateSource = () => {
    sourceRequest.current += 1
    setSelectedSource(null)
    setSourceBusy(false)
    setSourceError(null)
    setSubmitPrompt(null)
  }
  const changeMode = (next: Mode) => {
    if (mode === next) return
    invalidateSource()
    setSmartInput('')
    setMode(next)
  }
  const source = selectedSource?.repoId === repoId && selectedSource.primaryId === primary?.id ? selectedSource.source : null
  const explicitSmartReference = mode === 'smart' && isGitHubWorktreeReference(smartInput)
  const unsupportedFolderReference = folder && isGitHubWorktreeReference(name)
  const fromBranch = mode === 'branch' && branch.trim() !== ''
  const isPullRequest = source?.item.kind === 'pullRequest'
  const setup = project?.hooks?.setup ?? null
  const asksForSetup = choiceDemanded || (setup !== null && project?.settings?.setupPolicy === 'ask')
  const waitsForSetup = project?.hooks?.agentStartup === 'wait-for-setup'
  const defaultBase = project?.settings?.defaultBase ?? ''
  const agentOptionsCatalog = agentOptionsState?.agent === agent && agentOptionsState.status === 'ready' ? agentOptionsState.catalog : undefined
  const selectedModel = agentOptionsCatalog?.models.find((candidate) => candidate.id === model)
  const visibleLaunchOptions = selectedModel?.options ?? (agentOptionsCatalog && (!model || agentOptionsCatalog.unlisted === 'accept')
    ? agentOptionsCatalog.unlistedOptions
    : [])
  const sparsePaths = sparsePathsText.split(/\r?\n/).map((path) => path.trim()).filter(Boolean)
  const launchSelectionRequested = model.trim() !== '' || Object.keys(launchPicks).length > 0
  const defaultTabWarnings = project?.hooks?.warnings.filter((warning) => warning.startsWith('defaultTabs')) ?? []
  const recipeDiagnostics = project?.hooks?.environmentRecipeDiagnostics ?? []
  const selectedHostState = hostChoices.find((host) => host.id === selectedHost)
  const selectedHostUnavailable = selectedHost !== '' && selectedHostState?.available !== true
  const currentSearch = search && mode === 'github' && search.repoId === repoId && search.primaryId === (primary?.id ?? '') && search.query === query.trim() ? search : null
  const currentBranchSearch = branchSearch && mode === 'branch' && branchSearch.repoId === repoId && branchSearch.primaryId === (primary?.id ?? '') && branchSearch.query === branch.trim() ? branchSearch : null
  const issuePromptIsDerived = source?.item.kind === 'issue' && prompt.trim() === ''
  const plainSmartInputNeedsChoice = mode === 'smart' && smartInput.trim() !== '' && !explicitSmartReference
  const workspaceName = name.trim()
  const showBase = !folder && (source ? source.item.kind === 'issue' : mode !== 'github' && !fromBranch && !explicitSmartReference)
  const showBranchName = !folder && !isPullRequest && !fromBranch && (source ? source.item.kind === 'issue' : mode !== 'github' && !explicitSmartReference)
  const blocked = !repo || busy || (asksForSetup && setupChoice === null) || sourceBusy || unsupportedFolderReference ||
    (mode === 'github' && source === null) || (explicitSmartReference && source === null) || selectedHostUnavailable ||
    (launchSelectionRequested && (!agentOptionsCatalog?.supported || agentOptionsState?.status !== 'ready'))

  const fields = (): Record<string, unknown> => {
    const typedBase = base.trim()
    const startupPrompt = prompt.trim() || (source?.item.kind === 'issue' ? source.item.url : '')
    const submitPromptValue = submitPrompt ?? !(source?.item.kind === 'issue' && prompt.trim() === '')
    return {
      repo: repoId,
      ...(source ? { github: source.item.url } : {}),
      ...(workspaceName ? { name: workspaceName } : {}),
      ...(fromBranch ? { branch: branch.trim() } : !source && mode !== 'github' && !explicitSmartReference && showBase && typedBase && typedBase !== defaultBase ? { base: typedBase } :
        source?.item.kind === 'issue' && typedBase && typedBase !== defaultBase ? { base: typedBase } : {}),
      ...(agent ? { agent, ...(startupPrompt ? { prompt: startupPrompt, submitPrompt: submitPromptValue } : {}) } : {}),
      ...(model.trim() ? { model: model.trim() } : {}),
      ...(Object.keys(launchPicks).length > 0 ? { options: launchPicks } : {}),
      ...(sparsePaths.length > 0 ? { sparsePaths } : {}),
      ...(keepMain ? { keepMain: true } : {}),
      ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
      ...(branchName.trim() && !fromBranch && !isPullRequest && showBranchName ? { branchName: branchName.trim() } : {}),
      ...(parent ? { parent } : {}),
      ...(note.trim() ? { comment: note.trim() } : {}),
      ...(asksForSetup && setupChoice ? { setup: setupChoice } : {}),
      ...(project?.hooks?.defaultTabs?.length ? { defaultTabs: selectedDefaultTabs } : {}),
      ...(selectedHost ? { host: selectedHost } : {})
    }
  }

  const submit = async () => {
    if (blocked) return
    setBusy(true)
    const label = workspaceName || source?.item.title || (fromBranch ? branch.trim() : placeholder) || 'new workspace'
    const clearPending = onPending(repoId, label)
    const result = await createWorkspace(context, fields(), hooks)
    clearPending()
    setBusy(false)
    if (result === SETUP_CHOICE_NEEDED) {
      setChoiceDemanded(true)
      setAdvanced(true)
      return
    }
    if (!result) return
    if (!createMore) return onClose()
    sourceRequest.current += 1
    setSelectedSource(null)
    setSourceBusy(false)
    setSourceError(null)
    setSearch(null)
    setBranch('')
    setSmartInput('')
    setName('')
    setQuery('')
    setAgent('')
    setModel('')
    setLaunchPicks({})
    setAgentOptionsState(null)
    setSparsePathsText('')
    setKeepMain(false)
    setPrompt('')
    setSubmitPrompt(null)
    setSetupChoice(null)
    setChoiceDemanded(false)
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

  const chooseWorkItem = (item: GitHubWorkItem) => {
    void requestSource(item.url, 'github', query.trim())
  }
  const smartName = () => {
    setName(smartInput.trim())
    changeMode('name')
  }
  const smartBranch = () => {
    setBranch(smartInput.trim())
    changeMode('branch')
  }
  const smartSearch = () => {
    setQuery(smartInput.trim())
    changeMode('github')
  }
  const clearSource = () => invalidateSource()

  return (
    <Dialog open title="New workspace" onClose={onClose} size="wide">
      <form className="ui-stack" onSubmit={onSubmit} onKeyDown={onKeyDown}>
        <FormRow label="Project" htmlFor="create-project">
          <select id="create-project" className="ui-text-field__input" value={repoId} onChange={(event) => onRepoChange(event.target.value)}>
            {repos.map((r) => (
              <option key={r.id} value={r.id}>
                {repoLabel(r)}
              </option>
            ))}
          </select>
        </FormRow>
        {!folder && repo?.kind === 'git' && (
          <Tabs label="Workspace source" items={SOURCE_TABS} value={mode} onChange={(id) => changeMode(id as Mode)} />
        )}
        {mode === 'smart' && !folder && (
          <>
            <TextField
              label="Name"
              id="create-smart-name"
              autoFocus
              value={smartInput}
              onChange={(event) => {
                invalidateSource()
                setSmartInput(event.target.value)
              }}
              placeholder={placeholder}
              help="Enter a workspace name, #issue number, or GitHub URL."
            />
            {plainSmartInputNeedsChoice && (
              <div className="ui-cluster" role="group" aria-label="Choose how to use this text">
                <Button type="button" onClick={smartName}>Use text as workspace name</Button>
                <Button type="button" onClick={smartBranch}>Search branches</Button>
                <Button type="button" onClick={smartSearch}>Search GitHub</Button>
              </div>
            )}
            {explicitSmartReference && sourceBusy && <p className="ui-text-muted" role="status">Loading GitHub work item…</p>}
            {explicitSmartReference && sourceError && <p className="ui-error-text" role="alert">Could not resolve GitHub work item: {sourceError}</p>}
          </>
        )}
        {mode === 'github' && !folder && (
          <>
            <TextField
              label="Search GitHub"
              id="create-github-query"
              autoFocus
              value={query}
              onChange={(event) => {
                invalidateSource()
                setQuery(event.target.value)
              }}
              placeholder="Search issues and pull requests"
            />
            {sourceBusy && <p className="ui-text-muted" role="status">Loading GitHub work item…</p>}
            {sourceError && <p className="ui-error-text" role="alert">Could not resolve GitHub work item: {sourceError}</p>}
            {currentSearch?.status === 'loading' && <p className="ui-text-muted" role="status">Loading GitHub issues and pull requests…</p>}
            {currentSearch?.status === 'error' && <p className="ui-error-text" role="alert">Could not search GitHub work items: {currentSearch.error}</p>}
            {currentSearch?.status === 'ready' && currentSearch.errors.length > 0 && (
              <p className="ui-error-text" role="alert">{currentSearch.errors.join(' ')}</p>
            )}
            {currentSearch?.status === 'ready' && currentSearch.items.length === 0 && currentSearch.errors.length === 0 && (
              <p className="ui-text-muted" role="status">No GitHub issues or pull requests found.</p>
            )}
            {currentSearch?.status === 'ready' && currentSearch.items.length > 0 && (
              <ul className="ui-tree ui-stack" aria-label="GitHub issues and pull requests">
                {currentSearch.items.map((item) => (
                  <li key={`${item.kind}:${item.number}`} className="ui-tree-item ui-stack">
                    <Button
                      type="button"
                      className="ui-stack"
                      aria-pressed={source?.item.url === item.url}
                      onClick={() => chooseWorkItem(item)}
                    >
                      <Badge>{item.kind === 'pullRequest' ? 'Pull request' : 'Issue'}</Badge>
                      <span>{item.kind === 'pullRequest' ? 'PR' : 'Issue'} #{item.number}</span>
                      <strong>{item.title}</strong>
                      {item.headRefName && <span className="ui-text-muted">{item.headRefName}</span>}
                      {item.labels.map((label) => <Badge key={label}>{label}</Badge>)}
                    </Button>
                    <a className="ui-text-muted" href={item.url} target="_blank" rel="noreferrer">Open</a>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        {mode === 'name' && (
          <TextField
            label="Name"
            id="create-name"
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={source?.item.title ?? placeholder}
          />
        )}
        {mode === 'branch' && !folder && (
          <>
            <TextField label="Name" id="create-branch-name" value={name} onChange={(event) => setName(event.target.value)} placeholder={placeholder} />
            <TextField label="Existing branch" id="create-branch" value={branch} onChange={(event) => setBranch(event.target.value)} placeholder="Search or enter an existing branch" />
            {currentBranchSearch?.status === 'loading' && <p className="ui-text-muted" role="status">Loading branches…</p>}
            {currentBranchSearch?.status === 'error' && <p className="ui-error-text" role="alert">Could not search branches: {currentBranchSearch.error}</p>}
            {currentBranchSearch?.status === 'ready' && currentBranchSearch.refs.length === 0 && <p className="ui-text-muted" role="status">No matching branches.</p>}
            {currentBranchSearch?.status === 'ready' && currentBranchSearch.refs.length > 0 && (
              <ul className="ui-tree">
                {currentBranchSearch.refs.map((ref) => (
                  <li key={`${ref.kind}:${ref.name}`} className="ui-tree-item">
                    <Button type="button" aria-pressed={branch.trim() === ref.name} onClick={() => setBranch(ref.name)}>
                      {ref.name} <span className="ui-text-muted">{ref.kind}</span>
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        {source && (
          <>
            <section className="ui-stack" aria-label="Chosen GitHub source">
              <div className="ui-cluster">
                <strong>{source.item.kind === 'pullRequest' ? 'Pull request' : 'Issue'} #{source.item.number}: {source.item.title}</strong>
                <Button type="button" onClick={clearSource}>Clear source</Button>
              </div>
              {source.head?.refName && <p className="ui-text-muted">Source branch: {source.head.refName}</p>}
              <a className="ui-text-muted" href={source.item.url} target="_blank" rel="noreferrer">Open on GitHub</a>
            </section>
            <TextField
              label="Name"
              id="create-source-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={source.item.title}
              help="Optional worktree name; the linked source remains the default display name."
            />
          </>
        )}
        {unsupportedFolderReference && <p className="ui-error-text" role="alert">GitHub worktree sources require a Git repository.</p>}
        {showBase && (
          <TextField
            label="Base"
            id="create-base"
            value={base}
            onChange={(event) => {
              baseEdited.current = true
              setBase(event.target.value)
            }}
            placeholder="Default branch"
          />
        )}
        <FormRow label="Agent" htmlFor="create-agent">
          <select
            id="create-agent"
            className="ui-text-field__input"
            value={agent}
            onChange={(event) => {
              setAgent(event.target.value)
              setModel('')
              setLaunchPicks({})
              setAgentOptionsState(null)
            }}
          >
            <option value="">None</option>
            {agents.map((choice) => (
              <option key={choice.id} value={choice.id}>
                {choice.label}
              </option>
            ))}
          </select>
        </FormRow>
        {agent && agentOptionsState?.agent === agent && agentOptionsState.status === 'loading' && (
          <p className="ui-text-muted" role="status">Loading {agent} model options…</p>
        )}
        {agent && agentOptionsState?.agent === agent && agentOptionsState.status === 'error' && (
          <p className="ui-error-text" role="alert">Could not load {agent} model options: {agentOptionsState.error}</p>
        )}
        {agentOptionsCatalog && !agentOptionsCatalog.supported && (
          <p className="ui-text-muted">This agent does not support launch-time model and option selection.</p>
        )}
        {agentOptionsCatalog?.supported && (
          <div className="ui-stack">
            <FormRow label="Model" htmlFor="worktree-agent-model" help="Use the agent's native default when left blank.">
              <>
                <input
                  id="worktree-agent-model"
                  className="ui-text-field__input"
                  list="worktree-agent-models"
                  value={model}
                  onChange={(event) => {
                    setModel(event.target.value)
                    setLaunchPicks({})
                  }}
                  placeholder="Use the agent's native default"
                />
                <datalist id="worktree-agent-models">
                  {agentOptionsCatalog.models.map((choice) => <option key={choice.id} value={choice.id}>{choice.label}</option>)}
                </datalist>
              </>
            </FormRow>
            {visibleLaunchOptions.map((option) => option.type === 'boolean' ? (
              <label className="ui-checkbox-label" key={option.id}>
                <input
                  type="checkbox"
                  checked={launchPicks[option.id] === true}
                  onChange={(event) => setLaunchPicks((current) => ({ ...current, [option.id]: event.currentTarget.checked }))}
                />
                <span>{option.label}</span>
              </label>
            ) : (
              <FormRow label={option.label} htmlFor={`create-agent-option-${option.id}`} key={option.id}>
                <select
                  id={`create-agent-option-${option.id}`}
                  className="ui-text-field__input"
                  value={typeof launchPicks[option.id] === 'string' ? launchPicks[option.id] as string : ''}
                  onChange={(event) => setLaunchPicks((current) => {
                    const next = { ...current }
                    if (event.target.value === '') delete next[option.id]
                    else next[option.id] = event.target.value
                    return next
                  })}
                >
                  <option value="">Use default</option>
                  {option.choices?.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
                </select>
              </FormRow>
            ))}
          </div>
        )}
        {agent && (
          <FormRow label="Prompt" htmlFor="create-agent-prompt">
            <textarea
              id="create-agent-prompt"
              rows={3}
              className="ui-text-field__input"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="What should the agent do first?"
            />
          </FormRow>
        )}
        {agent && (prompt.trim() !== '' || source?.item.kind === 'issue') && (
          <label className="ui-checkbox-label">
            <input
              aria-label="Submit prompt automatically"
              type="checkbox"
              checked={submitPrompt ?? !issuePromptIsDerived}
              onChange={(event) => setSubmitPrompt(event.currentTarget.checked)}
            />
            <span>Submit prompt automatically</span>
          </label>
        )}
        <Button type="button" className="ui-disclosure" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>
          Advanced
        </Button>
        {advanced && (
          <div className="ui-stack">
            <TextField label="Display name" id="create-display-name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
            <FormRow
              label="Target peer"
              htmlFor="create-target-peer"
              help="Remote selections use exact authenticated peer IDs and never fall back locally. This runtime has no remote worktree-create owner."
            >
              <select id="create-target-peer" className="ui-text-field__input" value={selectedHost} onChange={(event) => setSelectedHost(event.target.value)}>
                <option value="">Current execution context (default)</option>
                {hostChoices.map((host) => (
                  <option key={host.id} value={host.id} disabled={!host.available}>
                    {host.label} {host.available ? '— available' : '— unavailable'}
                  </option>
                ))}
              </select>
            </FormRow>
            {hostError && <p className="ui-help-text" role="status">Remote host discovery is unavailable: {hostError}</p>}
            {showBranchName && (
              <TextField label="Branch name" id="create-branch-name-advanced" value={branchName} onChange={(event) => setBranchName(event.target.value)} placeholder="Generated from the name" />
            )}
            <FormRow label="Parent worktree" htmlFor="create-parent-worktree">
              <select id="create-parent-worktree" className="ui-text-field__input" value={parent} onChange={(event) => setParent(event.target.value)}>
                <option value="">No parent</option>
                {worktrees.map((w) => (
                  <option key={w.id} value={w.id}>
                    {workspaceOption(w, repos)}
                  </option>
                ))}
              </select>
            </FormRow>
            <FormRow label="Note" htmlFor="create-note">
              <textarea id="create-note" rows={2} className="ui-text-field__input" value={note} onChange={(event) => setNote(event.target.value)} />
            </FormRow>
            {repo?.kind === 'git' && (
              <>
                <FormRow
                  label="Sparse checkout paths"
                  htmlFor="create-sparse-paths"
                  help="One tracked repository-relative file or directory per line. Unsafe or missing paths are refused before creating the worktree."
                >
                  <textarea
                    id="create-sparse-paths"
                    rows={3}
                    className="ui-text-field__input"
                    value={sparsePathsText}
                    onChange={(event) => setSparsePathsText(event.target.value)}
                    placeholder="src&#10;docs"
                  />
                </FormRow>
                <label className="ui-checkbox-label">
                  <input type="checkbox" checked={keepMain} onChange={(event) => setKeepMain(event.target.checked)} />
                  <span>Fast-forward primary checkout when it is clean and exactly behind this remote base</span>
                </label>
              </>
            )}
                {project?.hooks?.defaultTabs?.length ? (
                  <fieldset className="ui-stack">
                    <legend>Default terminal tabs</legend>
                    {project?.hooks?.defaultTabs?.map((tab, index) => {
                      const selector = String(index + 1)
                      return (
                        <label className="ui-checkbox-label" key={selector}>
                          <input
                            type="checkbox"
                            checked={selectedDefaultTabs.includes(selector)}
                            onChange={(event) => setSelectedDefaultTabs((current) => event.target.checked
                              ? [...current, selector]
                              : current.filter((value) => value !== selector))}
                          />
                          <span>{tab.title ?? `Tab ${index + 1}`}</span>
                          {tab.command && <small className="ui-help-text">{tab.command}</small>}
                        </label>
                      )
                    })}
                    <small className="ui-help-text">Commands run as shell-only background tabs after the shared setup trust choice.</small>
                  </fieldset>
                ) : null}
                {defaultTabWarnings.map((warning) => <p className="ui-text-muted" role="status" key={warning}>{warning}</p>)}
                {recipeDiagnostics.map((diagnostic) => <p className="ui-text-muted" role="status" key={`${diagnostic.index}:${diagnostic.field ?? ''}`}>{diagnostic.message}</p>)}
                {(project?.hooks?.environmentRecipes?.length ?? 0) > 0 && (
                  <Button type="button" onClick={() => {
                    context.openView('view:quirky.worktree/environments', { repo: repoId })
                    onClose()
                  }}>Manage VM environments and review lifecycle commands</Button>
                )}
            {(setup || asksForSetup) && (
              <section className="ui-stack">
                <div className="ui-cluster">
                  <span>Setup script</span>
                  {setup && <Badge>{setup.badge}</Badge>}
                </div>
                <label className="ui-checkbox-label">
                  <input type="checkbox" checked={waitsForSetup} disabled readOnly title="Set in the project's settings" />
                  <span>Wait for setup to complete before starting agent</span>
                </label>
                {asksForSetup && (
                  <div className="ui-cluster" role="group" aria-label="Run setup now?">
                    <span>Run setup now?</span>
                    <Button type="button" variant={setupChoice === 'run' ? 'primary' : 'secondary'} aria-pressed={setupChoice === 'run'} onClick={() => setSetupChoice('run')}>
                      Run setup now
                    </Button>
                    <Button type="button" variant={setupChoice === 'skip' ? 'primary' : 'secondary'} aria-pressed={setupChoice === 'skip'} onClick={() => setSetupChoice('skip')}>
                      Skip for now
                    </Button>
                  </div>
                )}
              </section>
            )}
          </div>
        )}
        <div className="ui-actions">
          <label className="ui-checkbox-label">
            <input type="checkbox" checked={createMore} onChange={(event) => setCreateMore(event.target.checked)} />
            <span>Create more</span>
          </label>
          {asksForSetup && setupChoice === null && <span className="ui-text-muted">Choose whether to run setup, under Advanced.</span>}
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={blocked}>
            Create
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
