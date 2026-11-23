# Visual deck: tech spec

**Status:** Draft for execution. Logic spec: [logic.md](logic.md) (approved). The complexity gate fired because this crosses the quirky.view daemon and contract, the shared UI package, and the quirky.session chat window.

Paths are relative to the repo root.

## Architecture

The deck is built from four parts:

- **Deck logic and tab row in `@quirky/ui`.** Both plugins already depend on `@quirky/ui`, and neither imports the other (`plugins/quirky.session/package.json` has no `@quirky/plugin-view` dependency). So the shared deck is a pure model plus a tab-row component in `packages/ui/src/design-system/`, not a cross-plugin view. Each surface renders its own content under the tab row.
- **quirky.view daemon and contract.** Adds `label` to the spec, a persisted `done` flag, reopening, and window-callable `close` / `done` / `reopen`. Covers the CLI `done` command, help text and agent guidance.
- **quirky.view UI.** Covers the ViewCard header per surface (slim panel row, inline header, ⋯ menu), the inline height cap, minimum widths for boards, columns and tables, and the Views pane on the shared deck.
- **quirky.session chat.** `VisualPanel` drops its grid and filmstrip and always renders the deck. The plan is the pinned first entry. Composer reports a sent message so the deck resumes following. ChatView exposes the transcript height for the inline cap.

## Contracts & interfaces

### 1. View record and spec (quirky.view)

Files: `plugins/quirky.view/src/core/contract.ts`, `catalog.ts`, `store.ts`, `views.ts`, `main.ts`, `quirky-plugin.json`.

- **`ViewSpec`** becomes `{ title: string; label?: string; root: ViewNode }`.
  - `validateViewSpec` (`catalog.ts:1210`) accepts the key `label` (add it to `checkKeys`) and keeps it in the returned spec.
  - A label is a non-empty string of at most 24 characters (`MAX_LABEL_LENGTH = 24`).
  - Anything else is refused with `label must be at most 24 characters` (or `label must be a non-empty string`), the same way the title check refuses (`catalog.ts:1221-1223`).
- **`ViewRecord`** gains two fields:
  - `label?: string`, taken from the current spec.
  - `done?: boolean` on `ViewRecord` (required on `StoredViewRecord`, which is what `list` returns; readers default a missing value to false), persisted in a new `done INTEGER NOT NULL DEFAULT 0` column on `views`, added through a migration like `viewVersionsMigration`.
  - `getVersion` reports the current `done`, the same way it reports the current `closed`.
- **`ViewChangeKind`** adds `'done' | 'reopen'`. The `quirky.view/changed` payload shape is unchanged (`{sessionId, viewId, version, kind, placement}`). Update the schema enums in `quirky-plugin.json` (event at `:510-552`). Also update the `list` record schema (`:175-255`) to add `label` (optional) and `done` (required).
- **Clearing done.** Every new version clears it: `update` and `patch` set `done = 0`, and the single choke point is `ViewStore.appendVersion` (`store.ts:124`). The emitted kind stays `update` / `patch`.
- **Reopening.** `ViewService.reopen(viewId)` sets `closed = 0` and emits `reopen`. Reopening a view that is already open returns it unchanged and emits nothing. `update` and `patch` on a closed view now **reopen it** and apply the version, emitting `update` / `patch`. This replaces the conflict "closed; open a new one" (`views.ts:303-307`). Without it, a visual the user closed from the deck would refuse the agent's next update. `move` and `action` on a closed view still conflict.
- **`ViewService.setDone(viewId, done)`** persists the flag and emits `done`. Setting the current value is a no-op with no event.
- **RPCs** (`main.ts`):

  | Method | Params | Callers | Returns |
  |---|---|---|---|
  | `quirky.view/close` | `{ viewId }` | agent (own session, as today), **and** a window caller that can read the view's session | `{ ok: true }` |
  | `quirky.view/done` | `{ viewId, done: boolean }` | agent (own session) or a window caller that can read the session | `{ ok: true }` |
  | `quirky.view/reopen` | `{ viewId }` | a window caller that can read the session | `{ ok: true }` |

  Window authorization follows `quirky.view/move` (`windowOnly` plus `readable`). An unknown view is `not-found`, and a wrong-session agent is refused as today.
- **CLI** (`cli.ts`, `quirky-plugin.json` `cli-command` entries near `:675`):
  - Add `quirky view done --id <viewId> [--undo]`, which calls `quirky.view/done` with `done: !undo` and prints nothing on success.
  - Add its usage line under `close` in the usage block (`cli.ts:9-29`).
  - In the View spec paragraph, add one line documenting `"label"`: a short tab name, up to 24 characters.
  - There's no agent-facing `reopen` command. The agent reopens by updating.

### 2. Agent guidance (quirky.structured)

File: `plugins/quirky.structured/visual-guidance.ts` (`GUIDANCE`, "Working with visuals" at `:27-33`). Add two short rules in the existing voice:

1. Give every pane visual a `label` of a word or two ("SDD run"), because the chat shows visuals as tabs.
2. Run `quirky view done --id <id>` when a visual's work is over (a signed-off mock, a finished brainstorm, a superseded spec). Updating it later makes it live again.

### 3. Deck model and tab row (`@quirky/ui`)

New files:

- `packages/ui/src/design-system/visual-deck-model.ts` (pure, no React)
- `packages/ui/src/design-system/visual-deck.tsx`
- `packages/ui/src/design-system/visual-deck.css`

Export them from `packages/ui/src/design-system/index.ts`, and import the CSS wherever the other design-system CSS is imported.

```ts
// visual-deck-model.ts — pinned shapes, built against by quirky.view and quirky.session
export type DeckEntry = {
  id: string
  label: string        // already resolved: short label, else the full title (the tab truncates visually)
  title: string        // full title, for hover
  created: number      // creation order key; smaller is older
  done?: boolean
  pinned?: boolean     // the plan: always first, never closable, never done
}
export type DeckClosedEntry = { id: string; label: string; title: string; closedOrder: number }

/** pinned first, then live by `created`, then done by `created`. Stable. */
export function orderDeckEntries(entries: readonly DeckEntry[]): DeckEntry[]

/**
 * How many of `ordered` fit when tab i is widths[i] px and the row has `available` px, keeping
 * `focusedId` visible: if it would overflow it takes the last visible slot.
 * Returns the visible ids, in order, and the hidden ids, in order.
 */
export function fitDeckTabs(ordered: readonly DeckEntry[], widths: readonly number[], available: number, overflowButtonWidth: number, focusedId: string | null): { visible: string[]; hidden: string[] }

export type DeckFocus = { focusedId: string | null; mode: 'following' | 'steered'; dots: ReadonlySet<string> }
export type DeckEvent =
  | { type: 'drawn'; id: string }            // agent opened, updated or patched a visual
  | { type: 'picked'; id: string }           // user clicked a tab, picked from +N, or reopened from Closed
  | { type: 'stepped'; id: string }          // user used the version stepper on the focused visual
  | { type: 'asked'; id: string }            // chip click, move into the pane, new plan version
  | { type: 'sent' }                         // the user sent a message
  | { type: 'removed'; id: string; next: string | null } // closed or gone; `next` is the tab to its left, else the first remaining
export const INITIAL_DECK_FOCUS: DeckFocus
export function deckFocusReducer(state: DeckFocus, event: DeckEvent): DeckFocus
```

The reducer has these postconditions, which mirror logic SC-6 to SC-10 and SC-13:

- `drawn`: following → focus it and clear its dot. Steered → add a dot and leave focus alone, except on the focused entry, which is already on screen and gets no dot.
- `picked`, `stepped` → mode `steered`. `picked` focuses the entry and clears its dot.
- `asked` → focus it and clear its dot. The mode is unchanged.
- `sent` → mode `following`. Focus is unchanged.
- `removed` → drop its dot. When it was focused, focus `next`. The mode is unchanged.
- A focused id that no longer exists is the caller's job: the caller sends `removed`.

```ts
// visual-deck.tsx
export type VisualDeckTabsProps = {
  label: string                         // aria-label for the tablist
  entries: readonly DeckEntry[]         // unordered; the component orders them
  closed: readonly DeckClosedEntry[]    // newest closed first in the menu
  focusedId: string | null
  dots: ReadonlySet<string>
  onPick(id: string): void
  onClose(id: string): void
  onReopen(id: string): void
}
export function VisualDeckTabs(props: VisualDeckTabsProps): JSX.Element
```

What the tab row does:

- **Tabs.** It's a `role="tablist"` with roving tabindex and Arrow, Home and End keys, the same behavior as `Tabs` (`navigation.tsx:75`), in the underline style. Each tab shows a dot when it's in `dots` and is dimmed with a "done" suffix when `done` is set. Its full `title` is the tooltip.
- **Close button.** Every tab except a pinned one has an × that shows on hover, focus-within or selection. The × is its own button labeled `Close <title>`, and clicking it never also picks the tab.
- **Overflow.** It measures tab widths with a ResizeObserver and passes them to `fitDeckTabs`. Measuring in a hidden row is one acceptable technique.
- **+N button.** It shows `+<hidden count>` when tabs are hidden, and a plain ▾ when nothing is hidden but `closed` isn't empty. It doesn't render when both are empty.
- **+N menu.** It opens as a menu (reuse `Menu` from `navigation.tsx` if it can hold a section divider, otherwise use the same keyboard model). It lists the hidden entries in order, with done ones marked, then a "Closed" divider and the `closed` entries.

### 4. Card header, inline cap and renderers (quirky.view UI)

Files:

- `plugins/quirky.view/src/render/ViewCard.tsx`
- `plugins/quirky.view/src/render/visuals.tsx` (board, `:67-97`)
- `plugins/quirky.view/src/render/layout.tsx` (Columns, `:10-19`)
- `plugins/quirky.view/src/render/data.tsx` (DataTable, `:50-75`)

**Header by surface** (logic SC-4, SC-19). The `by {agent}` badge goes on every surface (`:318`).

- The sandbox badge (`:319`) becomes a shield `ControlIcon` labeled "Sandboxed, no network", shown as a tooltip.
- The version stepper shows only when the latest version is above 1.
- The Expand, Pop out and Move buttons move into a ⋯ `Menu` labeled "Visual actions". Its items are Expand, Pop out (when available), Move inline or Move to pane, Mark done or Mark live, and Close.
  - Mark done/live calls `quirky.view/done`. Close calls `quirky.view/close`. Both use `context.call` with `{ viewId }`.
- `surface: 'panel'` renders no title. The row is the stepper on the left, then the shield and ⋯ on the right.
- `surface: 'inline'` keeps the title on the left.
- The drawing indicator and the "didn't render" tag stay where they are. Expanded, window and thumbnail surfaces keep their current header, minus the author badge.

**Inline cap** (logic SC-18). On `surface: 'inline'` only, the body is capped to `max-height: calc(var(--quirky-transcript-height, 100vh) * 0.6)`, with `overflow: hidden`.

- When the content is taller than the cap (measure it with a ResizeObserver), show a bottom fade and a full-width "Show more" button. Clicking it removes the cap and turns into "Show less".
- Short content shows neither.
- The expanded state is local to the mounted card and resets on remount.

**Wide content** (logic SC-5).

- Board columns use `minmax(<about 160px in length units>, 1fr)`, and the board root gets `overflow-x: auto` and a right-edge fade while it can still scroll right.
- Columns get the same minimum and scroll.
- DataTable cells get a minimum width of about 96px in units, and its wrapper already scrolls.
- No renderer breaks words to fit (remove `overflowWrap: 'anywhere'` from board card text if that's what causes it).

### 5. Views pane on the deck (quirky.view UI)

Files: `plugins/quirky.view/src/Pane.tsx`, `plugins/quirky.view/src/control.ts`.

- `ToolPanelFrame`'s `tabs` slot (`Pane.tsx:143-150`) renders `VisualDeckTabs`, and the frame's separate close `IconButton` goes.
- **Entries.** They come from `quirky.view/list`:
  - `placement === 'pane' && !closed`
  - `label: record.spec.label ?? record.title`
  - `created`: the index in list order
  - `done: record.done`
- **Closed list.** Pane records with `closed`, with `closedOrder` taken from `updatedAt`.
- **Close and reopen.** × calls `quirky.view/close`, and reopening calls `quirky.view/reopen`. The client-side `dismissed` map goes away.
- **Focus.** It uses `deckFocusReducer`. A `quirky.view/changed` event with kind `open`, `update` or `patch` dispatches `drawn`, a tab click dispatches `picked`, and a close dispatches `removed`. The Views pane has no composer, so it never gets `sent`: it stays steered after a pick until it remounts, and that's expected.
- **Card surface.** The focused card renders through `ViewCard` with `surface: 'panel'`.
- **Control commands.** `ViewUiState.tabs` (`control.ts:16`) becomes `{ viewId, title, label, done }[]`. The `select-tab` control keeps working and dispatches `picked`. `dismiss-tab` maps to close.

### 6. Chat visual panel (quirky.session)

Files:

- `plugins/quirky.session/src/window/chat/VisualPanel.tsx`
- `plugins/quirky.session/src/window/chat/ChatView.tsx`
- `plugins/quirky.session/src/window/chat/Composer.tsx`

**VisualPanel.**

- Remove `grid`, `planCell`, `strip`, `tile`, `wide`, `CARD_MIN_UNITS`, `GAP_UNITS` and the thumbnail filmstrip. Keep the divider, width ratio pref, collapse rail, `fresh` count, empty state, `drawing` set and version pins.
- With any entry present, the header is `VisualDeckTabs` (label "Visuals") in place of the "Visuals" heading. The heading shows only in the empty state.
- **Entries.**
  - The plan, when `plan` is set: id `'plan'`, label `Plan v<N>`, pinned.
  - Pane visuals: `placement === 'pane' && !closed`, label from `label ?? title`, `created` from list order, `done` from the record.
  - `VisualRecord` and `readRecords` gain `label?: string`, `done: boolean` and `createdAt?`, read defensively as today.
- **Closed.** Pane records with `closed`.
- **Focus.** It uses `deckFocusReducer`:
  - `quirky.view/changed` open, update or patch → `drawn`.
  - A `move` into the pane → `asked`, and the panel expands.
  - A new plan version → `asked('plan')`, and the panel expands.
  - The `focus` prop (chip click) → `asked`, keeping today's version pin.
  - A tab or menu pick → `picked`.
  - A stepper use → `stepped`.
  - × → `quirky.view/close`, then `removed`.
  - Reopen → `quirky.view/reopen`, then `picked`.
- **Sent messages.** A new `sentNonce: number` prop dispatches `sent` whenever it changes after mount.
- **Content.** The plan renders `PlanPanel` as today. A visual renders one `Embedded` render view with `cardInput(viewId, 'panel', { version, drawing, focused: true })`. Only the focused visual is mounted.
- **Composer.** Add `onSent?: () => void`, called after `quirky.structured/send` resolves inside `submit` (`Composer.tsx:278-319`). The Visualize action (`ChatView.tsx:237`) doesn't count as sending.
- **ChatView.**
  - Keep `sentNonce` state, bumped by `onSent`, and pass it to VisualPanel.
  - Measure the transcript scroll container (`scrollRef`, `:552`) height with a ResizeObserver and set `--quirky-transcript-height: <px>px` on it. Embedded cards mount inside it, so the inline cap reads that height.

## Data models / schemas

The literal shapes live in:

- `ViewSpec`, `ViewRecord`, `ViewChangeKind`: `plugins/quirky.view/src/core/contract.ts`
- The list, event and RPC schemas: `plugins/quirky.view/quirky-plugin.json`
- `DeckEntry`, `DeckClosedEntry`, `DeckFocus`, `DeckEvent`, `VisualDeckTabsProps`: `packages/ui/src/design-system/visual-deck-model.ts` and `visual-deck.tsx`, exactly as written above
- `VisualRecord`: `plugins/quirky.session/src/window/chat/VisualPanel.tsx`
- `ViewUiState.tabs`: `plugins/quirky.view/src/control.ts`

## DO-NOT-CHANGE fences

- **`quirky.view/changed` payload keys** (`contract.ts:66-74`): other plugins and older windows read `{sessionId, viewId, version, kind, placement}`. Only add enum values.
- **The `view:quirky.view/render` mount input** (`parseRenderInput`, `ViewCard.tsx:554-566`): the transcript, the chat panel and the expanded layout all mount it. Don't rename or remove fields, and add new ones only as optional.
- **The visual panel's collapse threshold, width-ratio pref key and divider behavior** (`VisualPanel.tsx`, `WIDTH_RATIO_KEY`, `COLLAPSE_BELOW_UNITS`, the separator): the logic spec keeps them out of scope (SC-16).
- **`PlanPanel`** (`PlanPanel.tsx`): the plan's own rendering is out of scope. The deck only hosts it.
- **The expanded and window surfaces' bodies** (`BODY.expanded`, `BODY.window`): out of scope. Only their author badge goes.

## Always / Ask / Never

- **Always** route new text through the existing voice. Use length units (`--ui-length-unit`) and `--ui-*` tokens in styles, never raw px, except where measuring.
- **Always** keep the deck model pure and fully unit-tested, because both surfaces trust its order, fit and focus rules.
- **Ask** (surface it, don't decide alone) if `Menu` can't hold a divider and a second menu component seems needed.
- **Ask** if the `done` migration conflicts with an existing migration order.
- **Never** import `@quirky/plugin-view` from quirky.session or the other way round.
- **Never** mount every visual in the chat panel to measure or preview it. Only the focused one is mounted.

## Cross-cutting

- **Migration.** `done` is additive with a default of 0, and old rows read as live. A missing `label` reads as no label, so old windows and old records keep working.
- **Compatibility.** A window older than this daemon ignores `label` and `done` and gets the two new change kinds, which VisualPanel and Pane already tolerate, since an unknown kind just reloads. A newer window against an older daemon gets no `done` field, so `readRecords` defaults it to false.
- **Agent-visible change.** `update` and `patch` on a closed view now reopen it instead of failing. Note this in the PR body.

## Testing strategy

Per AGENTS.md, run single files locally with `bun test <file>`. The full suite runs on the draft PR with the `full-suite` label.

- `packages/ui/src/design-system/visual-deck.test.tsx` (new): `orderDeckEntries`, `fitDeckTabs` (including the focused tab taking the last slot), every `deckFocusReducer` transition, and the tab row's ×, dot, done dimming, +N count, ▾ with only closed entries, and the Closed section reopening.
- `plugins/quirky.view/test/catalog.test.ts`: `label` accepted, at most 24 characters, refused when longer or empty, unknown keys still refused.
- `plugins/quirky.view/test/views.test.ts`: done set and clear, update or patch clears done, reopen, update or patch on a closed view reopens, the new change kinds, `label` and `done` in `list`, window callers for close, done and reopen, and agent wrong-session refusal.
- `plugins/quirky.view/test/cli.test.ts`: usage lines (`:339-355`), `view done` and `--undo`.
- `plugins/quirky.view/test/render.test.ts`:
  - card header per surface: no author badge, shield, stepper hidden at 1 version, ⋯ menu items, Mark done and Close calls
  - the inline cap with Show more and Show less, and short content uncapped
  - board, columns and table minimum width and scroll
  - the Views pane on the deck (`describe('the views pane')`, `:500-627`): close and reopen through the daemon, drawn while steered → dot
- `plugins/quirky.structured/test/visual-level.test.ts`: the guidance mentions `label` and `quirky view done`.
- `plugins/quirky.session/test/chat-view.test.ts` (`describe('the visual panel')`, `:1989`):
  - Replace the grid and filmstrip tests (`:2015-2047`) with deck tests covering one visual at any width, plan first, tab order with done last, overflow, following vs. steered with dots, `sent` resuming following, chips, move and plan always taking focus, × closing to the Closed section, and reopen.
  - Keep the divider, rail and empty tests.
  - Update `:2268` and `:2282` (chip pin and expand) to the deck.
  - Add a test for the transcript-height CSS variable.
- `plugins/quirky.session/test/structured-view-layout.test.ts:237-`: update "wide dock with the plan pinned first" to the deck.

## Non-goals

- The mobile app, the expanded and pop-out window layouts, and the plan's own panel.
- Persisting the following/steered mode or the attention dots across a restart. They're view state.
- An agent-facing `reopen` command, because updating reopens.
