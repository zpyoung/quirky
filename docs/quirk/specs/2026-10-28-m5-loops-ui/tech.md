# Loop UI technical specification
Status: Approved autonomously. Logic: [logic.md](logic.md).

## Architecture
Implements [logic scope](logic.md#scope-and-non-goals). React19 plugin module `plugins/quirky.loops/src/ui.tsx` provides overlay, hosted loop view and declared UI commands. Setup/rail components use UiPluginContext only; same-plugin types imports are allowed. `quirky.terminal/openViewTab` hosts the view without owning its native session. Public menu-item declarations grow an additional terminal-plus target; terminal remains loop-neutral. Bounded journal is rendered read-only, not the interactive session composer.

## Code references
Implements [key decisions](logic.md#key-decisions--rationale). Root for all paths: `/Users/zpyoung/orca/workspaces/quirky/build-roadmap`.
- `packages/protocol/src/ui.ts`: UiMenuItemEntry lines95-108; UiPluginContext lines272-323. Add generic plus-menu literal, preserve pane behavior.
- `packages/daemon/src/plugins/ui-kinds.ts`: checkMenuItem lines79-98; `ui-model.ts` buildMenuItems and menuItems output. Validate/project generic target.
- `plugins/quirky.terminal/src/window/workspace/controller.ts`: WorkspaceOptions lines80-100, plusItems1077-1095, execClose808-829. Add generic plus contributions callback; leave pane/menu/agent behavior intact.
- `plugins/quirky.terminal/src/window/commands.ts`: watchMenuContributions/paneMenuContributions; route plus declaration through model. `src/ui.tsx`: workspaceSlots35-40 wires generic extras.
- `plugins/quirky.terminal/src/layout/service.ts`: openViewTab492 onward and ensureViewsClosable317-322 already public, validates declared view/method/command and guards all removals. Reuse instead of private imports. `src/layout/types.ts` ViewTab49-63 already has closeCommand/closeMethod/closeParams.
- `plugins/quirky.loops/main.ts`: handler registration145-218; `quirky-plugin.json` method/CLI declarations; `cli.ts` plugin CLI module. Additive UI/tab methods/commands only, preserving incoming preset API.
- `plugins/quirky.loops/src/types.ts`: authoritative LoopSnapshot/LoopConfig/IterationDetail; presets branch adds QueueItem/LoopPreset/QueueOperation. No duplicate runtime model.
- New `plugins/quirky.loops/window/contracts.ts`: shared component contract only, committed before workers. New `window/SetupDialog.tsx`, `window/config-form.tsx`, `window/LoopView.tsx` and focused subcomponents as needed inside assigned scope.
- Test reuse: `plugins/quirky.worktree/test/ui.test.ts` happy-dom window plugin conventions; `plugins/quirky.loops/test/rig.ts` startLoopRig actual daemon/native protocol fixture; `plugins/quirky.terminal/test/window/workspace-close.test.ts` and e2e-ui/workspace-tabs.test.ts hosted-tab/menu behavior.

## Contracts & interfaces
Implements [U01-U12](logic.md#behavior--scenarios). Component interfaces live in window/contracts.ts. Setup receives context/workspace/group, onClose/onCreated and onHandle; LoopView receives context/loopId/onHandle/report. SurfaceHandle exposes dispatch(action, params) and read() so declared UI commands exercise the same React handlers, not a second implementation. Handle removal on unmount prevents stale actions. Each handle reports form drafts/errors/busy/validation/active subform and selected attempt as JSON.


Shared setup-owned exports in `window/config-form.tsx`: `initialDraft(): LoopDraft`, `draftFromLoop(loop: LoopSnapshot): LoopDraft`, `validateDraft(draft: LoopDraft, options: { workspaceKind: 'git' | 'folder'; showCost: boolean; editing?: boolean }): DraftValidation`, and React `ConfigFields(props: ConfigFieldsProps)`. Setup component is named export `SetupDialog(props: SetupDialogProps)` from `window/SetupDialog.tsx`; rail component is named export `LoopView(props: LoopViewProps)` from `window/LoopView.tsx`. Rail may import those setup-owned helpers but cannot edit them; shared signatures above and window/contracts.ts are frozen before parallel execution.
Setup actions: update (partial draft), queue-add/edit/move/remove, start, cancel, advanced. Rail actions: pause, resume, stop-open/stop/cancel, steer-open/steer/cancel, edit-open/edit-update/edit-save/edit-cancel, queue add/edit/move/remove, iteration/back. Typed action unions and field types must reject unsupported combinations before calling APIs. DOM controls invoke the identical handlers.

Public window command IDs under `command:quirky.loops/`: new, setup-action, open, action, close-tab, close-choice. Command declarations carry schemas and CLI aliases. New accepts workspace/group, opens setup. Open accepts loopId, opens/reuses view tab explicitly active, except create invokes background open. Surface-action commands fail when no matching live surface, not success no-op. Close-tab reads fresh snapshot: running/needs-you opens loop close overlay; paused/ended removes tab directly. Close-choice cancel/keep-running/stop performs exact action. Backend closeMethod guards every removal: explicit approved close authorizes only matching loop/tab, does not grant unrelated closes. Bulk closes do not show a dialog or stop a worker; public guard behavior must safely distinguish or explicitly authorize this path.

Every mutation surfaces backend error; close failure retains tab. UI reads use generation/unmount fences and subscribe/reconnect rehydration. Loop events carry public snapshot; never reach into another plugin implementation. Start opens one background hosted tab; loop updates do not activate a tab. Existing tab reuse must not accidentally activate on background create.


Public close guard context is supplied by the tab host, not a caller-provided boolean. Add optional `closeContext: boolean` to the hosted-view tab type and openViewTab schema; false/absent retains the existing invocation shape. When true, the internal guard invocation additionally receives `closeReason: 'single' | 'bulk' | 'replacement'`. The host computes this at entry points: closeTab is single; closeTabs/closeGroup are bulk even when only one tab remains; replacing a preview is replacement. Thread the reason through removeTabs/ensureViewsClosable. Never take the reason from a closeTab caller argument. Loop tabs opt in; existing strict closeMethod schemas receive no added field. Single live-loop removals require matching one-shot authorization from the explicit loop close action. Bulk/group removals and lifecycle replacements detach views without stopping execution. Do not add a global bypass setting. Single authorization must bind and validate loopId+actual hosted tabId; no worker lifetime authority is granted.
## Data models / schemas
Implements [defaults](logic.md#decisions-locked). Draft string fields preserve invalid user input: name, agent, preset, prompt, queue bodies, intervalMinutes, anchor, sessionPolicy, maxIterations, checkCommand/checkTimeout/checkWhen, evaluatorCondition, maxActiveMinutes/maxCostUsd, protectedPaths plus noProgress/checkpointCommits/askBeforeNext/resumeAtLimitReset/repeatQueue/advanced booleans. Empty optional caps/check/evaluator map to omitted configuration; nonblank lines form protectedPaths. No-progress true and maxIterations10 are UI-only defaults. Create payload uses dependency LoopCreateInput; edit changed sections map to LoopConfigPatch, merging current complete nested sections before changed fields so omitted siblings survive.

Window state uses existing daemon-owned layout + slot reports. Any durable detached/bound-view metadata must be isolated loop UI plugin-store data, not a PTY/session ownership field. Avoid migration if derivable safely from workspace hosted tabs; never infer child exit from view absence.

## DO-NOT-CHANGE fences
Implements [native/focus decision](logic.md#decisions-locked).
- `plugins/quirky.loops/src/{driver,evidence,decision,queue,pacing,service,store}.ts`: dependency-owned engine/policy; UI must call public methods, no second scheduler.
- `plugins/quirky.structured/*` after dependency conflict reconciliation: execution authority and native process ownership are not UI scope.
- `plugins/quirky.terminal/src/layout/service.ts` session stop semantics: view removal cannot close loop native session.
- `docs/loop/LOOP.md`, queue.json, DECISIONS.md, scripts/build-loop and main branch: protected by loop protocol.
- No direct packages/ui internal imports or DOM scraping from the plugin.

## Always / Ask / Never
Always preserve newer integration runtime APIs and dependency contracts; public slots only; one owner per source/test file; daemon/window/API behavior identical; catch real errors; bounded message reads; clean up subscriptions and roots. Autonomous ambiguity resolution recorded in decisions, never ask a person. Never real HOME/provider state, paid model launch, fake completion, cap/safety weakening, PTY loop conversion, or silent focus steal.

## Cross-cutting
Implements [U11-U12](logic.md#u11-close-live-tab-detach-and-failure). Public command and close guards obey current capability/plugin lifecycle. Plugin disable disposes UI; core remains owner of cleanup. CLI methods retain schema/auth/idempotency conventions. Layout persists hosted tabs across renderer reload. macOS runtime acceptance only; Linux/Windows/native shell appearance require later platform verification, no claim here.

## Testing strategy
Implements [all acceptance scenarios](logic.md#behavior--scenarios). Setup owner `test/setup-ui.test.tsx` exercises consumer-visible validation/preset transitions/failed request state; rail owner `test/rail-ui.test.tsx` exercises real state controls and evidence/queue constraints. Integration owner `test/ui-api.test.ts` drives declared commands with real daemon/window harness, plus terminal generic menu and guarded hosted close regressions in owned new files. Keep tests behavior-based, not source strings/wiring echoes. Every flow has API/CLI proof; direct UI tests complement, not replace it. Throwaway isolated daemon+browser smoke uses a temporary HOME/QUIRKY_HOME and native scripted fixture provider, never real credentials. Required gate: affected `bun scripts/suite.ts` directories, `bun test scripts`, `bun run typecheck`, build then visible dogfood. Full suite belongs queue land. One final review round and blocking fix batch as LOOP instructs.

## Non-goals
See [logic non-goals](logic.md#scope-and-non-goals). No general interactive structured chat, no runtime scheduling changes or shell DOM coupling.
