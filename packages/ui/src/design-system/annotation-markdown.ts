/** Markdown escaping and line helpers shared by every plugin that renders annotation text for an agent. */

export function collapse(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 2048) : ''
}

export function longestBacktickRun(value: string): number {
  let longest = 0
  for (const match of value.matchAll(/`+/g)) longest = Math.max(longest, match[0].length)
  return longest
}

export function codeSpan(value: unknown): string {
  const text = collapse(value)
  const fence = '`'.repeat(Math.max(1, longestBacktickRun(text) + 1))
  const padding = text.startsWith('`') || text.endsWith('`') || text.startsWith(' ') || text.endsWith(' ') ? ' ' : ''
  return `${fence}${padding}${text}${padding}${fence}`
}

export function markdownText(value: unknown): string {
  const source = typeof value === 'string' ? value : ''
  let result = ''
  for (const char of source) {
    if (char === '\\' || '`*_{}[]<>#+.!|-'.includes(char)) result += '\\'
    result += char
  }
  return result
}

export function htmlFence(value: string): string {
  return '`'.repeat(Math.max(3, longestBacktickRun(value) + 1))
}

export function feedbackBlock(comment: string): string[] {
  const lines = comment.replace(/\r\n|\r/g, '\n').split('\n')
  return [`**Feedback:** ${markdownText(lines[0] ?? '')}`, ...lines.slice(1).map((line) => markdownText(line))]
}
