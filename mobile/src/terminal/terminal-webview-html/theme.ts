import type { RuntimeMobileTerminalTheme } from '../../../../src/shared/runtime-types'
import { colors } from '../../theme/mobile-theme'

export const DEFAULT_TERMINAL_THEME: RuntimeMobileTerminalTheme['theme'] = {
  background: colors.terminalBg,
  foreground: '#eceef2',
  cursor: '#eceef2',
  cursorAccent: colors.terminalBg,
  selectionBackground: '#5fd0d640',
  selectionForeground: '#eceef2',
  black: '#101114',
  red: '#ef6b73',
  green: '#4cc38a',
  yellow: '#e5b454',
  blue: '#6fb3ff',
  magenta: '#bd8ee8',
  cyan: '#63c5cf',
  white: '#c5c9d2',
  brightBlack: '#7c828d',
  brightRed: '#ff8b93',
  brightGreen: '#70dba5',
  brightYellow: '#f5ce7e',
  brightBlue: '#9fcbff',
  brightMagenta: '#d4acf4',
  brightCyan: '#8ddce3',
  brightWhite: '#eceef2'
}

export const MOBILE_TERMINAL_CARET_OPTIONS = {
  cursorBlink: false,
  cursorStyle: 'bar',
  showCursorImmediately: true,
  cursorInactiveStyle: 'block'
} as const
