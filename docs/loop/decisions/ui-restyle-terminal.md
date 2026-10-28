# ui-restyle-terminal decisions

## D1: Preserve all terminal behavior and existing contribution destinations
- **Question:** brainstorming purpose, consumers, scope, layout and interaction gray areas
- **Options:** redesign terminal behavior; restyle only visible center pane; cover both plugins' desktop surfaces while preserving feature contracts
- **Chose:** all desktop surfaces of quirky.terminal and quirky.terminal-dock; existing center views, bottom-left tools and floating renderer overlay unchanged
- **Why:** the approved parent explicitly excludes new features, phone UI and shortcut changes; the claimed item names both plugins
- **Evidence:** docs/quirk/specs/2026-10-28-ui-redesign/logic.md:23-59,83-119,176,192-202; ui-shell-slots D1,D3,D5
- **Reversibility:** medium (presentation only; feature APIs preserved)
- **Confidence:** high
- **Revisit if:** an existing flow becomes inaccessible in the shared rendering
- **Source:** locked by docs/quirk/specs/2026-10-28-ui-redesign/logic.md

## D2: Shared controls and semantic tokens replace injected plugin CSS
- **Question:** layout density, loading, empty, error and component-gap gray areas
- **Options:** tokenize injected CSS; simplify interactions to basic components; central shared terminal layout and reusable advanced variants
- **Chose:** shared controls and host-owned semantic-token layout; promote existing rich searchable/nested menu behavior into shared ContextMenu/ContextMenuList; remove obsolete plugin style injectors and local menu implementation, migrate callers
- **Why:** lint forbids plugin CSS even when tokenized; simplifying submenus, rich tabs or composer input would violate behavior preservation. Existing FormRow can own raw native select/textarea/checkbox controls with shared field styling
- **Evidence:** scripts/ui-lint.ts rules and source traversal; shared design-system contracts; terminal Menu.tsx; approved parent:85,117-119
- **Reversibility:** medium (shared menu prop contract)
- **Confidence:** high
- **Revisit if:** another area requires incompatible menu semantics
- **Source:** assumed — autonomous

## D3: Keep terminal-theme and runtime geometry authorities intact
- **Question:** dark/light precedence, sizes and platform boundaries
- **Options:** rewrite xterm preferences; freeze terminal geometry to token sizes; retain theme adapter and measured/persisted geometry
- **Chose:** retain terminal custom/Tango/system/inherit settings and existing appearance adapter; tokenize static chrome dimensions only; preserve measured/persisted pane and composer geometry
- **Why:** earlier theme decisions bind this item; geometry/PTY changes are not a visual restyle
- **Evidence:** ui-terminal-theme D2–D4,D8; DockHost.tsx and workspace GroupView.tsx runtime rectangle styles
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the actual restyled surface exposes a measured layout regression
- **Source:** locked by docs/loop/decisions/ui-terminal-theme.md

## D4: Use one combined spec and three disjoint OpenAI implementation components
- **Question:** execution skill research, spec, backend, testing and review preflight
- **Options:** normal full research/review/suite campaign; explicit build-first item policy
- **Chose:** combined logic/technical spec and shared menu types committed first; at most three OpenAI task implementers in isolated external worktrees, no worker checks or commits, all-writer attribution barrier. No reviewer alias probing or review dispatched; normal omp cross-family choice would be opus, not claimed reachable. Parent runs canonical UI lint/typecheck/build and minimum actual changed-surface browser smoke, no suites or screenshot scoring campaign
- **Why:** item title explicitly applies build-first; LOOP.md forbids suite/review/dogfood campaigns during this mode. Higher coding contract still requires actual changed-surface proof. No human asks or research swarm; parent approved design and four dependency decision logs are the research
- **Evidence:** authoritative git show build/roadmap:docs/loop/LOOP.md; claimed queue title; read skills brainstorming/writing-specs/writing-plans/subagent-driven-development/TDD; lsp status no configured servers
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** operator changes this item's build-first gate
- **Source:** locked by docs/loop/LOOP.md

## D5: Leave inherited metadata untouched and isolate every runtime
- **Question:** dirty-tree handling and test state ownership
- **Options:** stash inherited .serena; edit ambient user homes; preserve unrelated metadata and use private homes
- **Chose:** leave inherited untracked .serena unchanged; external owned worktrees/scratch and fresh HOME/QUIRKY_HOME for smoke; close owned browser/runtime and remove owned scratch after land
- **Why:** unrelated changes belong to the user and LOOP forbids real-state testing
- **Evidence:** initial git status --short --branch; LOOP hard rules; lane notes operator rule requires all future tests through remote bun scripts/suite.ts
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a needed capability is unavailable in isolated state
- **Source:** locked by docs/loop/LOOP.md

## D6: Keep native and other-platform acceptance unclaimed
- **Question:** which platform verification is supported by the implementation environment
- **Options:** infer all-platform/native success; portable CSS/browser APIs with macOS-only web smoke
- **Chose:** macOS build and an owned Chromium actual app surface only; Linux/Windows/native-host focus, resize and system appearance still need platform acceptance
- **Why:** no native changes are requested; LOOP locks macOS-only build/testing
- **Evidence:** LOOP platform rule; approved parent desktop-only scope
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** supported build/test platforms expand
- **Source:** deferred: platform

## D7: Fix integration at the shared token and resolved-palette owners
- **Question:** what did canonical lint/typecheck reveal after the source barrier?
- **Options:** exempt transparent literals or retain raw search colors; supply one shared transparent token and use the existing resolved terminal palette
- **Chose:** add canonical --ui-transparent in the shared primitive token file/public token map; use it for transparent editor/overlay chrome. Search decorations read the already-resolved full TerminalPalette rather than old raw Orca colors, preserving custom/Tango overrides. Restore missing React hooks import in EmulatorView and declare the dock's @quirky/ui workspace dependency with generated lockfile
- **Why:** first lint reported13 raw transparent literals; scanner exemptions would weaken the contract. First compiler reported14 missing-hook/cascading diagnostics in EmulatorView. Reading optional xterm ITheme fields then produced2 undefined-string diagnostics; the existing complete resolved palette is the correct typed authority, with no extra computed-style read on each search
- **Evidence:** canonical lint output; initial compiler outputs; successful full typecheck32.71s; actual UI build11host files/25plugin modules
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** an appearance override produces unreadable search decoration contrast
- **Source:** assumed — autonomous

## D8: Render shared context menus at the document overlay boundary
- **Question:** the first real New-tab menu's right edge was painted behind the adjacent Changes tool
- **Options:** hide/clip the menu, change host overflow/z-index globally, or portal the shared viewport-positioned menu to the owning renderer document body
- **Chose:** shared ContextMenu portals to document.body; nested menus remain one keyboard scope and caller state still owns closure/actions. Migrate old root-scoped menu tests to their owning documents, not query fallbacks
- **Why:** the actual first menu rectangle extended past the center boundary while its right edge was hidden under the host tool. A viewport overlay belongs outside plugin slot stacking/scroll boundaries. No global shell override or second plugin menu implementation is needed
- **Evidence:** initial dark menu screenshot and ancestor DOM rectangles; final private-browser actual pane context menu atx670..862.390625 over Changes startingx694 had rightEdgeHitInside=true, parent BODY; nested Quick Commands keyboard submenu opened, Escape left1menu then0
- **Reversibility:** medium (shared overlay placement)
- **Confidence:** high for the observed browser path
- **Revisit if:** exact native-window portal/focus behavior differs from the renderer
- **Source:** assumed — autonomous

## D9: Report minimum actual surface proof without a screenshot-score or suite claim
- **Question:** which required verification was actually exercised under explicit build-first?
- **Options:** infer full acceptance from typing; run prohibited campaigns; execute narrowly scoped real renderer/daemon/PTY paths and report their limits
- **Chose:** actual isolated daemon and shell output, terminal search1/2+Escape, real Sessions tool, Quick Command add/save with retained Project scope/body, nested context-menu keyboard ownership, floating maximize/restore/minimize with exact restored rectangle, and composer draft/highlight-overlay preservation through dark/light. Private browser errors were empty; document had no horizontal overflow. The composer fixture was a shell emitting a catalog-recognized title; no actual agent send/provider acceptance is claimed
- **Why:** this proves the changed presentation seam without pretending to exhaust all nine spec scenarios. Existing behavioral tests retained; promoted-menu regressions authored but not run. Full suites, formal review, independent85-floor visual scoring, full dogfood and native scenarios remain unrun under this item's explicit build-first gate
- **Evidence:** lane notes terminal-restyle-evidence/proof.json and dark.png/light.png; daemon scope success and TERMINAL_RESTYLE_SMOKE_CLEANED followed by service exit0; dedicated Chrome service stopped and private tab released
- **Reversibility:** easy
- **Confidence:** high for exercised paths, not a full visual approval
- **Revisit if:** end-phase suites or automated visual review identify a regression
- **Source:** locked by docs/loop/LOOP.md

## D10: Isolate browser targeting and honor exact-window fixture routing
- **Question:** the default app.path browser handle began reporting another lane's editor runtime, and a second own renderer refused ambiguous worktree navigation
- **Options:** continue acting on the shared target, weaken window routing, or use an explicitly owned CDP process/profile and exact public window API
- **Chose:** stop acting on the changed shared target; launch dedicated headless Chrome/profile, attach exact CDP, and route the fixture with ui.window.view.open to its authenticated live connId. All final captures guard the owned daemon origin. Stop only the dedicated owned Chrome; leave the shared browser/other lane pages untouched
- **Why:** driver target reuse is not product evidence. ui.state truthfully reported two connected windows and the ambiguity toast; explicit target routing is the existing supported contract. Later shared endpoint inventory had only another origin, no remaining own page to close
- **Evidence:** browser URL observations, dedicated service startup/stop, ui.state windows3/4 and ambiguity toast, exact-window API result, private CDP surface observations and origin guards
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the browser driver supplies process-isolated default targets
- **Source:** assumed — autonomous

## D11: Remove incidental presentation copies instead of repinning them
- **Question:** how should existing tests follow the presentation cutover?
- **Options:** re-pin new classes/colors/injected source, or retain consumer-visible assertions and delete obsolete implementation copies
- **Chose:** remove manifest/command forwarding copies, all-sessions-done classname and header wording pins, the floating injected-CSS text case, and the xterm search color-options spy/copy. Keep real search navigation/highlight presence/clearing, session identity/actions and other behavioral coverage; migrate only document-owned menu queries. New shared menu regressions cover nested/disabled/IME/focus behavior
- **Why:** a restyle should not substitute a new implementation snapshot for an old one. The retained scenarios still drive state and behavior; no tests were run or reported passing
- **Evidence:** terminal test/ui.test.ts, window/floating-overlay.test.ts, window/pane-search.test.ts, e2e-ui/features-search.test.ts, five window menu consumers and shared context-menu.test.tsx
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a consumer-visible boundary lacks behavioral coverage in the end phase
- **Source:** assumed — autonomous

## Progress
All source components returned, were audited against disjoint scopes and integrated: b4e49d0d workspace, dbbbcae8 tools, 9f892f89 composer, plus 3eb6d51f explicit menu test consumers using the same workspace implementer. All4external worktrees removed; inherited parent .serena untouched. Parent integration repairs and user README update complete. Pre-catch-up full typecheck/UI lint passed32.71s; actual UI build and minimum isolated browser/daemon/PTY proof completed (D7–D10). No tests/suites/scoring review/full dogfood/native acceptance run. Both owned runtime services finished, dedicated browser released/stopped. Next commit integration, merge build/roadmap once, read incoming decisions, rerun final typecheck and land through canonical queue.
