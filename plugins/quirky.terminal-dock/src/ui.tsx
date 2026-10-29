import { createRoot } from 'react-dom/client'
import type { MountFunction, UiPluginContext } from '@quirky/protocol'
import { InlineAgentCard } from '@quirky/ui'
import { Composer, type ComposerActions } from './window/Composer'
import { registerDockCommands } from './window/commands'
import { DockSettings } from './window/Settings'

const COMPOSER_VIEW = 'view:quirky.terminal-dock/composer'
const SETTINGS_VIEW = 'view:quirky.terminal-dock/settings'

type ViewInput = { pane: string; session: string }
type RegisterActions = (pane: string, actions: ComposerActions | null) => void

function viewInput(value: unknown): ViewInput | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  return typeof input.pane === 'string' && input.pane !== '' && typeof input.session === 'string' && input.session !== ''
    ? { pane: input.pane, session: input.session }
    : null
}

function prepareViewElement(element: HTMLElement): void {
  Object.assign(element.style, { display: 'flex', flexDirection: 'column', flex: '1', minHeight: '0', width: '100%' })
}

/** Registers the embedded composer, settings view and daemon-routed window commands. */
export function activate(context: UiPluginContext): void {
  const focusHandles = new Map<string, ComposerActions>()
  const registerActions: RegisterActions = (pane, actions) => {
    if (actions === null) focusHandles.delete(pane)
    else focusHandles.set(pane, actions)
  }

  const composerView: MountFunction = (element, { input }) => {
    prepareViewElement(element)
    const root = createRoot(element)
    const resolved = viewInput(input)
    if (resolved === null) {
      root.render(
        <div role="alert">
          <InlineAgentCard title="Terminal dock unavailable" description="The terminal dock requires a pane and session." status="failing" />
        </div>
      )
    } else {
      root.render(<Composer context={context} pane={resolved.pane} session={resolved.session} registerActions={registerActions} />)
    }
    return () => root.unmount()
  }

  const settingsView: MountFunction = (element) => {
    prepareViewElement(element)
    const root = createRoot(element)
    root.render(<DockSettings context={context} />)
    return () => root.unmount()
  }

  context.provide(COMPOSER_VIEW, composerView)
  context.provide(SETTINGS_VIEW, settingsView)
  registerDockCommands(context, focusHandles)
}
