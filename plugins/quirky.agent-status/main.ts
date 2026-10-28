import { join } from 'node:path'
import type { LaunchHookInput, LaunchPatch, PluginContext } from '@quirky/protocol'
import { ActivityFeed } from './src/activity'
import { DashboardService } from './src/dashboard'
import { ClaudeVersionGate, claudeEventsFor, claudeSettings, commandProbe } from './src/claude-settings'
import { HooksService } from './src/hooks'
import type { ScriptState } from './src/script-state'
import { AgentStatusService } from './src/service'
import { drainSpool } from './src/spool'
import { ActivityStore, migrations, RowStore } from './src/store'
import { DEFAULT_OUTPUT_LINES, DEFAULT_WAIT_MS } from './src/waits'

const DEFAULT_CLAUDE_COMMAND = 'claude'

/** The per-version Claude hook settings and Codex notify argument supplied to each agent launch. */
function agentHooks(context: PluginContext, gate: ClaudeVersionGate): (launch: LaunchHookInput) => Promise<LaunchPatch> {
  return async (launch) => {
    if (launch.agent === 'claude' || launch.agent === 'claude-agent-teams') {
      const version = await gate.version(await claudeCommand(context), { sessionId: launch.sessionId, worktreeId: launch.worktreeId })
      return { jsonArgs: { '--settings': claudeSettings(claudeEventsFor(version)) } }
    }
    if (launch.agent === 'codex') {
      const notify = `notify=${JSON.stringify([join(context.home, 'bin', 'quirky-hook'), 'codex'])}`
      return { args: ['-c', notify] }
    }
    return {}
  }
}

async function claudeCommand(context: PluginContext): Promise<string> {
  try {
    const agent = (await context.call('quirky.agents/get', { agent: 'claude' })) as { command?: unknown }
    if (typeof agent.command === 'string' && agent.command.trim() !== '') return agent.command
  } catch {
    // quirky.agents may be absent or the agent unknown; the plain command is the best guess
  }
  return DEFAULT_CLAUDE_COMMAND
}

function requireString(context: PluginContext, value: unknown, name: string): string {
  if (typeof value !== 'string' || value === '') throw context.error('invalid-params', `${name} must be a non-empty string`)
  return value
}

function sendText(context: PluginContext, value: unknown): string {
  if (typeof value !== 'string' || value === '') throw context.error('invalid-params', 'text must be a non-empty string')
  return value
}

function startTimeout(context: PluginContext, value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw context.error('invalid-params', 'startTimeoutMs must be an integer of at least 0')
  return value
}

const SCRIPT_STATES: readonly ScriptState[] = ['working', 'blocked', 'idle', 'unknown', 'exited']
const MAX_WAIT_MS = 60_000
const MAX_OUTPUT_LINES = 2000

function boundedInteger(context: PluginContext, value: unknown, name: string, max: number, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max) {
    throw context.error('invalid-params', `${name} must be an integer from 0 to ${max}`)
  }
  return value
}

function untilStates(context: PluginContext, value: unknown): ScriptState[] {
  if (value === undefined) return ['idle', 'blocked']
  const states = Array.isArray(value) ? value : null
  if (!states || states.length === 0 || !states.every((state): state is ScriptState => SCRIPT_STATES.includes(state))) {
    throw context.error('invalid-params', `until must be a non-empty list of: ${SCRIPT_STATES.join(', ')}`)
  }
  return states
}

function waitPattern(context: PluginContext, value: unknown): string {
  if (typeof value !== 'string' || value === '') throw context.error('invalid-params', 'pattern must be a non-empty string')
  return value
}

let service: AgentStatusService | undefined
let listenerStops: (() => void)[] = []

/** Wires status rows, the shared durable Activity feed, Dashboard queries, hooks and session summaries. */
export async function activate(context: PluginContext): Promise<void> {
  const store = context.openStore(migrations)
  const activity = new ActivityFeed(context, new ActivityStore(store))
  const active = new AgentStatusService(context, new RowStore(store), activity)
  const dashboard = new DashboardService(context, activity)
  service = active
  const installer = new HooksService(context)

  context.provide('launch-hook:quirky.agent-status/agent-hooks', agentHooks(context, new ClaudeVersionGate(commandProbe(context), Date.now)))
  context.provide('method:quirky.agent-status/list', (params: Record<string, unknown>) =>
    active.list(typeof params.worktree === 'string' ? params.worktree : undefined)
  )
  context.provide('method:quirky.agent-status/get', (params: Record<string, unknown>) =>
    active.get(params.session as string, typeof params.at === 'number' ? params.at : undefined)
  )
  context.provide('method:quirky.agent-status/explain', (params: Record<string, unknown>) =>
    active.explain(requireString(context, params.session, 'session'), typeof params.at === 'number' ? params.at : undefined)
  )
  context.provide('method:quirky.agent-status/activity', (params: Record<string, unknown>) =>
    active.activityQuery({
      ...(typeof params.worktree === 'string' ? { worktree: params.worktree } : {}),
      ...(typeof params.text === 'string' ? { text: params.text } : {}),
      ...(params.unreadOnly === true ? { unreadOnly: true } : {})
    })
  )
  context.provide('method:quirky.agent-status/dashboard', (params: Record<string, unknown>) => dashboard.query(params))
  context.provide('method:quirky.agent-status/acknowledge', (params: Record<string, unknown>) => {
    const session = params.session
    const turn = params.turn
    if (params.all === true) {
      if (session !== undefined || turn !== undefined) throw context.error('invalid-params', 'all cannot be combined with session or turn')
      return active.acknowledge({ all: true })
    }
    if (typeof session !== 'string' || session === '') throw context.error('invalid-params', 'session is required unless all is true')
    if (turn !== undefined && typeof turn !== 'string') throw context.error('invalid-params', 'turn must be a string')
    return active.acknowledge({ session, ...(typeof turn === 'string' ? { turn } : {}) })
  })
  context.provide('method:quirky.agent-status/clearCompleted', (params: Record<string, unknown>) =>
    active.clearCompleted(typeof params.worktree === 'string' ? params.worktree : undefined)
  )
  context.provide('method:quirky.agent-status/send', (params: Record<string, unknown>) =>
    active.send(requireString(context, params.session, 'session'), sendText(context, params.text), startTimeout(context, params.startTimeoutMs))
  )
  context.provide('method:quirky.agent-status/wait', (params: Record<string, unknown>) =>
    active.wait(
      requireString(context, params.session, 'session'),
      untilStates(context, params.until),
      boundedInteger(context, params.timeoutMs, 'timeoutMs', MAX_WAIT_MS, DEFAULT_WAIT_MS)
    )
  )
  context.provide('method:quirky.agent-status/waitOutput', (params: Record<string, unknown>) =>
    active.waitOutput(requireString(context, params.session, 'session'), {
      pattern: waitPattern(context, params.pattern),
      ignoreCase: params.ignoreCase === true,
      lines: boundedInteger(context, params.lines, 'lines', MAX_OUTPUT_LINES, DEFAULT_OUTPUT_LINES),
      timeoutMs: boundedInteger(context, params.timeoutMs, 'timeoutMs', MAX_WAIT_MS, DEFAULT_WAIT_MS)
    })
  )
  context.provide('method:quirky.agent-status/rules', () => active.rulesListing())
  context.provide('method:quirky.agent-status/ruleSet', (params: Record<string, unknown>) =>
    active.ruleSet(requireString(context, params.agent, 'agent'))
  )
  context.provide('method:quirky.agent-status/hooksStatus', () => installer.status())
  context.provide('method:quirky.agent-status/hooksSetup', (params: Record<string, unknown>) =>
    installer.setup(typeof params.agent === 'string' ? params.agent : undefined)
  )
  context.provide('method:quirky.agent-status/hooksRemove', (params: Record<string, unknown>) =>
    installer.remove(typeof params.agent === 'string' ? params.agent : undefined)
  )
  context.provide('job:quirky.agent-status/presence', () => active.sweepPresence())

  await active.hydrate()
  await drainSpool(context.home, (input) => active.ingest(input))
  listenerStops = [
    context.subscribe((event) => active.onEvent(event)),
    context.subscribe((event) => installer.onEvent(event)),
    context.pty.onFact((sessionId, fact) => active.onFact(sessionId, fact)),
    context.pty.onInput((sessionId, data) => active.onInput(sessionId, data))
  ]
  installer.begin()
}

export function deactivate(): void {
  for (const stop of listenerStops.splice(0)) stop()
  service?.shutdown()
  service = undefined
}
