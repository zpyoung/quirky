import { useLayoutEffect, useRef } from 'react'
import { Badge, Button, EmptyState, SectionHeader } from '@quirky/ui'
import type { Found } from './markers'
import { plural, type Session, type SessionState } from './session'
import * as styles from './styles'

type Props = { state: SessionState; found: Found; session: Session }

const WINDOW_MARGIN = 12
const BANNER_GAP = 4

/** Hangs the panel from the banner's right edge, keeping it inside the window. */
function placeUnderBanner(panel: HTMLElement) {
  const banner = panel.ownerDocument.querySelector('[data-feedback-banner]')?.getBoundingClientRect()
  const win = panel.ownerDocument.defaultView
  if (banner === undefined || win === null) return
  const top = banner.bottom + BANNER_GAP
  const right = Math.max(win.innerWidth - banner.right, WINDOW_MARGIN)
  Object.assign(panel.style, {
    top: `${top}px`,
    right: `${right}px`,
    maxWidth: `${Math.max(0, win.innerWidth - right - WINDOW_MARGIN)}px`,
    maxHeight: `${Math.max(0, Math.min(win.innerHeight * 0.6, win.innerHeight - top - WINDOW_MARGIN))}px`
  })
}

/**
 * The dropdown opened from the banner: every saved comment with its number, intent, owner and whether
 * its element is still on screen. It renders here rather than in the banner slot because that slot
 * stacks above the comment card, which has to stay on top. App re-renders on every layout change, so
 * the placement stays current without observers of its own.
 */
export function Tray({ state, found, session }: Props) {
  const panel = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    if (panel.current !== null) placeUnderBanner(panel.current)
  })
  const { comments, collapsed } = state
  const empty = comments.length === 0
  if (collapsed) return null
  return <section ref={panel} data-feedback-tray data-quirky-native-mask aria-label="Feedback comments" style={styles.tray}>
    <div style={styles.trayHead}>
      <SectionHeader title={`Feedback · ${plural(comments.length, 'comment')}`} actions={<>
        <Button data-feedback-copy disabled={empty} onClick={() => void session.copy()}>Copy</Button>
        <Button data-feedback-file disabled={empty} onClick={() => void session.fileIssue()}>File issue</Button>
        <Button data-feedback-clear variant="destructive" disabled={empty} onClick={() => void session.clear()}>Clear</Button>
      </>} />
    </div>
    <div style={styles.trayBody}>
      {state.recovered ? <p data-feedback-recovered style={styles.notice}>An unreadable comments file was set aside, so the tray started empty.</p> : null}
      {state.notice !== null ? <p data-feedback-notice role="status" style={styles.notice}>{state.notice}</p> : null}
      {empty ? <EmptyState message="Click part of the app to add a comment." /> : comments.map((comment, index) => {
        const stale = !found.has(comment.id)
        return <article key={comment.id} data-feedback-row={comment.id} style={styles.row}>
          <button type="button" aria-label={`Edit comment ${index + 1}`} style={styles.rowMain} onClick={() => session.edit(comment.id)}>
            <span style={styles.rowHead}>
              <strong>{index + 1}.</strong>
              <Badge>{comment.intent === 'change' ? 'Change' : 'Question'}</Badge>
            </span>
            <span style={styles.rowComment}>{comment.comment}</span>
            <small style={styles.rowMeta}>
              {session.ownerName(comment.capture.owner)}
              {stale ? <span data-feedback-stale style={styles.rowStale}> · No longer on screen</span> : null}
            </small>
          </button>
          <Button variant="destructive" aria-label={`Delete comment ${index + 1}`} onClick={() => void session.remove(comment.id)}>Delete</Button>
        </article>
      })}
    </div>
  </section>
}
