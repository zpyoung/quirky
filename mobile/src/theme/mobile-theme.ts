// Quirky mobile design tokens — matches desktop graphite/dark palette.
// All screen files should import from here instead of using inline hex values.

export const colors = {
  bgBase: '#0c0d0f',
  bgPanel: '#16171b',
  bgRaised: '#22242b',
  borderSubtle: '#24262c',
  editorSurface: '#16171b',
  // The chat composer: one lifted box whose round controls sit a step above it.
  composerSurface: '#16171b',
  composerBorder: 'rgba(236, 238, 242, 0.08)',
  composerControl: '#22242b',
  // A picked skill inside the composer's text.
  skillToken: '#5fd0d6',
  skillTokenSurface: 'rgba(95, 208, 214, 0.2)',

  textPrimary: '#eceef2',
  textSecondary: '#a0a6b1',
  textMuted: '#8a909b',

  // Crisp near-white surface for the single primary action on a screen (the
  // worktree FAB). Brighter than textPrimary so it reads as a solid button, not
  // disabled chrome, while staying monochrome (STYLEGUIDE: color is for state).
  surfaceBright: '#eceef2',

  accent: '#5fd0d6',
  // Text/icon color on a filled accent button, where the muted
  // textPrimary would lack contrast against the saturated fill.
  onAccent: '#0c0d0f',

  statusBlue: '#6fb3ff',
  statusGreen: '#4cc38a',
  statusAmber: '#e5b454',
  statusRed: '#ef6b73',
  // Merge CTA fill + its on-fill text, mirroring the desktop ChecksPanel's
  // bg-green-600 "Squash and merge" button (green-600 / white).
  mergeGreen: '#16a34a',
  onMergeGreen: '#ffffff',
  // Merged-PR purple, mirroring the desktop ReviewIcon's purple-400/70 tone.
  statusPurple: '#a78bfa',
  gitDecorationAdded: '#81b88b',
  gitDecorationDeleted: '#c74e39',
  diffAddedBg: 'rgba(63, 185, 80, 0.14)',
  diffDeletedBg: 'rgba(229, 83, 75, 0.14)',
  // Desktop's `--diff-*-gutter`: a tinted row's line-number column.
  diffAddedGutter: 'rgba(129, 184, 139, 0.3)',
  diffDeletedGutter: 'rgba(199, 78, 57, 0.32)',
  // Desktop's `--chat-diff-*`: diff text in the chat, mixed toward the foreground so it reads on a
  // tinted row where the git decoration colours would not.
  chatDiffAdded: '#a6f0b0',
  chatDiffRemoved: '#ffb3ad',

  syntaxComment: '#8a909b',
  syntaxKeyword: '#c79bff',
  syntaxString: '#6dd6b4',
  syntaxNumber: '#ff9d7a',
  syntaxType: '#5fd0d6',
  syntaxFunction: '#6fb3ff',
  syntaxVariable: '#eceef2',
  syntaxMeta: '#d6b58c',

  // Terminal WebView background — separate from app chrome
  terminalBg: '#16171b'
} as const

/** On your own message's fill (`colors.textPrimary`), where the dark palette's light text would
 *  vanish; its body text is `colors.bgBase`. */
export const onBrightColors = {
  secondary: '#4a4a4a',
  link: '#0f6f78',
  codeBackground: '#c8c8c8'
} as const

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24
} as const

export const radii = {
  row: 6,
  card: 14,
  button: 6,
  input: 6,
  camera: 8,
  composer: 24,
  // Attachment thumbnails and file cards inside the composer.
  composerItem: 12
} as const

export const typography = {
  titleSize: 18,
  bodySize: 14,
  metaSize: 12,
  monoFamily: 'monospace' as const
} as const
