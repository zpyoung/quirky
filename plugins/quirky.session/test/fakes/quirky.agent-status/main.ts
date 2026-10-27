import { join } from 'node:path'
import type { LaunchHookInput, PluginContext } from '@quirky/protocol'

export const CLAUDE_SETTINGS = {
  hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'fake-statusline-hook' }] }] }
}

/** Adds the JSON settings and Codex notify arguments produced by agent-status. */
export function activate(context: PluginContext): void {
  context.provide('launch-hook:quirky.agent-status/agent-hooks', (launch: LaunchHookInput) => {
    if (launch.agent === 'claude') return { jsonArgs: { '--settings': CLAUDE_SETTINGS } }
    const notify = `notify=${JSON.stringify([join(context.home, 'bin', 'quirky-hook'), 'codex'])}`
    return { args: ['-c', notify] }
  })
}
