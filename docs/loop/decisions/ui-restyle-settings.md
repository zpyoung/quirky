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

## D6: Integrate only attributed components and remove obsolete presentation consumers
- **Question:** worker scope/lifecycle boundary, component integration and coherence sweep
- **Options:** trust summaries; accept only all-worker HEAD/path attribution and preserve behavioral consumers
- **Chose:** all three trees retained base33c68018ca3ae4218567aacb077e160c9c301a43; parent delta was exactly its lint/docs/external-terminal-test/legacy-CSS scope. Accepted Mobile dc0193d8, CLI bd40fea8 and host5ff06f7c, merged and removed all three trees. Mobile test DOM dependency explicitly approved; parent declares CLI's matching React/DOM test dependencies. ui-cluster is the existing utility (initial packet ui-inline-actions typo corrected). Removed dead palette/settings CSS, MobileStyles and CLI ui.js; external terminal setting test follows accessible label/control rather than removed fieldset chrome
- **Why:** no concurrent shared writer or hidden source attribution; one convention replaces local DOM/CSS. Removed new parameter-forwarding CLI test, redundant mocked palette suite and incidental group-markup assertion instead of re-pinning. Existing real-daemon palette coverage remains authoritative
- **Evidence:** four HEAD/status inventories at barrier; component merge/worktree-remove receipts; repository-wide old CLI/style/class consumer grep; components.css:813–826; features-settings.test.ts
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** composed typecheck or runtime exposes a consumer mismatch
- **Source:** assumed — autonomous

## D7: Repair compiler-detected integration defects without weakening the gate
- **Question:** which failures in the first composed checks require correction
- **Options:** suppress diagnostics; restore missing syntax/bindings and explicit fixture types
- **Chose:** restore the lost closing test callback in sidebar-extras, restore its missing createElement/useEffect/useState imports, and type the Mobile fixture call parameters. Canonical lint already admitted all four scoped plugin IDs; no suppression/baseline/timeout change
- **Why:** source compilation exposed actual incomplete edits, not a reason to narrow the product or its gate. Static plugin structure validation independently found the missing React bindings; manifest/module/build discovery contracts otherwise matched
- **Evidence:** first typecheck TS1005 at sidebar-extras/test/ui.test.ts:336; second TS2552/TS2304/TS7006; SettingsPluginStructure report; repaired source ranges
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** final composed typecheck or actual mounts find another mismatch
- **Source:** assumed — autonomous

## D8: Record actual presentation proof, not a complete feature acceptance claim
- **Question:** minimum verification supported under explicit build-first
- **Options:** typecheck alone; prohibited suites/scoring campaign; actual disposable daemon/browser changed-path smoke and bounded claims
- **Chose:** canonical UIlint/root/mobile/prepared-desktop typecheck and actual UI build passed32.28s, emitting11host files/26plugin modules. A fresh HOME/QUIRKY_HOME daemon and dedicated owned Chromium1148 CDP rendered Settings, compiled CLI and Mobile. Actual Settings Cancel retained the default, Save persisted false, UI Theme Save pinned dark, long content scrolled764px viewport over11905px content with fixed actions and no horizontal overflow. CLI disabled missing-target installation; invalid offer stayed masked/retained with real daemon error and no saved runtime; draft survived theme change. Mobile explicit QR, machine-name save/readback, custom loopback address, actual162px QR loaded at204/408px, enlarge/Escape, rotation and safe public reports passed. Mobile opened left-bottom; palette empty-search then keyboard CLI navigation passed. Browser errors[]
- **Why:** exercises changed presentation paths without claiming suites, full dogfood, native behavior or an independent golden-screen score. No private capability/approval/RPC bypass. Screenshots omit live offer/QR credentials; proof JSON contains only boolean/size outcomes
- **Evidence:** settings-restyle-evidence/{proof.json,settings-dark.png,settings-light.png,cli-light.png,mobile-dark.png,mobile-light.png,cli-mobile-tool-dark.png} beside lane notes; canonical typecheck/build output and real daemon RPC readbacks
- **Reversibility:** easy
- **Confidence:** high for exercised paths
- **Revisit if:** end-phase behavior or screenshot scoring finds a presentation regression
- **Source:** assumed — autonomous

## D9: Correct smoke-driver assumptions without changing product behavior
- **Question:** how to interpret failed automation steps and a misleading confidentiality probe
- **Options:** treat driver failures as product defects; inspect actual surface/API and correct only harness extraction/waits
- **Chose:** direct waitForSelector does not accept state:hidden, so used page.waitForFunction for disappearance. Custom-address save awaited canonical option before selection. Corrected press signature to key/options. Rotation temporarily removes the URL field; an early null extraction made JSON.includes(null) match ordinary nulls. Repeated only after the real offered field/QR returned; both339-character old/new URLs differed and neither appeared in ui.state. No credential value persisted in evidence
- **Why:** actual visible/API outcomes resolve each ambiguity; no source workaround or timing increase is justified
- **Evidence:** smoke tool errors and subsequent option/field-length/public-report observations
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a stable nonempty offered URL is ever present in a public report
- **Source:** assumed — autonomous

## Progress
Spec and public package dependency contracts ready to commit. Next create three isolated component worktrees, dispatch disjoint workers (Mobile; CLI; host/settings/palette/sidebar-extras), integrate after the barrier, typecheck/build and minimum owned surface proof, single roadmap catch-up/read decisions, final typecheck, commit/detach/canonical land. No tests/reviews run; exactly one item this iteration.
