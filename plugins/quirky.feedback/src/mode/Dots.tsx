import type { Comment } from '../contract'
import type { Found } from './markers'
import * as styles from './styles'

/** Numbered dots over the elements the comments were written against; they never take the pointer. */
export function Dots({ comments, found }: { comments: Comment[]; found: Found }) {
  return <>{comments.map((comment, index) => {
    const rect = found.get(comment.id)
    if (rect === undefined) return null
    return <span key={comment.id} data-feedback-dot={comment.id} aria-hidden="true" style={{ ...styles.dot, left: rect.left, top: rect.top }}>{index + 1}</span>
  })}</>
}
