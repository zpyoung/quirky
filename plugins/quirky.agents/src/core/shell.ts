export type TokenizeResult = { ok: true; tokens: string[] } | { ok: false; error: string }

const SAFE_BARE = /^[A-Za-z0-9_@%+=:,./-]+$/

/**
 * Splits user-typed text into literal tokens the way a POSIX shell would split words, without ever
 * expanding anything: `;`, `|`, `&`, `$(` and backticks are ordinary characters, so a token only
 * ever reaches a command line through `quote`. Single quotes are literal; inside double quotes a
 * backslash escapes only `$`, backtick, `"`, `\` and newline; outside quotes it escapes the next
 * character, and a backslash-newline pair vanishes.
 */
export function tokenize(text: string): TokenizeResult {
  const tokens: string[] = []
  let current = ''
  let inToken = false
  let quote: '"' | "'" | null = null
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quote === "'") {
      if (ch === "'") quote = null
      else current += ch
      continue
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = null
      } else if (ch === '\\' && i + 1 < text.length) {
        const next = text[i + 1]
        if ('$`"\\'.includes(next)) {
          current += next
          i++
        } else if (next === '\n') {
          i++
        } else {
          current += ch
        }
      } else {
        current += ch
      }
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      inToken = true
    } else if (ch === '\\' && i + 1 < text.length) {
      const next = text[i + 1]
      i++
      if (next !== '\n') {
        current += next
        inToken = true
      }
    } else if (/\s/.test(ch)) {
      if (inToken) {
        tokens.push(current)
        current = ''
        inToken = false
      }
    } else {
      current += ch
      inToken = true
    }
  }
  if (quote) return { ok: false, error: 'unterminated quote' }
  if (inToken) tokens.push(current)
  return { ok: true, tokens }
}

/**
 * Quotes one token so sh, bash, zsh, dash and fish all read back the same bytes. Single quotes are
 * not literal in fish (backslash escapes survive inside them), so a quote is spliced as `"'"` and
 * a backslash as `"\\"` between single-quoted runs. A token of plain characters stays bare unless
 * `always` is set; one starting with `=` is always quoted because zsh expands `=cmd`.
 */
export function quote(token: string, always = false): string {
  if (!token) return "''"
  if (!always && SAFE_BARE.test(token) && !token.startsWith('=')) return token
  const parts: string[] = []
  let literal = ''
  const flush = (): void => {
    if (literal) {
      parts.push(`'${literal}'`)
      literal = ''
    }
  }
  for (const ch of token) {
    if (ch === "'") {
      flush()
      parts.push(`"'"`)
    } else if (ch === '\\') {
      flush()
      parts.push('"\\\\"')
    } else {
      literal += ch
    }
  }
  flush()
  return parts.join('')
}

/** Joins tokens into one command line, each quoted so the shell sees exactly these words. */
export function joinCommand(tokens: string[]): string {
  return tokens.map((token) => quote(token)).join(' ')
}
