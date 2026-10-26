import type { AgentKind } from '@quirky/protocol'

export const AGENT_TITLES: Record<AgentKind, string> = {
  shell: 'Shell',
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
  gemini: 'Gemini'
}

/** Single-quotes `value` for a POSIX shell. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/**
 * The shell command that starts a non-shell agent. `extraArgs` (from launch hooks) sit after the
 * agent's own arguments and before the prompt; a blank prompt is left out.
 */
export function agentCommand(agent: Exclude<AgentKind, 'shell'>, prompt: string | undefined, extraArgs: readonly string[]): string {
  const text = prompt?.trim()
  const extra = extraArgs.map((arg) => ` ${shellQuote(arg)}`).join('')
  switch (agent) {
    case 'claude':
    case 'codex':
      return `${agent}${extra}${text ? ` ${shellQuote(text)}` : ''}`
    case 'opencode':
      return `opencode${extra}${text ? ` --prompt ${shellQuote(text)}` : ''}`
    case 'gemini':
      return `gemini${extra}${text ? ` --prompt-interactive ${shellQuote(text)}` : ''}`
  }
}
