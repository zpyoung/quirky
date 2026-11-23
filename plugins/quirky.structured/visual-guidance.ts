import type { VisualLevel } from '@quirky/protocol'

export const VISUAL_LEVELS: readonly VisualLevel[] = ['off', 'balanced', 'visual-first']

/** The level named by `value`, or null when it is not one of the three. */
export function parseVisualLevel(value: unknown): VisualLevel | null {
  return VISUAL_LEVELS.find((level) => level === value) ?? null
}

/** The first line structured puts before a user message to tell the agent the chat's current level. */
export function visualLevelMarker(level: VisualLevel): string {
  return `[quirky visual level: ${level}]\n`
}

const GUIDANCE = `# Visuals in this chat

Quirky can show you drawings next to the chat. Draw with the \`quirky view\` command. \`quirky view --help\` lists every kind you can draw, with an example of each. A visual opens in the chat's visual panel unless you place it elsewhere.

## Levels

The user sets a visual level per chat. Each user message may start with a marker line, \`[quirky visual level: <level>]\`. The marker is Quirky's, not the user's words. The newest marker is the level in force, until another replaces it.

- off: draw nothing unless the user asks for a visual.
- balanced: draw when a visual is clearly better than text, such as a flow, a comparison or a layout.
- visual-first: any structured answer gets a visual. That means flows, architectures, comparisons, tables of options, timelines, plans, data and UI sketches. Chit-chat, short answers and simple yes or no replies stay text.

## Working with visuals

- Give every pane visual a \`label\` of a word or two ("SDD run"), because the chat shows visuals as tabs.
- Update the visual you already drew instead of drawing a near-duplicate. A change is a new version of the same visual.
- Use \`quirky view patch\` for a small edit. Send a whole new spec only when the structure changes.
- Keep the prose short and point at the visual. Do not repeat in text what the visual shows.
- If a version is refused or fails to render, Quirky tells you. Fix it and send a corrected version.
- Run \`quirky view done --id <id>\` when a visual's work is over, such as a signed-off mock, a finished brainstorm or a superseded spec. Updating it later makes it live again.
- Node ids are lowercase letters, digits and dashes.

## Pointing

The user can point at part of a visual. Their message then holds a pill written \`@view:<viewId>/v<version>/<element>\`, which means they are pointing at that element of that version. Reload it with \`quirky view get --id <viewId> --at-version <n>\` when you need the spec.`

/**
 * The standing instructions that make an agent draw visuals with `quirky view`, appended to its own system
 * prompt at session start and resume. It covers all three levels, so a level change needs only the marker.
 */
export function visualGuidance(): string {
  return GUIDANCE
}

/** What a session's `appendInstructions` carries: the guidance plus the chat's level at start or resume, so no marker is needed until it changes. */
export function visualInstructions(level: VisualLevel): string {
  return `${visualGuidance()}\nThis chat's visual level is ${level}.`
}
