# ui-restyle-ledger decisions

## D1: Preserve Ledger placement and operation authority
- **Question:** What changes in the layout/interaction gray areas?
- **Options:** rebuild Ledger; move it into a new registry; restyle existing contributions and keep behavior.
- **Chose:** Existing bottom-left projected tool, chooser/page/settings views and stable IDs; preserve all filters, commands, immutable revision snapshots and mutations.
- **Why:** The approved parent excludes new behavior and the shell already owns placement.
- **Evidence:** docs/quirk/specs/2026-10-28-ui-redesign/logic.md:23-59,184,194-202; ui-shell-slots D3,D5.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** a Ledger contribution is no longer reachable.
- **Source:** locked by docs/quirk/specs/2026-10-28-ui-redesign/logic.md

## D2: Remove injected CSS rather than relocate legacy widgets
- **Question:** Which visual approach handles density, themes, forms and dialogs?
- **Options:** copy legacy stylesheet into shared UI; full rewrite; shared components plus token-only layout composition.
- **Chose:** Shared controls/rows/badges/tabs/forms/dialogs/empty states with static CSSProperties layouts; remove LEDGER_CSS and style injection entirely. Native select/textarea use shared field classes within FormRow.
- **Why:** Keeps the same stateful logic while replacing bespoke controls; no raw values, new toolkit or local theme resolver.
- **Evidence:** plugins/quirky.ledger/src/ui/styles.ts:1-80; packages/ui/src/design-system/{contracts,primitives,panels,overlays}.tsx; ui-terminal-theme D4.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the shared kit lacks a required visible control.
- **Source:** assumed — autonomous

## D3: Keep loading, empty, errors and pending confirmation truthful
- **Question:** What should users see at asynchronous/error boundaries?
- **Options:** skeleton/mock success; preserve current messages/actions with shared presentation.
- **Chose:** Preserve Retry/Reload, validation/conflict/duplicates and busy gating; shared EmptyState and Dialog. Only the top modal traps focus during stacked confirmation.
- **Why:** Restyling cannot change mutation authority or conceal errors; native form submit must remain functional.
- **Evidence:** LedgerApp.tsx:785-1008; LedgerForm.tsx:125-198; LedgerSettings.tsx:51-81.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** minimum actual surface smoke exposes lost controls or inaccessible overflow.
- **Source:** assumed — autonomous

## D4: Follow build-first gates with two bounded implementers
- **Question:** What workflow, contracts and reviewer pairing apply unattended?
- **Options:** normal research/review/tests; one combined spec and typecheck gate.
- **Chose:** Commit unchanged public contracts and static layout contracts first; two OpenAI task implementers in external worktrees, no worker checks/commits. Parent integrates after HEAD/scope barrier. No reviewer/probe is dispatched because build-first skips formal review, suites and dogfood; no clean-review or golden-score claim. Minimum actual changed-surface smoke and typecheck only.
- **Why:** Current canonical LOOP and item title explicitly apply build-first. No asks/research swarms. LSP status returned no configured servers. Inherited .quirk/.serena and six diagnostic probes remain untouched.
- **Evidence:** git show build/roadmap:docs/loop/LOOP.md; queue wait ui-restyle-ledger; initial status and xd://lsp status.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** operator changes the mode.
- **Source:** locked by docs/loop/LOOP.md

## D5: Retain macOS-only proof and native limits
- **Question:** What cross-platform assurance is justified?
- **Options:** claim all platforms; macOS browser/build proof only.
- **Chose:** Portable DOM/React APIs, macOS runtime only. Linux/Windows/native-window visual and keyboard acceptance are unexercised; no OS integration changes.
- **Why:** Locked platform rule and renderer smoke do not prove native chrome.
- **Evidence:** docs/loop/LOOP.md platform rule; approved parent desktop-only scope.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** supported platform policy expands.
- **Source:** deferred: platform

## D6: Preserve fixed dialog actions through an opt-in shared contract
- **Question:** How does the shared Dialog retain Ledger's existing scrollable detail/pinned-footer behavior?
- **Options:** plugin CSS; globally change every dialog; optional shared scrollBody behavior.
- **Chose:** Add scrollBody default false to the shared Dialog and opt Ledger modals in; all other dialogs retain the existing default.
- **Why:** M5 Ledger D10 requires accessible history and fixed actions. Shared body flex/overflow handles this without a plugin stylesheet or unrelated behavior cutover.
- **Evidence:** docs/loop/decisions/m5-ledger.md D10; shared contract commit80ef44a0.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** actual tall-dialog proof fails to keep actions visible.
- **Source:** locked by docs/loop/decisions/m5-ledger.md

## D7: Replan the misplaced App slice under parent integration ownership
- **Question:** App worker's assigned tree was clean despite its completion report.
- **Options:** discard completed owned source; conceal boundary failure; stop writer and attribute exact parent paths.
- **Chose:** Stopped writer, confirmed its admitted relative patch paths resolved in parent, audited exact App.tsx/window.test.ts changes and unchanged worker HEAD5a375fb7. Parent takes sole ownership after all workers returned; no isolated-App execution claim. Dialog worker correctly changed its three assigned paths at unchanged dispatch HEAD; merged separately. Parent fixes per-instance filter IDs to avoid collisions when page and panel coexist, and migrates remaining detail selectors to accessible dialog naming and semantic footer.
- **Why:** Prompting is not isolation. Parent tracked source was clean before this worker and only these two attributed paths changed; unknown untracked user files remain untouched. No worker tests or commits occurred.
- **Evidence:** worker provenance reply and parent/worker HEAD/status/scope outputs; component5b0a4261.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** attribution finds another modified path.
- **Source:** assumed — autonomous

## Progress
Combined spec and unchanged public contracts prepared. Next commit layout/dependency contracts, dispatch two isolated bounded source components, parent-owned settings/lint integration, one roadmap catch-up and actual typecheck/minimum surface proof, then authoritative queue land. No suites/review/dogfood/golden score claimed.
