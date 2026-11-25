import type { AgentJournalRenderItem } from '../../../../../shared/agent-session-journal-types'
import type { AgentJournalVisualItem } from '../../../../../shared/agent-session-journal-v1-items'
import { validateViewSpec } from '../../../../../shared/view-spec/view-spec-validation'
import type { ViewSpec } from '../../../../../shared/view-spec/view-spec-types'

export type VisualRenderItem = AgentJournalRenderItem & { body: AgentJournalVisualItem }

export function isVisualItem(item: AgentJournalRenderItem): item is VisualRenderItem {
  return item.body.kind === 'visual'
}

export type VisualSpecState =
  | { kind: 'loading' }
  | { kind: 'ready'; spec: ViewSpec }
  | { kind: 'invalid'; errors: string[]; source: string }
  | { kind: 'failed'; message: string }

/** Reads one item whole from the host that keeps it; null when the host no longer has it. */
export type FullItemReader = () => Promise<AgentJournalRenderItem | null>

/** Each view once, at its newest revision, with the most recently opened view first. */
export function latestVisualsNewestFirst(
  items: readonly AgentJournalRenderItem[]
): VisualRenderItem[] {
  const byView = new Map<string, VisualRenderItem>()
  for (const item of items) {
    if (!isVisualItem(item)) {
      continue
    }
    const held = byView.get(item.body.viewId)
    if (!held || item.revision >= held.revision) {
      byView.set(item.body.viewId, item)
    }
  }
  return [...byView.values()].sort((a, b) => b.sequence - a.sequence)
}

/** True when the spec in the item is only a head: the wire shortened the item or the payload was cut. */
export function visualSpecNeedsFullItem(item: VisualRenderItem): boolean {
  return item.shortened === true || item.body.spec.truncated
}

function specFromText(text: string): VisualSpecState {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return {
      kind: 'invalid',
      errors: [
        `the spec is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
      ],
      source: text
    }
  }
  const checked = validateViewSpec(parsed)
  return checked.ok
    ? { kind: 'ready', spec: checked.spec }
    : { kind: 'invalid', errors: checked.errors, source: text }
}

/** The validated spec when the item already holds all of it, else null. */
export function readCompleteVisualSpec(item: VisualRenderItem): VisualSpecState | null {
  return visualSpecNeedsFullItem(item) ? null : specFromText(item.body.spec.head)
}

/**
 * The validated spec of a visual item. A complete head is read in place; a shortened or truncated
 * one is first replaced by the whole item from `readFull`. Never throws.
 */
export async function loadVisualSpec(
  item: VisualRenderItem,
  readFull: FullItemReader
): Promise<VisualSpecState> {
  const direct = readCompleteVisualSpec(item)
  if (direct !== null) {
    return direct
  }
  let full: AgentJournalRenderItem | null
  try {
    full = await readFull()
  } catch (error) {
    return { kind: 'failed', message: error instanceof Error ? error.message : String(error) }
  }
  if (full === null || !isVisualItem(full)) {
    return { kind: 'failed', message: 'The host no longer has this visual.' }
  }
  if (full.body.spec.truncated) {
    return { kind: 'failed', message: 'This visual is too large to show.' }
  }
  return specFromText(full.body.spec.head)
}
