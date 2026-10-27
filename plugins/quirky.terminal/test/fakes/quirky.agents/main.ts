import type { PluginContext } from '@quirky/protocol'

const AGENTS: Record<string, { label: string; promptMode: string }> = {
  claude: { label: 'Claude', promptMode: 'argv' },
  codex: { label: 'Codex', promptMode: 'argv' },
  goose: { label: 'Goose', promptMode: 'stdin-after-start' }
}

/** Stands in for `quirky.agents/get` with agents that take their prompt on the command line and one that takes it after start. */
export function activate(context: PluginContext): void {
  context.provide('method:quirky.agents/get', (params: Record<string, unknown>) => {
    const agent = params.agent as string
    const found = AGENTS[agent]
    if (!found) throw context.error('not-found', `unknown agent: ${agent}`)
    return { id: agent, label: found.label, promptMode: found.promptMode, enabled: true, resumable: true, canFork: false }
  })
}
