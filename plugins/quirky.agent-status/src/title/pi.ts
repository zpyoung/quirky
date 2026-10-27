import type { TitleStatus } from './core'
import { containsBrailleSpinner } from './glyphs'

/**
 * Markers Pi/OMP write between the `π` prefix and their label to encode turn state
 * (`π : cwd` working, `π > cwd` idle, `π ! cwd` needs input). A table because upstream
 * re-punctuates this channel between releases.
 */
const PI_STATE_MARKER_STATUS: Record<string, TitleStatus> = {
  ':': 'working',
  '!': 'permission',
  '>': 'idle',
}

// brand at a token boundary so wrapper prefixes (`zsh | OMP : cwd`) still expose the marker;
// whitespace must precede the marker so the legacy no-space `π: cwd` stays idle
const PI_STATE_TITLE_RE = /(?:^|[\s|])(π|Pi|OMP)[ \t]+([:!>])(?=\s|$)/u

/** Status a Pi/OMP native state title asserts, or null when the title carries no marker. */
export function getPiStateTitleStatus(title: string): TitleStatus | null {
  const match = PI_STATE_TITLE_RE.exec(title)
  return match ? PI_STATE_MARKER_STATUS[match[2]] : null
}

const PI_COMPATIBLE_SYNTHETIC_TITLE_RE = /^\s*(?:[⠀-⣿]\s+)?(pi|omp)(?:\s+-\s+action required|\s+(?:ready|idle|done))?\s*$/i
const LEGACY_PI_COMPATIBLE_TITLE_RE = /^\s*(?:[⠀-⣿]\s+)?π(?:\s*[-:]|\s)\s*.*$/u
// the brand may already have been swapped for the owner's label, but only in exact profile
// casing: a lowercase `pi - refactor…` is prose, and `omp-harness` must not read as a state
const PI_COMPATIBLE_SEPARATOR_RE = /^\s*(?:π|Pi|OMP)(?::|\s+([!>-]))(?=\s|$)/u
const PI_COMPATIBLE_PERMISSION_TAIL_RE = /\baction required\b/i

/** Status of a bare or ready/idle/action-required Pi/OMP label, or null for any other title. */
export function getPiCompatibleSyntheticAgentStatus(title: string): TitleStatus | null {
  if (!PI_COMPATIBLE_SYNTHETIC_TITLE_RE.test(title)) return null
  if (containsBrailleSpinner(title)) return 'working'
  const lower = title.toLowerCase()
  if (lower.includes('action required') || lower.includes('permission') || lower.includes('waiting')) return 'permission'
  return 'idle'
}

export function isLegacyPiCompatibleTitle(title: string): boolean {
  return LEGACY_PI_COMPATIBLE_TITLE_RE.test(title)
}

/** Reads the run state a π-branded title encodes in its separator (`π ! label` is blocked). */
export function getPiCompatibleTitleSeparatorStatus(title: string): TitleStatus | null {
  const nativeState = getPiStateTitleStatus(title)
  if (nativeState) return nativeState
  // a spinner anywhere means working and outranks the separator
  if (containsBrailleSpinner(title)) return null
  const match = PI_COMPATIBLE_SEPARATOR_RE.exec(title)
  if (!match) return null
  // `-` is both a separator and the delimiter in `OMP - action required`
  if (PI_COMPATIBLE_PERMISSION_TAIL_RE.test(title)) return 'permission'
  return match[1] === '!' ? 'permission' : 'idle'
}
