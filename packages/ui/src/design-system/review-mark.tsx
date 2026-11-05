import type { ReviewMarkProps, ReviewMarkState } from './contracts'

const glyphs: Record<ReviewMarkState, string> = { none: '○', reviewed: '✓', changed: '●' }
const defaultLabels: Record<ReviewMarkState, string> = {
  none: 'Not reviewed',
  reviewed: 'Reviewed',
  changed: 'Changed since review',
}

/** A glyph for a file's review state, exposed to assistive tech as an image named by `label`. */
export function ReviewMark({ state, label }: ReviewMarkProps) {
  return (
    <span role="img" aria-label={label ?? defaultLabels[state]} className={`ui-review-mark ui-review-mark--${state}`}>
      {glyphs[state]}
    </span>
  )
}
