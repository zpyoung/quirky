# ui-restyle-editor decisions

## D1: Preserve editor capabilities while replacing its presentation
- **Question:** What are purpose, scope, consumers and success criteria (brainstorming essential coverage)?
- **Options:** source-only restyle; all editor-owned surfaces; replace editor engines
- **Chose:** All desktop editor chrome and content presentation, preserving existing daemon state, engines, contributions, commands and shortcuts. SC1–SC7 name the inventory.
- **Why:** The approved rollout names editor without narrowing its contributions; behavior changes are a non-goal.
- **Evidence:** docs/quirk/specs/2026-10-28-ui-redesign/logic.md:194-202; plugins/quirky.editor/src/ui.tsx; EditorSurfaceScout mapping
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** A surface cannot preserve functionality through the existing public shared system.
- **Source:** locked by docs/quirk/specs/2026-10-28-ui-redesign/logic.md

## D2: Use graphite shared controls and retain canonical host placement
- **Question:** Layout, density, grouping, theme, interaction style and default placement gray areas?
- **Options:** copied legacy styles; shared controls plus semantic engine/layout styles; new toolkit
- **Chose:** Public shared controls and tokenized central engine/layout styles, comfortable rows, exact graphite dark/light. Files remains the canonical right-top tool; documents center views; overlays/settings remain registered boundaries. No duplicated tool heading or custom host button pile.
- **Why:** Both approved goldens and host projection already establish the structure. CSS-only recoloring would leave divergent control behavior and presentation.
- **Evidence:** docs/quirk/specs/2026-10-28-ui-redesign/logic.md:23-59,89-119; packages/daemon/src/plugins/tool-layout.ts; packages/ui/src/design-system/contracts.ts
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** Existing shared contracts cannot express necessary accessible editor interactions.
- **Source:** locked by docs/quirk/specs/2026-10-28-ui-redesign/logic.md

## D3: Preserve feature-specific data and failure semantics
- **Question:** Loading, empty/error states, disabled/busy actions, focus, keyboard, edit/close conflicts and measured/dynamic values?
- **Options:** simplify away states; preserve lifecycle semantics and restyle presentation
- **Chose:** Preserve truthful loading/error/retry, safe empty states, disabled/read-only guards, dirty-close cancellation, save acknowledgement, exact-window focus, existing navigation and keyboard routing. Keep user-controlled fonts and engine/content geometry as feature data; canvas colors come from computed tokens. Do not invent success or remove content renderers.
- **Why:** Styling must not weaken revision guards, sanitized outputs or existing editor capabilities.
- **Evidence:** plugins/quirky.editor/src/window/{DocumentSurface,SourceEditor,ExplorerPanel}.tsx; existing editor behavioral suites; combined spec SC1–SC5
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Actual changed-path smoke exposes a component semantics mismatch.
- **Source:** assumed — autonomous

## D4: Opt all editor source into the existing lint gate without exceptions
- **Question:** Enforcement, duplicate styling, print output and module ownership gray areas?
- **Options:** exemptions/baselines; enforce editor and remove private CSS; weaken scanner
- **Chose:** Add quirky.editor to scripts/ui-lint-plugins.json; remove injected stylesheet and literal style colors/pixels. Existing shared components own controls; centrally linted shared styles own necessary engine/layout presentation. Printable export remains self-contained and functional through a shared presentation boundary, not scanner suppression.
- **Why:** The approved system explicitly prohibits plugin CSS and raw style values. Existing scanner intentionally covers every opted-in source file.
- **Evidence:** scripts/ui-lint.ts; docs/loop/decisions/ui-tokens-and-components.md D2–D4,D10; combined spec SC6
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** A real non-presentation data value is incorrectly classified by the canonical scanner.
- **Source:** locked by docs/quirk/specs/2026-10-28-ui-redesign/logic.md

## D5: Execute one contracts-first wave under build-first
- **Question:** Spec, implementation, review, testing and autonomous approval process?
- **Options:** normal research/review/suite campaign; authoritative build-first override
- **Chose:** Combined self-reviewed logic/tech spec committed first; three disjoint external component worktrees, omp OpenAI task implementers, parent integration owner. No reviewer backend probed or dispatched because review rounds are forbidden. No suites/full dogfood/screenshot scoring; retain/write behavioral regressions, run required typecheck including lint and narrowly prove actual changed renderer behavior. No human asks or visual-companion/research swarm. Preserve inherited untracked .serena metadata.
- **Why:** LOOP.md overrides normal skill steps. User explicitly names build-first for this item. Minimum runtime proof remains required by coding contract and is not a full acceptance/review claim.
- **Evidence:** git show build/roadmap:docs/loop/LOOP.md; queue wait item title; xd://lsp status returned no configured servers
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Authoritative loop policy changes during this item.
- **Source:** locked by docs/loop/LOOP.md

## D6: macOS evidence only; portable APIs where inexpensive
- **Question:** Platform coverage and native surface claims?
- **Options:** certify every platform/native window; macOS renderer proof only
- **Chose:** macOS build/typecheck and owned isolated renderer smoke. Linux/Windows and native OS chrome are not certified; no OS-specific behavior is newly introduced.
- **Why:** LOOP locks platform scope and the redesign excludes the phone UI; this item changes editor-owned renderer presentation only.
- **Evidence:** docs/loop/LOOP.md platform rule; combined spec non-goals
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Supported build/test targets change.
- **Source:** deferred: platform

## D7: Share printable HTML presentation without changing export semantics
- **Question:** How can editor PDF export remain self-contained without plugin-owned CSS?
- **Options:** exempt export source from lint; duplicate literal palette; pure shared print helper with canonical token text
- **Chose:** `@quirky/ui/editor-print` createEditorPrintHtml with title/body/katexCss/theme; static bundled canonical tokens, preserved light print default and CSP. Markdown owner implements pure helper; parent owns package export integration.
- **Why:** Lint deliberately covers every source file; export must remain functional without plugin CSS or runtime source-file assumptions in packaged builds.
- **Evidence:** plugins/quirky.editor/src/markdown/pdf.ts; EditorMarkdown contract request; combined spec amendment
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Bundling cannot embed the canonical asset or PDF appearance changes.
- **Source:** assumed — autonomous

## D8: Keep content colors and engine assets distinct from app chrome
- **Question:** Which integration corrections preserve content while enforcing the approved design?
- **Options:** quantize authored ANSI colors; retain plugin styles; preserve content data and centralize engine presentation
- **Chose:** Restore the existing validated ANSI output-color pass-through rather than approximate arbitrary truecolor as a UI status. Add canonical --ui-transparent for shared engine selections/shadows. Shared Markdown CSS imports the installed KaTeX engine stylesheet/font assets; remove the private plugin link and obsolete plugin asset copy. Import CodeMirror syntax tags from their actual @lezer/highlight export and declare the direct dependency.
- **Why:** App chrome must use semantic tokens, but notebook output color data is not app status. The first real build rejected the incorrect CodeMirror export; UI lint reported 14 authored transparency values and the remaining stylesheet link. No scanner exception or disabled capability is added.
- **Evidence:** barrier-audit.json; first typecheck artifact20; first renderer build output; original notebook outputColor diff; packages/ui/build.ts
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Actual rendering shows missing math font assets or unreadable theme colors.
- **Source:** assumed — autonomous

## D9: Record minimum actual renderer proof without a golden-review claim
- **Question:** What did the changed-path smoke demonstrate, and where does its evidence stop?
- **Options:** infer usability from compiler only; run prohibited review/dogfood campaigns; narrow actual isolated renderer proof
- **Chose:** Run the real built renderer/daemon against a fresh isolated home and real fixture repository. Observed actual CodeMirror typing and acknowledged Save (marker present, Save disabled, dirty badge gone); Quick Open focused search and Enter created the correct canonical Markdown tab; rich-to-preview preserved fixture content; Files opened the notebook; shared trust Dialog canceled on Escape without running code; actual CSV filter retained only Monday; settled dark/light surfaces had no document-wide horizontal overflow. Standalone shared print HTML embedded canonical light tokens, escaped title and rendered white with graphite text.
- **Why:** These are real changed-surface interactions, not mock-component or compiler-only evidence. The standalone fixed-buffer editor fixture correctly stays pinned when Quick Open creates a terminal workspace tab; switch to the canonical Worktree host or explicitly target ui.window.view.open for fixture inspection. A transient theme-transition screenshot was not treated as settled contrast evidence.
- **Evidence:** source-save-proof.json, notebook-trust-proof.json, csv-filter-proof.json, final-render-proof.json, print-runtime-proof.json in the ignored lane evidence; actual screenshots; EditorNavigationScout exact source trace; full typecheck/UI build exit0 at 32.28s
- **Reversibility:** easy
- **Confidence:** high for named interactions only; full feature/native/golden acceptance unclaimed
- **Revisit if:** End-phase suites or independent golden review identify regressions.
- **Source:** assumed — autonomous

## D10: Fence the smoke browser by an exclusively owned profile and explicit CDP
- **Question:** How to respond when the managed Chrome helper changes to another lane's renderer?
- **Options:** keep driving/kill the shared page; stop actions and isolate by unique profile/CDP
- **Chose:** Stop using the original handle immediately after its URL changed from our private renderer to another lane's owned Browser restyle page. Notify lane8 through its observed exact omp terminal (accepted receipt only, no delivery claim). Do not close or kill that foreign page/process. Launch a unique owned Chrome profile/service and attach explicitly to CDP50274 for subsequent CSV/filter/dark/print evidence, then release that handle and stop only that exact service. Exclude the foreign-page screenshot from acceptance evidence.
- **Why:** An executable path alone did not fence concurrent browser helpers. Exact owned process/profile/CDP and public ui.state window identities avoid cross-lane control. With multiple live UI connections, ui.view.open correctly refused ambiguity; ui.window.view.open targeted the observed live connection3.
- **Evidence:** original helper URL drift and raw pages inventory; lane8 terminal discovery/send receipt; isolated Chrome service PID12595/profile chrome-isolated; explicit-CDP screenshot/filter/print receipts
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** The browser harness provides an independently verified process/target ownership guarantee.
- **Source:** assumed — autonomous

## D11: Keep shutdown evidence truthful and remove only owned leftovers
- **Question:** Did the throwaway isolated runtime cleanly exit?
- **Options:** claim clean exit; hide the fixture exception; record it and prove owned-process disposition
- **Chose:** Record service exit1: daemon.stop completed, but process-scope cleanup could not create its dispose marker because its directory beneath the disposable TMPDIR was already absent. A fresh exact-argument process inventory found no process matching the owned fixture base, smoke driver or unique Chrome profile. Remove only the exact owned fixture allocation afterwards. The earlier setup ENOENT was fixed by creating isolated TMPDIR before process-scope initialization; no production lifecycle workaround or test suppression was added.
- **Why:** This is a throwaway harness cleanup failure, not evidence that the product tests passed or that every foreign process was ours. No shared browser was killed.
- **Evidence:** supervised editor-lane9-smoke-ready exit1/log; shutdown-process-snapshot.json; exact owned base cleanup receipt
- **Reversibility:** easy
- **Confidence:** high for observed process inventory
- **Revisit if:** An owned surviving process is identified by exact fixture identity.
- **Source:** assumed — autonomous

## D12: Preserve incoming exact-window, Ask snapshot and shell mount contracts
- **Question:** Do the sole roadmap catch-up's decisions conflict with the restyle?
- **Options:** restore focus-inferred routing or old host mounts; preserve the landed owning contracts
- **Chose:** Read all four incoming decision logs completely: fix-test-agent-status-1028, fix-test-apps-mobile-1028, fix-test-ask-1028 and fix-test-packages-ui-1028. Preserve exact connId ambiguity/stale refusal, MainArea canonical active-view input identity, ToolShell's canonical panel focus region, exact-ID Ask snapshot isolation, authenticated attention ownership, mobile grants and native/platform evidence limits. No conflict or editor API/caller migration is required.
- **Why:** This restyle changes editor presentation rather than those authorities. The actual multi-window fixture ambiguity refusal is consistent with the incoming exact-window decision; fixture setup must target the live connection instead of weakening admission. The merge is clean and introduces no alternative editor state.
- **Evidence:** incoming-decisions.json complete four-log snapshot; sole git merge build/roadmap; merged compiler gate
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** The canonical merge-result gate demonstrates a concrete integration failure.
- **Source:** locked by incoming decision logs

## D13: Union lint opt-ins after canonical land rejects concurrent restyle composition
- **Question:** What is the required response to the actual landing conflict?
- **Options:** drop either plugin's enforcement; retry without merging; follow failed-land recovery and retain all opt-ins
- **Chose:** Switch back to the item branch, merge current roadmap, and resolve only scripts/ui-lint-plugins.json as editor plus terminal plus terminal-dock. Read ui-restyle-terminal D1–D13 and Progress completely. Preserve its shared ContextMenu, transparent token, theme/geometry authorities, exact-window/browser-isolation policy, authored behavioral tests and headless-GPU evidence limit.
- **Why:** The first canonical land exited1 before verification because both restyles edited the previously empty enforcement list. Both source sets must remain enforced. Their canonical transparent token changes are identical, not competing palettes. This merge is the explicit failed-land retry, not an unsolicited second catch-up.
- **Evidence:** first queue land3.24s conflict receipt; scripts/ui-lint-plugins.json conflict; retry-incoming-decisions.json
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** The composed typecheck or canonical retry names another concrete failure.
- **Source:** locked by docs/loop/LOOP.md failed-land retry procedure

## Progress
Ready for canonical land. Three scoped components committed and merged after exact HEAD/path/metadata barrier; all owned component worktrees removed with inherited metadata preserved. Source integration79e1faab and one clean roadmap catch-up complete. All four incoming logs read without conflict. Full merged UI-lint/root/mobile/prepared-desktop typecheck passed exit0/32.73s; pre-catch-up actual renderer build passed11host/vendor files25plugin modules and minimum real UI/print interactions are recorded in D9. Two substantive interaction regression files authored, suites/reviews/full dogfood/native/golden scoring UNRUN under build-first. No editor flow intentionally left unbuilt and no successor added. Owned isolated Chrome stopped, daemon shutdown exception and exact no-owned-process inventory retained under D11; original drifted foreign browser target untouched under D10. Next: commit this receipt, detach and canonical queue land ui-restyle-editor, await actual verdict; preserve compact ignored evidence then remove only owned scratch after success. No second item or whole-queue completion claim.
