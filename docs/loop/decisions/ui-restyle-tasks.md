# ui-restyle-tasks decisions

## D1: Preserve feature behavior and host-owned default slots
- **Question:** brainstorming essential purpose, scope, consumers, success, constraints and integration gray areas
- **Options:** visual-only migration; combine functional changes; invent a new panel layout model
- **Chose:** desktop visual-only migration across tasks and automations, existing left-bottom host placement and all current public behavior
- **Why:** approved redesign explicitly excludes changed behavior, APIs and shortcuts
- **Evidence:** docs/quirk/specs/2026-10-28-ui-redesign/logic.md:25-59,117-119,183,192-227
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** a shared primitive cannot preserve a current interaction
- **Source:** locked by docs/quirk/specs/2026-10-28-ui-redesign/logic.md

## D2: Use shared controls and canonical semantic feature layouts
- **Question:** layout/density/interaction/loading/empty/error gray areas
- **Options:** inject old plugin CSS with new colors; reuse shared primitives plus central semantic layouts; build private wrappers
- **Chose:** public shared controls with tokenized central layouts; preserve labeled semantic native data controls where no primitive fits; preserve existing empty/loading/error actions and true data-derived geometry
- **Why:** consistent graphite appearance without changing issue, Projects or automation authority/state machines; merely relocating old CSS is insufficient
- **Evidence:** parent spec design-system and behavior; current tasks/style.ts and automations/style.ts; @quirky/ui design-system contracts
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** actual narrow-panel or both-theme smoke exposes unreadable state or inaccessible control
- **Source:** assumed — autonomous

## D3: Execute three isolated source slices under build-first override
- **Question:** workflow questions, research, review, pairing, inherited metadata and checks
- **Options:** standard research/review/test rounds; authoritative build-first combined spec/contracts and bounded smoke
- **Chose:** commit dependencies and combined spec first; at most three OpenAI task implementers in disjoint external worktrees, no worker checks/commits; parent barrier/scope audit, typecheck and minimum actual changed-surface smoke. No reviewer dispatched or backend falsely claimed reachable. Preserve unrelated .serena metadata without staging it. Answer all questions autonomously, no human asks
- **Why:** authoritative loop forbids suites/review/dogfood before end-phase items and requires contracts first; developer still requires significant behavior execution evidence
- **Evidence:** git show build/roadmap:docs/loop/LOOP.md Build first; xd://lsp status returned no configured servers; scratch /tmp/quirky-tasks-restyle-lane9.xeHAFL
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** compiler or bounded smoke identifies an integration defect
- **Source:** locked by docs/loop/LOOP.md

## D4: Stop the barrier and repair attributed cross-worktree contamination
- **Question:** component audit found an unplanned parent Markdown change
- **Options:** silently accept the whitespace drift; discard all worker output; attribute the incident, restore only its exact residual delta, and repeat the barrier before committing
- **Chose:** worker acknowledged relative-path edits accidentally reached parent Markdown, NewIssue imports and Projects test; its attempted restoration left one missing blank line. Parent verified the complete residual diff was only that blank, restored it surgically, then repeated the authoritative all-tree barrier. All four HEADs matched0ac4aa16, changed paths matched assigned scopes and all metadata hashes were unchanged before component commits
- **Why:** sampled restoration is not byte-level attribution; no user source or unrelated metadata may be discarded
- **Evidence:** first audit exit1, parent git diff showed single deleted blank before toolbarButton; worker explicit tool provenance; second audit exit0; scratch barrier-audit.json
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** later tree evidence shows another unexplained modification
- **Source:** assumed — autonomous

## D5: Export existing shared context-menu CSS once
- **Question:** controlled shared menu migration exposed public stylesheet incompleteness
- **Options:** duplicate generic menu styles under each feature; import all terminal layout styles into every tool; move the existing generic block to its canonical shared owner
- **Chose:** unchanged qt-menu/qt-submenu/qt-swatch rules move from terminal-workspace.css into context-menu.css imported by public styles.css. No second menu implementation or public API change; automation-specific CSS positions only its menus
- **Why:** public ContextMenu exports need their styling without relying on terminal rendering; exact selector/token reuse preserves terminal consumers
- **Evidence:** design-system/context-menu.tsx exports; prior terminal-workspace.css174–210; combined spec dated amendment
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a shared context-menu consumer is styled differently in actual UI
- **Source:** assumed — autonomous

## D6: Load canonical CSS once through the host build
- **Question:** renderer build failed after adding direct shared stylesheet imports to two plugin entrypoints
- **Options:** change the plugin bundler/output contract; retain duplicated plugin CSS imports; follow the already-restyled editor's host stylesheet pattern
- **Chose:** remove only the new plugin CSS imports; host styles.css already imports canonical design-system/styles.css and all feature layouts once
- **Why:** fixed plugin entry naming ui.js applies to generated CSS too. Exact Bun probe with extension-aware naming emitted ui.js and ui.css, proving the collision. No runtime CSS fallback or ignored build error
- **Evidence:** bg4 typecheck passed then build failed Multiple files share same output path; direct probe outputs ui.js/ui.css; renderer build after removal passed11 host/vendor files25 plugin modules
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** plugin packaging gains a declared separate CSS-asset loading contract
- **Source:** assumed — autonomous

## D7: Reuse the actual visible automation tool instead of duplicating its editor
- **Question:** actual bounded UI observed duplicate Automations mounts during openEditor
- **Options:** suppress a duplicate DOM subtree; make Dialog ignore competing focus; correct navigation ownership at the existing daemon UI boundary
- **Chose:** identify the projected tool from public ui.contributions and actual saved placement/open slot from ui.state; reuse that visible tool for navigation/editor, close its exact moved slot, preserve unrelated center and restore that center when returning from settings. Retain standalone view behavior when no tool is mounted
- **Why:** original state.ts unconditionally opened the center; actual before receipt had2 apps/2 editor IDs/2 dialogs, with focus-trap recursion logged against the old runtime. After correction a fresh runtime had1 app/1 editor/1 dialog, acknowledged name/prompt/template edits, and Escape discarded the draft without creating a definition. Exact draft-loss cause from the duplicate run was not separately established
- **Evidence:** automation-duplicate-before.json; ui-proof.json navigation preserves Tasks settings center across uiNavigate/settings-return/right-bottom-close; new actual-daemon regression authored in ui-state.test.ts but not run; full typecheck bg6 exit0
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** multiple desktop clients expose a different per-window tool authority requirement
- **Source:** assumed — autonomous

## D8: Reset a width flex basis after the editor stacks vertically
- **Question:** narrow actual UI showed the template control reserving most of the dialog height
- **Options:** remove narrow layout; hardcode a shorter height; reset the existing row-axis basis when the intro changes to a column
- **Chose:** narrow media rule gives the template FormRow flex:initial and min-width:0; all other layout/behavior unchanged
- **Why:** the desktop flex-basis280 token measured width, but became height under flex-direction:column. Before screenshot pushed name/prompt below the usable body. After actual640x480 render the template basis was auto, intro height96.03, name top193.875 within456-high dialog, one-column form scrolled, and document had no horizontal overflow
- **Evidence:** automation-narrow-dark-fixed.png and final-narrow-proof.json; actual narrow typing/Tab/Escape passed, retained editor null/definitions empty afterward, fresh browser error entries[]
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** an end-phase visual capture exposes a different constrained-window problem
- **Source:** assumed — autonomous

## D9: Record bounded real UI proof without claiming suite or golden acceptance
- **Question:** what was exercised and what remains unmeasured under build-first
- **Options:** claim compiler-only; run prohibited review/suite campaigns; record exact actual smoke and limits
- **Chose:** real isolated daemon/profile, real public plugin APIs and built renderer, tracked fake gh upstream only. Actual Tasks default slot leaves center unchanged; closed filter→empty then clear→row; issue body renders; New Issue title/body/Markdown preview and Escape/reopen retain draft; Projects user-selected table3rows/board3cards/roadmap render; Automations single editor acknowledges edits/template, both themes, Escape/no definition, moved-slot close/settings return preserve center; corrected narrow form is usable. No suite, full feature dogfood, screenshot scoring, native OS effect or scheduling-run success claim
- **Why:** significant changed surfaces need execution evidence, but LOOP forbids the larger campaigns. Project provider initially needed the fixture stdin bridge; selecting a view through the real UI was necessary after external same-project selection retained local chooser state. An initial workspace composer opened/cancelled, but its form controls were not established by the selector observation, so no complete composer acceptance claim
- **Evidence:** isolated smoke services1/2/3 all exited0; dedicated Chrome profile/managed handles closed and exact service stopped; proof JSON/screenshots retained outside tracked source; final fresh error list[] excludes prior-runtime focus errors and fixture avatar DNS failure, not hidden by suppression
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** end-phase suites or golden review find a behavior or visual regression
- **Source:** locked by docs/loop/LOOP.md

## D10: Preserve every incoming restyle and gate the composed source
- **Question:** sole roadmap catch-up conflicted in shared lint enrollment
- **Options:** keep one lane's list; union all enrolled plugins and retain additive shared controls/styles
- **Chose:** union all18 opted-in IDs. Incoming full decision logs read: Accounts acceptance D1–17, Agents D1–15, Browser D1–13, Git D1–18, Ledger D1–10 and Orchestration D1–13, including each Progress. No normative conflict. Preserve their authority/private-home/model/catalog boundaries, projected tool placement, centralized menus, additive field/ref exports and Dialog.scrollBody defaultfalse
- **Why:** the conflict was additive enrollment, not competing implementation. Discarding another lane would weaken the shared gate
- **Evidence:** source2407a8c4, catch-up00cbf4aa; full merged bun run typecheck exit0/30.80s including UIlint/root/mobile/preparedDesktop; composed renderer build11 host/vendor files25 plugin modules. Postmerge actual private UI rendered Tasks row and1 automation editor, accepted Composed source typing at640x480, name top193.875, no horizontal overflow, Escape cancelled, unrelated center remained null and fresh error entries[]
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** final controller merge typecheck or end-phase visual/behavioral checks identify a conflict
- **Source:** assumed — autonomous

## Progress
Ready to land. Source/components/docs and consumer-visible regressions are complete; authored tests remain unrun under build-first. Sole roadmap catch-up completed and six incoming binding logs read in full. Final composed typecheck, renderer build and bounded actual UI passed (D10); no suites, review, full dogfood, golden/native acceptance claimed. All workers/scouts returned; component worktrees removed after full unrelated metadata preservation; all four private runtime services exited0; all owned managed tabs released and both exact Chrome services stopped. Next: commit final receipt, archive credential-free evidence, detach and run canonical queue.ts land ui-restyle-tasks, await authoritative success, then remove only owned scratch.
