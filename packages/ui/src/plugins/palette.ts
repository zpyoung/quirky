import { chordFromKeyEvent } from '@quirky/protocol'

const PALETTE_CHORD = 'mod+shift+p'

/** Whether a key press is the window's reserved chord for the command palette. */
export function isPaletteChord(event: Parameters<typeof chordFromKeyEvent>[0]): boolean {
  return chordFromKeyEvent(event) === PALETTE_CHORD
}

export type PaletteKey = { selected: number; run: boolean }

/**
 * Applies a key press to the palette's selection over `count` entries: arrows move and wrap, Enter
 * asks to run the selected entry (never when the list is empty). Other keys change nothing.
 */
export function paletteKey(key: string, selected: number, count: number): PaletteKey {
  if (count === 0) return { selected: 0, run: false }
  const current = Math.min(Math.max(selected, 0), count - 1)
  if (key === 'ArrowDown') return { selected: (current + 1) % count, run: false }
  if (key === 'ArrowUp') return { selected: (current - 1 + count) % count, run: false }
  return { selected: current, run: key === 'Enter' }
}
