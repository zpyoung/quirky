import { formatContributionId, type PluginContext } from '@quirky/protocol'
import { createAutomationService, type AutomationService } from './service'
import { createAutomationUiEnv } from './src/state'
import { editorMethods } from './src/editor/methods'
import { externalMethods } from './src/external/methods'
import { createAutomationDispatcher } from './dispatch'
import { createAutomationTargetResolver } from './target'

let activeService: AutomationService | undefined
let stopModelSnapshots: (() => void) | undefined

export async function activate(context: PluginContext): Promise<void> {
  const targets = createAutomationTargetResolver(context)
  const service = createAutomationService(context, Date.now, {
    targets,
    createDispatcher: (hooks) => createAutomationDispatcher(context, hooks)
  })
  const env = createAutomationUiEnv(context, service)
  const methods = {
    list: service.list,
    show: service.show,
    create: service.create,
    edit: service.edit,
    remove: service.remove,
    run: service.run,
    runs: service.runs,
    target: service.target,
    dispatch: service.dispatch,
    claimWorkspaceProvenance: service.claimWorkspaceProvenance,
    schedule: service.schedule,
    tick: () => service.tick(),
    ...env.methods,
    ...editorMethods(env),
    ...externalMethods(context)
  }
  stopModelSnapshots = context.subscribe((event) => {
    if (event.type !== 'quirky.agents/modelSnapshot') return
    const data = 'data' in event ? event.data : undefined
    void service.modelSnapshot(data).catch((error) => {
      context.log(`could not retire stale automation model picks: ${error instanceof Error ? error.message : String(error)}`)
    })
  })
  for (const [name, handler] of Object.entries(methods)) {
    context.provide(formatContributionId('method', context.pluginId, name), handler)
  }
  activeService = service
  try {
    await service.start()
  } catch (error) {
    stopModelSnapshots?.()
    stopModelSnapshots = undefined
    activeService = undefined
    service.dispose()
    throw error
  }
}

export function deactivate(): void {
  stopModelSnapshots?.()
  stopModelSnapshots = undefined
  const service = activeService
  activeService = undefined
  service?.dispose()
}
