import type { QuirkyEvent, UiPluginContext } from '@quirky/protocol'
import { parseDesktopWindowRoute } from '@quirky/ui/desktop-bridge'

const ACTIVE = 'setting:quirky.feedback/active'
const ENABLED = 'setting:quirky.feedback/enabled'
const BROWSER_DESIGN = 'command:quirky.browser/design'
const MODE_KEY = 'feedbackMode'

type ModeModule = Pick<typeof import('./mode'), 'mountFeedbackMode'>

/** The lazy import of the mode chunk, replaceable so a load failure can be exercised. */
export const modeLoader: { load(): Promise<ModeModule> } = { load: () => import('./mode') }

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

type Session = { dispose(): void }

let current: Session | null = null

/**
 * Registers the toggle command and the overlay that mounts the feedback mode. Everything heavy
 * loads through `modeLoader` on first activation, so a window that never uses the mode pays nothing.
 */
export function activate(context: UiPluginContext): void {
  const values = { active: false, enabled: true }
  let started = false
  let settled = false
  let stop: (() => void) | null = null
  let ticket = 0
  let loading = false

  const readSetting = (name: 'active' | 'enabled', fallback: boolean) => {
    try { return context.getSetting(name) === true } catch { return fallback }
  }

  const setActive = (value: boolean) => context.call('setting.set', { id: ACTIVE, value })

  const unmountMode = () => {
    ticket++
    loading = false
    const unmount = stop
    stop = null
    if (unmount === null) return
    context.setContext(MODE_KEY, undefined)
    unmount()
  }

  const annotate = async (pane: string): Promise<void> => {
    try { await setActive(false) } catch (cause) {
      context.toast('Could not leave Feedback mode', message(cause))
      return
    }
    values.active = false
    unmountMode()
    try {
      const response = await context.call('ui.command.run', { id: BROWSER_DESIGN, args: { action: 'annotate', pane } })
      const result = (response as { result?: { started?: unknown; reason?: unknown } } | null)?.result
      if (result?.started === false) context.toast('Could not start Annotate', typeof result.reason === 'string' ? result.reason : 'Browser Annotate did not start.')
    } catch (cause) {
      context.toast('Could not start Annotate', message(cause))
    }
  }

  const load = async () => {
    const mine = ++ticket
    loading = true
    let module: ModeModule
    try { module = await modeLoader.load() } catch (cause) {
      if (mine !== ticket) return
      loading = false
      values.active = false
      context.toast('Could not start Feedback mode', message(cause))
      void setActive(false).catch((error) => context.log(`feedback: could not turn the mode off: ${message(error)}`))
      return
    }
    if (mine !== ticket) return
    loading = false
    stop = module.mountFeedbackMode(context, { annotate })
    context.setContext(MODE_KEY, true)
  }

  const reconcile = () => {
    if (!settled) return
    const wanted = values.active && values.enabled
    if (wanted && stop === null && !loading) void load()
    else if (!wanted && (stop !== null || loading)) unmountMode()
  }

  const onEvent = (event: QuirkyEvent) => {
    if (event.type !== 'setting.changed' || (event.id !== ACTIVE && event.id !== ENABLED)) return
    const name = event.id === ACTIVE ? 'active' : 'enabled'
    const value = (event as { value?: unknown }).value
    values[name] = typeof value === 'boolean' ? value : readSetting(name, values[name])
    if (name === 'enabled' && !values.enabled && values.active) {
      values.active = false
      void setActive(false).catch((cause) => context.log(`feedback: could not turn the mode off: ${message(cause)}`))
    }
    reconcile()
  }

  context.provide('overlay:quirky.feedback/mode', (_element: HTMLElement) => {
    if (parseDesktopWindowRoute(location.href) !== null) return
    values.enabled = readSetting('enabled', true)
    const unsubscribe = context.subscribe(onEvent)
    if (!started) {
      started = true
      values.active = false
      setActive(false).catch((cause) => context.log(`feedback: could not turn the mode off at startup: ${message(cause)}`)).finally(() => {
        settled = true
        reconcile()
      })
    } else if (settled) {
      values.active = readSetting('active', false)
      reconcile()
    }
    return () => {
      unsubscribe()
      unmountMode()
    }
  })

  context.provide('command:quirky.feedback/toggle', async () => {
    if (!readSetting('enabled', true)) return { active: false }
    const next = !readSetting('active', false)
    try { await setActive(next) } catch (cause) {
      context.toast('Could not change Feedback mode', message(cause))
      throw cause
    }
    return { active: next }
  })

  current = { dispose: unmountMode }
}

export function deactivate(): void {
  current?.dispose()
  current = null
}
