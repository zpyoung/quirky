import { useLayoutEffect, useRef } from 'react'
import { Button, TextArea } from '@quirky/ui'
import { MAX_COMMENT_LENGTH, type CommentIntent } from '../contract'
import { DISCARD_WARNING, type Card as CardState } from './session'
import * as styles from './styles'

type Actions = {
  setText(text: string): void
  setIntent(intent: CommentIntent): void
  submit(): void
  cancel(): void
}

const INTENTS: { intent: CommentIntent; label: string }[] = [
  { intent: 'change', label: 'Change' },
  { intent: 'question', label: 'Question' }
]

/** Where a comment is written: a new one for the selected element, or the text of a saved one. */
export function Card({ card, number, actions }: { card: CardState; number: number | null; actions: Actions }) {
  const trimmed = card.text.trim()
  const tooLong = trimmed.length > MAX_COMMENT_LENGTH
  const editing = card.id !== null
  const cardElement = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    const capture = card.capture
    if (editing || capture === null) return
    const element = cardElement.current
    if (element === null) return
    const win = element.ownerDocument.defaultView
    if (win === null) return
    const place = () => {
      const { width, height } = element.getBoundingClientRect()
      const rect = capture.rect
      const margin = 12
      const maxLeft = Math.max(margin, win.innerWidth - width - margin)
      const maxTop = Math.max(margin, win.innerHeight - height - margin)
      const left = Math.min(Math.max(rect.x, margin), maxLeft)
      const below = rect.y + rect.height + margin
      const above = rect.y - height - margin
      let top = Math.min(Math.max(rect.y, margin), maxTop)
      if (below >= margin && below <= maxTop) top = below
      else if (above >= margin) top = Math.min(above, maxTop)
      Object.assign(element.style, { left: `${left}px`, top: `${top}px`, right: 'auto', bottom: 'auto' })
    }
    place()
    const observer = new win.ResizeObserver(place)
    observer.observe(element)
    win.addEventListener('resize', place)
    return () => {
      observer.disconnect()
      win.removeEventListener('resize', place)
    }
  }, [card.capture, card.id, card.serial, card.warned, editing, tooLong])
  return <section ref={cardElement} data-feedback-card data-quirky-native-mask aria-label={editing ? 'Edit comment' : 'New comment'} style={styles.card}>
    <h2 style={styles.cardTitle}>{editing ? `Edit comment ${number ?? ''}` : `Comment on ${card.label}`}</h2>
    <div style={styles.cardBody}>
      <div role="group" aria-label="Kind of comment" style={styles.intentGroup}>
        {INTENTS.map(({ intent, label }) => <Button key={intent} variant={card.intent === intent ? 'primary' : 'secondary'} aria-pressed={card.intent === intent} onClick={() => actions.setIntent(intent)}>{label}</Button>)}
      </div>
      <TextArea
        label="Comment"
        autoFocus
        style={{ outlineOffset: 'calc(-1 * var(--ui-focus-width))' }}
        value={card.text}
        onChange={(event) => actions.setText(event.target.value)}
        error={tooLong ? `Comments can be up to ${MAX_COMMENT_LENGTH} characters.` : undefined}
      />
      {card.warned ? <p role="alert" style={styles.warning}>{DISCARD_WARNING}</p> : null}
    </div>
    <div style={styles.cardActions}>
      <Button onClick={actions.cancel}>Cancel</Button>
      <Button data-feedback-submit variant="primary" disabled={trimmed === '' || tooLong || card.saving} onClick={actions.submit}>{editing ? 'Save' : 'Add'}</Button>
    </div>
  </section>
}
