# ui-restyle-accounts decisions

## D1: Restyle all existing contributions without changing feature authority
- **Question:** Brainstorming purpose, consumer, scope and successful outcome?
- **Options:** recolor only; replace feature state; shared presentation across Accounts and Vault
- **Chose:** All existing Accounts settings/status/accessory/overlay and Vault history/search-settings interiors, preserving public IDs, stores, APIs and actions.
- **Why:** Approved scope forbids new features/behavior changes; omission of secondary surfaces would leave inconsistent presentation.
- **Evidence:** docs/quirk/specs/2026-10-28-ui-redesign/logic.md:23-59,117-119,185,194-202; MapRestyle source survey
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** A shared control cannot preserve a required behavior.
- **Source:** locked by docs/quirk/specs/2026-10-28-ui-redesign/logic.md

## D2: Inherit graphite hierarchy, density and host placement
- **Question:** Visual layout, density, theme, grouping and interaction gray areas?
- **Options:** local plugin toolkit; duplicate shell frames; existing shared controls/tokens and host slots
- **Chose:** Public @quirky/ui controls, semantic dark/light tokens and comfortable density; Accounts retains status/settings/accessory/overlay contributions; Vault remains right-bottom. Existing host chrome stays host-owned.
- **Why:** Goldens and existing projection establish these decisions. CSS-only recoloring keeps divergent controls; inventing tool registrations changes behavior.
- **Evidence:** approved parent spec:89-119; packages/daemon/src/plugins/tool-layout.ts; packages/ui/src/design-system/contracts.ts; ui-shell-slots D3,D5,D6
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** Existing contribution cannot be reached through the shell.
- **Source:** locked by docs/quirk/specs/2026-10-28-ui-redesign/logic.md

## D3: Preserve truthful loading, empty/error, busy and secret-state semantics
- **Question:** Loading/empty/error state and interaction-style gray areas?
- **Options:** simplify away edge states; retain existing transitions while changing controls
- **Chose:** Preserve safe provider/credential/transcript content, retry and cancellation, account/reset-generation fences, busy/disabled guards, search consent, virtualization, keyboard/focus and persisted preferences. Shared empty/error presentation must not imply success.
- **Why:** Existing consumer behavior is the invariant. Dynamic quota percentages and virtualizer measurements are data, not new design constants.
- **Evidence:** plugins/quirky.accounts/src/window/{AccountsSettings,Usage,model}.tsx/.ts; plugins/quirky.vault/src/window/{HistoryPanel,SearchSettings}.tsx; item combined spec scenarios1–6
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Actual changed-surface smoke exposes a shared-control semantics mismatch.
- **Source:** assumed — autonomous

## D4: Enforce both plugins without exceptions or private styles
- **Question:** CSS ownership, duplicate styling and enforcement gray areas?
- **Options:** exemptions/baselines; retain local injectors; shared controls and centrally linted layout styles
- **Chose:** Remove both local CSS modules/injectors, use shared controls and token-only accounts.css/vault.css for necessary layout, opt both IDs into canonical ui-lint-plugins.json without deleting existing IDs.
- **Why:** Approved system prohibits raw colors/pixels and plugin CSS; central styles cannot be a verbatim legacy-CSS relocation.
- **Evidence:** scripts/ui-lint.ts; scripts/ui-lint-plugins.json; ui-tokens-and-components D2–D4,D10; combined spec technical contracts
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Canonical scanner rejects legitimate measured feature data.
- **Source:** locked by docs/quirk/specs/2026-10-28-ui-redesign/logic.md

## D5: Execute two disjoint implementers under build-first
- **Question:** Autonomous approval, spec/research/review/test and implementation preflight?
- **Options:** normal research/review/suites; authoritative build-first contracts-first wave
- **Chose:** One combined self-reviewed specification, existing shared signatures recorded and committed before two OpenAI task implementers in external component worktrees; parent integration owner. No reviewer probed/dispatched because review rounds are prohibited. No human asks, companion offer, research swarms, suites/full dogfood/golden-model scoring; parent runs typecheck/lint and minimum genuine renderer smoke required by coding contract.
- **Why:** Current LOOP build-first and claimed title apply. Public shared contracts require no new schema/type signatures. Existing unrelated .serena remains untouched. LSP reports no configured servers.
- **Evidence:** git show build/roadmap:docs/loop/LOOP.md; canonical wait title; xd://lsp status; combined spec technical contracts
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Authoritative policy changes.
- **Source:** locked by docs/loop/LOOP.md

## D6: Bound platform and fixture claims
- **Question:** Native/platform coverage and credential safety?
- **Options:** infer all platforms/native behavior; macOS isolated renderer proof only
- **Chose:** macOS only; portable shared web APIs where inexpensive. Runtime fixture uses fresh isolated homes, synthetic sources and owned Chromium/CDP; no real provider login, clipboard/native notifications or history mutations. Existing provider Keychain isolation must be reused, not assumed from HOME alone. Linux/Windows and actual native chrome remain unverified.
- **Why:** LOOP locks platform and state safety; prior fixture evidence identifies Keychain as outside HOME isolation.
- **Evidence:** LOOP platform/state rules; MapRestyle warning; prior lane accounts evidence fixture/support.ts
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Supported platforms expand or fixture access reaches real state.
- **Source:** deferred: platform

## D7: Integrate only the audited disjoint source and explicit workspace dependencies
- **Question:** Did the implementers remain inside their assigned source contracts?
- **Options:** trust reports; audit every component and parent at the barrier
- **Chose:** Both worker HEADs remained 6c9f4deedbeb336d96102221d537b267a75c9fe0; exact path inventories matched their five-path packets and parent changed only stylesheet composition/lint/docs. Committed Accounts e14104ea and Vault 1ae24672 after both returned; merged both, archived inherited component metadata and removed both worktrees/branches immediately. Parent integration adds both real @quirky/ui workspace dependencies and regenerates bun.lock.
- **Why:** Explicit source attribution prevents cross-tree writes; the first compiler pass exposed missing public UI dependency declarations rather than a need for relative/private imports.
- **Evidence:** barrier HEAD/status tool output; component commit/merge/remove receipts; compiler artifacts15/17; plugin package.json and bun.lock
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** A source path or dependency differs from its recorded owner.
- **Source:** assumed — autonomous

## D8: Preserve focus and required-choice authority through minimal shared contracts
- **Question:** How can shared controls retain Accounts button focus and non-dismissible/busy modal semantics?
- **Options:** local duplicate dialogs/ref casts; inert close callbacks/CSS hiding; minimal additive shared capabilities
- **Chose:** ButtonProps adds optional native React19 button ref inherited by IconButton. Dialog onClose becomes optional: omission removes its X and prevents Escape/backdrop dismissal while retaining focus trapping. Switch dialog omits it; reset omits it while submitting. Remove the obsolete CSS close-hiding rule. Shared backdrop explicitly enables pointer events within the host's intentionally noninteractive overlay layer.
- **Why:** Compiler rejected real trigger refs. Source integration exposed a visible inert close control; actual renderer then showed all switch actions inherited pointer-events:none from .overlay-layer. Fix the shared boundary, never force-click or bypass the UI guard.
- **Evidence:** packages/ui/src/design-system/{contracts,overlays,components.css}; actual 760-wide renderer failed Keep click pointer-events:none, then switch-runtime-proof.json observed Escape/backdrop retention, no X, trapped Tab and actual explicit Keep closing the dialog
- **Reversibility:** medium (additive public shared props, existing callers remain valid)
- **Confidence:** high
- **Revisit if:** A consumer requires independent close-button versus Escape permissions.
- **Source:** assumed — autonomous

## D9: Repair observed geometry at the shared layout owner
- **Question:** What did the initial actual Usage and narrow account render reveal?
- **Options:** clip the app or weaken overflow checks; correct popup/measurement/row layout
- **Chose:** Usage popup uses token-step width bounded by viewport, not 100% of a small status-item mount; its max-height reserves the status bar. Hidden width measurement is fixed entirely offscreen on the negative side, not an overflowing absolute row. Account metadata spans remain separate readable lines, trailing actions wrap below identities when narrow, and section headings wrap as complete labels before supporting copy. Give the Accounts status mount a token-based preferred width, still flex-shrinkable, so collapse can measure actual available width rather than locking itself at the initial +N intrinsic size; hidden mount shrinks to zero.
- **Why:** Initial popup was149.6wide, began at y-14 and document scroll width1486 for viewport1340. Corrected actual popup was384wide at y20 and document width1340; narrow760 popup stayed entirely inside viewport with document width760. Reflow preserves actions rather than removing them.
- **Evidence:** initial/final screenshot and computed rectangle outputs; narrow-runtime-proof.json; packages/ui/src/design-system/accounts.css
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Another viewport or text scale exposes a concrete geometry defect.
- **Source:** assumed — autonomous

## D10: Migrate behavioral regressions without pinning private markup
- **Question:** Which tests depend on controls replaced by the shared kit?
- **Options:** restore obsolete attributes/classes; drop behavioral coverage; migrate to actual labels and shared dialog structure
- **Chose:** Third test-only worker updated exactly five scoped files at unchanged e5404b8f, then parent committed8f0a078e and removed its worktree/branch after the barrier. Accounts/Vault dialogs resolve role plus aria-labelledby; native fields use associated labels; bulk switch choices resolve only the shared direct footer so duplicate per-session actions cannot weaken generation/single-flight/policy tests. Remove the inline display-style pin while retaining hidden-control and restore assertions. Add one real required-choice Dialog focus/dismissal/action transition regression.
- **Why:** Feature-state assertions must survive presentation changes; incidental CSS assertions must not be re-pinned. Source inspection caught and corrected a first-match selector that would have selected an individual session instead of the bulk action.
- **Evidence:** five-file component inventory and commit8f0a078e; packages/ui/test/design-system.test.tsx required-choice scenario; plugins/quirky.accounts/test/remaining-ui.test.tsx dialogFooterButtonByText
- **Reversibility:** easy
- **Confidence:** high for source attribution; tests UNRUN under build-first
- **Revisit if:** End-phase execution finds a substantive behavior failure.
- **Source:** locked by docs/loop/LOOP.md

## D11: Record only the exercised isolated renderer evidence
- **Question:** What verification supports the restyle without claiming full acceptance or golden approval?
- **Options:** compiler-only inference; prohibited full campaigns; narrow genuine renderer proof with exact limits
- **Chose:** Actual daemon, PTY and synthetic account/history sources under private HOME/QUIRKY_HOME, fake security/provider executables and local provider proxy; exclusively owned Chromium profile/CDP53911. Exercised Used25→Remaining75→Used, provider details/reset Dialog Escape cancellation, Accounts tabs/Appearance and six masked empty secret inputs, Vault canonical right-bottom opening/title-filter no-match/Clear/options/expanded transcript, Search Settings/Advanced without enabling indexing. Actual Claude terminal selection toB opened required-choice modal; Escape/backdrop did not close, Tab remained trapped, no X existed, and a real explicit Keep closed it without relabeling the session. Both themes have exact canonical text/surface values, no private injected styles and no document overflow at1340; narrow760 also remains within viewport. Status meters show7providers at1340 and5at760, and hiding yields mount width0/displaynone then restores.
- **Why:** These are exercised production UI/API paths, not component copies or suite output. The fixture initially omitted sidebar-extras and produced exactly2missing-setting pageerrors; adding the genuine dependency and restarting the same home left that sequence unchanged, with no new errors. Old errors are retained, not erased.
- **Evidence:** scratch switch/status/narrow/dark/light-runtime-proof.json; actual screenshots accounts-vault-final-{dark,light}.png and Vault settings/transcript images; public searchStatus enabledfalse/filesIndexed0; build/typecheck command receipts
- **Reversibility:** easy
- **Confidence:** high for named interactions only
- **Revisit if:** End-phase suites or independent golden review find a concrete defect.
- **Source:** locked by docs/loop/LOOP.md

Evidence limits: no test suite, formal code-review round, full feature dogfood, native-host run or independent golden-model scoring was run. The rapid automation fill/type attempt yielded a shorter controlled Vault query (`n`/`no`); only the actual no-match/Clear transition is proved, not arbitrary full-string typing. No store/model change is inferred or made. Native clipboard/OS dialogs/browser handoff, credentials from real homes, Linux/Windows and full query/virtualizer workloads are not certified by this smoke.

## D12: Compose the sole roadmap merge without dropping shared contracts
- **Question:** How do concurrent shared-system restyles compose with Accounts/Vault?
- **Options:** pick one side of the shared conflicts; preserve all additive contracts and canonical owners
- **Chose:** Sole catch-up target e0b4e9533ac3ee8a36374217cfb7438acb7b5e5c, merge756c0344. ReadIncomingRestyleDecisions read all7incoming logs completely, including raw truncated lines/Progress, covering94decisions; parent recorded seven SHA256 snapshots. Union all style imports/lint IDs; preserve shared SelectField/TextArea/refs, Dialog wide/scrollBody/top-dialog focus ownership plus our optional dismissal, and both regression sets. Replace all4account/history native selects with the newly landed shared SelectField and remove obsolete select rules. Keep Usage's existing composed lifecycle because incoming Popover's document-capture Escape would close Usage before nested reset cancellation could consume it.
- **Why:** These are additive contracts, not competing authorities. Source conflicts must not drop another area's opt-in or dialog focus guard. No feature store, schema, credential, search-consent or command-routing change is required.
- **Evidence:** merge conflict/resolution receipts; incoming-decisions.json with seven actual hashes and per-log decision ranges; packages/ui/src/design-system/{contracts,overlays,floating}.tsx/.ts; item spec catch-up amendment
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Canonical landing finds another concrete integration conflict.
- **Source:** locked by incoming ui-restyle decisions

## D13: Keep generated phone bundles outside repository source lint
- **Question:** Why did the caught-up typecheck reject13diagnostics in Mobile assets while its source restyle had passed?
- **Options:** remove or rewrite inherited generated assets; special-case a plugin/path; correct source inventory using the repository's existing Git convention
- **Chose:** Canonical lint inventories cached plus nonignored new files through git ls-files --cached --others --exclude-standard, then applies its unchanged rules/exclusions. Tracked files remain enforced even if an ignore pattern matches; ordinary new source is still enforced. Non-Git fixture roots retain filesystem scanning. Git inventory failure fails closed. Child Git uses isolated HOME/QUIRKY_HOME and no inherited Git overrides. Add one authored regression covering ignored generated CSS, force-tracked ignored source and untracked ordinary source; do not run it under build-first.
- **Why:** git ls-files found no tracked Mobile bundle assets; git check-ignore identifies the explicit generated output directory. apps/mobile/scripts/build-pages.ts:89–133 owns those page.js/page.css/index.html outputs. scripts/suite.ts already uses cached+nonignored inventory. This is a source-versus-build-artifact boundary, not a color/CSS rule exception or a phone restyle. No inherited generated asset was edited or deleted.
- **Evidence:** failed caught-up typecheck artifact69; git ownership/ignore output; scripts/ui-lint.ts repositorySourceFiles; scripts/ui-lint.test.ts inventory regression; subsequent actual canonical typecheck/UI build exit0/30.25s with all opt-ins retained
- **Reversibility:** easy
- **Confidence:** high for observed generated-artifact failure; authored boundary regression UNRUN
- **Revisit if:** A tracked/new source file escapes the unchanged scanner rules.
- **Source:** assumed — autonomous

## D14: Verify the composed fields/dialogs and stop owned resources
- **Question:** What evidence supports the final caught-up source?
- **Options:** reuse only early screenshots; run prohibited broad campaigns; fresh gate and minimum merged-surface proof
- **Chose:** Full frozen-install/UIlint/root/mobile/prepared-desktop typecheck plus UI build passed30.25s, emitting11host files/26plugin modules. Reloaded actual composed renderer; all4shared selects mounted, changed/restored Claude policy, Vault sort and history depth through real UI state. New selection toClaudeC still required explicit Keep after Escape; nested Codex reset Escape closed only reset and retained Usage. Current light/dark screenshot+computed-token/overflow proof retained, with no private stylesheet injection; merged light status showed8meters as current snapshots fit. Closed the owned tab, stopped its exclusively owned Chrome service, and graceful synthetic daemon/PTY/provider shutdown exited0.
- **Why:** The incoming focus stack/native fields are exercised, not inferred from a clean merge. Evidence remains scoped; suites, formal reviews, full dogfood, native coverage and golden-model scoring are still unrun under build-first.
- **Evidence:** merged-runtime-proof.json, merged-dark-runtime-proof.json, merged-accounts-vault-{light,dark}.png; canonical30.25s command output; browser release/Chrome stop/runtime exit0 receipts
- **Reversibility:** easy
- **Confidence:** high for named exercised paths only
- **Revisit if:** Canonical merge-result typecheck or end-phase visual/behavior acceptance fails.
- **Source:** locked by docs/loop/LOOP.md

## Progress
Ready for canonical land. Sole roadmap catch-up756c0344 and all7incoming logs/94decisions read; all source/test components integrated and temporary worktrees/branches removed. Final full typecheck/UI lint/root/mobile/prepared-desktop and UI build passed30.25s after generic generated-artifact inventory repair; fresh composed renderer proof is D14. All agents/check jobs returned; owned tab/Chrome/runtime/PTY/provider processes stopped, runtime exit0. Inherited .serena and ignored Mobile bundle assets remain untouched. No suite/review/full dogfood/native/golden-score approval claim; no unbuilt flow or follow-up. Next commit this receipt and scanner fix, detach, canonical absolute queue.ts land ui-restyle-accounts and await its authoritative verdict; archive compact nonsecret evidence beside lane notes and remove only owned scratch after success.
