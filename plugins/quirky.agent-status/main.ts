import { join } from 'node:path'
import type { LaunchHookInput, LaunchPatch, PluginContext } from '@quirky/protocol'
import { ClaudeVersionGate, commandProbe, writeClaudeSettings } from './src/claude-settings'
import { HooksService } from './src/hooks'
import type { ScriptState } from './src/script-state'
import { AgentStatusService } from './src/service'
import { drainSpool } from './src/spool'
import { migrations, RowStore } from './src/store'
import { DEFAULT_OUTPUT_LINES, DEFAULT_WAIT_MS } from './src/waits'

const DEFAULT_CLAUDE_COMMAND = 'claude'

/** The launch arguments that point Claude at its per-version hook settings and Codex at the notify script. */
function agentHooks(context: PluginContext, gate: ClaudeVersionGate): (launch: LaunchHookInput) => Promise<LaunchPatch> {
  return async (launch) => {
    if (launch.agent === 'claude' || launch.agent === 'claude-agent-teams') {
      const version = await gate.version(await claudeCommand(context), { sessionId: launch.sessionId, worktreeId: launch.worktreeId })
      return { args: ['--settings', writeClaudeSettings(context.dataDir, version)] }
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

/** Wires the agent-status service: hook events in, rows and session summaries out. */
export async function activate(context: PluginContext): Promise<void> {
  const store = context.openStore(migrations)
  const active = new AgentStatusService(context, new RowStore(store))
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
  context.subscribe((event) => active.onEvent(event))
  context.subscribe((event) => installer.onEvent(event))
  context.pty.onFact((sessionId, fact) => active.onFact(sessionId, fact))
  context.pty.onInput((sessionId, data) => active.onInput(sessionId, data))
  installer.begin()
}

export function deactivate(): void {
  service?.shutdown()
  service = undefined
}
