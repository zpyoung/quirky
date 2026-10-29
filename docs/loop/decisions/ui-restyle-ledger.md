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

## D8: Report actual renderer proof without claiming a visual score or suite pass
- **Question:** What assurance is available under build-first?
- **Options:** infer full parity; run prohibited campaigns; report only compiler/build and narrowly exercised renderer evidence.
- **Chose:** Canonical UI lint/root/mobile/prepared-desktop typecheck passed twice (41.70s, final37.69s); final UI build emitted11host files/25plugin modules. Real daemon-served UI showed populated bottom-left Ledger and targeted page, required-field errors, actual bug creation via form-associated submit, history scrolling with fixed actions, snapshot Delete/Cancel, triage Resolve/Cancel returning with the same selection and exactly one dialog, settings90→30/Saved with canonical readback, filtered empty state, and live dark/light themes. Narrow1000×700 reached all rows through the host scroll region with no document horizontal overflow. Final shared Button rows use block text flow so IDs remain legible; delayed refresh uses shared busy text/ellipsis, not dead plugin animation CSS.
- **Why:** These are actual changed-surface observations, not a full dogfood campaign, screenshot-model/golden approval, suite or native-window proof. Existing tests were updated for accessible shared labels/semantic footer and authored behavior remains unrun.
- **Evidence:** bg2/bg4 typecheck, bg3/bg5 UI build; ledger-restyle-l8-smoke and ledger-restyle-l8-final; private ui-restyle-ledger receipts/screenshots. Detail body738px/scroll965px/footer bottom867px within900px viewport; renderer pageerrors=[]; canonical ledger readback3entries/staleAfterDays30.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** end-phase tests or the independent visual gate finds a defect.
- **Source:** locked by docs/loop/LOOP.md

## D9: Bound browser isolation claims after observing branded Chrome updater behavior
- **Question:** Did private HOME/user-data-dir prove all branded-browser OS state was isolated?
- **Options:** conceal updater logs; delete real browser state; stop owned runtime and use the testing-browser distribution.
- **Chose:** The first uniquely owned Chrome profile exposed GoogleUpdater child logs referencing the real user's Library, including prefs commits. Stopped that owned runtime; did not inspect, delete, restore or otherwise modify the user's Library. No claim that the first browser was fully OS-isolated. Final minimal dark/light and scroll-body proof used installed Playwright Chrome for Testing with a fresh private home/profile, background-network/component-update/breakpad disabled and a new owned CDP endpoint; both exact CDP tabs were released and private process scopes cleaned. Never used the previously prohibited shared app.path handle or other lanes' CDP sessions.
- **Why:** HOME plus a private browser profile does not override every macOS OS-directory API. Actual updater side effects cannot be undone safely by editing user state; renderer proof and filesystem isolation are different claims.
- **Evidence:** ledger-restyle-l8-smoke service stderr: GoogleUpdater --install/--wake-all and real-Library prefs commits; final testing-browser readiness and exit receipts.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** another branded/native tool is proposed for isolated verification.
- **Source:** assumed — autonomous

## D10: The sole roadmap catch-up brought no incoming changes
- **Question:** Which concurrent decisions constrain the final source?
- **Options:** repeatedly merge; perform the required one catch-up and preserve existing contracts.
- **Chose:** After App integration commit ecb71998, git merge build/roadmap returned Already up to date. No incoming source/decision logs or conflicts. Existing Ledger, remote-authority and redesign decisions remain binding; no remote/native capability or follow-up item was added.
- **Why:** One catch-up is the current loop contract; further merge is reserved for an actual controller failure.
- **Evidence:** canonical merge output; m5-ledger and m7-ledger-remote-host-flows full read by LedgerBindingConstraints.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** queue land reports a real conflict or type failure.
- **Source:** locked by docs/loop/LOOP.md

## Progress
Ready to land after final typecheck37.69s, final UI build and minimal actual dark/light/scroll/form/confirmation/settings proof. Both implementers returned, both temporary trees removed. App provenance violation and first Chrome updater-isolation limit are explicit in D7/D9, not clean-assurance claims. No suite/formal review/dogfood/golden score/native acceptance was run or claimed. Final owned runtime shutdown must finish, then commit all owned source/docs, detach and run authoritative queue land ui-restyle-ledger in this turn. Preserve all unknown untracked diagnostics and other lanes' browser state.
