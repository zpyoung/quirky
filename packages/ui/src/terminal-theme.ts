import { GRAPHITE_TERMINAL_PALETTES, type TerminalAppearanceMode, type TerminalPalette } from '@quirky/protocol'

function appearanceFor(element: Element): TerminalAppearanceMode {
  const document = element.ownerDocument
  const declared = document.documentElement.getAttribute('data-theme')
  if (declared !== null) return declared === 'light' ? 'light' : 'dark'
  return document.defaultView?.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

/** Reads the app's full graphite terminal palette and overlays inherited app/plugin terminal base colors. */
export function readTerminalTheme(element: Element): TerminalPalette {
  const palette = GRAPHITE_TERMINAL_PALETTES[appearanceFor(element)]
  const style = element.ownerDocument.defaultView?.getComputedStyle(element)
  return {
    ...palette,
    background: style?.getPropertyValue('--terminal-background').trim() || palette.background,
    foreground: style?.getPropertyValue('--terminal-foreground').trim() || palette.foreground,
    cursor: style?.getPropertyValue('--terminal-cursor').trim() || palette.cursor
  }
}
