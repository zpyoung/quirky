/** Resolved window appearance, after app theme choice and system preference. */
export type TerminalAppearanceMode = 'dark' | 'light'

export const TERMINAL_ANSI_KEYS = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'
] as const

/** Complete xterm-compatible palette data, independent of any renderer. */
export type TerminalPalette = Readonly<Record<(typeof TERMINAL_ANSI_KEYS)[number] |
  'background' | 'foreground' | 'cursor' | 'cursorAccent' | 'selectionBackground' | 'selectionForeground', string>>

/** Canonical graphite terminal tokens; plugins never define their own default colors. */
export const GRAPHITE_TERMINAL_PALETTES: Readonly<Record<TerminalAppearanceMode, TerminalPalette>> = {
  dark: {
    background: '#16171b', foreground: '#eceef2', cursor: '#eceef2', cursorAccent: '#16171b',
    selectionBackground: '#7c8cff40', selectionForeground: '#eceef2',
    black: '#101114', red: '#ef6b73', green: '#4cc38a', yellow: '#e5b454',
    blue: '#7c8cff', magenta: '#bd8ee8', cyan: '#63c5cf', white: '#c5c9d2',
    brightBlack: '#7c828d', brightRed: '#ff8b93', brightGreen: '#70dba5', brightYellow: '#f5ce7e',
    brightBlue: '#a0acff', brightMagenta: '#d4acf4', brightCyan: '#8ddce3', brightWhite: '#eceef2'
  },
  light: {
    background: '#ffffff', foreground: '#1b1d22', cursor: '#1b1d22', cursorAccent: '#ffffff',
    selectionBackground: '#5b6cff30', selectionForeground: '#1b1d22',
    black: '#1b1d22', red: '#d6455d', green: '#1f9d63', yellow: '#a56e08',
    blue: '#5b6cff', magenta: '#9656b8', cyan: '#167f8b', white: '#c5c9d2',
    brightBlack: '#646b76', brightRed: '#b62d46', brightGreen: '#167747', brightYellow: '#855706',
    brightBlue: '#4352cb', brightMagenta: '#784293', brightCyan: '#106570', brightWhite: '#f4f5f7'
  }
}
