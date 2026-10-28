import { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { MountFunction, UiPluginContext } from '@quirky/protocol'
import { TASKS_VIEW, TASKS_SETTINGS_VIEW, type TasksState, type TaskPreferences } from './contracts'
import { TasksList, WorkspaceComposer } from './list/TasksList'
import { IssueSurface } from './issue/IssueSurface'
import { NewIssueDialog } from './issue/NewIssueDialog'
import { ProjectsSurface } from './projects/ProjectsSurface'
import { TASKS_STYLE } from './style'

function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
async function readState(context: UiPluginContext): Promise<TasksState> {
  const value = await context.call('quirky.tasks/state', {})
  if (!object(value) || !object(value.navigation) || !object(value.preferences) || typeof value.revision !== 'number') throw new Error('Invalid Tasks state from daemon')
  return value as TasksState
}
function useTasksState(context: UiPluginContext) {
  const [state, setState] = useState<TasksState | null>(null)
  const [error, setError] = useState('')
  const generation = useRef(0)
  const refresh = useCallback(async () => {
    const request = ++generation.current
    try {
      const next = await readState(context)
      if (request !== generation.current) return
      setState(previous => !previous || next.revision >= previous.revision ? next : previous)
      setError('')
    } catch (cause) { if (request === generation.current) setError(message(cause)) }
  }, [context])
  useEffect(() => {
    void refresh()
    const off = context.subscribe(event => { if (event.type === 'quirky.tasks/changed' || event.type.startsWith('setting.')) void refresh() })
    return () => { generation.current++; off() }
  }, [context, refresh])
  return { state, error, refresh }
}

function TasksSettings({ context, state, refresh, report }: { context: UiPluginContext; state: TasksState; refresh(): Promise<void>; report?: (state: unknown) => void }) {
  const [error, setError] = useState('')
  const [availabilityError, setAvailabilityError] = useState('')
  const [diagnosis, setDiagnosis] = useState<Record<string, unknown> | null>(null)
  const [checking, setChecking] = useState(false)
  const [checkNonce, setCheckNonce] = useState(0)
  const selectionKey = JSON.stringify(state.navigation.repoIds)
  useEffect(() => {
    let active = true
    setChecking(true)
    setAvailabilityError('')
    void context.call('quirky.tasks/repositories', {}).then(async value => {
      if (!Array.isArray(value)) throw new Error('Repository list is unavailable')
      const repo = value.find(entry => object(entry) && typeof entry.worktree === 'string' && (state.navigation.repoIds === null || state.navigation.repoIds.includes(String(entry.id))))
      if (!object(repo) || typeof repo.worktree !== 'string') throw new Error('Select a Git project to diagnose this source.')
      const next = await context.call('quirky.hosting/diagnoseAuth', { worktree: repo.worktree })
      if (!object(next) || typeof next.ghAvailable !== 'boolean' || typeof next.requiredHostAuthenticated !== 'boolean') throw new Error('GitHub availability is unknown')
      if (active) setDiagnosis(next)
    }).catch(cause => { if (active) { setDiagnosis(null); setAvailabilityError(message(cause)) } }).finally(() => { if (active) setChecking(false) })
    return () => { active = false }
  }, [context, selectionKey, checkNonce])
  useEffect(() => { report?.({ preferences: state.preferences, diagnosis, checking, error, availabilityError }) }, [state.preferences, diagnosis, checking, error, availabilityError, report])
  const save = async (patch: Partial<TaskPreferences>) => {
    try { await context.call('quirky.tasks/preferences', patch); await refresh(); setError('') }
    catch (cause) { setError(message(cause)) }
  }
  const integrations = async () => {
    try {
      const model = await context.call('ui.contributions', {})
      const view = object(model) && Array.isArray(model.views) ? model.views.find(entry => object(entry) && entry.plugin === 'quirky.reviews' && entry.settings === true && typeof entry.module === 'string') : null
      if (!object(view) || typeof view.id !== 'string') throw new Error('Provider integration settings are unavailable. Enable GitHub Reviews to use its settings page.')
      await context.call('ui.view.open', { id: view.id })
    } catch (cause) { setError(message(cause)) }
  }
  const sourceStatus = checking ? 'Checking…' : diagnosis ? diagnosis.ghAvailable !== true ? 'Not installed' : diagnosis.requiredHostAuthenticated === true ? 'Ready' : 'Connect required' : 'Unavailable'
  return <section className="tasks-settings" aria-label="Task Sources settings">
    <h3>Task Sources</h3>
    <label><input type="checkbox" checked={state.preferences.showTasksButton} onChange={event => void save({ showTasksButton: event.target.checked })} />Show Tasks button</label>
    <div className="tasks-row">{['github', 'gitlab', 'linear', 'jira'].map(provider => <label key={provider}><input type="checkbox" checked={state.preferences.visibleTaskProviders.includes(provider)} disabled={state.preferences.visibleTaskProviders.length === 1 && state.preferences.visibleTaskProviders.includes(provider)} onChange={event => void save({ visibleTaskProviders: event.target.checked ? [...state.preferences.visibleTaskProviders, provider] : state.preferences.visibleTaskProviders.filter(value => value !== provider) })} />{provider === 'github' ? 'GitHub' : provider === 'gitlab' ? 'GitLab' : provider === 'linear' ? 'Linear' : 'Jira'}</label>)}</div>
    <div className="tasks-row"><strong>GitHub · {sourceStatus}</strong><button disabled={checking} onClick={() => setCheckNonce(value => value + 1)}>Re-check GitHub</button></div>
    {availabilityError && <p role="alert">{availabilityError}</p>}
    {diagnosis?.ghAvailable === false && <button onClick={() => void context.executeCommand('command:quirky.tasks/open-link', { url: 'https://cli.github.com' }).catch(cause => setError(message(cause)))}>Install GitHub CLI</button>}
    {diagnosis?.ghAvailable === true && diagnosis.requiredHostAuthenticated !== true && <p>Authenticate with <code>gh auth login</code> <button onClick={() => void context.executeCommand('command:quirky.tasks/copy-text', { text: 'gh auth login' }).catch(cause => setError(message(cause)))}>Copy sign-in command</button></p>}
    <p>GitHub uses your installed gh CLI and its authenticated account. Other task sources appear when their provider plugin is available.</p>
    <label>Default source <select value={state.preferences.defaultTaskSource} onChange={event => void save({ defaultTaskSource: event.target.value })}>{['github', 'gitlab', 'linear', 'jira'].map(provider => <option key={provider} value={provider} disabled={provider !== 'github'}>{provider}{provider === 'github' ? '' : ' — provider plugin required'}</option>)}</select></label>
    <button onClick={() => void integrations()}>Provider integration settings</button>
    {error && <p role="alert">{error}</p>}
  </section>
}

function TasksSettingsView({ context, report }: { context: UiPluginContext; report?: (state: unknown) => void }) {
  const { state, error, refresh } = useTasksState(context)
  return <div className="quirky-tasks"><style>{TASKS_STYLE}</style><header className="tasks-header"><button onClick={() => void context.call('quirky.tasks/open', {}).catch(cause => context.toast('Could not open Tasks', message(cause)))}>Back to Tasks</button><h2>Task Sources</h2></header><main className="tasks-body">{error && <p role="alert">{error}<button onClick={() => void refresh()}>Retry</button></p>}{state ? <TasksSettings context={context} state={state} refresh={refresh} report={report} /> : <p role="status">Loading task settings…</p>}</main></div>
}

function TasksApp({ context, report }: { context: UiPluginContext; report?: (state: unknown) => void }) {
  const { state, error, refresh } = useTasksState(context)
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => { if (state) report?.({ navigation: state.navigation, revision: state.revision }) }, [state, report])
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (document.querySelector('[role="dialog"], [role="menu"], [role="listbox"], [data-tasks-popover]')) return
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
        const input = root.current?.querySelector<HTMLInputElement>('[data-tasks-search]')
        if (input) { event.preventDefault(); input.focus(); input.select() }
        return
      }
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (state?.navigation.detail || state?.navigation.newIssue) return
      const active = document.activeElement
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active instanceof HTMLSelectElement) { active.blur(); event.preventDefault(); return }
      event.preventDefault()
      void context.call('quirky.tasks/close', {}).catch(cause => context.toast('Could not close Tasks', message(cause)))
    }
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
  }, [context, state?.navigation.detail, state?.navigation.newIssue])
  const navigate = async (mode: 'issues' | 'prs' | 'projects') => {
    try { await context.call('quirky.tasks/navigate', { mode, detail: null, newIssue: false }); await refresh() }
    catch (cause) { context.toast('Could not change Tasks view', message(cause)) }
  }
  return <div className="quirky-tasks" ref={root}>
    <style>{TASKS_STYLE}</style>
    <header className="tasks-header">
      <button aria-label="Close tasks" title="Close · Esc" onClick={() => void context.call('quirky.tasks/close', {}).catch(cause => context.toast('Could not close Tasks', message(cause)))}>×</button>
      <h2>Tasks</h2>
      {state && <nav aria-label="Task mode" className="tasks-row">{(['issues', 'prs', 'projects'] as const).map(mode => <button key={mode} aria-pressed={state.navigation.mode === mode} onClick={() => void navigate(mode)}>{mode === 'issues' ? 'Issues' : mode === 'prs' ? 'PRs' : 'Projects'}</button>)}</nav>}
      <button className="tasks-settings-button" onClick={() => void context.call('quirky.tasks/settings', {}).catch(cause => context.toast('Could not open task settings', message(cause)))}>Task settings</button>
    </header>
    {error && <div role="alert">{error}<button onClick={() => void refresh()}>Retry</button></div>}
    {!state ? <p role="status">Loading Tasks…</p> : <>
      <main className="tasks-body">{state.navigation.detail ? <IssueSurface context={context} state={state} refresh={refresh} /> : state.navigation.mode === 'projects' ? <ProjectsSurface context={context} state={state} refresh={refresh} /> : <TasksList context={context} state={state} refresh={refresh} />}</main>
      {state.navigation.newIssue && <NewIssueDialog context={context} state={state} refresh={refresh} />}
    </>}
  </div>
}

function TasksComposerOverlay({ context, report }: { context: UiPluginContext; report?: (state: unknown) => void }) {
  const { state, refresh } = useTasksState(context)
  if (!state) return null
  return <div className="quirky-tasks" style={{ display: 'contents', pointerEvents: 'auto' }}>
    <style>{TASKS_STYLE}</style>
    <WorkspaceComposer context={context} state={state} refresh={refresh} report={report} />
  </div>
}

function TasksSidebar({ context, report }: { context: UiPluginContext; report?: (state: unknown) => void }) {
  const { state } = useTasksState(context)
  const [hover, setHover] = useState(false)
  const [menu, setMenu] = useState(false)
  const [availability, setAvailability] = useState<string | null>(null)
  const prefetchedAt = useRef(0)
  useEffect(() => { report?.({ visible: state?.preferences.showTasksButton ?? true, menu }) }, [state, report, menu])
  const prefetch = () => {
    setHover(true)
    if (!state || Date.now() - prefetchedAt.current < 30_000) return
    prefetchedAt.current = Date.now()
    void context.call('quirky.tasks/repositories', {}).then(async repos => {
      const first = Array.isArray(repos) ? repos.find(repo => object(repo) && typeof repo.worktree === 'string') : undefined
      if (!object(first) || typeof first.worktree !== 'string') { setAvailability('Select a Git repository'); return }
      const auth = await context.call('quirky.hosting/diagnoseAuth', { worktree: first.worktree })
      if (!object(auth) || auth.ghAvailable !== true) setAvailability('GitHub source unavailable: Local Mac source tool unavailable')
      else if (auth.requiredHostAuthenticated !== true) setAvailability('GitHub source unavailable: Local Mac provider auth needed')
      else {
        setAvailability('')
        if (state.preferences.defaultTaskSource === 'github') await context.call('quirky.tasks/list', { page: 1 })
      }
    }).catch(cause => setAvailability(message(cause)))
  }
  if (state && !state.preferences.showTasksButton) return null
  return <div style={{ position: 'relative', display: 'flex', gap: 4 }} onMouseEnter={prefetch} onMouseLeave={() => setHover(false)} onFocus={prefetch} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) { setHover(false); setMenu(false) } }}>
    <button style={{ flex: 1, textAlign: 'left' }} onClick={() => void context.call('quirky.tasks/open', {}).catch(cause => context.toast('Could not open Tasks', message(cause)))} onContextMenu={event => { event.preventDefault(); setMenu(true) }}>☷ Tasks</button>
    {hover && state?.preferences.visibleTaskProviders.includes('github') && <button aria-label="Open GitHub tasks" disabled={availability !== ''} title={availability ?? 'Checking GitHub availability…'} onClick={() => void context.call('quirky.tasks/preferences', { defaultTaskSource: 'github' }).then(() => context.call('quirky.tasks/open', { source: 'github' })).catch(cause => context.toast('Could not open GitHub tasks', message(cause)))}>GH</button>}
    {menu && <div role="menu" style={{ position: 'absolute', top: '100%', left: 0, zIndex: 30, background: 'var(--bg-raised)', border: '1px solid var(--border)', padding: 5 }}>
      <button role="menuitem" onClick={() => { setMenu(false); void context.call('quirky.tasks/preferences', { showTasksButton: false }).catch(cause => context.toast('Could not hide Tasks', message(cause))) }}>Hide from sidebar</button>
    </div>}
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
  context.provide('sidebar-section:quirky.tasks/tasks', (element: HTMLElement, props: { report?: (state: unknown) => void }) => {
    const root = createRoot(element)
    root.render(<TasksSidebar context={context} report={props.report} />)
    return () => root.unmount()
  })
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
