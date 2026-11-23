/** One visual in the deck. `pinned` is the plan: always first, never closable, never done. */
export type DeckEntry = {
  id: string
  /** Already resolved: the short label, else the full title. The tab truncates it visually. */
  label: string
  /** Full title, shown on hover. */
  title: string
  /** Creation order key; smaller is older. */
  created: number
  done?: boolean
  pinned?: boolean
}

export type DeckClosedEntry = { id: string; label: string; title: string; closedOrder: number }

/** Orders tabs as pinned first, then live by `created`, then done by `created`. Stable; never mutates `entries`. */
export function orderDeckEntries(entries: readonly DeckEntry[]): DeckEntry[] {
  const rank = (entry: DeckEntry) => (entry.pinned ? 0 : entry.done ? 2 : 1)
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => rank(a.entry) - rank(b.entry) || (rank(a.entry) === 0 ? 0 : a.entry.created - b.entry.created) || a.index - b.index)
    .map(({ entry }) => entry)
}

/**
 * Splits `ordered` into the tabs that fit and the ones that overflow, where tab i is `widths[i]` wide and
 * the row is `available` wide. The overflow button's width only counts when something is hidden. The
 * focused tab always stays visible: if it would overflow it takes the last visible slot. Both lists
 * keep the order of `ordered`.
 */
export function fitDeckTabs(
  ordered: readonly DeckEntry[],
  widths: readonly number[],
  available: number,
  overflowButtonWidth: number,
  focusedId: string | null,
): { visible: string[]; hidden: string[] } {
  const width = (index: number) => widths[index] ?? 0
  const total = ordered.reduce((sum, _entry, index) => sum + width(index), 0)
  if (total <= available) return { visible: ordered.map((entry) => entry.id), hidden: [] }

  const budget = available - overflowButtonWidth
  let count = 0
  let used = 0
  while (count < ordered.length && used + width(count) <= budget) {
    used += width(count)
    count += 1
  }

  const keep = new Set<number>()
  const focusedIndex = focusedId === null ? -1 : ordered.findIndex((entry) => entry.id === focusedId)
  if (focusedIndex >= count) {
    while (count > 0 && used + width(focusedIndex) > budget) {
      count -= 1
      used -= width(count)
    }
    keep.add(focusedIndex)
  }
  for (let index = 0; index < count; index += 1) keep.add(index)

  const visible: string[] = []
  const hidden: string[] = []
  ordered.forEach((entry, index) => (keep.has(index) ? visible : hidden).push(entry.id))
  return { visible, hidden }
}

/** What the deck shows and why: `following` tracks the agent's newest visual, `steered` holds the user's choice and marks others with dots. */
export type DeckFocus = { focusedId: string | null; mode: 'following' | 'steered'; dots: ReadonlySet<string> }

export type DeckEvent =
  /** The agent opened, updated or patched a visual. */
  | { type: 'drawn'; id: string }
  /** The user clicked a tab, picked from +N, or reopened from Closed. */
  | { type: 'picked'; id: string }
  /** The user used the version stepper on the focused visual. */
  | { type: 'stepped'; id: string }
  /** A chip click, a move into the pane, or a new plan version. */
  | { type: 'asked'; id: string }
  /** The user sent a message. */
  | { type: 'sent' }
  /** A visual was closed or went away; `next` is the tab to its left, else the first remaining. */
  | { type: 'removed'; id: string; next: string | null }

export const INITIAL_DECK_FOCUS: DeckFocus = { focusedId: null, mode: 'following', dots: new Set() }

const withoutDot = (dots: ReadonlySet<string>, id: string): ReadonlySet<string> => {
  if (!dots.has(id)) return dots
  const next = new Set(dots)
  next.delete(id)
  return next
}

/**
 * Pure transition for the deck's focus. A focused id that no longer exists is the caller's job: it
 * sends `removed`. A `drawn` on the focused tab never adds a dot, since the user is already looking at it.
 */
export function deckFocusReducer(state: DeckFocus, event: DeckEvent): DeckFocus {
  switch (event.type) {
    case 'drawn':
      if (state.mode === 'following') return { ...state, focusedId: event.id, dots: withoutDot(state.dots, event.id) }
      if (event.id === state.focusedId || state.dots.has(event.id)) return state
      return { ...state, dots: new Set(state.dots).add(event.id) }
    case 'picked':
      return { focusedId: event.id, mode: 'steered', dots: withoutDot(state.dots, event.id) }
    case 'stepped':
      return state.mode === 'steered' ? state : { ...state, mode: 'steered' }
    case 'asked':
      return { ...state, focusedId: event.id, dots: withoutDot(state.dots, event.id) }
    case 'sent':
      return state.mode === 'following' ? state : { ...state, mode: 'following' }
    case 'removed':
      return { ...state, focusedId: state.focusedId === event.id ? event.next : state.focusedId, dots: withoutDot(state.dots, event.id) }
  }
}
