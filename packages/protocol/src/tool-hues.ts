/** The hue names a tool may register. Each resolves to a `--ui-hue-<name>` token, and none is a status color. */
export const UI_TOOL_HUES = ['blue', 'violet', 'teal', 'coral', 'magenta', 'slate', 'azure', 'sand', 'mint', 'lilac', 'rose', 'tan', 'cyan', 'plum'] as const
export type UiToolHue = (typeof UI_TOOL_HUES)[number]
