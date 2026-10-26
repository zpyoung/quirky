import { createRoot } from 'react-dom/client'
import type { MountFunction, UiPluginContext } from '@quirky/protocol'
import { AgentsView } from './window/AgentsView'
import { BUILT_IN_AGENT_IDS, openAgentTab } from './window/agentTabs'
import { AgentsStore, SETTINGS_VIEW_ID } from './window/model'

const PLUGIN_ID = 'quirky.agents'

/**
 * Activates the agents plugin's window code: the Agents view and the commands that open
 * an agent tab in the worktree of the open session view.
 */
export function activate(context: UiPluginContext): void {
  const mountSettings: MountFunction = (element) => {
    Object.assign(element.style, { display: 'flex', flexDirection: 'column', flex: '1', minHeight: '0' })
    const store = new AgentsStore(context)
    const root = createRoot(element)
    store.start()
    root.render(<AgentsView store={store} />)
    return () => {
      store.stop()
      root.unmount()
    }
  }

  context.provide(SETTINGS_VIEW_ID, mountSettings)
  context.provide(`command:${PLUGIN_ID}/open-settings`, () => context.openView(SETTINGS_VIEW_ID))
  context.provide(`command:${PLUGIN_ID}/new-agent-tab`, () => openAgentTab(context, null))
  for (const id of BUILT_IN_AGENT_IDS) context.provide(`command:${PLUGIN_ID}/new-${id}-tab`, () => openAgentTab(context, id))
}
