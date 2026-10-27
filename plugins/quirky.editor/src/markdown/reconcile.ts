import { applyPatches, cleanupEfficiency, cleanupSemantic, makeDiff, makePatches } from '@sanity/diff-match-patch'

const RECONCILE_MAX_CODE_UNITS = 50_000
const DIFF_TIMEOUT_SECONDS = 0.01

type ReconcileInput = {
  originalSource: string
  baseCanonical: string
  edited: string
  roundTrip(markdown: string): string | null
}

export type ReconcileResult = { text: string; preserved: boolean }

export function restoreMarkdownSourceEol(markdown: string, source: string): string {
  return restoreEol(toLf(markdown), detectDominantEol(source))
}

/** Reuses exact source bytes where a patch can be round-trip proven; unsafe edits fail closed. */
export function reconcileSerializedMarkdown({
  originalSource,
  baseCanonical,
  edited,
  roundTrip
}: ReconcileInput): ReconcileResult | null {
  if (edited === baseCanonical) return { text: originalSource, preserved: true }
  if (Math.max(originalSource.length, baseCanonical.length, edited.length) > RECONCILE_MAX_CODE_UNITS) return null

  const eol = detectDominantEol(originalSource)
  const base = restoreEol(toLf(baseCanonical), eol)
  const replacement = restoreEol(toLf(edited), eol)
  if (hasRepeatedHalfMatchSeed(base, replacement)) return null

  let diffs = makeDiff(base, replacement, { checkLines: true, timeout: DIFF_TIMEOUT_SECONDS })
  if (diffs.length > 2) {
    diffs = cleanupSemantic(diffs)
    diffs = cleanupEfficiency(diffs)
  }
  const patches = makePatches(base, diffs)
  const offsets = getUtf8OffsetsAtCodeUnitIndices(
    originalSource,
    patches.flatMap((patch) => [patch.start1, patch.start2])
  )
  for (const patch of patches) {
    const start1 = offsets.get(patch.start1)
    const start2 = offsets.get(patch.start2)
    if (start1 === undefined || start2 === undefined) return null
    patch.start1 = start1
    patch.start2 = start2
  }

  const [patched, applied] = applyPatches(patches, originalSource)
  if (applied.some((value) => !value)) return null
  const roundTripped = roundTrip(patched)
  if (roundTripped === null || normalizeForSafety(roundTripped) !== normalizeForSafety(edited)) return null
  return { text: patched, preserved: true }
}

function stripTrailingNewlines(text: string): string {
  return text.replace(/\n+$/, '')
}

function detectDominantEol(text: string): '\n' | '\r\n' {
  const total = (text.match(/\n/g) ?? []).length
  if (total === 0) return '\n'
  const crlf = (text.match(/\r\n/g) ?? []).length
  return crlf * 2 >= total ? '\r\n' : '\n'
}

function toLf(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

function restoreEol(text: string, eol: '\n' | '\r\n'): string {
  return eol === '\r\n' ? text.replace(/\n/g, '\r\n') : text
}

function normalizeForSafety(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

function utf8LengthOfCodePoint(codePoint: number): number {
  if (codePoint <= 0x7f) return 1
  if (codePoint <= 0x7ff) return 2
  if (codePoint <= 0xffff) return 3
  return 4
}

function getUtf8OffsetsAtCodeUnitIndices(text: string, codeUnitIndices: number[]): Map<number, number> {
  const targets = [...new Set(codeUnitIndices)].sort((left, right) => left - right)
  const offsets = new Map<number, number>()
  let codeUnitIndex = 0
  let byteOffset = 0
  for (const target of targets) {
    const boundedTarget = Math.max(0, Math.min(target, text.length))
    while (codeUnitIndex < boundedTarget) {
      const codePoint = text.codePointAt(codeUnitIndex) ?? 0xfffd
      byteOffset += utf8LengthOfCodePoint(codePoint >= 0xd800 && codePoint <= 0xdfff ? 0xfffd : codePoint)
      codeUnitIndex += codePoint > 0xffff ? 2 : 1
    }
    offsets.set(target, byteOffset)
  }
  return offsets
}

function hasRepeatedHalfMatchSeed(base: string, edited: string): boolean {
  const minimumLength = Math.min(base.length, edited.length)
  let prefixLength = 0
  while (prefixLength < minimumLength && base.charCodeAt(prefixLength) === edited.charCodeAt(prefixLength)) {
    prefixLength += 1
  }
  let suffixLength = 0
  while (
    suffixLength < minimumLength - prefixLength &&
    base.charCodeAt(base.length - suffixLength - 1) === edited.charCodeAt(edited.length - suffixLength - 1)
  ) {
    suffixLength += 1
  }
  const middleBase = base.slice(prefixLength, base.length - suffixLength)
  const middleEdited = edited.slice(prefixLength, edited.length - suffixLength)
  const longer = middleBase.length > middleEdited.length ? middleBase : middleEdited
  const shorter = middleBase.length > middleEdited.length ? middleEdited : middleBase
  if (longer.length < 4 || shorter.length * 2 < longer.length) return false

  const seedLength = Math.floor(longer.length / 4)
  for (const start of [Math.ceil(longer.length / 4), Math.ceil(longer.length / 2)]) {
    const seed = longer.slice(start, start + seedLength)
    const first = shorter.indexOf(seed)
    if (first !== -1 && shorter.includes(seed, first + 1)) return true
  }
  return false
}

