import type { PluginContext } from '@quirky/protocol'
import { createApp } from './src/app'
import type { AgentKind, AvatarApp, AvatarSettings, HandoffInput, Level, NeedAction } from './src/contracts'
import { register as registerBrain } from './src/brain/session'
import { register as registerGate } from './src/gate/service'
import { register as registerHandoff } from './src/handoff'
import { register as registerKeepAwake } from './src/keepawake'
import { register as registerNotify } from './src/notify'
import { register as registerReport } from './src/report'
import { register as registerShipping } from './src/shipping/index'
import { register as registerSupervisor } from './src/supervisor/events'
import { restoreHandoffs } from './src/restore'

const PLUGIN = 'quirky.avatar'
const LEVELS: readonly Level[] = ['shadow', 'local', 'own-branch', 'full']
const AGENTS: readonly AgentKind[] = ['claude', 'codex', 'pi', 'omp']
const NEED_ACTIONS: readonly NeedAction[] = ['allow-once', 'deny', 'confirm', 'redo', 'review-accept', 'review-reject', 'answer', 'restart', 'take-back', 'restart-to-handoff']

type Params = Record<string, unknown>

let disposers: (() => void)[] = []
let disposerLog: (message: string) => void = () => {}

function invalid(context: PluginContext, message: string): Error {
  return context.error('invalid-params', message)
}

function requireString(context: PluginContext, params: Params, name: string): string {
  const value = params[name]
  if (typeof value !== 'string' || value === '') throw invalid(context, `${name} must be a non-empty string`)
  return value
}

function optionalString(context: PluginContext, params: Params, name: string): string | undefined {
  const value = params[name]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw invalid(context, `${name} must be a string`)
  return value
}

function optionalRecord(context: PluginContext, params: Params, name: string): Params | undefined {
  const value = params[name]
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid(context, `${name} must be an object`)
  return value as Params
}

function optionalInteger(context: PluginContext, params: Params, name: string): number | undefined {
  const value = params[name]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw invalid(context, `${name} must be a non-negative integer`)
  return value
}

function stringList(context: PluginContext, params: Params, name: string): string[] {
  const value = params[name]
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item !== '')) {
    throw invalid(context, `${name} must be a list of non-empty strings`)
  }
  return value as string[]
}

const SETTING_IDS: Record<keyof AvatarSettings, string> = {
  defaultLevel: 'default-level',
  switches: '',
  houseRules: 'house-rules',
  allowCommands: 'allow-commands',
  denyCommands: 'deny-commands',
  deployCommands: 'deploy-commands',
  brainAgent: 'brain-agent',
  brainModel: 'brain-model',
  judgmentTimeoutSeconds: 'judgment-timeout-seconds'
}

const SWITCH_SETTING_IDS = { messaging: 'switch-messaging', historyRewrite: 'switch-history-rewrite', deploys: 'switch-deploys' } as const

function settingPatches(context: PluginContext, params: Params): [string, unknown][] {
  const patches: [string, unknown][] = []
  const push = (name: string, value: unknown) => patches.push([`setting:${PLUGIN}/${name}`, value])
  for (const key of Object.keys(params)) {
    if (!(key in SETTING_IDS)) throw invalid(context, `unknown setting ${key}`)
  }
  if (params.defaultLevel !== undefined) {
    if (!LEVELS.includes(params.defaultLevel as Level)) throw invalid(context, `defaultLevel must be one of ${LEVELS.join(', ')}`)
    push(SETTING_IDS.defaultLevel, params.defaultLevel)
  }
  if (params.switches !== undefined) {
    const switches = params.switches
    if (typeof switches !== 'object' || switches === null || Array.isArray(switches)) throw invalid(context, 'switches must be an object')
    for (const [id, value] of Object.entries(switches)) {
      if (!(id in SWITCH_SETTING_IDS)) throw invalid(context, `unknown switch ${id}`)
      if (typeof value !== 'boolean') throw invalid(context, `switches.${id} must be a boolean`)
      push(SWITCH_SETTING_IDS[id as keyof typeof SWITCH_SETTING_IDS], value)
    }
  }
  for (const key of ['houseRules', 'allowCommands', 'denyCommands', 'deployCommands'] as const) {
    if (params[key] !== undefined) push(SETTING_IDS[key], stringList(context, params, key).join('\n'))
  }
  if (params.brainAgent !== undefined) {
    if (!AGENTS.includes(params.brainAgent as AgentKind)) throw invalid(context, `brainAgent must be one of ${AGENTS.join(', ')}`)
    push(SETTING_IDS.brainAgent, params.brainAgent)
  }
  if (params.brainModel !== undefined) {
    if (params.brainModel !== null && typeof params.brainModel !== 'string') throw invalid(context, 'brainModel must be a string or null')
    push(SETTING_IDS.brainModel, params.brainModel ?? '')
  }
  if (params.judgmentTimeoutSeconds !== undefined) {
    const seconds = params.judgmentTimeoutSeconds
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) throw invalid(context, 'judgmentTimeoutSeconds must be a positive number')
    push(SETTING_IDS.judgmentTimeoutSeconds, seconds)
  }
  return patches
}

function provideMethods(context: PluginContext, app: AvatarApp): void {
  const method = (name: string, handler: (params: Params) => unknown) => context.provide(`method:${PLUGIN}/${name}`, handler)

  method('eligibility', () => app.services.handoff.eligibility())
  method('handoff', async (params) => {
    if (!Array.isArray(params.items) || !params.items.every((item) => typeof item === 'object' && item !== null && !Array.isArray(item))) {
      throw invalid(context, 'items must be a list of hand-off inputs')
    }
    return { results: await app.services.handoff.handoff(params.items as HandoffInput[]) }
  })
  method('takeBack', async (params) => {
    if (params.all === true) return { results: await app.services.handoff.takeBack({ all: true }) }
    return { results: await app.services.handoff.takeBack({ worktreeIds: stringList(context, params, 'worktreeIds') }) }
  })
  method('status', () => app.services.report.status())
  method('sidebarStatus', () => app.services.report.sidebarStatus())
  method('report', () => app.services.report.report())
  method('log', (params) =>
    app.store.journalPage({
      worktreeId: optionalString(context, params, 'worktreeId'),
      limit: optionalInteger(context, params, 'limit'),
      before: optionalInteger(context, params, 'before')
    })
  )
  method('resolveNeed', (params) => {
    const action = requireString(context, params, 'action')
    if (!NEED_ACTIONS.includes(action as NeedAction)) throw invalid(context, `action must be one of ${NEED_ACTIONS.join(', ')}`)
    return app.services.handoff.resolveNeed(
      requireString(context, params, 'needId'),
      action as NeedAction,
      optionalString(context, params, 'text'),
      optionalRecord(context, params, 'answers')
    )
  })
  method('mandate', (params) => app.services.handoff.mandate(requireString(context, params, 'worktreeId')))
  method('settings', () => app.settings())
  method('setSettings', async (params) => {
    for (const [id, value] of settingPatches(context, params)) await context.call('setting.set', { id, value })
    return app.settings()
  })
}

/** Builds the avatar app, registers its modules, and restores hand-offs after every service is ready. */
export async function activate(context: PluginContext): Promise<void> {
  disposerLog = (message) => context.log(message)
  const app = createApp(context)
  provideMethods(context, app)
  context.provide(`tool-gate:${PLUGIN}/gate`, async () => ({ decision: 'unavailable', reason: 'the avatar gate is not available', encoded: null }))
  context.provide(`launch-hook:${PLUGIN}/gate-hooks`, async () => ({}))
  context.provide(`job:${PLUGIN}/watchdog`, async () => {})
  context.provide(`job:${PLUGIN}/records`, async () => {})

  disposers = []
  for (const register of [registerGate, registerHandoff, registerBrain, registerSupervisor, registerShipping, registerReport, registerKeepAwake, registerNotify]) {
    const dispose = register(app)
    if (typeof dispose === 'function') disposers.push(dispose)
  }
  restoreHandoffs(app)
}

/** Runs every disposer, last first; one that throws is logged and the rest still run. */
export function runDisposers(disposers: (() => void)[], log: (message: string) => void): void {
  for (let i = disposers.length - 1; i >= 0; i--) {
    try {
      disposers[i]!()
    } catch (error) {
      try {
        log(`avatar: disposer failed: ${error instanceof Error ? error.message : String(error)}`)
      } catch {
        continue
      }
    }
  }
}

export function deactivate(): void {
  const pending = disposers
  disposers = []
  const log = disposerLog
  disposerLog = () => {}
  runDisposers(pending, log)
}
