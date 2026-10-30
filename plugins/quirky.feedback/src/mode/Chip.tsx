import { Button } from '@quirky/ui'
import * as styles from './styles'

export type PaneChip = { pane: string; element: Element; rect: DOMRect }

const NATIVE_HOST = '.qbp-native-host'
const BROWSER_PANE = '.qbp[data-browser-pane]'
const WATCH_MODE = '.qbp-mode[data-mode="watch"]'

/** The visible Native browser panes. A Watch pane has no native view to cover, so it gets no chip. */
export function findPaneChips(): PaneChip[] {
  const chips: PaneChip[] = []
  for (const host of document.querySelectorAll(NATIVE_HOST)) {
    const element = host.closest(BROWSER_PANE)
    const pane = element?.getAttribute('data-browser-pane') ?? ''
    if (element === null || pane === '' || element.querySelector(WATCH_MODE) !== null) continue
    const rect = host.getBoundingClientRect()
    if (rect.width > 0 && rect.height > 0) chips.push({ pane, element, rect })
  }
  return chips
}

type Props = { chips: PaneChip[]; onComment(element: Element): void; onAnnotate(pane: string): void }

/** A Native page draws above the app, so the pane is commented on through a chip pinned to it. */
export function Chips({ chips, onComment, onAnnotate }: Props) {
  return <>{chips.map(({ pane, element, rect }) => <div
    key={pane}
    data-feedback-chip={pane}
    data-quirky-native-mask
    style={{ ...styles.chip, left: `calc(${rect.left}px + var(--ui-space-8))`, top: `calc(${rect.top}px + var(--ui-space-8))` }}
  >
    <Button onClick={() => onComment(element)}>Comment on this pane</Button>
    <Button onClick={() => onAnnotate(pane)}>Annotate this page</Button>
  </div>)}</>
}
