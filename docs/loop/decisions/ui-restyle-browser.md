# ui-restyle-browser decisions

## D1: Keep Browser in its existing center views
- **Question:** brainstorming purpose, placement and layout gray areas
- **Options:** new Browser stripe tool; preserve registered center views and settings contribution
- **Chose:** preserve original view IDs, hosted panes, Settings section and command-opened settings view; no new global controls
- **Why:** parent design distinguishes center browsing from tool panels; host already owns placement
- **Evidence:** approved ui-redesign logic.md:23–59,179,199; plugins/quirky.browser/src/ui.tsx; ui-shell-slots D3,D5
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** approved placement changes
- **Source:** locked by docs/quirk/specs/2026-10-28-ui-redesign/logic.md

## D2: Use shared controls and semantic token layout without moving plugin CSS
- **Question:** layout-style, density, loading, empty/error and interaction gray areas
- **Options:** relocate Browser selectors into host CSS; duplicate toolkit; shared components with token-based inline feature layout
- **Chose:** shared Button/IconButton/TextField/Badge/StatusDot/SectionHeader/FormRow and existing generic shared control classes; remove injected styles. Preserve loading/disabled/error and recovery behavior, address/find refs, rich menus and feature labels
- **Why:** the scanner forbids plugin CSS; moving Browser-specific styles would evade rather than satisfy the shared-system requirement. FormRow explicitly supports semantic native select/textarea/checkbox children
- **Evidence:** packages/ui/src/design-system/contracts.ts; panels.tsx:24–64; scripts/ui-lint.ts:27–30; scout BrowserRestyleSurvey
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** actual surface requires a missing generic shared primitive
- **Source:** locked by docs/quirk/specs/2026-10-28-ui-redesign/logic.md

## D3: Keep measured geometry and drawing content separate from chrome
- **Question:** exception handling for page highlights, native viewport and frozen screenshot drawing
- **Options:** replace geometry with spacing tokens; preserve content-derived dimensions and ink while tokenizing surrounding chrome
- **Chose:** preserve runtime coordinates, image/canvas sizes and chosen PNG ink colors. No web-page or exported-image recoloring
- **Why:** these values are content/interaction contracts, not custom UI chrome; changing them would alter feature behavior
- **Evidence:** BrowserPaneWindow nativeSize and pointer conversion; DesignWindow measured highlight/pin geometry; MarkupOverlay source-image drawing
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a fixed chrome literal is disguised as runtime content
- **Source:** assumed — autonomous

## D4: Build-first gates override campaigns, not evidence honesty
- **Question:** execution preflight, tests, screenshot scores and research
- **Options:** prohibited suite/review campaign; combined spec/contracts, at most3 disjoint OpenAI implementers and parent typecheck/minimal smoke
- **Chose:** build-first; no research swarms, test suites, formal reviews, full dogfood or reviewer probes. Add React19 input-ref typing to shared TextField before dispatch. Parent performs scope/HEAD barrier, required actual changed-surface smoke and typecheck including canonical lint; preserve unknown untracked files
- **Why:** current LOOP and item title explicitly apply build-first. The reusable screenshot command currently rejects Browser page without native/Watch fixture; no fabricated passing score. Minimal own runtime proof is not a default85 screenshot-review pass
- **Evidence:** git show build/roadmap:docs/loop/LOOP.md; scripts/ui-review/capture.ts:649–670; current lsp status no servers; initial git status
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** operator phase policy changes
- **Source:** locked by docs/loop/LOOP.md

## Progress
Combined spec self-reviewed against SC1–SC5 and approved parent. Shared TextField ref contract is additive and forwarded by existing React19 implementation. Next commit contracts/spec then dispatch3disjoint UI slices in external worktrees. No business API changes or new flows.
