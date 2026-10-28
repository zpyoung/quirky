# Settings Mobile visibility technical spec

Status: autonomous approval; loop-requested companion to [logic.md](logic.md).

## Purpose
Bound the diagnostic to the real host overflow and existing Mobile renderer; preserve working app behavior when the reproduction succeeds.

## Architecture
Supports [logic.md#conceptual-model](logic.md#conceptual-model). `plugins/quirky.mobile/src/ui.tsx` mounts `MobileSettings`; its final `DeviceList` invokes the existing API. The host in `packages/ui/src/styles.css` owns `.main-body > .plugin-slot` overflow. Use the production Bun daemon and built React UI in an isolated browser; do not substitute Happy DOM for layout proof.

## Code references
Supports [logic.md#scope--non-goals](logic.md#scope--non-goals).
- `/Users/zpyoung/orca/workspaces/quirky/build-lane-2/plugins/quirky.mobile/src/window/MobileSettings.tsx:154-207`: settings content and trailing device list.
- `/Users/zpyoung/orca/workspaces/quirky/build-lane-2/plugins/quirky.mobile/src/window/DeviceList.tsx:16-58`: revoke action and row rendering.
- `/Users/zpyoung/orca/workspaces/quirky/build-lane-2/packages/ui/src/styles.css:1149-1160`: host slot sizing/scrolling candidates, only if runtime evidence implicates this owner.
- `/Users/zpyoung/orca/workspaces/quirky/build-lane-2/packages/daemon/src/daemon.ts:117-129`: production startup; lines 269–289 own cleanup.
- `/Users/zpyoung/orca/workspaces/quirky/build-lane-2/apps/desktop/src/bun/page.ts:1-4`: UI URL/token hash.

## Contracts & interfaces
Supports [logic.md#behavior--scenarios](logic.md#behavior--scenarios). No API signature or shared schema changes. Retain the public mobile pairing/state/revoke contracts. A scroll owner must remain constrained by the visible host content area while allowing its full content to be reached. Wheel navigation must not depend on focus in an unrelated input. Keyboard focus may scroll a descendant into view through normal browser behavior; programmatic scrolling is diagnostic only, never acceptance evidence.

## Data models / schemas
Supports [logic.md#data-flow](logic.md#data-flow). No stored model migrations. Run-owned pairing secrets and runtime token stay in private temporary/runtime artifacts, never committed. Persist only redacted geometry, outcomes and report paths in the decision log.

## DO-NOT-CHANGE fences
Supports [logic.md#decisions-locked](logic.md#decisions-locked). Mobile crypto, allowlists, peer grants, registry semantics and revoke API are fenced because the problem is viewport reachability, not authorization. Protected loop scripts, queue and shared decision index are untouched. Unrelated shell/tool-slot redesign stays owned by its queue item.

## Always / Ask / Never
Supports [logic.md#scope--non-goals](logic.md#scope--non-goals). Always isolate HOME/QUIRKY_HOME and clean up processes. No human asks; record decisions. Never edit real provider homes, create fake success rows, or force a click on an offscreen control. Preserve a no-code outcome when the app works.

## Cross-cutting
Supports [logic.md#data-flow](logic.md#data-flow). macOS web surface only; no native-only behavior changes. No new telemetry, persistence, permissions or remote calls. Screenshots/report artifacts remain ignored and are not committed.

## Testing strategy
Supports [logic.md#behavior--scenarios](logic.md#behavior--scenarios). First reproduce A1–A3 on the built actual UI at 1280×720. Read geometry/overflow ownership without mutating it. Run the guarded web workflow; record any targeting limitation separately. If a fix is needed, keep a failing-before/passing-after browser scenario, following existing repository test conventions and avoiding source-text/CSS-literal assertions. If investigation-only, no permanent test or code change. Parent owns all build/test/typecheck execution, not workers. Before landing run `bun run build`, `bun run typecheck`, `bun test scripts`; if production code changes, run the affected package suites through `bun scripts/suite.ts` as LOOP.md requires.

## Non-goals
Supports [logic.md#scope--non-goals](logic.md#scope--non-goals). No mobile redesign, new RPC, native-window verification, or shell-wide visual migration.
