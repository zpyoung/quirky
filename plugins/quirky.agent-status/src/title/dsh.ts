/**
 * DSH-TUI titles are `<prefix> 🐋 <session title>`; the whale is the one part no other agent
 * emits. It must outrank the Gemini glyphs because DSH's rest prefix `✦` is Gemini's working glyph.
 */
export const DSH_WHALE = '\u{1F40B}'

export function isDshTerminalTitle(title: string): boolean {
  return title.includes(DSH_WHALE)
}
