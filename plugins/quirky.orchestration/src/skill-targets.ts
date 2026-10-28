import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

type Target = (home: string, configHome: string, env: Record<string, string | undefined>) => string

// Native global skill directories from https://github.com/vercel-labs/skills/blob/main/src/agents.ts.
// Keep only Quirky agent IDs whose loader has an explicit target; shared .agents targets are
// included only for the agent IDs documented to read that directory.
const targets: Record<string, Target> = {
  claude: (home, _config, env) => join(env.CLAUDE_CONFIG_DIR?.trim() || join(home, '.claude'), 'skills'),
  'claude-agent-teams': (home, _config, env) => join(env.CLAUDE_CONFIG_DIR?.trim() || join(home, '.claude'), 'skills'),
  amp: (_home, config) => join(config, 'agents', 'skills'),
  antigravity: (home) => join(home, '.gemini', 'antigravity', 'skills'),
  aug: (home) => join(home, '.augment', 'skills'),
  autohand: (home, _config, env) => join(env.AUTOHAND_HOME?.trim() || join(home, '.autohand'), 'skills'),
  cline: (home) => join(home, '.agents', 'skills'),
  codebuddy: (home) => join(home, '.codebuddy', 'skills'),
  codex: (home) => join(home, '.agents', 'skills'),
  'command-code': (home) => join(home, '.commandcode', 'skills'),
  continue: (home) => join(home, '.continue', 'skills'),
  copilot: (home) => join(home, '.copilot', 'skills'),
  crush: (_home, config) => join(config, 'crush', 'skills'),
  cursor: (home) => join(home, '.cursor', 'skills'),
  devin: (_home, config) => join(config, 'devin', 'skills'),
  droid: (home) => join(home, '.factory', 'skills'),
  gemini: (home) => join(home, '.gemini', 'skills'),
  goose: (_home, config) => join(config, 'goose', 'skills'),
  grok: (home, _config, env) => join(env.GROK_HOME?.trim() || join(home, '.grok'), 'skills'),
  hermes: (home, _config, env) => join(env.HERMES_HOME?.trim() || join(home, '.hermes'), 'skills'),
  kilo: (home) => join(home, '.kilo', 'skills'),
  kiro: (home) => join(home, '.kiro', 'skills'),
  kimi: (home) => join(home, '.agents', 'skills'),
  'mistral-vibe': (home, _config, env) => join(env.VIBE_HOME?.trim() || join(home, '.vibe'), 'skills'),
  openclaw: (home) => openClawSkillsDir(home),
  opencode: (_home, config) => join(config, 'opencode', 'skills'),
  pi: (home) => join(home, '.agents', 'skills'),
  qoder: (home) => join(home, '.qoder', 'skills'),
  'qoder-cn': (home) => join(home, '.qoder-cn', 'skills'),
  'qwen-code': (home) => join(home, '.qwen', 'skills'),
  roo: (home) => join(home, '.roo', 'skills'),
  rovo: (home) => join(home, '.rovodev', 'skills'),
  trae: (home) => join(home, '.trae', 'skills'),
  zcode: (home) => join(home, '.zcode', 'skills')
}

function openClawSkillsDir(home: string): string {
  if (existsSync(join(home, '.openclaw'))) return join(home, '.openclaw', 'skills')
  if (existsSync(join(home, '.clawdbot'))) return join(home, '.clawdbot', 'skills')
  if (existsSync(join(home, '.moltbot'))) return join(home, '.moltbot', 'skills')
  return join(home, '.openclaw', 'skills')
}

/** Return only the mapped agent's native global SKILL.md path, or null without a documented loader. */
export function skillPathForAgent(agentId: string, env: Record<string, string | undefined> = process.env): string | null {
  const home = env.HOME?.trim() || homedir()
  const configHome = env.XDG_CONFIG_HOME?.trim() || join(home, '.config')
  const target = Object.hasOwn(targets, agentId) ? targets[agentId] : undefined
  return target ? join(target(home, configHome, env), 'orchestration', 'SKILL.md') : null
}
