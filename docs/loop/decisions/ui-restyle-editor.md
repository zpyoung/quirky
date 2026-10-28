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

## Progress
Combined spec self-reviewed and shared existing component/style ownership contracts committed before implementer dispatch. Next: three isolated source tasks, no worker checks/commits, barrier audit and integration; parent lint/typecheck/minimal actual UI proof, one roadmap catch-up and incoming-decision audit, final compiler gate then canonical queue land. Suites, automated golden scoring and review rounds remain unrun under build-first; no visual-approval claim.
