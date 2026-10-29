# Ledger graphite restyle

## Status & amendments
Approved parent design applied autonomously under LOOP.md. 2026-10-28: one combined logic/tech spec in build-first mode; no separate spec/review gate.

## Purpose and scope
Move all existing Ledger desktop surfaces onto shared graphite components and tokens without changing Ledger data, revision checks, scope, public commands, or navigation. Ledger remains the existing bottom-left tool, with its existing center-page chooser, targeted page and settings view. The host owns stripes and tabs.

## Conceptual model and data flow
Existing public Ledger requests, controller routing and revision snapshots remain authoritative. Shared components render the same controlled values and invoke the same handlers. The parent retains each entry's immutable id/revision snapshot for confirmation; display changes never create mutation authority.

## Decisions locked
- Layout/density: compact token-spaced header and filters, readable rows with secondary metadata, bottom-left existing tool; no second launcher or slot authority.
- Interaction: shared Button/IconButton, Tabs, ListRow where suitable, Badge, TextField, FormRow, EmptyState and Dialog replace local CSS/controls. Native select/textarea/checkbox elements use the shared form styling and token-only composition, not a second widget toolkit.
- Loading/empty/errors: preserve actionable Retry/Reload and existing honest text; empty filtered list keeps New entry. No simulated entries, fake successful operations or hidden errors.
- Modals: preserve form validation, busy gating, snapshot confirmation and history. Shared Dialog's focus/keyboard handling is presentation; only the top modal may own focus when confirmation temporarily covers triage.
- Theme: inherit canonical --ui-* tokens and data-theme; no local theme resolver, raw color/pixel declarations or plugin CSS.
- Scope: UI only. No daemon, persistence, protocol, shortcuts, remote provider or native integration changes.

## Behavior and acceptance scenarios
1. Open Ledger tool with an active workspace. Existing Worktree/Project/Group scope, filters, refresh, New and Triage remain usable in the bottom-left slot; rows keep entry identity, type, state, review and filed-here information. Example: worktree Bug A and project Decision B retain their current scope inclusion before/after restyle.
2. Open Ledger center view without a target. Chooser shows attached/detached ledgers and counts; opening one shows the existing targeted page without creating a ledger. Empty catalog remains explicit.
3. Filter/search/sort and select rows on a page. Existing immutable selection snapshots and bulk actions remain; a delete confirmation lists the same id/revision/title and Cancel leaves entries unchanged.
4. Create/edit an entry. Existing type-specific content and qualified location fields remain, required-field errors are visible, submit stays a real form submission, duplicate/conflict feedback remains, and Cancel does not save. Example: missing bug title/file/description/severity still prevents submission.
5. Open detail/history and triage. Origin, actor, full revision history, revert selection, review/state actions and evidence remain; busy/disabled state remains. Confirmation does not leave two focus traps fighting.
6. Open project Ledger settings. Existing 0–3650 integer staleness validation, revision guard, Save/Reload and saved feedback remain.
7. Switch dark/light. Every Ledger surface uses shared theme tokens, with no local stylesheet, white-on-white controls or page-level overflow at ordinary desktop size. Narrow tool filters wrap and list/dialog bodies scroll.
8. Canonical UI lint includes quirky.ledger; raw colors/pixels/plugin CSS fail the existing scanner. No scanner exception or duplicate checker is introduced.

## Alternatives and rationale
Recommended: shared primitives with token-only inline layout composition, removing LEDGER_CSS. A direct legacy stylesheet move into packages/ui would leave bespoke widget styles behind; a full Ledger rewrite would risk mutation and snapshot behavior. Neither is needed.

## Industry insights
Use the approved parent's existing research and unchanged dark/light goldens; no new research swarm under build-first. See ../2026-10-28-ui-redesign/logic.md#industry-insights.

## Non-goals and deferred ideas
No new feature flows, APIs, data migrations, native behavior or phone UI. No deferred implementation flow is identified. Screenshot-model scoring, formal review and suites are not run in build-first and are not represented as passing.

## Glossary
Tool: host-owned slot contribution. Page: existing Ledger center view. Snapshot: immutable entry id/revision captured before a guarded mutation.

## Technical decisions and execution contract
- Keep public exported IDs, component props and all API/controller semantics unchanged. No new public signatures are needed; this spec commits that unchanged shared contract before implementers.
- Replace src/ui/styles.ts CSS string with static React CSSProperties layout objects using existing --ui-* tokens, percentages/flex/zero/unitless geometry only. No new stylesheet or CSS string.
- Component A owns LedgerApp.tsx (including chooser/panel/page/sidebar/inline confirmations). Component B owns LedgerForm.tsx, LedgerDetail.tsx, LedgerTriage.tsx. Parent owns styles.ts, LedgerSettings.tsx, dependency/lock, lint enrollment and docs. Disjoint single-wave components; no worker commits or checks; absolute worktree paths required.
- Shared components imported only from @quirky/ui. Native select/textarea may reuse ui-text-field__input within FormRow. Existing tests keep behavioral assertions; do not add appearance/source/wording inventory pins.
- Add optional shared Dialog `scrollBody` (default false) so Ledger retains its existing scrollable body and pinned action footer without plugin CSS; unrelated dialogs retain their existing default presentation.
- Gate: bun run typecheck. Minimum actual changed-surface proof: build UI, mount actual daemon-served Ledger in a fresh isolated HOME/QUIRKY_HOME, inspect dark/light and exercise a form/detail/confirmation/settings path without real state. This is not a full dogfood or golden review campaign.
- One roadmap catch-up before land; read incoming decisions. Land only through authoritative queue executable.
- Platform: macOS proof only; Linux/Windows/native-window acceptance remains unexercised.

## Implementation evidence
Shared controls and token-only layout migration is implemented; `Dialog.scrollBody` preserves fixed actions. Final root typecheck includes canonical Ledger UI lint and all three TypeScript targets; final UI bundle and actual dark/light surface proof are recorded in ui-restyle-ledger decisions D8–D10. Suites, formal review, independent screenshot scoring and native acceptance were not executed under build-first. The App worker path violation and first branded-browser updater side effects remain explicit evidence limitations, not hidden passing checks.
