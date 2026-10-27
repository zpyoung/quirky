/** The rows picked for the bulk bar, and the row a shift-click measures from. */
export type SelectionState = {
  /** Selected paths. A plain click never selects, so this is empty until a modifier click. */
  readonly selected: readonly string[]
  readonly anchor: string | null
}

export const EMPTY_SELECTION: SelectionState = { selected: [], anchor: null }

/**
 * What a pointer or key did. `order` is the paths of the rows in display order (tree folders
 * included only for the file rows they show). Unlike Orca, whose Shift and Cmd clicks open a split,
 * every modifier click here selects.
 */
export type SelectionAction =
  | { type: 'click'; path: string }
  | { type: 'mod-click'; path: string }
  | { type: 'shift-click'; path: string; order: readonly string[] }
  | { type: 'context-click'; path: string }
  /** Escape, or a pointer-down outside the panel. */
  | { type: 'escape' }
  /** The view mode or the worktree changed. */
  | { type: 'reset' }
  /** The visible rows changed (status refresh, filter): drop what is gone. */
  | { type: 'prune'; order: readonly string[] }

/** The next state, and the row to open in a diff when the action was a plain click (else null). */
export type SelectionResult = { state: SelectionState; open: string | null }

export const isSelected = (state: SelectionState, path: string): boolean => state.selected.includes(path)

/**
 * The selection reducer. A plain click clears the selection and opens the row; mod-click toggles
 * and moves the anchor; shift-click selects the run of rows from the anchor to the clicked row,
 * replacing the previous selection and keeping the anchor (with no usable anchor it selects only
 * the clicked row); context-click selects only the row unless it is already selected. States
 * come back unchanged (same reference) when nothing changes, so callers can skip a re-render.
 */
export function reduceSelection(state: SelectionState, action: SelectionAction): SelectionResult {
  switch (action.type) {
    case 'click':
      return { state: { selected: [], anchor: action.path }, open: action.path }
    case 'mod-click': {
      const selected = isSelected(state, action.path)
        ? state.selected.filter((p) => p !== action.path)
        : [...state.selected, action.path]
      return { state: { selected, anchor: action.path }, open: null }
    }
    case 'shift-click': {
      const from = state.anchor === null ? -1 : action.order.indexOf(state.anchor)
      const to = action.order.indexOf(action.path)
      if (from === -1 || to === -1) return { state: { selected: [action.path], anchor: action.path }, open: null }
      const [low, high] = from <= to ? [from, to] : [to, from]
      return { state: { selected: action.order.slice(low, high + 1), anchor: state.anchor }, open: null }
    }
    case 'context-click':
      return {
        state: isSelected(state, action.path) ? state : { selected: [action.path], anchor: action.path },
        open: null
      }
    case 'escape':
    case 'reset':
      return { state: state.selected.length === 0 && state.anchor === null ? state : EMPTY_SELECTION, open: null }
    case 'prune': {
      const visible = new Set(action.order)
      const selected = state.selected.filter((p) => visible.has(p))
      const anchor = state.anchor !== null && visible.has(state.anchor) ? state.anchor : null
      if (selected.length === state.selected.length && anchor === state.anchor) return { state, open: null }
      return { state: { selected, anchor }, open: null }
    }
  }
}
