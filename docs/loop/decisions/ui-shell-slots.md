# ui-shell-slots decisions

## D1: Follow the approved shell row without restyling feature interiors
- **Question:** brainstorming purpose, scope, layout, density and interaction defaults
- **Options:** rebuild all plugin UIs; CSS-only rearrangement; host structural migration with existing plugin content
- **Chose:** host structural migration, approved graphite shared components/tokens, six independent slots and center views
- **Why:** the approved rollout assigns feature interiors to later area owners and explicitly removes global plugin tabs/sidebar piles
- **Evidence:** docs/quirk/specs/2026-10-28-ui-redesign/logic.md:23-59,168-202
- **Reversibility:** medium (visible shell layout)
- **Confidence:** high
- **Revisit if:** a feature is unreachable through the new host
- **Source:** locked by docs/quirk/specs/2026-10-28-ui-redesign/logic.md

## D2: Keep per-user tool layout in the canonical daemon store
- **Question:** persistence, grouping and conflict resolution gray areas
- **Options:** localStorage; project/worktree preferences; existing profile-wide daemon ui_state
- **Chose:** existing profile-wide daemon ui_state with additive tools and exact-window center history
- **Why:** layout/focus must remain API-readable and scriptable; the store is already profile-global, not selected-worktree-owned
- **Evidence:** docs/architecture.md:317-324; packages/daemon/src/plugins/layout.ts:37-70,152-188,904-935
- **Reversibility:** hard (public state contract)
- **Confidence:** high
- **Revisit if:** user identity becomes independent of QUIRKY_HOME profiles
- **Source:** locked by docs/architecture.md

## D3: Project effective legacy contributions into tools and preserve original IDs
- **Question:** data mapping, duplicates and third-party exceptions
- **Options:** rename every declaration; retain separate old rails; effective host projection with explicit alias destinations
- **Chose:** panel/sidebar/activity projection; deduplicate existing alternate launchers into substantive content; preserve arbitrary third-party content; views/commands/status/settings/overlays retain canonical owners
- **Why:** a second registry or mass caller migration would change feature behavior and collide with area owners; top plugin tabs and sidebar piles still disappear
- **Evidence:** packages/protocol/src/ui.ts:87-105,169-208; packages/daemon/src/plugins/ui-model.ts; builtin manifest inventory captured through JSON parsing
- **Reversibility:** medium (projection can change without changing plugin IDs)
- **Confidence:** high
- **Revisit if:** a plugin needs explicit placement metadata rather than deterministic defaults
- **Source:** assumed — autonomous

## D4: Use durable pending asks as actionable Inbox authority
- **Question:** attention lifecycle, empty/error states and dismissal meaning
- **Options:** treat toast dismissal as answer; duplicate ask records; derive from public ask API and preserve canonical answer path
- **Chose:** host Inbox derives unresolved questions; eight-second corner toast disappears independently; failed answer retains question; no implicit focus/worktree change
- **Why:** pending asks already have durable sequence/answer authority while toasts are transient presentation
- **Evidence:** plugins/quirky.ask/src/store.ts; packages/ui/src/components/Toasts.tsx; approved spec scenarios2–3
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** a non-question attention source requires durable acknowledgement
- **Source:** locked by docs/quirk/specs/2026-10-28-ui-redesign/logic.md

## D5: Retain exact-window and plugin-internal view behavior
- **Question:** center tabs, existing shortcuts and auxiliary-window integration
- **Options:** tab every installed plugin; replace feature-owned tabs; track actually opened center contributions while retaining inner feature tabs
- **Chose:** actually opened center view history with latest input and exact-window routing; auxiliary windows keep route-local views; existing plugin shortcut priority retained with host search trigger
- **Why:** installed-plugin navigation is explicitly removed, and replacing document/session ownership changes behavior beyond the redesign
- **Evidence:** packages/ui/src/components/MainArea.tsx:7-34; packages/ui/src/plugins/host.ts:377-395,1070-1084; packages/daemon/src/plugins/layout.ts:278-327
- **Reversibility:** medium
- **Confidence:** medium
- **Revisit if:** area restyles expose a direct host tab contract for their documents/sessions
- **Source:** assumed — autonomous

## D6: Reuse only the shared system and inherited theme resolver
- **Question:** visual component and error/loading/empty defaults
- **Options:** plugin CSS and raw literals; second toolkit; shared controls/tokens and host frames
- **Chose:** shared controls, ToolPanelFrame, readable loading/error with plugin name+Reload, EmptyState; shell-only token CSS; existing data-theme resolution
- **Why:** all packages/ui is lint-enforced and the dependency owns system contracts; plugin interiors are not opted into lint prematurely
- **Evidence:** ui-tokens-and-components D1–D10; @quirky/ui design-system public exports; parent spec:83-119
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a required host control cannot be expressed by a shared component
- **Source:** locked by docs/quirk/specs/2026-10-28-ui-redesign/logic.md

## D7: Execute one combined spec and three disjoint source components
- **Question:** execution skill preflight, research, review and verification
- **Options:** standard research/review campaigns; build-first combined spec/contracts and source workers
- **Chose:** contracts committed first, at most three OpenAI task implementers in external worktrees, no worker checks/commits, parent attribution barrier/typecheck/minimum actual smoke; no review backend probes because no review is run
- **Why:** authoritative LOOP build-first overrides the ordinary execution skills. No human asks. Inherited .serena stays untouched; no tests run until end phase
- **Evidence:** git show build/roadmap:docs/loop/LOOP.md Build first section; language-server status returned no configured servers; combined item logic spec
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** authoritative LOOP enters the end phase
- **Source:** locked by docs/loop/LOOP.md

## D8: Bound dimensions and use opaque same-window drag state
- **Question:** resize limits, invalid data and drag trust gray areas
- **Options:** trust arbitrary DataTransfer bytes; unbounded geometry; validated IDs with same-window drag state and bounded dimensions
- **Chose:** validate effective IDs/slots at daemon mutation, side160–1200/bottom100–1000/splits0.15–0.85; source drag state is local gesture-only, destination persisted through API; small viewport rendering can contract without changing preference
- **Why:** corrupted stores and external drags cannot create inaccessible/oversized layouts; gesture state is not authority
- **Evidence:** item logic spec SC3–4 and public tool-slots.ts types
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** actual shell smoke exposes a narrow-window accessibility problem
- **Source:** assumed — autonomous

## Progress
Design self-reviewed and combined spec/shared types prepared. Next commit contracts, dispatch three disjoint source implementers, integrate after all return, typecheck and minimum private-home real shell smoke, one roadmap catch-up and canonical land. Tests/review/full dogfood remain unrun in build-first. Exactly one claimed item this iteration.
