import type { GeneratedAgentIconName } from './generated-agents'

const AGENT_MARKS: Record<string, GeneratedAgentIconName> = {
  aider: 'aider',
  amp: 'amp',
  antigravity: 'antigravity',
  rovo: 'atlassian',
  claude: 'claude',
  'claude-agent-teams': 'claude',
  cline: 'cline',
  codebuddy: 'codebuddy',
  codex: 'codex',
  'command-code': 'command-code',
  copilot: 'copilot',
  cursor: 'cursor',
  devin: 'devin',
  gemini: 'gemini',
  goose: 'goose',
  grok: 'grok',
  kilo: 'kilo',
  kimi: 'kimi',
  kiro: 'kiro',
  'mistral-vibe': 'mistral',
  muse: 'muse',
  opencode: 'opencode',
  opencode2: 'opencode',
  'opencode-go': 'opencode',
  pi: 'pi',
  qoder: 'qoder',
  'qoder-cn': 'qoder',
  'qwen-code': 'qwen',
  trae: 'trae',
  zcode: 'zai'
}

/** The vendored mark for an agent or usage provider ID, or null when it has none. */
export function agentIconName(id: string): GeneratedAgentIconName | null {
  return Object.hasOwn(AGENT_MARKS, id) ? AGENT_MARKS[id]! : null
}
