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
  return <section data-feedback-card data-quirky-native-mask aria-label={editing ? 'Edit comment' : 'New comment'} style={styles.card}>
    <h2 style={styles.cardTitle}>{editing ? `Edit comment ${number ?? ''}` : `Comment on ${card.label}`}</h2>
    <div style={styles.cardBody}>
      <div role="group" aria-label="Kind of comment" style={styles.intentGroup}>
        {INTENTS.map(({ intent, label }) => <Button key={intent} variant={card.intent === intent ? 'primary' : 'secondary'} aria-pressed={card.intent === intent} onClick={() => actions.setIntent(intent)}>{label}</Button>)}
      </div>
      <TextArea
        label="Comment"
        autoFocus
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
