import { useCallback, useEffect, useRef, useState, type ComponentType } from 'react'
import { createRoot } from 'react-dom/client'
import type { MountFunction, UiPluginContext } from '@quirky/protocol'
import { API, AUTOMATIONS_VIEW, AUTOMATIONS_SETTINGS_VIEW, type AutomationUiState } from './ui-contracts'
import { AutomationEditor } from './editor/AutomationEditor'
import { AutomationsPage } from './list/AutomationsPage'
import { Button, ContextMenuList, EmptyState, FormRow, ToolPanelFrame } from '@quirky/ui'

function message(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause) }
function useAutomationState(context: UiPluginContext) {
  const [state, setState] = useState<AutomationUiState | null>(null)
  const [error, setError] = useState('')
  const request = useRef(0)
  const refresh = useCallback(async () => {
    const ticket = ++request.current
    try {
      const next = await context.call(`${API}uiState`, {}) as AutomationUiState
      if (ticket !== request.current) return
      setState(previous => !previous || previous.revision <= next.revision ? next : previous)
      setError('')
    } catch (cause) { if (ticket === request.current) setError(message(cause)) }
  }, [context])
  useEffect(() => {
    void refresh()
    const off = context.subscribe(event => { if (event.type.startsWith(API) || event.type.startsWith('setting.')) void refresh() })
    return () => { request.current++; off() }
  }, [context, refresh])
  return { state, error, refresh }
}

type SurfaceProps = { context: UiPluginContext; report?: (state: unknown) => void }
function AutomationApp({ context, report }: SurfaceProps) {
  const { state, error, refresh } = useAutomationState(context)
  const notify = useCallback((text: string, kind: 'success' | 'error' | 'info' = 'info') => context.toast('Automations', text, { kind }), [context])
  const current = useRef({ state, error })
  current.current = { state, error }
  const pageSurface = useRef<unknown>(null)
  const editorSurface = useRef<unknown>(null)
  const reportPage = useCallback((value: unknown) => {
    pageSurface.current = value
    report?.({ ...current.current.state, error: current.current.error, pageSurface: value, editorSurface: editorSurface.current })
  }, [report])
  const reportEditor = useCallback((value: unknown) => {
    editorSurface.current = value
    report?.({ ...current.current.state, error: current.current.error, pageSurface: pageSurface.current, editorSurface: value })
  }, [report])
  useEffect(() => {
    if (!state?.editor) editorSurface.current = null
    report?.({ ...state, error, pageSurface: pageSurface.current, editorSurface: editorSurface.current })
  }, [state, error, report])
  return <div className="quirky-automations">
    <ToolPanelFrame title="Automations" actions={<>
      <Button onClick={() => void context.call(`${API}settings`, {}).catch(cause => notify(message(cause), 'error'))}>Automation settings</Button>
    </>}>
      <div className="auto-app-body">
        {error && <div className="auto-shell-error" role="alert">{error} <Button onClick={() => void refresh()}>Retry</Button></div>}
        {!state ? <div className="auto-shell-loading" role="status"><EmptyState message="Loading Automations…" /></div> : <>
          <AutomationsPage context={context} state={state} refresh={refresh} notify={notify} report={reportPage} />
          {state.editor && <AutomationEditor context={context} state={state} refresh={refresh} notify={notify} report={reportEditor} />}
        </>}
      </div>
    </ToolPanelFrame>
  </div>
}

function AutomationSettings({ context, report }: SurfaceProps) {
  const [visible, setVisible] = useState(context.getSetting('show-automations-button') !== false)
  const [ask, setAsk] = useState(context.getSetting('ask-before-delete') !== false)
  const [error, setError] = useState('')
  const refresh = useCallback(() => {
    setVisible(context.getSetting('show-automations-button') !== false)
    setAsk(context.getSetting('ask-before-delete') !== false)
  }, [context])
  useEffect(() => context.subscribe(event => { if (event.type.startsWith('setting.')) refresh() }), [context, refresh])
  useEffect(() => { report?.({ showAutomationsButton: visible, askBeforeDelete: ask, error }) }, [visible, ask, error, report])
  const save = async (name: string, value: boolean) => {
    try {
      await context.call('setting.set', { id: `setting:quirky.automations/${name}`, value })
      if (name === 'show-automations-button') setVisible(value)
      else setAsk(value)
      setError('')
    } catch (cause) { setError(message(cause)) }
  }
  return <section className="auto-settings">
    <ToolPanelFrame title="Automation settings" actions={<Button onClick={() => void context.call(`${API}open`, {}).catch(cause => setError(message(cause)))}>Open Automations</Button>}>
      <div className="auto-settings__content">
        <p>Schedule agent work and choose whether Automations appears in the sidebar.</p>
        <ol><li>Describe the work</li><li>Quirky starts each run</li><li>Review the results</li></ol>
        <FormRow label="Show Automations Button" htmlFor="auto-setting-sidebar" help="Show the Automations shortcut in the sidebar.">
          <input id="auto-setting-sidebar" type="checkbox" checked={visible} onChange={event => void save('show-automations-button', event.target.checked)} />
        </FormRow>
        <FormRow label="Ask Before Deleting Automations" htmlFor="auto-setting-delete" help="Show a confirmation before deleting automations and their run history.">
          <input id="auto-setting-delete" type="checkbox" checked={ask} onChange={event => void save('ask-before-delete', event.target.checked)} />
        </FormRow>
        {error && <p role="alert" className="auto-error">{error}</p>}
      </div>
    </ToolPanelFrame>
  </section>
}

function AutomationSidebar({ context, report }: SurfaceProps) {
  const [visible, setVisible] = useState(context.getSetting('show-automations-button') !== false)
  const [menu, setMenu] = useState(false)
  const [error, setError] = useState('')
  const menuTrigger = useRef<HTMLButtonElement | null>(null)
  useEffect(() => context.subscribe(event => { if (event.type.startsWith('setting.')) setVisible(context.getSetting('show-automations-button') !== false) }), [context])
  useEffect(() => { report?.({ visible, menu, error }) }, [visible, menu, error, report])
  if (!visible) return null
  return <div className="auto-sidebar" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setMenu(false) }}>
    <Button className="auto-sidebar__trigger" onClick={() => void context.call(`${API}open`, {}).catch(cause => setError(message(cause)))} onContextMenu={event => {
      event.preventDefault()
      menuTrigger.current = event.currentTarget
      setMenu(true)
    }}>◷ Automations</Button>
    {menu && <div className="auto-sidebar__menu"><ContextMenuList
      label="Automations actions"
      items={[{ id: 'hide', label: 'Hide from sidebar' }]}
      onChoose={(item) => {
        if (item.id !== 'hide') return
        setMenu(false)
        void context.call('setting.set', { id: 'setting:quirky.automations/show-automations-button', value: false }).then(() => setVisible(false)).catch(cause => setError(message(cause)))
      }}
      onClose={() => {
        setMenu(false)
        menuTrigger.current?.focus()
      }}
    /></div>}
    {error && <span role="alert">{error}</span>}
  </div>
}

export function activate(context: UiPluginContext): void {
  const mount = (Component: ComponentType<SurfaceProps>): MountFunction => (element, props) => {
    element.classList.add('auto-plugin-mount')
    const root = createRoot(element)
    root.render(<Component context={context} report={props.report} />)
    return () => queueMicrotask(() => root.unmount())
  }
  context.provide(AUTOMATIONS_VIEW, mount(AutomationApp))
  context.provide(AUTOMATIONS_SETTINGS_VIEW, mount(AutomationSettings))
  context.provide('sidebar-section:quirky.automations/automations', mount(AutomationSidebar))
  context.provide('command:quirky.automations/open', () => context.call(`${API}open`, {}))
  context.provide('command:quirky.automations/settings', () => context.call(`${API}settings`, {}))
}
