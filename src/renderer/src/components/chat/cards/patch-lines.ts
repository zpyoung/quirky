export type PatchLine =
  | { kind: 'hunk'; text: string }
  | {
      kind: 'context' | 'added' | 'removed'
      text: string
      oldLine: number | null
      newLine: number | null
    }

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

/** A unified diff as display lines with their line numbers; file headers and `\ No newline` notes
 *  are left out. A removed line has only an old number, an added line only a new one. */
export function parsePatchLines(patch: string): PatchLine[] {
  const lines: PatchLine[] = []
  let oldLine = 0
  let newLine = 0
  let inHunk = false
  for (const raw of patch.split('\n')) {
    const header = HUNK_HEADER.exec(raw)
    if (header) {
      oldLine = Number(header[1])
      newLine = Number(header[2])
      inHunk = true
      lines.push({ kind: 'hunk', text: raw })
      continue
    }
    if (!inHunk || raw.startsWith('\\')) {
      continue
    }
    const marker = raw.charAt(0)
    if (marker === '+') {
      lines.push({ kind: 'added', text: raw.slice(1), oldLine: null, newLine })
      newLine += 1
    } else if (marker === '-') {
      lines.push({ kind: 'removed', text: raw.slice(1), oldLine, newLine: null })
      oldLine += 1
    } else if (marker === ' ') {
      lines.push({ kind: 'context', text: raw.slice(1), oldLine, newLine })
      oldLine += 1
      newLine += 1
    }
  }
  return lines
}

/** Added and removed line counts of a patch; null when it was cut short, so the counts would lie. */
export function countPatchLines(
  patch: string,
  truncated: boolean
): { added: number; removed: number } | null {
  if (truncated) {
    return null
  }
  let added = 0
  let removed = 0
  for (const line of parsePatchLines(patch)) {
    added += line.kind === 'added' ? 1 : 0
    removed += line.kind === 'removed' ? 1 : 0
  }
  return { added, removed }
}
