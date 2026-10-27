import { join } from 'node:path'
import type { LaunchHookInput, LaunchPatch, PluginContext } from '@quirky/protocol'
import { ClaudeVersionGate, commandProbe, writeClaudeSettings } from './src/claude-settings'
import { HooksService } from './src/hooks'
import { AgentStatusService } from './src/service'
import { drainSpool } from './src/spool'
import { importNotificationsSetting, migrations, RowStore } from './src/store'

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

let service: AgentStatusService | undefined

/** Wires the agent-status service: hook events in, rows and session summaries out. */
export async function activate(context: PluginContext): Promise<void> {
  const store = context.openStore(migrations(context.home))
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
  await importNotificationsSetting(context, store)
  installer.begin()
}

export function deactivate(): void {
  service?.shutdown()
  service = undefined
}
