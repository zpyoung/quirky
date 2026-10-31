import type { Comment } from '../contract'
import { OVERLAY_ATTRIBUTE } from './target'

export type Found = Map<string, DOMRect>

function locate(selector: string): DOMRect | null {
  if (selector === '') return null
  try {
    const element = document.querySelector(selector)
    if (element === null || element.closest(`[${OVERLAY_ATTRIBUTE}]`) !== null) return null
    const { visibility } = getComputedStyle(element)
    if (visibility === 'hidden' || visibility === 'collapse') return null
    const rect = element.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0 ? rect : null
  } catch {
    return null
  }
}

/**
 * Re-queries each comment's stored selector against the live document. A comment is found only
 * while its selector matches a visible element; the stored capture is never updated from a match.
 */
export function findMarkers(comments: Comment[]): Found {
  const found: Found = new Map()
  for (const comment of comments) {
    const rect = locate(comment.capture.selector)
    if (rect !== null) found.set(comment.id, rect)
  }
  return found
}
