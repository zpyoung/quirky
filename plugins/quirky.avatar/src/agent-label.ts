const AGENT_LABELS: Record<string, string> = {
  claude: 'Claude', codebuddy: 'CodeBuddy', qoder: 'Qoder', codex: 'Codex', hermes: 'Hermes',
  pi: 'Pi', omp: 'OMP', 'prime-agent': 'Prime Agent', cursor: 'Cursor', gemini: 'Gemini',
  antigravity: 'Antigravity', rovo: 'Rovo Dev', copilot: 'GitHub Copilot', opencode: 'OpenCode',
  opencode2: 'OpenCode 2', zcode: 'ZCode', grok: 'Grok', openclaw: 'OpenClaw', devin: 'Devin',
  droid: 'Droid', cline: 'Cline', kimi: 'Kimi', muse: 'Muse', jcode: 'Jcode', kiro: 'Kiro'
}

/** The name a person knows an agent by; an unlisted id is capitalized and an empty one reads "this agent". */
export function agentLabel(agent: string): string {
  if (agent === '') return 'this agent'
  return AGENT_LABELS[agent] ?? agent.charAt(0).toUpperCase() + agent.slice(1)
}
