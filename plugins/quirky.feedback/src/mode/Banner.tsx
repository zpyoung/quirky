import { Button } from '@quirky/ui'
import * as styles from './styles'

export const BANNER_TEXT = 'Feedback mode on · Option uses the app · Esc exits'

export function Banner({ onExit }: { onExit(): void }) {
  return <div data-feedback-banner data-quirky-native-mask role="status" style={styles.banner}>
    <span>{BANNER_TEXT}</span>
    <Button onClick={onExit}>Exit</Button>
  </div>
}
