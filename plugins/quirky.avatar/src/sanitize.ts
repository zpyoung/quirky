const INVISIBLE = /[­᠎​-‏‪-‮⁠-⁤⁦-⁩﻿]/g
const HTML_COMMENT = /<!--[\s\S]*?(?:-->|$)/g
const DETAILS_BLOCK = /<details\b[^>]*>[\s\S]*?(?:<\/details\s*>|$)/gi
const INLINE_LINK_TITLE = /(\]\(\s*(?:<[^>]*>|[^)\s]*))\s+(?:"[^"]*"|'[^']*')\s*\)/g
const REFERENCE_LINK_TITLE = /^(\s*\[[^\]\n]+\]:\s*\S+)\s+(?:"[^"]*"|'[^']*'|\([^)\n]*\))[ \t]*$/gm
const MAX_PASSES = 8

/**
 * Removes the markup a reader cannot see but a model still reads: HTML comments, zero-width and
 * bidi control characters, `<details>` blocks and markdown link titles. Visible text is kept, so
 * a repo file or PR comment stays quotable data. Repeats until nothing changes, so markup that
 * only forms once an inner piece is removed does not survive.
 */
export function sanitize(text: string): string {
  let current = text.replace(INVISIBLE, '')
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const next = current
      .replace(HTML_COMMENT, '')
      .replace(DETAILS_BLOCK, '')
      .replace(INLINE_LINK_TITLE, '$1)')
      .replace(REFERENCE_LINK_TITLE, '$1')
    if (next === current) break
    current = next
  }
  return current
}

/**
 * Sanitizes `text` and wraps it in a labelled `<data>` block for a prompt, so the model reads it
 * as quoted material and not as instructions. A closing tag inside the text cannot end the block.
 */
export function quoteAsData(label: string, text: string): string {
  const body = sanitize(text).replace(/<\/data/gi, '<\\/data')
  const safeLabel = label.replace(/["<>\n]/g, ' ')
  return `<data source="${safeLabel}">\n${body}\n</data>`
}
