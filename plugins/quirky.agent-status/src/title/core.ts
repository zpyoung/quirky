import { containsBrailleSpinner } from './glyphs'
import { isLegacyPiCompatibleTitle } from './pi'

export type TitleStatus = 'working' | 'permission' | 'idle'

const CLAUDE_COMMAND_RE = String.raw`(?:.*[\\/])?claude(?:\.(?:exe|cmd|bat|ps1))?`
const CLAUDE_MANAGEMENT_TITLE_RE = new RegExp(
  String.raw`^\s*(?:"${CLAUDE_COMMAND_RE}"|'${CLAUDE_COMMAND_RE}'|${CLAUDE_COMMAND_RE})\s+agents\s*$`,
  'i',
)

// boundary-aware so cwd paths such as `~/codex/ready` and `reworking` don't match
export const STRONG_IDLE_KEYWORDS_RE = /(?<![\w./\\-])(ready|idle|done)(?![\w\-])/i
export const STRONG_WORKING_KEYWORDS_RE = /(?<![\w./\\-])(working|thinking|running)(?![\w\-])/i

export const CURSOR_NATIVE_TITLE_LOWER = 'cursor agent'

export function isPiTerminalTitle(title: string): boolean {
  return isLegacyPiCompatibleTitle(title) && !containsBrailleSpinner(title)
}

export function containsAny(title: string, words: readonly string[]): boolean {
  const lower = title.toLowerCase()
  return words.some((word) => lower.includes(word))
}

export function isClaudeManagementTitle(title: string): boolean {
  return CLAUDE_MANAGEMENT_TITLE_RE.test(title)
}
