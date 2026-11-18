import type { ModeItem, PermissionModeName, PlanItem, StructuredMessage } from '@quirky/protocol'

/** A plan version as its newest journal item shows it, with the journal span it covers. */
export type PlanVersion = PlanItem & { firstSeq: number; lastSeq: number }

/**
 * The plan versions in `messages` (journal order), one per version number and ordered by it. Every
 * status change journals a full copy, so the last item of a version is its current state.
 */
export function planVersions(messages: StructuredMessage[]): PlanVersion[] {
  const byVersion = new Map<number, PlanVersion>()
  for (const message of messages) {
    const item = message.item
    if (item?.kind !== 'plan') continue
    const existing = byVersion.get(item.version)
    byVersion.set(item.version, { ...item, firstSeq: existing?.firstSeq ?? message.seq, lastSeq: message.seq })
  }
  return [...byVersion.values()].sort((a, b) => a.version - b.version)
}

const modeItems = (messages: StructuredMessage[]): ModeItem[] =>
  messages.flatMap((message) => (message.item?.kind === 'mode' ? [message.item] : []))

/** The newest `mode` item, which is the mode Claude is in and whether Auto is on offer; null before any. */
export function currentMode(messages: StructuredMessage[]): ModeItem | null {
  return modeItems(messages).at(-1) ?? null
}

/** The mode that was in effect before the newest stretch of Plan, so leaving Plan can go back to it. */
export function previousMode(messages: StructuredMessage[]): PermissionModeName {
  const items = modeItems(messages)
  let end = items.length - 1
  while (end >= 0 && items[end]!.mode !== 'plan') end--
  if (end < 0) return 'default'
  let start = end
  while (start > 0 && items[start - 1]!.mode === 'plan') start--
  return items[start - 1]?.mode ?? 'default'
}

/** How an approval's target mode reads in the plan row and the panel marker. */
export function approvedModeLabel(mode: PlanItem['approvedMode']): string | null {
  if (mode === 'auto') return 'auto mode'
  if (mode === 'acceptEdits') return 'accept edits'
  if (mode === 'default') return 'review edits'
  return null
}

/** The transcript row's text for `item`, its version's latest state. */
export function planRowText(item: PlanItem): string {
  const { version } = item
  if (item.status === 'waiting') return `Plan ready (v${version}) · view in panel`
  if (item.status === 'approved') {
    const target = approvedModeLabel(item.approvedMode)
    return target === null ? `Plan approved (v${version})` : `Plan approved (v${version}) · ${target}`
  }
  return `Plan v${version} · ${item.status === 'revised' ? 'revised' : 'not answered'}`
}

/** The panel's version marker: "v2 · waiting · revised", "v3 · approved · auto mode". */
export function planMarker(item: PlanItem): string {
  const parts = [`v${item.version}`]
  if (item.status === 'approved') {
    const target = approvedModeLabel(item.approvedMode)
    parts.push(target === null ? 'approved' : `approved · ${target}`)
  } else {
    parts.push(item.status === 'not-answered' ? 'not answered' : item.status)
  }
  if (item.status === 'waiting' && item.version > 1) parts.push(item.unchanged === true ? 'unchanged' : 'revised')
  return parts.join(' · ')
}

/** The header chip's text for the newest version. */
export function planChipText(newest: PlanItem): string {
  if (newest.status === 'waiting') return `Plan · v${newest.version} waiting`
  if (newest.status === 'not-answered') return newest.reason === 'feedback' ? 'Plan · waiting for Claude' : 'Plan · not answered'
  return 'Plan'
}
