import { join } from 'node:path'
import type { LaunchHookInput, PluginContext } from '@quirky/protocol'

export const CLAUDE_SETTINGS = {
  hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'fake-statusline-hook' }] }] }
}

type PointerState = 'idle' | 'working' | 'blocked' | 'unknown' | 'exited'
let pointerState: PointerState = 'unknown'
let pointerQuiet = true

export function resetPointerState(): void {
  pointerState = 'unknown'
  pointerQuiet = true
}

export function setPointerState(state: PointerState): void {
  pointerState = state
}

export function setPointerQuiet(quiet: boolean): void {
  pointerQuiet = quiet
}


/** Supplies launch-hook arguments and script-state results for session tests. */
export function activate(context: PluginContext): void {
  context.provide('launch-hook:quirky.agent-status/agent-hooks', (launch: LaunchHookInput) => {
    if (launch.agent === 'claude') return { jsonArgs: { '--settings': CLAUDE_SETTINGS } }
    const notify = `notify=${JSON.stringify([join(context.home, 'bin', 'quirky-hook'), 'codex'])}`
    return { args: ['-c', notify] }
  })
  context.provide('method:quirky.agent-status/explain', (params: Record<string, unknown>) => ({
    session: params.session,
    name: null,
    agent: 'claude',
    state: pointerState,
    screen: { origin: null, verdict: null, ignored: [], ...(pointerQuiet ? {} : { pendingQuiet: 'idle' }) },
    decidedBy: 'rule',
    summary: pointerState
  }))
}
