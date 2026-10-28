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

## D5: Supply a shared DOM-only selection-overlay primitive
- **Question:** the existing guest picker constructs local stylesheet chrome inside a closed shadow root, beyond the three React slices
- **Options:** leave unthemed plugin CSS in a serialized program; move Browser-specific selectors wholesale; shared minimal DOM selection component with canonical token sheet
- **Chose:** public @quirky/ui/selection-overlay expression constructs only host/shadow/surface/highlight/label with canonical tokens.css and generic token-based selection presentation. Browser keeps ownership markers, payload redaction, geometry, events, cancellation and lifetime
- **Why:** an external guest world cannot mount the app's React component tree or inherit its token sheet. This is an actual missing reusable DOM primitive, not a relocation of pane/design selectors. Source Browser calls only the public UI subpath
- **Evidence:** plugins/quirky.browser/src/design/guest.ts:339–355 original local style construction; packages/ui/src/design-system/selection-overlay.ts; additive package export
- **Reversibility:** easy
- **Confidence:** high for the actual Watch picker exercised in D10; Native theme integration is unclaimed
- **Revisit if:** the guest program is not self-contained after bundling or the external document interferes with owned geometry
- **Source:** assumed — autonomous

## D6: Keep platform assurance bounded to macOS
- **Question:** native/system browser and cross-platform visual acceptance
- **Options:** infer native/other OS behavior; exercise this Mac's built renderer and preserve existing native handoffs
- **Chose:** macOS owned Chromium smoke only; no WKWebView/default-profile storage or clipboard write to the user's session. Linux/Windows font/control/viewport acceptance remains unexercised
- **Why:** locked platform scope and existing native SDK limitations do not change in a presentation-only restyle
- **Evidence:** docs/loop/LOOP.md What is already decided; Browser README Native boundaries
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** supported platform scope expands
- **Source:** deferred: platform

## D7: Fix canonical lint/type diagnostics at their owners
- **Question:** the first gates reported three raw-transparent compositions, a missing CSS text module declaration and unsupported React CSSProperties.WebkitUserDrag
- **Options:** scanner exclusions/casts; shared semantic alpha tokens and concrete asset/DOM typing
- **Chose:** shared transparent/shadow/scrim aliases in the primitive token sheet; explicit stylesheet text asset declaration; HTML draggable=false instead of an untyped vendor CSS property. No scanner changes or suppressions
- **Why:** the published scanner correctly includes transparent among raw color literals. Alpha composition belongs to shared tokens, not plugins; HTML image drag behavior has a typed native property
- **Evidence:** initial canonical gate output; packages/ui/src/design-system/tokens.css; style-assets.d.ts; BrowserPaneWindow watch image; final bg8 typecheck exit0
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the asset loader changes or another shared overlay needs different alpha semantics
- **Source:** assumed — autonomous

## D8: Escape the shell stacking context for the viewport markup editor
- **Question:** actual built Draw showed tools/stripes over the nominally fixed full-window editor and obscured its footer actions
- **Options:** larger z-index inside the pane; move the existing viewport overlay to document.body
- **Chose:** a body portal with the same dialog ref, handlers, drawing data, event isolation and cancellation; native controls inherit semantic accentColor
- **Why:** increasing an already maximal child z-index cannot escape an ancestor stacking context. The isolated final smoke shows the whole editor above the shell and accessible Cancel/Copy Markup, with real stroke/undo/redo transitions
- **Evidence:** earlier screenshot omp-sshots-15b878bb4bd4af65.webp; isolated fixed screenshots 15b879cf0b5f063a and15b879e2f81f063b; MarkupOverlay.tsx
- **Reversibility:** easy
- **Confidence:** high for the exercised renderer
- **Revisit if:** native-window focus acceptance contradicts the existing dialog lifecycle
- **Source:** assumed — autonomous

## D9: Isolate the smoke browser by profile and exact CDP endpoint
- **Question:** lane9 reported the shared app.path Chrome target collision during its editor smoke
- **Options:** keep using/close/kill the shared-path handle; stop its use and attach an explicitly owned profile/CDP browser
- **Chose:** no more operations or close/kill on the shared-path handle. Launch a separate scoped Chrome at50649 with its unique private profile; use only that explicit CDP tab. Stop own old fixture50143 and replace it with fresh51425. Never touch lane9's50274/65350. Final unique CDP tab released; only its scoped Chrome and own fixture were stopped, both exit0
- **Why:** the user report is authoritative; handle names alone did not establish isolation. Earlier screenshots/actions retain the collision qualification and do not substitute for final isolated evidence
- **Evidence:** user interjection; scoped Chrome service ready identity/profile; explicit CDP browser.open; final services exit0
- **Reversibility:** easy
- **Confidence:** high for final isolated scope
- **Revisit if:** a browser automation target lacks process/profile/endpoint ownership proof
- **Source:** assumed — autonomous

## D10: Report only observed gates and bounded actual surface proof
- **Question:** what supports landing under the explicit build-first policy?
- **Options:** claim every suite/native/golden score; record actual type/build/smoke and preserve unrun boundaries
- **Chose:** final bun run typecheck passed UIlint/root/mobile/prepared-desktop in40.78s; actual UI build emitted11host/vendor files and25plugin UI modules. Isolated final Watch showed Find1of2→2of2, dark/light markup with real stroke and Undo/Redo state, bundled guest picker selecting the owned h1 into an actual annotation/tray, dark profile creation/selected radios and Browser Settings, light home-page save/engine selection and native checkbox/disabled-active-profile controls. Actual readback showedlight/duckduckgo/exact owned home URL. Screenshots personally inspected. No native guest, real browser-source import, send or clipboard write was performed
- **Why:** minimum changed-surface proof is not a suite, full dogfood or independent screenshot score. Existing behavioral tests remain unrun; design-ui selectors now use semantic annotation/target regions rather than deleted styling classes. No appearance/source-text test pins added
- **Evidence:** bg7build exit0; bg8typecheck exit0; isolated screenshots/evidence under .quirk/build-loop/ui-restyle-browser; actual scoped services/CLI API responses
- **Reversibility:** easy
- **Confidence:** high for exercised paths only
- **Revisit if:** the end-phase owner finds a behavioral or scored-visual failure
- **Source:** locked by docs/loop/LOOP.md

### Verification qualifications
- First own source runtime lost CDP before UI use and cleaned up. A fresh runtime used the established harness's mock-keychain Chrome launcher and started successfully; no product root-cause or runtime-policy change is claimed.
- On first pane activation, immediate Find interaction twice lost the just-opened field; after window settlement, explicit observed Find entry/count transitions succeeded. No timeout/retry policy or product condition was weakened. This is not a claim that initial-activation timing was debugged.
- Earlier API fixture input used a selector-prefixed worktree where the view needed a raw ID; corrected before final isolated proof. Folder fixtures intentionally show unavailable Git features. Diagnostics retain three refused health requests to the already stopped old50143daemon. A misnamed pageErrors field based on navigation entries was discarded; it is not error-count evidence.
- The sole roadmap catch-up changed queue state only, brought no new decision logs and caused no source conflicts. No second roadmap merge is planned except actual controller-failure recovery.
- No suites, formal review round, full dogfood or default85 independent screenshot score ran under build-first. The existing ui-final-review item remains the collected-visual-review owner; no testing/review follow-up was added.

## D11: Compose concurrent restyles through the required failed-land recovery
- **Question:** the canonical land exited1 on concurrent public export, token-map and lint-enrollment conflicts
- **Options:** drop another lane's exports/enforcement; retry unchanged; merge current roadmap and preserve both contracts
- **Chose:** merge current roadmap only as required controller-failure recovery. Keep selection-overlay, terminal-theme and editor-print public exports; retain Browser shadow/scrim aliases with the shared identical transparent token; enforce Browser, editor, terminal and terminal-dock together. Read incoming editor D1–D13, terminal D1–D13 and UI repair D1–D20/Progress completely
- **Why:** these are additive shared-system registrations, not competing palettes or state authorities. Preserve canonical active-view input/focus, rich document-body context menus, content color/geometry ownership, exact-window routing and the independently reported native/GPU/browser-isolation limits
- **Evidence:** first controller land exit1/20.97s; three exact conflict blocks and explicit union resolutions; incoming decision logs; recovery merge/type/build receipts
- **Reversibility:** easy
- **Confidence:** high after merged typecheck/build and the final guarded Browser smoke
- **Revisit if:** merged typecheck or minimal current Browser surface fails
- **Source:** locked by docs/loop/LOOP.md failed-land retry procedure

## D12: Keep delayed Find replies from replacing the focused draft
- **Question:** fresh composed Browser smoke typed Alpha but displayed Ala with No matches
- **Options:** slow the driver/retry or increase waits; preserve the current typed query while its field owns focus
- **Chose:** a bounded Find draft-ownership guard, following the address field's existing distinction between local editing and canonical state. Hydrate on real pane changes and canonical updates when not editing; do not rehydrate merely on blur before Next's click. Add an unrun consumer-visible stale-reply regression
- **Why:** the source unconditionally copied pane.find.text into the controlled field while onChange issued per-keystroke requests. An older reply could alter the text before subsequent keyboard events. No backend search, lease, queue, timeout, retry or debounce change is warranted
- **Evidence:** recovery screenshot15b87be8e4bd1efd/valueAla; BrowserPaneWindow canonical effect445–450 and Find onChange; bounded component worktree atcb0b6e04
- **Reversibility:** easy
- **Confidence:** high: final actual typing retained Alpha and Next moved1of2→2of2 without changing the query
- **Revisit if:** focused draft protection breaks canonical external-query or pane-change hydration
- **Source:** assumed — autonomous

## D13: Finish recovery with current source proof, not earlier receipts
- **Question:** what passed after the recovery merge and focused Find repair?
- **Options:** reuse the pre-repair type/smoke; record fresh current typing/build and an owned Browser interaction
- **Chose:** scoped f8d33f58 repair plus two unrun real-component regressions; final full typecheck/UIlint/root/mobile/prepared-desktop exit0/34.28s and UI build11host/25plugin modules exit0. Fresh private54775runtime on uniquely owned53064CDP retained typedAlpha/count1of2, then Alpha/count2of2 after Next. Final dark/light screenshots and full-window light Draw/Cancel were personally inspected; no Watch green status dot suggests an agent is working. Both final scoped services exited0 and the exact CDP tab was released
- **Why:** an earlier recovery build attempted alongside frozen install could not resolve the newly merged KaTeX CSS; the build after setup completed succeeded without source workaround. Reload of the previous fixture later showed Connecting to Watch with no fresh frame; final repaired-path proof uses a fresh owned runtime and does not claim reload lease acceptance. No backend/lease code changed
- **Evidence:** bg13typecheck, bg14build; screenshots15b87d9b4d7d1efe/15b87da9023d1eff/15b87da9433d1f00; earlier red15b87be8e4bd1efd; canonical pane snapshot/readbacks; final services exit0. Two old53190health refusals remain in browser diagnostics; no zero-error-whole-campaign claim
- **Reversibility:** easy
- **Confidence:** high for current exercised source only; native, suites and golden scoring remain unrun
- **Revisit if:** canonical merge-result gate or end-phase acceptance finds a regression
- **Source:** assumed — autonomous

## Progress
Required recovery merge cb0b6e04 retained every concurrent export/token/enforcement contract. Bounded Find repair f8d33f58 passed the current typecheck/UIlint and actual built fresh-runtime Watch proof under D12–D13; authored tests remain unrun. All four component worktrees removed and every owned fixture/unique-CDP service stopped; user-prohibited shared handle untouched. Next commit final docs/receipts, detach and retry authoritative land; await actual receipt in this turn. No second item or full-queue completion claim.
