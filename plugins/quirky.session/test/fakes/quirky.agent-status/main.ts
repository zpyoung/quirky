import { join } from 'node:path'
import type { LaunchHookInput, PluginContext } from '@quirky/protocol'

export function claudeSettingsFile(home: string): string {
  return join(home, 'hooks', 'claude-settings.json')
}

/** Adds the arguments the real agent-status hook adds: Claude's settings file and Codex's notify command. */
export function activate(context: PluginContext): void {
  context.provide('launch-hook:quirky.agent-status/agent-hooks', (launch: LaunchHookInput) => {
    if (launch.agent === 'claude') return { args: ['--settings', claudeSettingsFile(context.home)] }
    const notify = `notify=${JSON.stringify([join(context.home, 'bin', 'quirky-hook'), 'codex'])}`
    return { args: ['-c', notify] }
  })
}
