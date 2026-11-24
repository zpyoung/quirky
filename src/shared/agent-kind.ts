// Mapping from the renderer's `TuiAgent` union (every agent Orca knows how to launch) to the
// closed `AgentKind` enum carried on launch descriptors. Lives in `src/shared/` because main and
// renderer both stamp and read it; a new TuiAgent member is one edit here.

import { z } from 'zod'
import type { TuiAgent } from './tui-agent'

// Mirrors `TuiAgent` launch surface; `claude`↔`claude-code` (product, not CLI string). `other` is the escape hatch; see `tuiAgentToAgentKind`.
export const AGENT_KIND_VALUES = [
  'claude-code',
  'claude-agent-teams',
  'codebuddy',
  'openclaude',
  'codex',
  'autohand',
  'opencode',
  'opencode2',
  'mimo-code',
  'pi',
  'omp',
  'prime-agent',
  'qoder',
  'qoder-cn',
  'gemini',
  'antigravity',
  'aider',
  'goose',
  'amp',
  'kilo',
  'kiro',
  'crush',
  'aug',
  'cline',
  'codebuff',
  'freebuff',
  'command-code',
  'continue',
  'cursor',
  'droid',
  'kimi',
  'mistral-vibe',
  'qwen-code',
  'rovo',
  'hermes',
  'openclaw',
  'copilot',
  'grok',
  'devin',
  'ante',
  'jcode',
  'trae',
  'muse',
  'dsh',
  'zcode',
  'other'
] as const
export const agentKindSchema = z.enum(AGENT_KIND_VALUES)
export type AgentKind = z.infer<typeof agentKindSchema>

export const launchSourceSchema = z.enum([
  'command_palette',
  'sidebar',
  'quick_command',
  'tab_bar_quick_launch',
  'task_page',
  'new_workspace_composer',
  'workspace_jump_palette',
  'shortcut',
  'onboarding',
  'diff_notes_send',
  'notes_send',
  'conflict_resolution',
  'source_control_recovery',
  'terminal_context_menu',
  'explain_commit',
  // Launches the host performs for a caller outside the desktop app.
  'cli',
  'mobile',
  'orchestration',
  'unknown'
])
export type LaunchSource = z.infer<typeof launchSourceSchema>

export const requestKindSchema = z.enum(['new', 'resume', 'followup'])
export type RequestKind = z.infer<typeof requestKindSchema>

/** What a launch descriptor says about the agent it starts. */
export type AgentLaunchMetadata = {
  agent_kind: AgentKind
  launch_source: LaunchSource
  request_kind: RequestKind
  nth_repo_added?: number
}

type ConcreteAgentKind = Exclude<AgentKind, 'other'>

const TUI_AGENT_KIND_BY_AGENT = {
  claude: 'claude-code',
  'claude-agent-teams': 'claude-agent-teams',
  codebuddy: 'codebuddy',
  openclaude: 'openclaude',
  codex: 'codex',
  autohand: 'autohand',
  opencode: 'opencode',
  opencode2: 'opencode2',
  'mimo-code': 'mimo-code',
  pi: 'pi',
  omp: 'omp',
  'prime-agent': 'prime-agent',
  qoder: 'qoder',
  'qoder-cn': 'qoder-cn',
  gemini: 'gemini',
  antigravity: 'antigravity',
  aider: 'aider',
  goose: 'goose',
  amp: 'amp',
  kilo: 'kilo',
  kiro: 'kiro',
  crush: 'crush',
  aug: 'aug',
  cline: 'cline',
  codebuff: 'codebuff',
  freebuff: 'freebuff',
  'command-code': 'command-code',
  continue: 'continue',
  cursor: 'cursor',
  droid: 'droid',
  kimi: 'kimi',
  'mistral-vibe': 'mistral-vibe',
  'qwen-code': 'qwen-code',
  rovo: 'rovo',
  hermes: 'hermes',
  openclaw: 'openclaw',
  copilot: 'copilot',
  grok: 'grok',
  devin: 'devin',
  ante: 'ante',
  trae: 'trae',
  muse: 'muse',
  zcode: 'zcode',
  dsh: 'dsh',
  jcode: 'jcode'
} satisfies Record<TuiAgent, ConcreteAgentKind>

// Why: `satisfies Record<TuiAgent, …>` makes the lookup exhaustive at compile
// time, but stale persisted settings or unsafe IPC casts can carry a string
// outside the union at runtime — fall back to `'other'` instead of throwing.
export function tuiAgentToAgentKind(agent: TuiAgent): AgentKind {
  return TUI_AGENT_KIND_BY_AGENT[agent] ?? 'other'
}

// Why: the worktree-initial-terminal launch path only carries the
// `agent_kind`, not the TuiAgent. Reverse the map so that path can stamp the
// tab's launch agent without threading TuiAgent through every startup builder.
const AGENT_BY_TUI_AGENT_KIND: Partial<Record<AgentKind, TuiAgent>> = Object.fromEntries(
  Object.entries(TUI_AGENT_KIND_BY_AGENT).map(([agent, kind]) => [kind, agent as TuiAgent])
)

export function agentKindToTuiAgent(kind: AgentKind | null | undefined): TuiAgent | null {
  if (!kind) {
    return null
  }
  return AGENT_BY_TUI_AGENT_KIND[kind] ?? null
}
