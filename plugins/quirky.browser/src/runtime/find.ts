export function findWatchOccurrences(query: string, forward: boolean, current: number): { current: number; total: number } {
  const selection = window.getSelection()
  const selectedRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null
  const selectedStartNode = selectedRange?.startContainer ?? null
  const selectedStartOffset = selectedRange?.startOffset ?? -1
  const selectedEndNode = selectedRange?.endContainer ?? null
  const selectedEndOffset = selectedRange?.endOffset ?? -1
  selection?.removeAllRanges()

  if (!query || !document.body) return { current: 0, total: 0 }

  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu')
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  const previousCurrent = Number.isSafeInteger(current) && current > 0 ? current : 0
  let firstNode: Node | null = null
  let firstOffset = 0
  let firstLength = 0
  let lastNode: Node | null = null
  let lastOffset = 0
  let lastLength = 0
  let nextNode: Node | null = null
  let nextOffset = 0
  let nextLength = 0
  let previousNode: Node | null = null
  let previousOffset = 0
  let previousLength = 0
  let previousMatchSelected = false
  let total = 0
  let node: Node | null

  while ((node = walker.nextNode())) {
    const parent = node.parentElement
    if (!parent || parent.closest('script,style,noscript,textarea,input,select,[contenteditable="true"],[hidden],[aria-hidden="true"]')) continue
    const source = node.nodeValue || ''
    pattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = pattern.exec(source))) {
      total++
      const offset = match.index
      const length = match[0].length
      if (!firstNode) {
        firstNode = node
        firstOffset = offset
        firstLength = length
      }
      lastNode = node
      lastOffset = offset
      lastLength = length
      if (total === previousCurrent) {
        previousMatchSelected = selectedStartNode === node && selectedStartOffset === offset &&
          selectedEndNode === node && selectedEndOffset === offset + length
      }
      if (total === previousCurrent + 1) {
        nextNode = node
        nextOffset = offset
        nextLength = length
      }
      if (total === previousCurrent - 1) {
        previousNode = node
        previousOffset = offset
        previousLength = length
      }
    }
  }

  if (total === 0) return { current: 0, total: 0 }
  const hasPreviousMatch = previousCurrent <= total && previousMatchSelected
  let targetCurrent: number
  let targetNode: Node | null
  let targetOffset: number
  let targetLength: number
  if (!hasPreviousMatch) {
    if (forward) {
      targetCurrent = 1
      targetNode = firstNode
      targetOffset = firstOffset
      targetLength = firstLength
    } else {
      targetCurrent = total
      targetNode = lastNode
      targetOffset = lastOffset
      targetLength = lastLength
    }
  } else if (forward && previousCurrent === total) {
    targetCurrent = 1
    targetNode = firstNode
    targetOffset = firstOffset
    targetLength = firstLength
  } else if (!forward && previousCurrent === 1) {
    targetCurrent = total
    targetNode = lastNode
    targetOffset = lastOffset
    targetLength = lastLength
  } else if (forward) {
    targetCurrent = previousCurrent + 1
    targetNode = nextNode
    targetOffset = nextOffset
    targetLength = nextLength
  } else {
    targetCurrent = previousCurrent - 1
    targetNode = previousNode
    targetOffset = previousOffset
    targetLength = previousLength
  }

  if (targetNode) {
    const range = document.createRange()
    range.setStart(targetNode, targetOffset)
    range.setEnd(targetNode, targetOffset + targetLength)
    selection?.addRange(range)
    const rect = range.getBoundingClientRect()
    window.scrollBy(rect.left, rect.top - window.innerHeight / 2)
  }
  return { current: targetCurrent, total }
}
