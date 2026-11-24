export const TERMINAL_PANE_SPLIT_SOURCES = [
  'contextual_tour',
  'keyboard',
  'context_menu',
  'command',
  'unknown'
] as const

export type TerminalPaneSplitSource = (typeof TERMINAL_PANE_SPLIT_SOURCES)[number]
