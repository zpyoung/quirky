# ui-restyle-orchestration decisions

## D1: Restyle all four desktop plugin surfaces without changing workflow authority
- **Question:** brainstorming purpose, layout, density, interaction and coverage defaults
- **Options:** cosmetic legacy-class patch; rebuild workflows; migrate every existing renderer contribution onto shared controls
- **Chose:** shared-component migration of orchestration, Heimdall, handoff and loops, including settings, overlays and secondary views; preserve IDs, default host slots, state machines, APIs and CLI
- **Why:** the approved redesign changes appearance and location, not feature behavior; shared controls avoid continuing visual divergence
- **Evidence:** docs/quirk/specs/2026-10-28-ui-redesign/logic.md:23-59,83-119,182,192-202; OrchestrationUiMap source map
- **Reversibility:** medium (visible composition)
- **Confidence:** high
- **Revisit if:** an existing flow cannot be expressed by the public shared components
- **Source:** locked by docs/quirk/specs/2026-10-28-ui-redesign/logic.md

## D2: Preserve pending, empty, failure, draft and safety behavior
- **Question:** brainstorming loading-pattern, empty-state, error-state and interaction gray areas
- **Options:** hide sparse/error states; invent new retry behavior; retain canonical transitions using shared feedback and controls
- **Chose:** preserve current read/request ownership, displayed failures, retries, draft values, approval/close/delete confirmations and exact record targets; shared semantic statuses and concise empty states
- **Why:** presentation must not launch, cancel, approve or discard anything implicitly; these plugins operate supervised agents and long-running loops
- **Evidence:** item logic SC1–SC4; plugins/quirky.handoff/src/window/model.ts; plugins/quirky.loops/src/ui.tsx closeChoiceCommand; plugins/quirky.orchestration/src/ui.tsx request guard
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** narrow runtime proof or end-phase tests demonstrate changed control semantics
- **Source:** assumed — autonomous

## D3: Reuse the canonical theme, component and lint authorities
- **Question:** implementation choices, theming, grouping and exception defaults
- **Options:** plugin-local styles; second toolkit; existing @quirky/ui components/tokens and canonical opt-in list
- **Chose:** public @quirky/ui imports, existing data-theme authority, all four IDs in scripts/ui-lint-plugins.json; remove obsolete local styles rather than exempting them
- **Why:** the approved system is mandatory and binding prior decisions prohibit baselines and duplicate theme state
- **Evidence:** ui-tokens-and-components D2/D4/D10; ui-terminal-theme D4; ui-shell-slots D3/D6
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a missing shared visual primitive requires an explicit shared-package addition
- **Source:** locked by docs/quirk/specs/2026-10-28-ui-redesign/logic.md

## D4: Use build-first combined spec and three isolated implementation components
- **Question:** execution workflow, backend pairing, research, review and verification
- **Options:** full skill research/review/suite campaigns; explicit item build-first override
- **Chose:** one combined logic/technical spec and committed unchanged shared API boundary; three OpenAI task implementers in external worktrees, no worker checks or commits. Parent audits all paths at the barrier, integrates, runs lint/typecheck/build and minimum real changed-surface smoke. No reviewer/probes, suites, screenshot scoring or full dogfood claimed
- **Why:** authoritative LOOP and exact queue title explicitly select build-first; no human decisions are requested. Existing .serena is unrelated user metadata and stays untouched
- **Evidence:** git show build/roadmap:docs/loop/LOOP.md Build first section; item title; LSP status returned no configured servers
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the operator changes this item's verification policy
- **Source:** locked by docs/loop/LOOP.md

## D5: Verify on this Mac with wholly private runtime state
- **Question:** platform and process safety constraints
- **Options:** ambient user home/browser; private owned daemon and Chromium
- **Chose:** disposable HOME/QUIRKY_HOME/provider/XDG environment and owned-process scope; dedicated Chromium/CDP to avoid cross-lane target reuse. Linux/Windows and real native window acceptance remain unexercised
- **Why:** tests/smoke may not touch real user state and only macOS build is authorized
- **Evidence:** LOOP hard rules and platform policy; ui-restyle-terminal D13/iteration14 browser ownership observations
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** supported platform scope changes
- **Source:** deferred: platform

## D6: Add missing native fields and editor appearance once in the shared system
- **Question:** all three implementers identified multiline/select controls absent from public input-only TextField; handoff also injects its own CodeMirror theme
- **Options:** local native-styled controls/CSS; discard functional editor; add minimal shared primitives and scoped shared editor styles
- **Chose:** public TextArea and SelectField with native form/label/help/error semantics, shared wrapping readout/option-list utilities, central CodeMirror/secret-highlight token bridge. Existing functional editor and composed combobox retain their model behavior
- **Why:** every named plugin needs these controls; adding them once avoids four bespoke controls and preserves secret markers/editing. No CodeMirror dependency or state machine is added to the shared components
- **Evidence:** RestyleFleet/RestyleHandoff/RestyleLoops handoffs; plugins/quirky.handoff/src/window/PreviewEditor.tsx:28-39; packages/ui/src/design-system/contracts.ts:10
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** real browser proof exposes native form/selection/secret-mark regressions
- **Source:** assumed — autonomous

## D7: Quarantine two relative-path edits and reassign their ownership after stopping the writer
- **Question:** fleet worker reported that relative edit paths resolved against the parent despite the absolute-root fence
- **Options:** conceal the attribution failure; discard correct owned source; stop the writer and explicitly replan disjoint ownership
- **Chose:** stopped fleet worker; its returned assigned tree was unchanged and parent diff contained exactly the two admitted orchestration paths plus parent-owned lint config. Parent assumes src/ui.tsx and window/OrchestrationSettings.tsx; resumed fleet scope excludes both and retains only Heimdall, orchestration package/remote-output/tests
- **Why:** accepting worker prose alone would bypass isolation. The stopped barrier and exact parent path inventory establish attribution without reverting unrelated user state; no concurrent writer now owns either quarantined path
- **Evidence:** RestyleFleet stop report; parent git diff path inventory; scratch scope-recovery.json; source initial/current snapshots
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the final barrier finds any other out-of-scope path
- **Source:** assumed — autonomous

## D8: Repair the shared appearance and event boundaries exposed by the real build and smoke
- **Question:** integrated build and actual handoff overlay revealed concrete integration failures
- **Options:** change build output naming; local style/event exceptions; retain host stylesheet ownership and fix the shared modal boundary
- **Chose:** remove plugin shared-CSS imports because the host already loads the canonical stylesheet; fixed ui-dialog-backdrop pointer-events:auto so dialogs in the intentionally pointer-transparent overlay layer can receive actual clicks. Keep native editing and secret decoration logic; no plugin stylesheet or event bypass
- **Why:** Bun's fixed ui.js entry name collided with the CSS outputs introduced by those imports. Browser click was genuinely blocked with pointer-events:none on dialog/backdrop/overlay ancestors; central backdrop ownership repaired both handoff and loops. Center-view dialogs already worked, which isolated the inheritance boundary
- **Evidence:** first UI build exit1 Multiple files share the same output path; successful subsequent11host/25plugin build; observed modal ancestor styles before fix and real destination selection/preview typing/loop draft actions after fix
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** another overlay needs a different explicit event boundary
- **Source:** assumed — autonomous

## D9: Keep liveness distinct from work status and remove incidental assertions
- **Question:** composition audit found new worker-liveness dots implying active work/failure, and wording-only assertions carried through the migration
- **Options:** equate any live process with working and normal exit with failure; retain raw source/copy assertions; report literal liveness without invented work state and keep behavioral checks
- **Chose:** liveness rows display host-provided states without invented semantic work dots. Installed orchestration skill coverage uses done/accent rather than working. Removed the loop pause-label dictionary test instead of repinning it; handoff detached regression checks actual editable controls, not any-disabled descendants or fieldset markup
- **Why:** process liveness is not proof of active work or failure. Controls must remain disabled through the real detach transition even after markup changes; labels/classes are not that invariant
- **Evidence:** RemoteWorkerOutputView liveness rows; OrchestrationSettings coverage rows; loop rail and handoff edit regressions
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a canonical activity field supplies stronger liveness-to-work semantics
- **Source:** assumed — autonomous

## D10: Use a stable owned headless shell after two newer browser transports failed
- **Question:** minimum real-surface smoke could not navigate in either system Chrome or bundled Chromium1248
- **Options:** claim browser pass from HTTP200; alter product timeouts; try an installed stable owned headless executable and retain the diagnostic limit
- **Chose:** both failed scopes cleaned and exited0; existing headless_shell1148 with a separate profile/CDP loaded the same real app and exercised it. No product timeout, default, renderer or daemon behavior changed
- **Why:** HTTP fetch returned200 in3ms and daemon APIs were healthy, but Page.navigate and even direct Runtime.evaluate failed on newer browser targets; Chromium1248 stderr reported CVDisplayLinkCreateWithCGDisplay failed. This is transport/environment evidence, not a proven application defect. The stable headless shell then navigated and painted normally
- **Evidence:** Page.navigate/Runtime.evaluate timeout receipts; owned chrome.stderr.log; stable browser.open receipt and saved actual PNGs
- **Reversibility:** easy
- **Confidence:** high for the observed tool failure; root cause beyond the boundary remains unproven
- **Revisit if:** current Chromium/macOS capture acceptance is required
- **Source:** assumed — autonomous

## D11: Record minimum surface proof without claiming full acceptance or visual scoring
- **Question:** which verification actually supports this build-first land
- **Options:** infer complete feature acceptance; run prohibited suite/review/dogfood campaigns; report only exercised compiler/runtime evidence
- **Chose:** canonical lint and root/mobile/prepared-desktop typecheck passed31.89s; UI build emitted11host/25plugin modules. Three wholly private daemon/browser scopes cleaned and exited0. Stable owned headless Chromium exercised default left-bottom Heimdall empty/refresh, real orchestration policy save/readback2, shared command dialog Escape, real handoff multiline template persistence, searchable destination selection, actual CM typing and detached controls, one synthetic AWS marker with tokenized red decoration, dark/light editor backgrounds22/23/27 and255/255/255, and draft retention. Loop setup changed to queue, added two multiline items, moved the second first, retained its name across theme change, cancelled, and public list stayed empty. Missing loop/remote Dispatch displayed honest errors. No page-wide horizontal overflow. Screenshots/proof saved beside lane notes
- **Why:** this proves changed mounts, fields, event boundaries and theme composition without claiming nonempty fleet lifecycle, provider launch/delivery, remote pagination, full feature-flow acceptance, native/macOS-window behavior, screenshot score or tests/suites. Browser error inventory contains one driver-injected invalid selector error at pptr:internal, not an application exception; two later selector/key mistakes were corrected in the driver only
- **Evidence:** orchestration-restyle-evidence/proof.json and5PNG captures beside lane notes; browser tool receipts; owned service exit0 receipts; authored/migrated tests are unrun
- **Reversibility:** easy
- **Confidence:** high for exercised paths; exhaustive acceptance remains unclaimed
- **Revisit if:** end-phase tests or approved screenshot scoring identify a regression
- **Source:** locked by docs/loop/LOOP.md

## Progress
All three source components passed the all-worker path/HEAD barrier at ddb06f9d; committed b982bbbb/fleet,93fee2af/handoff,e8d7fd75/loops, merged and removed all component worktrees. Parent source, lint opt-in, shared primitive/event support and docs integrated. Initial type errors in new test selectors/native query typing fixed; full typecheck and narrow real surface proof are recorded in D8–D11. All workers and3owned browser/daemon scopes returned; no owned runtime remains. Tests/suites/reviews/full dogfood/screenshot scoring remain unrun under explicit build-first. Next one roadmap catch-up, read all incoming decisions, final typecheck/build and any minimal merged proof, then commit/detach/canonical land and await receipt.
