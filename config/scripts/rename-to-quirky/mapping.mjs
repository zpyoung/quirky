/**
 * The Orca to Quirky mapping table and the text transform built on it.
 * applyMapping(text, { relPath, keepTokens }) runs, in order: the package.json
 * homepage rule, keepToken protection, explicit identity mappings (including
 * the two websocket port declarations, each in its own file only), then the
 * generic case-preserving mapping (longest first). It returns the new text, the
 * number of replacements, how many keepTokens it shielded, and the lines where
 * `orca` sat inside a word (see isBoundaryMatch).
 */

const GENERIC_MAP = {
  orcad: 'quirkyd',
  Orcad: 'Quirkyd',
  ORCAD: 'QUIRKYD',
  orca: 'quirky',
  Orca: 'Quirky',
  ORCA: 'QUIRKY'
}

const GENERIC_PATTERN = /orcad|Orcad|ORCAD|orca|Orca|ORCA/g

const HOMEPAGE_PATTERN = /("homepage"\s*:\s*"[^"]*?)github\.com\/stablyai\/orca"/g

const EXPLICIT_RULES = [
  { pattern: /Orca Dev(?![A-Za-z0-9])/g, to: 'Quirky' },
  { pattern: /com\.stablyai\.orca/g, to: 'com.zpyoung.quirky' },
  { pattern: /com\.stably\.orca/g, to: 'com.zpyoung.quirky' },
  { pattern: /zpyoung\/orca/g, to: 'zpyoung/quirky' },
  {
    pattern: /(\bconst\s+DEFAULT_WS_PORT\s*(?::[^=\n]+)?=\s*)6768(?![0-9A-Za-z_.])/g,
    to: (_match, head) => `${head}6778`,
    onlyIn: 'src/main/runtime/runtime-rpc/runtime-rpc-pairing-types.ts'
  },
  {
    pattern: /(\bconst\s+DEV_PINNED_WS_PORT\s*(?::[^=\n]+)?=\s*)6769(?![0-9A-Za-z_.])/g,
    to: (_match, head) => `${head}6779`,
    onlyIn: 'src/main/runtime/rpc/ws-fallback-port-store.ts'
  }
]

const isLetter = (char) => char !== undefined && /\p{L}/u.test(char)
const isUpper = (char) => isLetter(char) && char === char.toUpperCase() && char !== char.toLowerCase()
const isLower = (char) => isLetter(char) && char === char.toLowerCase() && char !== char.toUpperCase()

/**
 * True when the match at [start, start + length) sits on an identifier or
 * separator boundary on both sides: the neighbour is absent or not a letter, or
 * the case changes there (`getOrca`, `orcaPage`). Anything else (`torcas`,
 * `Orcas`, `porcaro`) is inside a word.
 */
export function isBoundaryMatch(text, start, length) {
  const before = text[start - 1]
  const first = text[start]
  const after = text[start + length]
  const last = text[start + length - 1]
  const leftOk = !isLetter(before) || (isUpper(first) && isLower(before))
  const rightOk = !isLetter(after) || (isUpper(after) && isLower(last))
  return leftOk && rightOk
}

export function mapGeneric(text) {
  return text.replace(GENERIC_PATTERN, (match) => GENERIC_MAP[match])
}

function protectKeepTokens(text, keepTokens) {
  const vault = []
  let hits = 0
  let out = text
  const ordered = [...keepTokens].filter(Boolean).sort((a, b) => b.length - a.length)
  for (const token of ordered) {
    const parts = out.split(token)
    if (parts.length === 1) {
      continue
    }
    hits += parts.length - 1
    const placeholder = `${''.repeat(vault.length + 1)}`
    vault.push({ placeholder, token })
    out = parts.join(placeholder)
  }
  const restore = (value) => {
    let restored = value
    for (const { placeholder, token } of vault) {
      restored = restored.split(placeholder).join(token)
    }
    return restored
  }
  return { out, hits, restore }
}

export function applyMapping(text, { relPath = '', keepTokens = [] } = {}) {
  let count = 0
  let out = text

  // runs before protection: the stablyai/orca keep token would otherwise shield the homepage URL
  if (relPath === 'package.json' || relPath.endsWith('/package.json')) {
    out = out.replace(HOMEPAGE_PATTERN, (_match, head) => {
      count++
      return `${head}github.com/zpyoung/quirky"`
    })
  }

  const protectedText = protectKeepTokens(out, keepTokens)
  out = protectedText.out

  for (const rule of EXPLICIT_RULES) {
    if (rule.onlyIn && rule.onlyIn !== relPath) {
      continue
    }
    out = out.replace(rule.pattern, (...args) => {
      count++
      return typeof rule.to === 'function' ? rule.to(...args) : rule.to
    })
  }

  const suspiciousLines = []
  let scannedTo = 0
  let line = 1
  out = out.replace(GENERIC_PATTERN, (match, offset, whole) => {
    count++
    if (!isBoundaryMatch(whole, offset, match.length)) {
      for (let i = scannedTo; i < offset; i++) {
        if (whole[i] === '\n') {
          line++
        }
      }
      scannedTo = offset
      if (suspiciousLines.at(-1) !== line) {
        suspiciousLines.push(line)
      }
    }
    return GENERIC_MAP[match]
  })

  const originalLines = suspiciousLines.length ? text.split('\n') : []
  return {
    text: protectedText.restore(out),
    count,
    keepHits: protectedText.hits,
    suspicious: suspiciousLines.map((lineNumber) => ({
      line: lineNumber,
      text: originalLines[lineNumber - 1].trim().slice(0, 200)
    }))
  }
}
