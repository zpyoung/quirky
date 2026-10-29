import type { ReactNode } from 'react'

const ESCAPE = '\uE002'

type Part = { text: string; highlighted: boolean }

function decodeTextOnce(text: string): string {
  return text.replace(/\uE002([012])/g, (_match, code: string) => {
    if (code === '0') return '[['
    if (code === '1') return ']]'
    return ESCAPE
  })
}

/** Parse FTS-authored markers before decoding source escapes; decoded literals are never scanned again. */
export function evidenceParts(source: string): Part[] {
  const raw: Part[] = []
  let highlighted = false
  let start = 0
  let cursor = 0
  while (cursor < source.length) {
    if (!highlighted && source.startsWith('[[', cursor)) {
      if (cursor > start) raw.push({ text: source.slice(start, cursor), highlighted: false })
      highlighted = true
      cursor += 2
      start = cursor
    } else if (highlighted && source.startsWith(']]', cursor)) {
      if (cursor > start) raw.push({ text: source.slice(start, cursor), highlighted: true })
      highlighted = false
      cursor += 2
      start = cursor
    } else {
      cursor += 1
    }
  }
  if (start < source.length) raw.push({ text: source.slice(start), highlighted })
  if (highlighted) return [{ text: decodeTextOnce(source), highlighted: false }]
  return raw.map((part) => ({ ...part, text: decodeTextOnce(part.text) })).filter((part) => part.text !== '')
}

export function EvidenceText({ source }: { source: string }): ReactNode {
  return evidenceParts(source).map((part, index) => part.highlighted
    ? <mark key={index} className="qvh-evidence-highlight" data-vault-highlight>{part.text}</mark>
    : <span key={index}>{part.text}</span>)
}
