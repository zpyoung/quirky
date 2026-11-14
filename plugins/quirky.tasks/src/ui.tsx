import { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { MountFunction, UiPluginContext } from '@quirky/protocol'
import { Button, ControlIcon, FormRow, IconButton, InlineError, NoticeLine, SectionHeader, Tabs, ToolPanelFrame } from '@quirky/ui'
import { TASKS_TOOL, TASKS_VIEW, TASKS_SETTINGS_VIEW, type TasksState, type TaskPreferences } from './contracts'
import { CompactTasks } from './list/CompactTasks'
import { place } from './list/place'
import { object as record, parseTasksState } from './list/model'
import { TasksList, WorkspaceComposer } from './list/TasksList'
import { effectiveList } from './list/useCompactList'
import { IssueSurface } from './issue/IssueSurface'
import { NewIssueDialog } from './issue/NewIssueDialog'
import { ProjectsSurface } from './projects/ProjectsSurface'
import { ROW_MENU_COMMAND, runRowMenu } from './list/row-menu'

function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
async function readState(context: UiPluginContext): Promise<TasksState> {
  const next = parseTasksState(await context.call('quirky.tasks/state', {}))
  if (!next) throw new Error('Invalid Tasks state from daemon')
  return next
}
function useTasksState(context: UiPluginContext) {
  const [state, setState] = useState<TasksState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)
  const adopt = useCallback((next: TasksState) => {
    setState(previous => !previous || next.revision >= previous.revision ? next : previous)
    setError(null)
  }, [])
  const reload = async () => {
    const request = ++generation.current
    try {
      const next = await readState(context)
      if (request === generation.current) adopt(next)
    } catch (cause) {
      if (request === generation.current) setError(message(cause))
    }
  }
  const reloadRef = useRef(reload)
  reloadRef.current = reload
  const refresh = useCallback(() => reloadRef.current(), [])
  useEffect(() => {
    void refresh()
    const off = context.subscribe(event => {
      if (event.type === 'quirky.tasks/changed' || event.type.startsWith('setting.')) void refresh()
    })
    return () => { generation.current++; off() }
  }, [context, refresh])
  return { state, error, adopt, refresh, reload }
}

function collapseTasks(context: UiPluginContext) {
  place.requestFocus('row')
  void context.call('ui.tool.open', { id: TASKS_TOOL }).catch(cause => context.toast('Could not collapse Tasks', message(cause)))
}

async function diagnoseSource(context: UiPluginContext, repoIds: string[] | null): Promise<Record<string, unknown>> {
  const repositories = await context.call('quirky.tasks/repositories', {})
  if (!Array.isArray(repositories)) throw new Error('Repository list is unavailable')
  const repository = repositories.find(entry => object(entry) && typeof entry.worktree === 'string' && (repoIds === null || repoIds.includes(String(entry.id))))
  if (!object(repository) || typeof repository.worktree !== 'string') throw new Error('Select a Git project to diagnose this source.')
  const diagnosis = await context.call('quirky.hosting/diagnoseAuth', { worktree: repository.worktree })
  if (!object(diagnosis) || typeof diagnosis.ghAvailable !== 'boolean' || typeof diagnosis.requiredHostAuthenticated !== 'boolean') {
    throw new Error('GitHub availability is unknown')
  }
  return diagnosis
}

function TasksSettings({ context, state, refresh, report }: { context: UiPluginContext; state: TasksState; refresh(): Promise<void>; report?: (state: unknown) => void }) {
  const [error, setError] = useState('')
  const [availabilityError, setAvailabilityError] = useState('')
  const [diagnosis, setDiagnosis] = useState<Record<string, unknown> | null>(null)
  const [checking, setChecking] = useState(false)
  const diagnosisGeneration = useRef(0)
  const selectionKey = JSON.stringify(state.navigation.repoIds)
  const runCheck = async () => {
    const request = ++diagnosisGeneration.current
    setChecking(true)
    setAvailabilityError('')
    try {
      const next = await diagnoseSource(context, state.navigation.repoIds)
      if (request === diagnosisGeneration.current) {
        setDiagnosis(next)
      }
    } catch (cause) {
      if (request === diagnosisGeneration.current) {
        setDiagnosis(null)
        setAvailabilityError(message(cause))
      }
    } finally {
      if (request === diagnosisGeneration.current) setChecking(false)
    }
  }
  const runCheckRef = useRef(runCheck)
  runCheckRef.current = runCheck
  useEffect(() => {
    void runCheckRef.current()
    return () => { diagnosisGeneration.current += 1 }
  }, [context, selectionKey])
  useEffect(() => { report?.({ preferences: state.preferences, diagnosis, checking, error, availabilityError }) }, [state.preferences, diagnosis, checking, error, availabilityError, report])
  const save = async (patch: Partial<TaskPreferences>) => {
    try { await context.call('quirky.tasks/preferences', patch); await refresh(); setError('') }
    catch (cause) { setError(message(cause)) }
  }
  const integrations = async () => {
    try {
      await context.call('ui.view.open', { id: 'view:quirky.reviews/settings' })
    } catch (cause) { setError(message(cause)) }
  }
  const sourceStatus = checking ? 'Checking…' : diagnosis ? diagnosis.ghAvailable !== true ? 'Not installed' : diagnosis.requiredHostAuthenticated === true ? 'Ready' : 'Connect required' : 'Unavailable'
  return <section className="tasks-settings" aria-label="Task Sources settings">
    <FormRow label="Show Tasks button" htmlFor="tasks-show-button">
      <input type="checkbox" checked={state.preferences.showTasksButton} onChange={event => void save({ showTasksButton: event.target.checked })} />
    </FormRow>
    <SectionHeader title="Visible providers" />
    <div className="tasks-row">{['github', 'gitlab', 'linear', 'jira'].map(provider => <FormRow key={provider} label={provider === 'github' ? 'GitHub' : provider === 'gitlab' ? 'GitLab' : provider === 'linear' ? 'Linear' : 'Jira'} htmlFor={`tasks-provider-${provider}`}><input type="checkbox" checked={state.preferences.visibleTaskProviders.includes(provider)} disabled={state.preferences.visibleTaskProviders.length === 1 && state.preferences.visibleTaskProviders.includes(provider)} onChange={event => void save({ visibleTaskProviders: event.target.checked ? [...state.preferences.visibleTaskProviders, provider] : state.preferences.visibleTaskProviders.filter(value => value !== provider) })} /></FormRow>)}</div>
    <div className="tasks-row"><strong>GitHub · {sourceStatus}</strong><Button disabled={checking} onClick={() => void runCheck()}>Re-check GitHub</Button></div>
    {availabilityError && <InlineError message={availabilityError} action={{ label: 'Retry', onAction: () => { void runCheck() } }} />}
    {diagnosis?.ghAvailable === false && <Button onClick={() => void context.executeCommand('command:quirky.tasks/open-link', { url: 'https://cli.github.com' }).catch(cause => setError(message(cause)))}>Install GitHub CLI</Button>}
    {diagnosis?.ghAvailable === true && diagnosis.requiredHostAuthenticated !== true && <p>Authenticate with <code>gh auth login</code> <Button onClick={() => void context.executeCommand('command:quirky.tasks/copy-text', { text: 'gh auth login' }).catch(cause => setError(message(cause)))}>Copy sign-in command</Button></p>}
    <p>GitHub uses your installed gh CLI and its authenticated account. Other task sources appear when their provider plugin is available.</p>
    <FormRow label="Default source" htmlFor="tasks-default-source"><select value={state.preferences.defaultTaskSource} onChange={event => void save({ defaultTaskSource: event.target.value })}>{['github', 'gitlab', 'linear', 'jira'].map(provider => <option key={provider} value={provider} disabled={provider !== 'github'}>{provider}{provider === 'github' ? '' : ' — provider plugin required'}</option>)}</select></FormRow>
    <Button onClick={() => void integrations()}>Provider integration settings</Button>
    {error && <InlineError message={error} />}
  </section>
}

function TasksSettingsView({ context, report }: { context: UiPluginContext; report?: (state: unknown) => void }) {
  const { state, error: loadError, refresh, reload } = useTasksState(context)
  return <div className="quirky-tasks">
    <ToolPanelFrame title="Task Sources" actions={<Button onClick={() => void context.call('quirky.tasks/open', {}).catch(cause => context.toast('Could not open Tasks', message(cause)))}>Back to Tasks</Button>}>
      <main className="tasks-body">
        {loadError && !state && <InlineError message={loadError} action={{ label: 'Retry', onAction: () => { void reload() } }} />}
        {loadError && state && <div role="status" className="tasks-settings__notice">
          <NoticeLine actions={[{ label: 'Retry', onAction: () => { void reload() } }]}>Couldn't refresh task settings. Showing the last loaded settings. {loadError}</NoticeLine>
        </div>}
        {!state && !loadError && <div role="status"><NoticeLine>Loading task settings…</NoticeLine></div>}
        {state && <TasksSettings context={context} state={state} refresh={refresh} report={report} />}
      </main>
    </ToolPanelFrame>
  </div>
}

type TabCounts = { issues: number | null; prs: number | null }

function countOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

/**
 * Reads the Issues and PRs tab counts for the list the tabs sit over; an unreadable count stays null.
 * `reload` reads them again, and a read superseded by a newer one never overwrites it.
 */
function useTabCounts(context: UiPluginContext, navigation: TasksState['navigation'] | null): { counts: TabCounts; reload(): void; reloadCounts(): void } {
  const [counts, setCounts] = useState<TabCounts>({ issues: null, prs: null })
  const generation = useRef(0)
  const view = navigation ? effectiveList(navigation) : null
  const repoIds = navigation?.repoIds ?? null
  const key = view ? JSON.stringify([view.mode, view.query, repoIds]) : null
  const reloadCounts = () => {
    if (!view) return
    const request = ++generation.current
    void context.call('quirky.tasks/counts', { mode: view.mode, query: view.query, repoIds })
      .then(raw => {
        const value = record(raw)
        const next = value ? { issues: countOf(value.issues), prs: countOf(value.prs) } : { issues: null, prs: null }
        if (request === generation.current) setCounts(next)
      })
      .catch(() => {
        if (request === generation.current) setCounts({ issues: null, prs: null })
      })
  }
  const reloadRef = useRef(reloadCounts)
  reloadRef.current = reloadCounts
  const reload = useCallback(() => reloadRef.current(), [])
  useEffect(() => {
    if (!view) return
    reloadRef.current()
    return () => { generation.current += 1 }
  }, [context, key])
  return { counts, reload, reloadCounts }
}

function TasksApp({ context, report }: { context: UiPluginContext; report?: (state: unknown) => void }) {
  const { state, error: loadError, adopt, refresh, reload } = useTasksState(context)
  const root = useRef<HTMLDivElement>(null)
  const { counts, reload: reloadCountsForRefresh, reloadCounts } = useTabCounts(context, state?.navigation ?? null)
  const refreshAndCount = useCallback(async () => {
    await refresh()
    reloadCountsForRefresh()
  }, [refresh, reloadCountsForRefresh])
  const [listRefreshToken, setListRefreshToken] = useState(0)
  const refreshAfterIssueCreate = useCallback(async () => {
    await refreshAndCount()
    setListRefreshToken((value) => value + 1)
  }, [refreshAndCount])
  const focusRow = useRef<boolean | null>(null)
  const initialFocus = focusRow.current ?? (focusRow.current = place.takeFocus() === 'row')
  if (state) focusRow.current = false
  useEffect(() => { if (state) report?.({ navigation: state.navigation, revision: state.revision }) }, [state, report])
  useEffect(() => {
    void context.call('quirky.tasks/prepare', {}).then(() => refresh()).catch(() => undefined)
  }, [context, refresh])
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (document.querySelector('[role="dialog"], [role="menu"], [role="listbox"], [data-tasks-popover]')) return
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
        const input = root.current?.querySelector<HTMLInputElement>('[data-tasks-search]')
        if (input) { event.preventDefault(); input.focus(); input.select() }
        return
      }
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (state?.navigation.newIssue) return
      const active = document.activeElement
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active instanceof HTMLSelectElement) { active.blur(); event.preventDefault(); return }
      event.preventDefault()
      if (state?.navigation.detail) {
        void context.call('quirky.tasks/navigate', { detail: null }).then(value => {
          const next = parseTasksState(value)
          if (next) adopt(next)
          else void refresh()
        }).catch(cause => context.toast('Could not close the task', message(cause)))
        return
      }
      collapseTasks(context)
    }
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
  }, [context, adopt, refresh, state?.navigation.detail, state?.navigation.newIssue])
  const navigate = async (mode: 'issues' | 'prs' | 'projects') => {
    try { await context.call('quirky.tasks/navigate', { mode, detail: null, newIssue: false }); await refresh() }
    catch (cause) { context.toast('Could not change Tasks view', message(cause)) }
  }
  const tabs = [
    { id: 'issues', label: 'Issues', ...(counts.issues !== null ? { count: counts.issues } : {}) },
    { id: 'prs', label: 'PRs', ...(counts.prs !== null ? { count: counts.prs } : {}) },
    { id: 'projects', label: 'Projects' }
  ]
  return <div className="quirky-tasks" ref={root}>
    <ToolPanelFrame title="Tasks" tabs={state && <Tabs label="Task mode" items={tabs} value={state.navigation.mode} onChange={mode => void navigate(mode as 'issues' | 'prs' | 'projects')} />} actions={<IconButton label="Collapse Tasks" title="Collapse Tasks" onClick={() => collapseTasks(context)}><ControlIcon name="arrows-in" /></IconButton>}>
      {!state && loadError && <InlineError message={loadError} action={{ label: 'Retry', onAction: () => { void reload() } }} />}
      {!state && !loadError && <div role="status"><NoticeLine>Loading Tasks…</NoticeLine></div>}
      {state && <>
        {loadError && <div role="status"><NoticeLine actions={[{ label: 'Retry', onAction: () => { void reload() } }]}>Couldn't refresh Tasks. Showing the last loaded tasks. {loadError}</NoticeLine></div>}
        <main className="tasks-body">{state.navigation.mode === 'projects' ? state.navigation.detail ? <IssueSurface context={context} state={state} refresh={refresh} /> : <ProjectsSurface context={context} state={state} refresh={refresh} /> : <TasksList context={context} state={state} refresh={refreshAndCount} adopt={adopt} initialFocus={initialFocus} onDataChanged={reloadCounts} listRefreshToken={listRefreshToken} />}</main>
        {state.navigation.newIssue && <NewIssueDialog context={context} state={state} refresh={refreshAfterIssueCreate} />}
      </>}
    </ToolPanelFrame>
  </div>
}

function TasksComposerOverlay({ context, report }: { context: UiPluginContext; report?: (state: unknown) => void }) {
  const { refresh } = useTasksState(context)
  return <div className="quirky-tasks tasks-overlay-root">
    <WorkspaceComposer context={context} refresh={refresh} report={report} />
  </div>
}


function linkArgument(raw: unknown): string {
  if (!object(raw) || typeof raw.url !== 'string' || raw.url.length > 8192) throw new Error('A GitHub HTTP(S) URL is required')
  const url = new URL(raw.url)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || /[\u0000-\u001f\u007f]/.test(raw.url)) throw new Error('Only HTTP(S) links without credentials can be opened')
  return raw.url
}

export function activate(context: UiPluginContext): void {
  const mount: MountFunction = (element, props) => {
    Object.assign(element.style, { display: 'flex', flex: '1', minWidth: '0', minHeight: '0', overflow: 'hidden' })
    const root = createRoot(element)
    root.render(<TasksApp context={context} report={props.report} />)
    return () => root.unmount()
  }
  context.provide(TASKS_VIEW, mount)
  context.provide(TASKS_SETTINGS_VIEW, (element: HTMLElement, props: { report?: (state: unknown) => void }) => {
    Object.assign(element.style, { display: 'flex', flex: '1', minWidth: '0', minHeight: '0', overflow: 'hidden' })
    const root = createRoot(element)
    root.render(<TasksSettingsView context={context} report={props.report} />)
    return () => root.unmount()
  })
  context.provide('overlay:quirky.tasks/workspace-composer', (element: HTMLElement, props: { report?: (state: unknown) => void }) => {
    element.style.display = 'contents'
    const root = createRoot(element)
    root.render(<TasksComposerOverlay context={context} report={props.report} />)
    return () => root.unmount()
  })
  context.provide(TASKS_TOOL, (element: HTMLElement, props: { report?: (state: unknown) => void }) => {
    const root = createRoot(element)
    root.render(<CompactTasks context={context} report={props.report} />)
    return () => root.unmount()
  })
  context.provide(ROW_MENU_COMMAND, (input: unknown) => runRowMenu(context, input))
  context.provide('command:quirky.tasks/open', async (raw: unknown) => {
    if (context.getLayout().view?.id === 'view:quirky.notifications/settings') return { opened: false }
    const repositories = await context.call('quirky.tasks/repositories', {})
    if (!Array.isArray(repositories) || repositories.length === 0) return { opened: false }
    return context.call('quirky.tasks/open', object(raw) ? raw : {})
  })
  context.provide('command:quirky.tasks/copy-link', async (raw: unknown) => {
    try {
      const url = linkArgument(raw)
      if (!navigator.clipboard?.writeText) throw new Error('The clipboard is not available in this window')
      await navigator.clipboard.writeText(url)
      context.toast('GitHub link copied', '')
      return { copied: true }
    } catch (cause) { context.toast('Failed to copy GitHub link', message(cause)); throw cause }
  })
  context.provide('command:quirky.tasks/copy-text', async (raw: unknown) => {
    try {
      if (!object(raw) || typeof raw.text !== 'string' || new TextEncoder().encode(raw.text).length > 8192) throw new Error('Text to copy must be no larger than 8 KiB')
      if (!navigator.clipboard?.writeText) throw new Error('The clipboard is not available in this window')
      await navigator.clipboard.writeText(raw.text)
      context.toast('Copied text', '')
      return { copied: true }
    } catch (cause) { context.toast('Could not copy text', message(cause)); throw cause }
  })
  context.provide('command:quirky.tasks/open-link', async (raw: unknown) => {
    try { return await context.call('quirky.terminal/openExternal', { target: linkArgument(raw) }) }
    catch (cause) { context.toast('Could not open GitHub link', message(cause)); throw cause }
  })
}
