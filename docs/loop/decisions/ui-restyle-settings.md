# ui-restyle-settings decisions

## D1: Keep the approved presentation scope and existing authority
- **Question:** purpose, consumers, success, scope and visual layout/density/interaction gray areas at brainstorming
- **Options:** rewrite settings behavior; CSS-only skin; shared-control presentation migration
- **Chose:** shared-control migration for Mobile desktop page/settings, CLI settings, host Settings, host palette and Source Control activity; preserve contribution IDs, default slots, public methods and daemon authority
- **Why:** approved redesign explicitly changes appearance/location, not feature behavior; existing host already owns slots and palette
- **Evidence:** docs/quirk/specs/2026-10-28-ui-redesign/logic.md:23–59,83–119,187,194–202; SettingsMap source map
- **Reversibility:** medium (visible hierarchy)
- **Confidence:** high
- **Revisit if:** a current control becomes unreachable after migration
- **Source:** locked by docs/quirk/specs/2026-10-28-ui-redesign/logic.md

## D2: Preserve security, lifecycle and unavailable-capability semantics
- **Question:** loading/empty/error, integration mapping, recovery, secrets and confirmation gray areas
- **Options:** generic optimistic forms; preserve existing feature-owned flows with shared labeled controls and truthful feedback
- **Chose:** preserve pending-offer reuse/explicit rotation, intentional QR/copy visibility but no public-report secrets, revoke partial-success feedback, password CLI offer, foreign launcher confirmation, target gating, managed-only removal and unmount guards; readable shared empty/error/loading states
- **Why:** restyling must not weaken pairing/launcher boundaries or advertise unavailable relay/distribution/native capabilities
- **Evidence:** sb-mobile-daemon D5–D9/D15; m2-sidebar-extras D9/D10/D12; plugins/quirky.cli/ui.js; packages/ui/src/components/SettingsDialog.tsx
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** changed-surface proof reveals a lost action, draft or safety boundary
- **Source:** assumed — autonomous

## D3: Use compiled React for CLI and existing shared presentation contracts
- **Question:** technical grouping, duplicate conventions and component feasibility
- **Options:** retain imperative local DOM controls; add another shared DOM toolkit; compile a React UI module like existing plugins
- **Chose:** migrate CLI ui.js to src/ui.tsx, manifest dist/ui.js and all imports; @quirky/ui dependency contracts committed before workers. Mobile and sidebar-extras also import the public package. No plugin CSS/style tags, duplicate shared stylesheet imports or new RPC/schema contracts
- **Why:** actual shared components avoid duplicate toolkit behavior. packages/ui/build.ts discovers src/ui.tsx; host already loads shared CSS
- **Evidence:** packages/ui/build.ts:13–64; packages/ui/src/design-system/contracts.ts; ui-tokens-and-components D4/D10; ui-restyle-orchestration D8–D13
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a required control cannot be expressed without a shared extension
- **Source:** assumed — autonomous

## D4: Follow build-first with three disjoint isolated implementers
- **Question:** execution preflight, research/spec/review/testing and inherited worktree state
- **Options:** normal research/review/suite campaign; combined spec/contracts with parent typecheck and minimum actual changed-surface proof
- **Chose:** one logic.md with final tech contracts, three OpenAI task implementers in external worktrees, no worker checks/commits, absolute-only tools and all-worker attribution barrier. No cross-family review or backend probes because review is explicitly skipped. Parent typecheck/UI lint, build and narrow actual browser/API smoke; no suites, scoring or full dogfood. No human asks. Inherited .serena untouched
- **Why:** queue item and authoritative LOOP explicitly impose build-first. No configured LSP server was reported. Unrelated metadata is user-owned
- **Evidence:** git show build/roadmap:docs/loop/LOOP.md; canonical queue wait lane10 ui-restyle-settings; xd://lsp status; initial git status
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** operator changes the item verification policy
- **Source:** locked by docs/loop/LOOP.md

## D5: Keep macOS-only proof and portable browser presentation
- **Question:** platform/native coverage boundary
- **Options:** infer native/cross-platform parity; use current portable controls and limit claims
- **Chose:** macOS build and owned Chromium web renderer proof only; OS folder pickers, keychain/window chrome/focus and Linux/Windows behavior not certified. No new native-only scenario introduced
- **Why:** scope is a desktop presentation restyle, not native integration
- **Evidence:** LOOP Platforms; approved redesign non-goals; existing CLI native folder picker unchanged
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** supported platform matrix expands
- **Source:** deferred: platform

## Progress
Spec and public package dependency contracts ready to commit. Next create three isolated component worktrees, dispatch disjoint workers (Mobile; CLI; host/settings/palette/sidebar-extras), integrate after the barrier, typecheck/build and minimum owned surface proof, single roadmap catch-up/read decisions, final typecheck, commit/detach/canonical land. No tests/reviews run; exactly one item this iteration.
