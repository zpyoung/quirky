import type { UiToolHue } from './tool-hues'
import type { UiSlotEntry } from './ui'

/** The six host-owned locations for plugin tool windows. */
export const UI_TOOL_SLOTS = ['left-top', 'left-bottom', 'right-top', 'right-bottom', 'bottom-left', 'bottom-right'] as const
export type UiToolSlot = (typeof UI_TOOL_SLOTS)[number]
/** Where a tool lives: one of the slots, or the left stripe's overflow list. */
export type UiToolPlacement = UiToolSlot | 'overflow'

/** A host projection of effective plugin contributions, not a second plugin registry. */
export type UiToolEntry = {
  id: string
  title: string
  icon: string
  hue: UiToolHue
  defaultSlot: UiToolSlot
  /** Null only for the host-owned Inbox. */
  contributionId: string | null
  /** Original contribution IDs which target this tool after projection. */
  aliases: string[]
  /**
   * A view that shows this tool full size. The tool's slot and this view are never both open for
   * the focused window, so opening one closes the other.
   */
  expandedView?: string
}

/** Saved once per user profile, never per worktree or project. */
export type UiToolLayout = {
  placements: Record<string, UiToolPlacement>
  order: string[]
  /** Holds only real slots, never `'overflow'`. */
  open: Record<UiToolSlot, string | null>
  sizes: { left: number; right: number; bottom: number; leftSplit: number; rightSplit: number; bottomSplit: number }
}

export type UiToolResize = Partial<UiToolLayout['sizes']>
export type UiToolContribution = UiSlotEntry & { defaultSlot?: UiToolSlot; icon?: string; hue?: UiToolHue }
