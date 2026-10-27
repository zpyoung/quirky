const WRAPPER_SEPARATOR = ' | '

/**
 * A wrapped terminal title split into the texts an identity check should consider, whole title
 * first and innermost pane title last. Multiplexers prefix the pane's own title (`zsh | ⠋ Claude
 * Code`), so a check anchored to the start of the string would miss the agent that owns the pane.
 */
export function getWrapperTitleSegments(title: string): string[] {
  const segments = [title]
  let separatorIndex = title.indexOf(WRAPPER_SEPARATOR)
  while (separatorIndex >= 0) {
    const wrapped = title.slice(separatorIndex + WRAPPER_SEPARATOR.length).trim()
    if (wrapped && !segments.includes(wrapped)) segments.push(wrapped)
    separatorIndex = title.indexOf(WRAPPER_SEPARATOR, separatorIndex + WRAPPER_SEPARATOR.length)
  }
  return segments
}
