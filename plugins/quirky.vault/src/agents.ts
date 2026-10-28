// History sources, distinct from the larger launchable-agent catalog.
export const HISTORY_AGENTS = [
  'claude', 'codebuddy', 'qoder', 'codex', 'hermes', 'pi', 'omp', 'prime-agent',
  'cursor', 'gemini', 'antigravity', 'rovo', 'copilot', 'opencode', 'opencode2',
  'zcode', 'grok', 'openclaw', 'devin', 'droid', 'cline', 'kimi', 'muse', 'jcode', 'kiro'
] as const
export type HistoryAgent = typeof HISTORY_AGENTS[number]
