import { isQoderComposerReady } from './qoder-terminal-readiness'
import { memoizeTitleClassification } from '../../shared/terminal-title-classification-memo'
import { detectAgentStatusFromTitle, type AgentStatus } from '../../shared/agent-detection'
import type { RuntimeTerminalWaitBlockedReason } from '../../shared/runtime-types'
import type { TuiAgent } from '../../shared/tui-agent'
import {
  evaluateAgentStateRules,
  hasQuietReadyRules,
  holdsReadyTextToQuiet,
  type AgentStateVerdict
} from './agent-state-rules/agent-state-rules-engine'
import { findPromptAnchorIndexes } from './agent-state-rules/agent-state-text-anchors'
import { isTerminalWaitWhitespace } from './terminal-wait-tail-window'
import { showsIdleTitleAnchor } from './agent-state-rules/agent-state-title-anchors'
import { compiledFromActiveAgentStateRules } from './agent-state-rules/active-agent-state-rules'
import {
  findTerminalWaitBlockedSignal,
  isSettledAfter,
  isUnblockedAfter
} from './agent-state-rules/blocked-text-layer'

// Why agent-agnostic: Quirky's own `<Agent> ready` titles, and any agent title stating rest in words.
const EXPLICIT_IDLE_TITLE_RE = /(^|\s)(ready|idle|done)(\s|$|[.!?])/i

function computeExplicitIdleStatusFromTitle(title: string): AgentStatus | null {
  const status = detectAgentStatusFromTitle(title)
  // Why: launch titles like "Codex YOLO" contain an agent name but aren't readiness signals; terminal.wait needs explicit idle evidence.
  return status === 'idle' && (EXPLICIT_IDLE_TITLE_RE.test(title) || showsIdleTitleAnchor(title))
    ? 'idle'
    : null
}

/**
 * Pure in `title` for one rule set, so it is memoized on the title string like the status
 * classifier it wraps: the wait path re-asks for the same unchanged title on every poll tick and
 * every repaint frame, and the marker scan below is a regex sweep each time (~72ns vs ~7ns). Why a
 * fresh memo per rule set: a rules reload can change which titles read as idle.
 */
const explicitIdleTitleMemo = compiledFromActiveAgentStateRules(() =>
  memoizeTitleClassification(computeExplicitIdleStatusFromTitle)
)

export function detectExplicitIdleStatusFromTitle(title: string): AgentStatus | null {
  return explicitIdleTitleMemo()(title)
}

export function isKnownReadyPromptPreview(preview: string): boolean {
  const normalized = preview.toLowerCase()
  return isUnblockedAfter(normalized, findKnownReadyPromptIndex(normalized))
}

/**
 * The ready-prompt text rules for a pane about to take input. Unlike isKnownReadyPromptPreview
 * (agent presence), nothing counts while a hold anchor shows (Codex's provisional startup header):
 * 0.157 discards input typed behind it while its daemon starts.
 */
export function isKnownReadyPromptSettled(preview: string): boolean {
  const normalized = preview.toLowerCase()
  return isSettledAfter(normalized, findKnownReadyPromptIndex(normalized))
}

/**
 * Tier 1 body evidence for every tui-idle site. `readScreenLines` yields the screen the agent's
 * rules read, or null when the runtime has no trustworthy one.
 *
 * Why the agent's own answer is final: a screen refusal must shut the shared text lane too.
 * A strong rule held to quiet counts here only on a clockless pane, which cannot measure quiet;
 * on a clocked one isQuietReadyScreenBody holds it to quiescence instead, and an agent whose
 * own ready text is held to quiet takes no shared text either.
 */
export function isKnownReadyPromptBody(
  waitText: string,
  agent: TuiAgent | null,
  readScreenLines: () => readonly string[] | null,
  hasOutputClock: boolean
): boolean {
  if (agent === 'qoder' || agent === 'qoder-cn') {
    return isQoderComposerReady(readScreenLines())
  }
  // Why before the rules: such an agent settles only on the quiet lane while it has a clock.
  if (hasOutputClock && holdsReadyTextToQuiet(agent)) {
    return false
  }
  const ruled = evaluateAgentStateRules(agent, {
    readScreenLines,
    readText: () => waitText.toLowerCase(),
    hasOutputClock
  })
  if (ruled !== null) {
    return isStrongIdle(ruled) && (!ruled.requiresQuiet || !hasOutputClock)
  }
  return isKnownReadyPromptSettled(waitText)
}

/**
 * Tier 1b body evidence: a ready screen or text the agent also paints mid-turn, so the ranking
 * holds it to quiescence. Why identified panes only for Muse: a `cat`ed transcript or pager in an
 * unknown pane can show the composer.
 */
export function isQuietReadyScreenBody(
  waitText: string,
  agent: TuiAgent | null,
  readScreenLines: () => readonly string[] | null
): boolean {
  if (hasQuietReadyRules(agent)) {
    const ruled = evaluateAgentStateRules(agent, {
      readScreenLines,
      readText: () => waitText.toLowerCase()
    })
    return ruled !== null && isStrongIdle(ruled) && ruled.requiresQuiet
  }
  return (agent === null || agent === 'muse') && isMuseReadyPromptPreview(waitText)
}

function isStrongIdle(
  verdict: AgentStateVerdict
): verdict is Extract<AgentStateVerdict, { state: 'idle' }> {
  return verdict.state === 'idle' && verdict.strength === 'strong'
}

export function isMuseReadyPromptPreview(preview: string): boolean {
  const normalized = preview.toLowerCase()
  return isUnblockedAfter(normalized, findMuseReadyPromptIndex(normalized))
}

export function detectTerminalWaitBlockedReason(
  preview: string
): RuntimeTerminalWaitBlockedReason | null {
  const normalized = preview.toLowerCase()
  return findActionableTerminalWaitBlockedSignal(normalized)?.reason ?? null
}

export function findActionableTerminalWaitBlockedSignal(
  normalized: string
): { reason: RuntimeTerminalWaitBlockedReason; index: number } | null {
  const blockedSignal = findTerminalWaitBlockedSignal(normalized)
  if (blockedSignal === null) {
    return null
  }
  const dismissedModalIndex = findDismissedStartupModalIndex(normalized)
  // Why: a live prompt after the modal means it was dismissed → signal no longer actionable, even mid-run (Cursor never reports idle via OSC title).
  return dismissedModalIndex !== null && dismissedModalIndex > blockedSignal.index
    ? null
    : blockedSignal
}

// Why: a live prompt (idle OR busy) proves the startup modal was dismissed, so a mid-run Cursor lane stops reporting stale trust hits.
// Why Muse beside the rule-file anchors: Muse has not moved to agent-state-rules/ yet.
function findDismissedStartupModalIndex(normalized: string): number | null {
  const live = findPromptAnchorIndexes(normalized).live
  const muse = findMuseReadyPromptIndex(normalized)
  return live === null || muse === null ? (live ?? muse) : Math.max(live, muse)
}

function findKnownReadyPromptIndex(normalized: string): number | null {
  const anchored = findPromptAnchorIndexes(normalized).ready
  const claude = findClaudeReadyPromptIndex(normalized)
  return anchored === null || claude === null ? (anchored ?? claude) : Math.max(anchored, claude)
}

const CLAUDE_PROMPT_GLYPH = '\u276f'
const CLAUDE_EMPTY_INPUT_PLACEHOLDER = 'try "'
const CLAUDE_SPINNER_ROW_RE = /^[\u00b7\u2722\u2733\u2736\u273b\u273d] \S/
// Why not `thought`: a mid-turn thinking row shares the summary's `<verb> for <duration>` shape.
const CLAUDE_TURN_SUMMARY_RE =
  /^[\u00b7\u2722\u2733\u2736\u273b\u273d] (?!thought )[\p{L}'-]+ for \d/u

// Why the screen: Claude Code paints no idle OSC title. `Try "…"` fills the empty input box only
// before the first turn; after one, the proof is a past-tense summary row (`✻ Brewed for 1s`)
// where the live spinner row (`✶ Flambéing…`) stood. No banner check: SessionStart hook output
// routinely pushes the banner off the visible screen.
function findClaudeReadyPromptIndex(normalized: string): number | null {
  const promptIndex = normalized.lastIndexOf(CLAUDE_PROMPT_GLYPH)
  if (promptIndex === -1) {
    return null
  }
  let cursor = promptIndex + CLAUDE_PROMPT_GLYPH.length
  while (
    cursor < normalized.length &&
    (isTerminalWaitWhitespace(normalized, cursor) || normalized.charCodeAt(cursor) === 0xa0)
  ) {
    cursor += 1
  }
  if (normalized.startsWith(CLAUDE_EMPTY_INPUT_PLACEHOLDER, cursor)) {
    return promptIndex
  }
  return isClaudeInputEmpty(normalized, promptIndex) &&
    endsClaudeTurnWithSummary(normalized, promptIndex)
    ? promptIndex
    : null
}

function isClaudeInputEmpty(normalized: string, promptIndex: number): boolean {
  const lineEnd = normalized.indexOf('\n', promptIndex)
  return (
    normalized
      .slice(promptIndex + CLAUDE_PROMPT_GLYPH.length, lineEnd === -1 ? undefined : lineEnd)
      .trim() === ''
  )
}

/** Whether the last spinner-glyph row since the last submitted prompt is a finished-turn summary. */
function endsClaudeTurnWithSummary(normalized: string, promptIndex: number): boolean {
  const submittedIndex =
    promptIndex > 0 ? normalized.lastIndexOf(CLAUDE_PROMPT_GLYPH, promptIndex - 1) : -1
  const spinnerRows = normalized
    .slice(submittedIndex + 1, promptIndex)
    .split('\n')
    .map((line) => line.trimStart())
    .filter((line) => CLAUDE_SPINNER_ROW_RE.test(line))
  const lastRow = spinnerRows.at(-1)
  return lastRow !== undefined && CLAUDE_TURN_SUMMARY_RE.test(lastRow)
}

/**
 * Whether a tui-idle wait should read the provider's visible screen.
 *
 * Why Claude even with runtime text: it paints with cursor moves, so what reaches the tail is a
 * few status rows below its prompt box, never the prompt the ready rule needs.
 */
export function tuiIdleNeedsVisibleScreenProbe(
  lastAgentStatus: AgentStatus | null,
  waitText: string,
  agent: string | null | undefined
): boolean {
  return lastAgentStatus === null && (waitText.length === 0 || agent === 'claude')
}

// Why: Muse titles its OSC with the bare cwd and never updates it, so only the body can
// prove the TUI is up. The voice-input composer is present even without loaded skills.
function findMuseReadyPromptIndex(normalized: string): number | null {
  const headerIndex = normalized.lastIndexOf('muse code')
  if (headerIndex === -1) {
    return null
  }
  const segment = normalized.slice(headerIndex)
  return segment.includes('voice') && segment.includes('input') && segment.includes('❯')
    ? headerIndex
    : null
}
