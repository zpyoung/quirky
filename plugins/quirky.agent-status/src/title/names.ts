/**
 * Whole-token matching of agent names inside terminal titles. Substring matching painted cwd
 * titles such as `opencode-blinker` or `openclaude` as the wrong agent, so the boundary guard
 * rejects path separators and hyphenated compounds on both sides.
 */

// narrower than the launchable agents: a short name like "amp" would classify "timestamp ready"
export const AGENT_NAMES = [
  'claude',
  'openclaude',
  'codex',
  'copilot',
  'cursor',
  'gemini',
  'antigravity',
  'opencode',
  'opencode2',
  'mimo',
  'openclaw',
  'aider',
  'grok',
  'devin',
  'zcode',
  'jcode',
]

const WINDOWS_EXECUTABLE_SUFFIX = String.raw`(?:\.(?:exe|cmd|bat|ps1))`

const nameSource = (name: string) => `(?<![\\w./\\\\-])${name}(?:${WINDOWS_EXECUTABLE_SUFFIX})?(?![\\w./\\\\-])`

const ANY_LEGACY_AGENT_NAME_RE = new RegExp(AGENT_NAMES.map(nameSource).join('|'), 'i')

/** True when the title contains any known agent name as a whole token. */
export function titleHasAnyLegacyAgentName(title: string): boolean {
  return ANY_LEGACY_AGENT_NAME_RE.test(title)
}

// `android` contains `droid`; hermes and agy are unsafe as substrings for the same reason
export const DROID_AGENT_NAME_RE = /(?<![\w./\\-])droid(?![\w./\\-])/i
export const HERMES_AGENT_NAME_RE = /(?<![\w./\\-])hermes(?![\w./\\-])/i
export const AGY_AGENT_NAME_RE = /(?<![\w./\\-])agy(?![\w./\\-])/i
