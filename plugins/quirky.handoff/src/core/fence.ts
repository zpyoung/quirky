/** A backtick fence longer than any backtick run in `text`, at least three. */
export function fenceFor(text: string): string {
  let longest = 0
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length)
  return '`'.repeat(Math.max(3, longest + 1))
}

/** `text` wrapped in a text fence that `text` cannot close. */
export function fenced(text: string): string {
  const fence = fenceFor(text)
  return `${fence}text\n${text}\n${fence}`
}
