/**
 * Turns raw agent output into a commit message, ported from Orca: strips the noise CLIs print
 * around an answer, then splits it into a subject and a body. Pure.
 */

type JcodeJsonResult = { text?: unknown }

function isJcodeJsonResult(value: unknown): value is JcodeJsonResult {
  return typeof value === 'object' && value !== null && 'text' in value
}

const REASONING_TAGS = [
  { open: '<think>', close: '</think>' },
  { open: '◁think▷', close: '◁/think▷' }
] as const

function normalizeLineFeeds(value: string): string {
  let crlf = value.indexOf('\r\n')
  if (crlf === -1) return value
  let normalized = `${value.slice(0, crlf)}\n`
  let chunkStart = crlf + 2
  crlf = value.indexOf('\r\n', chunkStart)
  while (crlf !== -1) {
    normalized += `${value.slice(chunkStart, crlf)}\n`
    chunkStart = crlf + 2
    crlf = value.indexOf('\r\n', chunkStart)
  }
  return `${normalized}${value.slice(chunkStart)}`
}

function stripLeadingReasoningBlock(text: string): string {
  for (const { open, close } of REASONING_TAGS) {
    if (!text.startsWith(open)) continue
    const closeIndex = text.indexOf(close, open.length)
    return closeIndex === -1 ? text : text.slice(closeIndex + close.length).trim()
  }
  return text
}

/** Drops reasoning that ends in a closing tag whose opening tag was never printed. */
function stripPrefilledReasoningPreamble(text: string): string {
  for (const { open, close } of REASONING_TAGS) {
    const closeIndex = text.indexOf(close)
    if (closeIndex !== -1 && text.lastIndexOf(open, closeIndex) === -1) return text.slice(closeIndex + close.length).trim()
  }
  return text
}

function isFenceInfoCharacter(code: number): boolean {
  return (
    (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 45 || code === 95
  )
}

/** The body of a fence that opens the text and closes at its very end, else null. Scans boundaries instead of building line arrays, as outputs can be huge. */
function enclosingFenceBody(text: string): string | null {
  if (!text.startsWith('```')) return null
  let headerEnd = 3
  while (headerEnd < text.length && text.charCodeAt(headerEnd) !== 10) {
    if (!isFenceInfoCharacter(text.charCodeAt(headerEnd))) return null
    headerEnd++
  }
  if (headerEnd >= text.length) return null
  const closingFenceStart = text.length - 3
  if (closingFenceStart <= headerEnd || !text.endsWith('```')) return null
  if (text.charCodeAt(closingFenceStart - 1) !== 10) return null
  return text.slice(headerEnd + 1, closingFenceStart - 1)
}

function cleanOutput(raw: string): string {
  let text = normalizeLineFeeds(raw).trim()

  if (text.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(text)
      if (isJcodeJsonResult(parsed) && typeof parsed.text === 'string') text = parsed.text.trim()
    } catch {
      // not a JSON envelope; keep the text as printed
    }
  }

  const tokensUsageIndex = text.search(/\n\[Tokens\]\s/)
  if (tokensUsageIndex !== -1) text = text.slice(0, tokensUsageIndex).trimEnd()

  // a real message never opens with these, so they are a CLI's status line
  const firstNewline = text.indexOf('\n')
  if (firstNewline !== -1) {
    const firstLine = text.slice(0, firstNewline)
    if (/^(generating|thinking)\b/i.test(firstLine) || /^[.…]+$/.test(firstLine.trim())) {
      text = text.slice(firstNewline + 1).trim()
    }
  }

  text = stripLeadingReasoningBlock(text)

  const fenced = enclosingFenceBody(text)
  if (fenced !== null) text = fenced.trim()

  return text.replace(/^(\s*)(?:[-*•●]\s+|\d+[.)]\s+)/, '$1').trim()
}

/**
 * The commit message an agent's raw output holds: surrounding whitespace, a jcode `{"text"}`
 * envelope, a trailing `[Tokens]` line, a leading status line or reasoning block, one enclosing
 * fence and a leading list marker are removed. With `custom` (a user's own command, which can run
 * a raw model) reasoning that only has a closing tag is dropped too; a built-in agent's message
 * may legitimately mention that tag.
 */
export function cleanGeneratedMessage(raw: string, options: { custom: boolean }): string {
  const cleaned = cleanOutput(raw)
  if (!options.custom) return cleaned
  const answer = stripPrefilledReasoningPreamble(cleaned)
  return answer === cleaned ? cleaned : cleanOutput(answer)
}

/**
 * Splits generated text into a subject (first line, trailing dots removed, at most 72 characters;
 * "Update project files" when empty) and a body (everything after that line, trimmed). `message`
 * joins them with a blank line.
 */
export function splitCommitMessage(text: string): { message: string; subject: string; body: string } {
  const normalized = cleanOutput(text)
  const firstNewline = normalized.indexOf('\n')
  const subjectLine = firstNewline === -1 ? normalized : normalized.slice(0, firstNewline)
  const subject = subjectLine.trim().replace(/[.]+$/g, '').slice(0, 72).trimEnd()
  const body = firstNewline === -1 ? '' : normalized.slice(firstNewline + 1).trim()
  const safeSubject = subject.length > 0 ? subject : 'Update project files'
  return { message: body.length > 0 ? `${safeSubject}\n\n${body}` : safeSubject, subject: safeSubject, body }
}
