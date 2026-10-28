export function fitUsagePrefix(
  chipWidths: readonly number[],
  suffixButtonWidths: readonly number[],
  availableWidth: number,
  gap: number
): number | null {
  const chipCount = chipWidths.length
  if (chipCount === 0) return null

  let allChipsWidth = 0
  for (let index = 0; index < chipCount; index += 1) {
    allChipsWidth += chipWidths[index]!
    if (index > 0) allChipsWidth += gap
  }
  if (allChipsWidth <= availableWidth) return null

  let prefixWidth = 0
  let largestFittingPrefix = 0
  for (let visibleCount = 0; visibleCount < chipCount; visibleCount += 1) {
    if (visibleCount > 0) prefixWidth += chipWidths[visibleCount - 1]! + gap
    const collapsedCount = chipCount - visibleCount
    const suffixWidth = suffixButtonWidths[collapsedCount] ?? Number.POSITIVE_INFINITY
    const candidateWidth = prefixWidth + suffixWidth
    if (candidateWidth <= availableWidth) largestFittingPrefix = visibleCount
  }

  return largestFittingPrefix
}
