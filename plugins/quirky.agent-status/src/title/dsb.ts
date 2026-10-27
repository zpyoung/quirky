import { CLAUDE_IDLE, GEMINI_IDLE, GEMINI_PERMISSION, GEMINI_SILENT_WORKING, GEMINI_WORKING, containsAgentSpinnerGlyph } from './glyphs'
import { isDshTerminalTitle } from './dsh'
import type { TitleStatus } from './core'
import { getWrapperTitleSegments } from './wrapper'

const DSB_TITLE_RE = /(?:^| - )deepseek build$/i
// DSB separates its spinner with " - "; a Claude task can end on the same suffix
const DSB_WORKING_TITLE_RE = /^(?:⚠ Action Required - )?[⠀-⣿]+\s+-\s+[\s\S]+?\s-\s+deepseek build$/i
const NATIVE_VENDOR_PREFIXES = [`${CLAUDE_IDLE} `, '. ', '* ', GEMINI_IDLE, GEMINI_PERMISSION, GEMINI_SILENT_WORKING, GEMINI_WORKING]

export function isDeepSeekBuildTerminalTitle(title: string): boolean {
  const segments = getWrapperTitleSegments(title.trim())
  // native owner markers win even inside a wrapper; task glyphs are not markers
  if (segments.some((segment) => isDshTerminalTitle(segment) || NATIVE_VENDOR_PREFIXES.some((prefix) => segment.startsWith(prefix)))) {
    return false
  }
  return segments.some((segment) => DSB_TITLE_RE.test(segment) && (!containsAgentSpinnerGlyph(segment) || DSB_WORKING_TITLE_RE.test(segment)))
}

export function getDeepSeekBuildTitleStatus(title: string): TitleStatus | null {
  if (!isDeepSeekBuildTerminalTitle(title)) return null
  const segments = getWrapperTitleSegments(title.trim())
  if (segments.some((segment) => segment.startsWith('⚠ Action Required - '))) return 'permission'
  return segments.some((segment) => DSB_WORKING_TITLE_RE.test(segment)) ? 'working' : 'idle'
}
