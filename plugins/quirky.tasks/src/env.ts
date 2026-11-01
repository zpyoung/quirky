import { UI_TOOL_SLOTS, validateValue, type PluginContext, type Schema, type UiLayout, type UiToolSlot } from '@quirky/protocol'
import { TASKS_TOOL, TASKS_VIEW, TASKS_SETTINGS_VIEW, type TaskListView, type TaskNavigation, type TaskPreferences, type TaskRepo, type TasksEnv, type TasksState } from './contracts'

const providers = ['github', 'gitlab', 'linear', 'jira']
export function defaultState(): TasksState {
  return {
    revision: 0,
    navigation: { source: 'github', mode: 'issues', repoIds: null, query: 'is:issue is:open', page: 1, scrollTop: 0, detail: null, newIssue: false, project: null, lastList: { mode: 'issues', query: 'is:issue is:open', page: 1 } },
    preferences: { showTasksButton: true, visibleTaskProviders: [...providers], defaultTaskSource: 'github', defaultTaskViewPreset: 'all', defaultRepoSelection: null },
    issueDraft: { title: '', body: '', labels: [], assignees: [], repoId: null },
    projects: { pinned: [], recent: [], lastViewByProject: {}, queryByView: {}, hiddenColumns: {}, columnWidths: {}, roadmapZoom: 'month' },
    links: {}
  }
}
export function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function strings(value: unknown): value is string[] { return Array.isArray(value) && value.length <= 1000 && value.every(v => typeof v === 'string' && v.length <= 2048) }
function invalid(context: PluginContext, message: string): never { throw context.error('invalid-params', message) }

const projectSchema: Schema = {
  type: 'object',
  properties: { id: { type: 'string' }, owner: { type: 'string' }, ownerType: { type: 'string', enum: ['user', 'organization'] }, number: { type: 'integer', minimum: 1 }, url: { type: 'string' }, host: { type: 'string' }, title: { type: 'string' }, viewId: { type: 'string' }, viewNumber: { type: 'integer', minimum: 1 } },
  required: ['id', 'owner', 'ownerType', 'number', 'url']
}
const linkSchema: Schema = { type: 'object', properties: { worktree: { type: 'string' }, name: { type: 'string' }, url: { type: 'string' }, repoId: { type: 'string' } }, required: ['worktree', 'name', 'url', 'repoId'] }

function durableState(context: PluginContext, text: string): Pick<TasksState, 'preferences' | 'projects' | 'links'> {
  if (text.length > 2 * 1024 * 1024) throw new Error('Persisted Tasks state exceeds its size limit')
  const value: unknown = JSON.parse(text)
  if (!record(value) || !record(value.preferences) || !record(value.projects) || !record(value.links)) throw new Error('Invalid persisted Tasks state')
  const projects = value.projects
  for (const key of ['pinned', 'recent']) {
    const targets = projects[key]
    if (!Array.isArray(targets) || targets.length > (key === 'recent' ? 10 : 100) || targets.some(target => validateValue(projectSchema, target) !== null)) throw new Error(`Invalid persisted project ${key}`)
  }
  for (const key of ['lastViewByProject', 'queryByView', 'hiddenColumns', 'columnWidths']) {
    const map = projects[key]
    if (!record(map) || Object.keys(map).length > 1000) throw new Error(`Invalid persisted project ${key}`)
    for (const [entryKey, entry] of Object.entries(map)) {
      if (entryKey.length > 8192 || ['__proto__', 'constructor', 'prototype'].includes(entryKey)) throw new Error('Invalid project preference key')
      const valid = key === 'hiddenColumns' ? strings(entry) : key === 'columnWidths' ? record(entry) && Object.values(entry).every(width => typeof width === 'number' && Number.isFinite(width) && width >= 60) : typeof entry === 'string' && entry.length <= 8192
      if (!valid) throw new Error(`Invalid persisted project ${key} entry`)
    }
  }
  if (!['month', 'quarter', 'year'].includes(String(projects.roadmapZoom))) throw new Error('Invalid roadmap zoom')
  if (Object.keys(value.links).length > 10000 || Object.values(value.links).some(link => validateValue(linkSchema, link) !== null)) throw new Error('Invalid persisted workspace links')
  // All durable fields have been validated above before this typed adoption.
  return { preferences: { ...defaultState().preferences, ...validatePreferences(context, value.preferences) }, projects: projects as TasksState['projects'], links: value.links as TasksState['links'] }
}

export function validatePreferences(context: PluginContext, input: Record<string, unknown>): Partial<TaskPreferences> {
  const patch: Partial<TaskPreferences> = {}
  if ('showTasksButton' in input) {
    if (typeof input.showTasksButton !== 'boolean') invalid(context, 'showTasksButton must be boolean')
    patch.showTasksButton = input.showTasksButton
  }
  if ('visibleTaskProviders' in input) {
    const value = input.visibleTaskProviders
    if (!strings(value) || value.length === 0 || value.some(v => !providers.includes(v))) invalid(context, 'At least one supported task provider must stay visible')
    patch.visibleTaskProviders = [...new Set(value)]
  }
  if ('defaultTaskSource' in input) {
    if (typeof input.defaultTaskSource !== 'string' || !providers.includes(input.defaultTaskSource)) invalid(context, 'Unknown task provider')
    patch.defaultTaskSource = input.defaultTaskSource
  }
  if ('defaultTaskViewPreset' in input) {
    if (typeof input.defaultTaskViewPreset !== 'string' || !['all', 'issues', 'assigned', 'prs', 'mine', 'needs-review'].includes(input.defaultTaskViewPreset)) invalid(context, 'Invalid task preset')
    patch.defaultTaskViewPreset = input.defaultTaskViewPreset
  }
  if ('defaultRepoSelection' in input) {
    if (input.defaultRepoSelection !== null && !strings(input.defaultRepoSelection)) invalid(context, 'defaultRepoSelection must be null or repository IDs')
    patch.defaultRepoSelection = input.defaultRepoSelection === null ? null : [...new Set(input.defaultRepoSelection)]
  }
  return patch
}

function validateNavigation(context: PluginContext, input: Partial<TaskNavigation>): Partial<TaskNavigation> {
  const patch: Partial<TaskNavigation> = {}
  if ('source' in input) {
    if (typeof input.source !== 'string' || !providers.includes(input.source)) invalid(context, 'Unknown task provider')
    patch.source = input.source
  }
  if ('mode' in input) {
    if (!['issues', 'prs', 'projects'].includes(String(input.mode))) invalid(context, 'Invalid Tasks mode')
    patch.mode = input.mode
  }
  if ('repoIds' in input) {
    if (input.repoIds !== null && !strings(input.repoIds)) invalid(context, 'repoIds must be null or repository IDs')
    patch.repoIds = input.repoIds === null ? null : [...new Set(input.repoIds)]
  }
  if ('query' in input) {
    if (typeof input.query !== 'string' || new TextEncoder().encode(input.query).length > 8192) invalid(context, 'Task query exceeds 8 KiB')
    patch.query = input.query
  }
  if ('page' in input) {
    if (!Number.isSafeInteger(input.page) || input.page! < 1 || input.page! > 1000) invalid(context, 'page must be between 1 and 1000')
    patch.page = input.page
  }
  if ('scrollTop' in input) {
    if (typeof input.scrollTop !== 'number' || !Number.isFinite(input.scrollTop) || input.scrollTop < 0) invalid(context, 'scrollTop must be non-negative')
    patch.scrollTop = input.scrollTop
  }
  if ('newIssue' in input) {
    if (typeof input.newIssue !== 'boolean') invalid(context, 'newIssue must be boolean')
    patch.newIssue = input.newIssue
  }
  if ('detail' in input) {
    const detail = input.detail
    if (detail !== null && (!record(detail) || typeof detail.worktree !== 'string' || !['issue', 'pullRequest'].includes(detail.kind) || !Number.isSafeInteger(detail.number) || detail.number < 1)) invalid(context, 'Invalid work-item target')
    patch.detail = detail
  }
  if ('project' in input) {
    const project = input.project
    if (project !== null && (!record(project) || typeof project.id !== 'string' || typeof project.owner !== 'string' || !['user', 'organization'].includes(project.ownerType) || !Number.isSafeInteger(project.number) || project.number < 1 || typeof project.url !== 'string')) invalid(context, 'Invalid project target')
    patch.project = project
  }
  return patch
}

type TasksToolState = { layout: UiLayout | null; slot: UiToolSlot | null }

async function currentTasksToolState(context: PluginContext): Promise<TasksToolState> {
  const [stateValue, modelValue] = await Promise.all([
    context.call('ui.state', {}),
    context.call('ui.contributions', {})
  ])
  if (!record(stateValue) || !record(stateValue.layout)) return { layout: null, slot: null }
  const layout = stateValue.layout as unknown as UiLayout
  if (!record(layout.tools) || !record(modelValue) || !Array.isArray(modelValue.tools)) return { layout, slot: null }
  const tools = layout.tools
  if (!record(tools.placements) || !record(tools.open)) return { layout, slot: null }
  const taskTool = modelValue.tools.find((entry) => record(entry) && entry.id === TASKS_TOOL)
  if (!record(taskTool) || typeof taskTool.id !== 'string') return { layout, slot: null }
  const slot = tools.placements[taskTool.id]
  if (typeof slot !== 'string' || !(UI_TOOL_SLOTS as readonly string[]).includes(slot) || tools.open[slot as UiToolSlot] !== taskTool.id) {
    return { layout, slot: null }
  }
  return { layout, slot: slot as UiToolSlot }
}

export function createTasksEnv(context: PluginContext): TasksEnv {
  const store = context.openStore(['CREATE TABLE task_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)'])
  let state = defaultState()
  const saved = store.get<{ value: string }>('SELECT value FROM task_state WHERE key = ?', 'durable')
  if (saved) {
    Object.assign(state, durableState(context, saved.value))
  }
  let durable = JSON.stringify({ preferences: state.preferences, projects: state.projects, links: state.links })
  const env: TasksEnv = {
    context,
    previousView: null,
    read() {
      const copy = structuredClone(state)
      const visible = context.getSetting('show-tasks-button')
      if (typeof visible === 'boolean') copy.preferences.showTasksButton = visible
      return copy
    },
    update(change) {
      const next = structuredClone(state)
      change(next)
      const { mode, query, page } = next.navigation
      if (mode !== 'projects') next.navigation.lastList = { mode, query, page }
      next.revision = state.revision + 1
      const nextDurable = JSON.stringify({ preferences: next.preferences, projects: next.projects, links: next.links })
      if (nextDurable.length > 2 * 1024 * 1024) throw context.error('invalid-params', 'Tasks preferences exceed their storage limit')
      if (nextDurable !== durable) {
        store.run('INSERT INTO task_state(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', 'durable', nextDurable)
        durable = nextDurable
      }
      state = next
      context.emit('changed', { revision: state.revision })
      return env.read()
    },
    apply(input) {
      const patch = validateNavigation(context, input)
      const current = state.navigation
      const modeChanged = 'mode' in patch && patch.mode !== current.mode
      const contextChanged = modeChanged || ('query' in patch && patch.query !== current.query) || ('repoIds' in patch && JSON.stringify(patch.repoIds) !== JSON.stringify(current.repoIds)) || ('source' in patch && patch.source !== current.source)
      return env.update(next => {
        next.navigation = {
          ...next.navigation,
          ...(contextChanged ? { page: 1, scrollTop: 0 } : {}),
          ...(modeChanged && !('detail' in patch) ? { detail: null } : {}),
          ...patch
        }
        if (patch.mode && patch.mode !== current.mode && !('query' in patch)) next.navigation.query = patch.mode === 'prs' ? 'is:pr is:open' : 'is:issue is:open'
      })
    },
    async navigate(input) {
      return env.apply(input)
    },
    async repositories() {
      const repos = await context.call('quirky.repo/list', {})
      if (!Array.isArray(repos)) throw new Error('Repository list is unavailable')
      const worktrees = await context.call('quirky.worktree/list', {})
      if (!Array.isArray(worktrees)) throw new Error('Workspace list is unavailable')
      const result: TaskRepo[] = []
      for (const repo of repos) {
        if (!record(repo) || repo.kind !== 'git' || typeof repo.path !== 'string' || typeof repo.id !== 'string' || typeof repo.name !== 'string') continue
        const worktree = worktrees.find(w => record(w) && w.repoId === repo.id && (w.isMain === true || w.path === repo.path))
        if (!record(worktree) || typeof worktree.id !== 'string') continue
        result.push({ id: repo.id, name: repo.name, path: repo.path, kind: 'git', displayName: typeof repo.displayName === 'string' ? repo.displayName : null, worktree: worktree.id })
      }
      return result
    }
  }
  return env
}

const navigationKeys = ['source', 'mode', 'repoIds', 'query', 'page', 'scrollTop', 'detail', 'newIssue', 'project']

function presetList(preset: string): TaskListView {
  const mode = ['prs', 'mine', 'needs-review'].includes(preset) ? 'prs' : 'issues'
  const query = preset === 'mine' ? 'author:@me is:pr is:open' : preset === 'needs-review' ? 'review-requested:@me is:pr is:open' : preset === 'assigned' ? 'assignee:@me is:issue is:open' : mode === 'prs' ? 'is:pr is:open' : 'is:issue is:open'
  return { mode, query, page: 1 }
}

/** The Tasks methods. Entry methods choose between the panel and the tab; navigation never does. */
export function coreMethods(env: TasksEnv) {
  const { context } = env
  let defaultsApplied = false

  function applyDefaults(params: Record<string, unknown>): TasksState {
    const { preferences } = env.read()
    const preset = presetList(preferences.defaultTaskViewPreset)
    const initial: Partial<TaskNavigation> = { source: preferences.defaultTaskSource, repoIds: preferences.defaultRepoSelection, mode: preset.mode, detail: null, newIssue: false, ...params }
    const query = typeof params.query === 'string' ? params.query : initial.mode === preset.mode ? preset.query : initial.mode === 'prs' ? 'is:pr is:open' : 'is:issue is:open'
    const result = env.apply({ ...initial, query })
    defaultsApplied = true
    if (result.navigation.mode !== 'projects') return result
    return env.update(next => { next.navigation.lastList = preset })
  }

  async function tasksPlace() {
    const current = await currentTasksToolState(context)
    return { ...current, tab: current.layout?.viewTabs?.find(candidate => candidate.id === TASKS_VIEW) }
  }

  return {
    state: () => env.read(),
    repositories: () => env.repositories(),
    /** Applies the first-open defaults once and returns the state without touching layout; both mounts call it on mount. */
    async prepare() {
      return defaultsApplied ? env.read() : applyDefaults({})
    },
    /**
     * The entry for everything outside the panel and the tab. A row, a project, a new issue or
     * Projects expands into the tab; anything else shows the panel, or the tab when it is open.
     */
    async open(params: Record<string, unknown>) {
      const layoutState = await context.call('ui.state', {})
      let settingsWorktree: string | undefined
      let returningFromSettings = false
      if (record(layoutState) && record(layoutState.layout)) {
        const view = layoutState.layout.view
        returningFromSettings = record(view) && view.id === TASKS_SETTINGS_VIEW
        if (returningFromSettings && record(view) && record(view.input) && typeof view.input.worktree === 'string') settingsWorktree = view.input.worktree
        if (view === null || (record(view) && typeof view.id === 'string' && view.id !== TASKS_VIEW && view.id !== TASKS_SETTINGS_VIEW)) {
          env.previousView = view as UiLayout['view']
        }
      }
      const result = defaultsApplied
        ? navigationKeys.some(key => key in params) ? env.apply(params) : env.read()
        : applyDefaults(params)
      if (returningFromSettings) await context.call('ui.view.close', {})
      const { navigation } = result
      const expands = (params.detail != null && navigation.detail !== null)
        || (params.project != null && navigation.project !== null)
        || params.newIssue === true
        || params.mode === 'projects'
      if (expands) {
        await context.call('ui.view.open', { id: TASKS_VIEW, input: { navigation, revision: result.revision, ...(settingsWorktree !== undefined ? { worktree: settingsWorktree } : {}) } })
        return result
      }
      const place = await tasksPlace()
      if (place.tab === undefined) await context.call('ui.tool.open', { id: TASKS_TOOL })
      else if (place.layout?.view?.id !== TASKS_VIEW) await context.call('ui.view.open', { id: TASKS_VIEW, ...(place.tab.input !== undefined ? { input: place.tab.input } : {}) })
      return result
    },
    navigate: (params: Record<string, unknown>) => env.navigate(params),
    async settings() {
      const taskTool = await currentTasksToolState(context)
      const view = taskTool.layout?.view ?? null
      const inputValue = view?.input
      const input = record(inputValue) ? inputValue : null
      const previousInputValue = env.previousView?.input
      const previousInput = record(previousInputValue) ? previousInputValue : null
      const worktree = typeof input?.worktree === 'string'
        ? input.worktree
        : view?.id === TASKS_VIEW && typeof previousInput?.worktree === 'string'
          ? previousInput.worktree
          : undefined
      if (taskTool.layout) {
        if (view === null) env.previousView = null
        else if (view.id !== TASKS_VIEW && view.id !== TASKS_SETTINGS_VIEW) env.previousView = view
      }
      if (taskTool.slot !== null) defaultsApplied = true
      await context.call('ui.view.open', { id: TASKS_SETTINGS_VIEW, ...(worktree !== undefined ? { input: { worktree } } : {}) })
      return { opened: true }
    },
    /** Closes whichever form of Tasks is open and leaves every other tool and tab where it was. */
    async close() {
      const place = await tasksPlace()
      if (place.slot !== null) {
        await context.call('ui.tool.close', { slot: place.slot })
      } else if (place.layout?.view?.id === TASKS_VIEW) {
        await context.call('ui.view.close', {})
      } else if (place.tab !== undefined) {
        await context.call('ui.view.open', { id: TASKS_VIEW, ...(place.tab.input !== undefined ? { input: place.tab.input } : {}) })
        await context.call('ui.view.close', {})
      }
      return { closed: true }
    },
    async preferences(params: Record<string, unknown>) {
      const patch = validatePreferences(context, params)
      if (patch.showTasksButton !== undefined) await context.call('setting.set', { id: 'setting:quirky.tasks/show-tasks-button', value: patch.showTasksButton })
      return env.update(next => { Object.assign(next.preferences, patch) })
    }
  }
}
