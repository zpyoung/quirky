import { Button, ControlIcon } from '@quirky/ui'
import { plural } from './session'
import * as styles from './styles'

export const BANNER_TEXT = 'Feedback mode on · Option uses the app · Esc exits'

type Props = { count: number; open: boolean; onToggle(): void; onExit(): void }

/** Says the mode is on, and holds the comment count that opens the panel and the way out of the mode. */
export function Banner({ count, open, onToggle, onExit }: Props) {
  return <div data-feedback-banner data-quirky-feedback data-quirky-native-mask role="status" style={styles.banner}>
    <span>{BANNER_TEXT}</span>
    <Button data-feedback-toggle aria-expanded={open} style={styles.bannerToggle} onClick={onToggle}>
      {plural(count, 'comment')}
      <ControlIcon name="caret-down" size={12} />
    </Button>
    <Button onClick={onExit}>Exit</Button>
  </div>
}
