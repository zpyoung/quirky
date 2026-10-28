export const uiTokens = {
  color: {
    rail: '--ui-rail',
    surface: '--ui-surface',
    selected: '--ui-selected',
    border: '--ui-border',
    text: '--ui-text',
    muted: '--ui-muted',
    accent: '--ui-accent',
    working: '--ui-working',
    needsYou: '--ui-needs-you',
    failing: '--ui-failing',
  },
  font: {
    title: '--ui-font-title',
    body: '--ui-font-body',
    label: '--ui-font-label',
    section: '--ui-font-section',
    mono: '--ui-font-mono',
  },
  space: {
    2: '--ui-space-2',
    4: '--ui-space-4',
    6: '--ui-space-6',
    8: '--ui-space-8',
    12: '--ui-space-12',
    16: '--ui-space-16',
    24: '--ui-space-24',
  },
  radius: {
    mark: '--ui-radius-mark',
    control: '--ui-radius-control',
    window: '--ui-radius-window',
  },
  row: {
    single: '--ui-row-single',
    double: '--ui-row-double',
  },
  dimension: {
    borderWidth: '--ui-border-width',
    focusWidth: '--ui-focus-width',
    focusOffset: '--ui-focus-offset',
    icon: '--ui-icon-size',
    statusDot: '--ui-status-dot-size',
  },
} as const

type TokenGroups = typeof uiTokens
export type UiTokenName = {
  [Group in keyof TokenGroups]: TokenGroups[Group][keyof TokenGroups[Group]]
}[keyof TokenGroups]
