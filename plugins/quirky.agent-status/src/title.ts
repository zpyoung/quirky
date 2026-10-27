import {
  CURSOR_NATIVE_TITLE_LOWER,
  STRONG_IDLE_KEYWORDS_RE,
  STRONG_WORKING_KEYWORDS_RE,
  containsAny,
  isClaudeManagementTitle,
  isPiTerminalTitle,
  type TitleStatus,
} from './title/core'
import { getDeepSeekBuildTitleStatus } from './title/dsb'
import { isDshTerminalTitle } from './title/dsh'
import {
  AGY_AGENT_NAME_RE,
  DROID_AGENT_NAME_RE,
  HERMES_AGENT_NAME_RE,
  titleHasAnyLegacyAgentName,
} from './title/names'
import {
  CLAUDE_IDLE,
  GEMINI_IDLE,
  GEMINI_PERMISSION,
  GEMINI_SILENT_WORKING,
  GEMINI_WORKING,
  containsAgentSpinnerGlyph,
} from './title/glyphs'
import { isOpenCodeNativeTitle } from './title/opencode'
import { getPiCompatibleSyntheticAgentStatus, getPiCompatibleTitleSeparatorStatus, getPiStateTitleStatus } from './title/pi'
import { qoderTitleStatus } from './title/qoder'

export type { TitleStatus }

/**
 * What a terminal title says about its agent, for sessions with no hook row: `working` (spinner
 * or working keyword), `permission` (the agent needs the user), `idle` (at rest), or `null` when
 * the title names no agent and carries no status glyph, such as a shell's `~/src/app`.
 */
export function classifyTitle(title: string): TitleStatus | null {
  const buildStatus = getDeepSeekBuildTitleStatus(title)
  if (buildStatus) return buildStatus
  const qoderStatus = qoderTitleStatus(title)
  if (qoderStatus) return qoderStatus
  if (!title || isClaudeManagementTitle(title)) return null
  if (title.trim().toLowerCase() === CURSOR_NATIVE_TITLE_LOWER) return null

  if (isOpenCodeNativeTitle(title)) return containsAgentSpinnerGlyph(title) ? 'working' : 'idle'

  // Pi/OMP's marker is an explicit protocol and its free-form label can carry any glyph or keyword
  const piStateStatus = getPiStateTitleStatus(title)
  if (piStateStatus) return piStateStatus

  // DSH prefixes `✦` at rest, which is Gemini's working glyph
  if (!isDshTerminalTitle(title)) {
    if (title.includes(GEMINI_PERMISSION)) return 'permission'
    if (title.includes(GEMINI_WORKING) || title.includes(GEMINI_SILENT_WORKING)) return 'working'
    if (title.includes(GEMINI_IDLE)) return 'idle'
  }

  const piSyntheticStatus = getPiCompatibleSyntheticAgentStatus(title)
  if (piSyntheticStatus) return piSyntheticStatus

  if (title.startsWith(`${CLAUDE_IDLE} `) || title === CLAUDE_IDLE) return 'idle'
  // before the blanket idle below: `π ! <label>` is an agent waiting on the user
  const piSeparatorStatus = getPiCompatibleTitleSeparatorStatus(title)
  if (piSeparatorStatus) return piSeparatorStatus
  if (isPiTerminalTitle(title)) return 'idle'
  if (containsAgentSpinnerGlyph(title)) return 'working'

  const hasDroidAgentName = DROID_AGENT_NAME_RE.test(title)
  const hasLegacyAgentName = titleHasAnyLegacyAgentName(title)
  if (!hasLegacyAgentName && !hasDroidAgentName && !HERMES_AGENT_NAME_RE.test(title) && !AGY_AGENT_NAME_RE.test(title)) {
    return null
  }
  if (containsAny(title, ['action required', 'permission', 'waiting'])) return 'permission'
  if (STRONG_IDLE_KEYWORDS_RE.test(title)) return 'idle'
  if (STRONG_WORKING_KEYWORDS_RE.test(title)) return 'working'
  if (title.startsWith('. ')) return 'working'
  if (title.startsWith('* ')) return 'idle'

  // droid hooks are authoritative; a name-only native title must not read as completion
  if (hasDroidAgentName && !hasLegacyAgentName) return null

  return 'idle'
}
