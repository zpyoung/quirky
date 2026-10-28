import { UI_TOOL_SLOTS, type PluginContext, type Schema, type UiLayout, type UiToolSlot } from '@quirky/protocol'
import type { AutomationService } from '../service'
import { AUTOMATIONS_VIEW, AUTOMATIONS_SETTINGS_VIEW, type AutomationMethods, type AutomationNavigation, type AutomationUiEnv, type AutomationUiState } from './ui-contracts'

export const navigationSchema: Schema = {
  type: 'object',
  properties: {
    page: { type: 'string', enum: ['list', 'detail', 'runs', 'run'] },
    automationId: {}, runId: {},
    tab: { type: 'string', enum: ['overview', 'runs'] },
    query: { type: 'string' }, host: { type: 'string' },
    status: { type: 'string', enum: ['all', 'enabled', 'paused'] },
    lastRun: { type: 'string', enum: ['all', 'failed', 'succeeded', 'never'] },
    agent: { type: 'string' }, sort: { type: 'string', enum: ['name', 'lastRun'] },
    direction: { type: 'string', enum: ['asc', 'desc'] }, runQuery: { type: 'string' },
    runStatus: { type: 'string', enum: ['all', 'successful', 'failed', 'progress', 'skipped'] }
  },
  additionalProperties: false
}

export function initialUiState(): AutomationUiState {
  return {
    revision: 0,
    navigation: { page: 'list', automationId: null, runId: null, tab: 'overview', query: '', host: 'all', status: 'all', lastRun: 'all', agent: '', sort: 'name', direction: 'asc', runQuery: '', runStatus: 'all' },
    editor: null
  }
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

type AutomationToolState = { layout: UiLayout | null; slot: UiToolSlot | null }

async function currentAutomationToolState(context: PluginContext): Promise<AutomationToolState> {
  const [stateValue, modelValue] = await Promise.all([
    context.call('ui.state', {}),
    context.call('ui.contributions', {})
  ])
  if (!record(stateValue) || !record(stateValue.layout)) return { layout: null, slot: null }
  const layout = stateValue.layout as unknown as UiLayout
  if (!record(layout.tools) || !record(modelValue) || !Array.isArray(modelValue.tools)) return { layout, slot: null }
  const tools = layout.tools
  if (!record(tools.placements) || !record(tools.open)) return { layout, slot: null }
  const automationTool = modelValue.tools.find((entry) =>
    record(entry) && entry.contributionId === AUTOMATIONS_VIEW && typeof entry.id === 'string'
  )
  if (!record(automationTool) || typeof automationTool.id !== 'string') return { layout, slot: null }
  const slot = tools.placements[automationTool.id]
  if (typeof slot !== 'string' || !(UI_TOOL_SLOTS as readonly string[]).includes(slot) || tools.open[slot] !== automationTool.id) {
    return { layout, slot: null }
  }
  return { layout, slot: slot as UiToolSlot }
}
const enums: Record<string, readonly string[]> = {
  page: ['list', 'detail', 'runs', 'run'], tab: ['overview', 'runs'], status: ['all', 'enabled', 'paused'],
  lastRun: ['all', 'failed', 'succeeded', 'never'], sort: ['name', 'lastRun'], direction: ['asc', 'desc'],
  runStatus: ['all', 'successful', 'failed', 'progress', 'skipped']
}
function validateNavigation(context: PluginContext, input: Record<string, unknown>): Partial<AutomationNavigation> {
  const patch: Record<string, unknown> = {}
  const keys = navigationSchema.properties!
  for (const [key, value] of Object.entries(input)) {
    if (!Object.hasOwn(keys, key)) throw context.error('invalid-params', `Unknown automation navigation field: ${key}`)
    if (key === 'automationId' || key === 'runId') {
      if (value !== null && (typeof value !== 'string' || value.length === 0 || value.length > 4096)) throw context.error('invalid-params', `${key} must be an identity or null`)
    } else if (enums[key]) {
      if (typeof value !== 'string' || !enums[key]!.includes(value)) throw context.error('invalid-params', `Invalid automation ${key}`)
    } else if (typeof value !== 'string' || new TextEncoder().encode(value).length > (key === 'query' || key === 'runQuery' ? 65536 : 4096)) {
      throw context.error('invalid-params', `Invalid or oversized automation ${key}`)
    }
    patch[key] = value
  }
  return patch as Partial<AutomationNavigation>
}

export function createAutomationUiEnv(context: PluginContext, service: AutomationService): AutomationUiEnv & { methods: AutomationMethods } {
  let state = initialUiState()
  let previousView: UiLayout['view'] = null
  const rememberPrevious = (layout: UiLayout | null) => {
    if (!layout) return
    const view = layout.view
    if (view === null || (record(view) && typeof view.id === 'string' && view.id !== AUTOMATIONS_VIEW && view.id !== AUTOMATIONS_SETTINGS_VIEW)) previousView = view as UiLayout['view']
  }
  const env: AutomationUiEnv & { methods: AutomationMethods } = {
    context, service,
    read: () => structuredClone(state),
    update(change) {
      const next = structuredClone(state)
      change(next)
      next.revision = state.revision + 1
      state = next
      context.emit('uiChanged', { revision: state.revision })
      return env.read()
    },
    async navigate(input) {
      const patch = validateNavigation(context, input)
      const toolState = await currentAutomationToolState(context)
      const currentView = toolState.layout?.view ?? null
      rememberPrevious(toolState.layout)
      const returningFromSettings = record(currentView) && currentView.id === AUTOMATIONS_SETTINGS_VIEW
      const next = env.update(value => { Object.assign(value.navigation, patch) })
      if (toolState.slot === null) {
        if (!record(currentView) || currentView.id !== AUTOMATIONS_VIEW) await context.call('ui.view.open', { id: AUTOMATIONS_VIEW })
      } else if (returningFromSettings) {
        if (previousView) await context.call('ui.view.open', { id: previousView.id, ...(previousView.input === undefined ? {} : { input: previousView.input }) })
        else await context.call('ui.view.close', {})
      }
      return next
    },
    methods: {}
  }
  env.methods = {
    uiState: () => env.read(),
    uiNavigate: params => env.navigate(params),
    open: params => env.navigate(params),
    async close() {
      const toolState = await currentAutomationToolState(context)
      if (toolState.slot !== null) {
        await context.call('ui.tool.close', { slot: toolState.slot })
        return { closed: true }
      }
      if (previousView) await context.call('ui.view.open', { id: previousView.id, ...(previousView.input === undefined ? {} : { input: previousView.input }) })
      else await context.call('ui.view.close', {})
      return { closed: true }
    },
    async settings() {
      const toolState = await currentAutomationToolState(context)
      rememberPrevious(toolState.layout)
      await context.call('ui.view.open', { id: AUTOMATIONS_SETTINGS_VIEW })
      return { opened: true }
    }
  }
  return env
}
