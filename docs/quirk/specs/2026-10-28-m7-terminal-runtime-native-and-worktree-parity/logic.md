# Terminal runtime, native bridge and worktree parity

## Status & amendments
Approved autonomously under authoritative LOOP.md. 2026-10-28 initial design; combined behavior and technical contracts. Build-first: author acceptance coverage, defer permanent suites/reviews/dogfood to the end phase. Parent still performs required isolated changed-path smoke and typecheck.

## Goal and conceptual model
Implement the distinct unbuilt flows in the predecessor's [exhaustive ledger](../2026-10-28-m7-sweep-terminal-completion/logic.md#exhaustive-disposition-ledger). The complete queue title and that ledger remain obligations; this is not a declaration that terminal parity is complete. Extend public owning plugins rather than recreate Orca's private IPC or introduce a second authority. Every mutation has one durable owner; views/CLI compose the same declared methods.

## Decisions locked
- API/authentication: preserve kernel-attested caller and exact session/dispatch/incarnation. Unavailable is a typed outcome, never approval. Explicit remote runtime selection has no local fallback. Reject conflicting selectors and local-cwd shortcuts for remote targets.
- CLI/output: existing Quirky command discovery, usage/runtime exit codes, JSON conventions and request IDs remain. Profile launchers pin QUIRKY_HOME. Installation never overwrites a foreign command silently; status and reveal distinguish missing/managed/foreign.
- Discovery/data: only nonempty successful authoritative host-bound model probes can retire stale saved models. Empty/failed/unsupported probes preserve saved choices and seeded catalog. Opaque IDs stay visible; stale choices disclose support and never silently select a different model. Launch/recipe choices use the canonical resolver, retain raw > structured > inherited precedence and do not write provider model configuration.
- Visual/lifecycle: explicit loading, empty, error and unavailable states; recoverable user drafts; stable group/order/identity; readable/scriptable filters and navigation. Hidden work remains discoverable. Sleep parks exact selected views, not processes. Cleanup rechecks present safety through canonical removal.
- Native: supported public shell bridge only. Folder chooser cancellation is distinct from error. Native notification permission/click/dismiss require actual SDK hooks; signed helper/TCC lifecycle requires a real signing/packaging identity, not a simulated ad-hoc claim. Window routes must be owner-bound and must not accidentally close another window.
- Resource use: visible-only terminal/editor mounts, one history, bounded transcript polling; stop timers/subscriptions on deactivation and fence late results by current identity.
- Retain existing phone panels/notifications/artifact grants, automation provenance/sidebar filters, Browser controls/import/routing, editor viewer leases, dock, host-power/orchestration shutdown and existing native clipboard owner. No duplicate implementation or queue ownership.
- macOS only. Linux/Windows/WSL implementation/acceptance is deferred platform work. Preserve excluded non-GitHub hosting, Objective runner and PR sitter.

## Alternatives and rationale
1. Chosen: extend existing owners with three isolated implementation components and parent-owned terminal composition. Public API growth is allowed by roadmap, so a missing bridge is engineering unless an external/native authority really is absent.
2. Replace Ask/provider/status/worktree authorities: rejected; creates divergent persistence, launch choices and unsafe reconciliation.
3. Claim related shipped features as missing-flow equivalents or fake native/remote success: rejected; existing phone panels are not an Emulator tab, and shell execution success is not permission/delivery proof.

## Acceptance scenarios
Each implementer writes deterministic consumer-visible API/CLI behavior coverage for its shipped flows, including boundary/error transitions, but does not execute suites in this build phase. The final disposition ledger records implemented versus genuine prerequisite/unbuilt flows without deleting obligations.

### A1: Exact caller Ask handoff and unavailable
Before: a live orchestration worker with kernel-attested session identity and active dispatch; separately stale, unbound and impersonating callers. Walkthrough: request a typed question, wait, answer via coordinator, reconnect/restart, repeat request ID. After: durable handoff retains exact run/dispatch/worker/session authority, no duplicate question, typed answers/free text mapping and bounded deadline; stale/inactive targets return unavailable or typed refusal without another target. Native Claude/Codex question conversion preserves question IDs/options and refuses secret input. Kernel confirmations never treat unavailable as consent; mobile renders the terminal unavailable reason. Existing FIFO, fresh promotion seq, four-wait busy gate, inert previews and four-second result flash remain.

### A2: Session liveness without UI adoption
Before: pending asks on live, proven-exited and unknown sessions, with no desktop attached. Walkthrough: reconcile or wait after session changes/restart. After: live background sessions are not made unavailable solely for absent UI; proven expired exact ownership can terminally resolve unavailable with a reason; unknown evidence is not proof of death. Timers/listeners stop on shutdown. Plugin-authored confirmations retain their owner lifecycle.

### A3: Provider model discovery and retirement
Before: saved model/options for one host; model catalog changes. Walkthrough: refresh through public API/Settings using a provider-owned bounded discovery probe; repeat with empty output, failure, malformed output and another host. After: only authoritative nonempty results replace/retire that exact agent/host model; options remain where valid, other hosts unaffected, failed probes preserve prior state. Stale saved IDs remain visible with explicit feedback. Unsupported/pending host capabilities cannot promise launch settings applied.

### A4: Transcript/private-OSC/status composition
Before: captured Codex/Muse provider identity/transcript with delayed completion, request-user-input and child events. Walkthrough: append real provider-format records, retry a delayed final line, emit OSC9999, replace session identity, stop/deactivate. After: bounded parser/poller updates existing status authority, ignores stale identity/turns, exposes readable questions/detail, never turns silence into completion. Existing Claude statusline/OSC7501/hook precedence remain; remote producer status requires exact authenticated host identity and refuses unsupported transport, never falls back locally.

### A5: AI recipe composition
Before: configured hosting/review/branch/conversation action recipe with structured model/options and conflicting raw args. Walkthrough: invoke its existing public UI/API/CLI action. After: actual one-shot or terminal launch uses canonical resolver exactly once, correct prompt/context, provenance and singleton precedence. Agent change clears incompatible picks; custom command semantics and inherited/project overrides remain. No second resolver or global provider-model write.

### B1: Installed external command and profile launchers
Before: isolated profile and install directory with missing, managed or foreign quirky launcher. Walkthrough: status, install, status, reveal, uninstall; create two profile launchers and invoke them. After: exact launcher target/profile reported; foreign file never replaced without explicit confirmation, managed removal cannot delete a replaced foreign file. Invoked commands reach their pinned profile; shell-safe paths and permissions work. UI/API/CLI share owning methods; privileged /usr/local writes require real authorization rather than guessing success.

### B2: Saved and one-off paired runtime selection
Before: two valid paired runtime offers and an unreachable target. Walkthrough: add/list/show/remove a saved runtime, select via explicit global or ambient setting, use a one-off offer, combine conflicting explicit selectors, request current-cwd selection remotely. After: target uses existing E2EE pairing protocol and device scope, sensitive offers/tokens are not printed by list/status, explicit/ambient precedence is deterministic, no local request on remote failure. Unsupported remote command/capability reports exact refusal.

### B3: Native folder and Dashboard window routes
Before: a desktop shell connected to a disposable daemon, Dashboard view/filter input. Walkthrough: choose directory, cancel directory chooser, open Dashboard pop-out and close it. After: actual supported native chooser result is returned through a public owner-bound bridge; cancellation returns no paths. Pop-out uses declared route, exact view/input and window identity; main shell is not stopped by closing an auxiliary window. Absent shell/native support refuses, no browser prompt imitation. Native-only focus/dialog scenarios are pending handoff, not headless proof.

### B4: Native notification and signed host prerequisites
Before: SDK notification and signing capabilities known. Walkthrough: query capability and inspect supported packaging identity. After: only real permission/click/dismiss callbacks can satisfy those flows; void showNotification is never delivery acknowledgement. Signed terminal host launchd/TCC/admission/upgrade preserves live PTYs and exact profile identity, only with real signing identity/packaging support. Missing external prerequisite is explicitly recorded, never fake/ad-hoc production parity.

### C1: Remaining worktree grouping/filter/property controls
Before: mixed PR/status/activity/project/main/detached/external/CLI/automation/host rows, plus folder workspaces. Walkthrough: change PR grouping, agent-activity/project sorting, project manual/recent order, card properties and hide CLI/default-branch/detached/other-client/host filters through UI and API; restart and clear. After: stable persisted ordering and truthful active/hidden counts, main/folder semantics per source; unknown host/client evidence is not fabricated. Existing sidebar-extras filters retain their authority and automation provenance is immutable.

### C2: External policy and visibility inbox
Before: git worktree created outside Quirky. Walkthrough: discover it under global/per-project show/hide/inherit, review inbox, show one group, keep hidden, suppress inbox. After: detection retains real metadata/ownership, per-project override wins global, hidden rows remain reviewable unless explicitly suppressed; hide never deletes checkout or sessions.

### C3: Navigation, references, statuses and project identity
Before: three workspaces with custom notes/status/project icon/tracker identity. Walkthrough: select/back/forward/previous/next/index via public commands, Open in supported target, link/unlink URL/tracker reference, edit statuses and board assignment, set project identity. After: exact workspace history with forward truncation, absent stale entries skipped/refused without another target, reference changes persist without changing branch/path or executing URLs, custom board and sidebar agree, settings reflect current defaults. Available-host controls require actual host authority.

### C4: Creation choices and safety
Before: isolated repository with selected base/model/effort/setup/env/shared paths/default tabs/sparse choice. Walkthrough: create via same UI/API/CLI; fail setup, use existing branch, offline base, invalid sparse path and unsupported host. After: canonical worktree create honors only selected supported choices, records actual provenance, no duplicate agent prompt and no silent remote-to-local execution. Sparse/prepared pool/keep-main/behind/issue-command split/environment/default tabs/per-project shared paths remain separate requirements; already shipped carry/issue-draft behavior is not reimplemented. Invalid choices refuse before filesystem mutation; no warning-only supported claim.

### C5: Archive cleanup classifiers and exact sleep
Before: seven-day archived and thirty-day idle candidates, dirty/live/unknown/volatile/remote-disconnected context, multiple windows. Walkthrough: preview/ignore/restore/remove and sleep selected subtree. After: classifier uses durable actual evidence, not user-asserted death; stale fingerprints cannot authorize deletion; current canonical removal guards apply. Sleep parks exact selected window/workspace view leases and retains every process/history/buffer; absent per-window routing explicitly refuses ambiguous closure.

### T1: Distinct terminal destinations, rendering and remapping
Before: visible terminal groups and existing Browser/editor/Markdown/handoff owner APIs. Walkthrough: create/open distinct terminal destinations, Mobile Emulator only where supported real provider exists, change rendering extras and key mappings, hide/reveal tabs. After: declared scriptable commands route exact target, inactive views unmount and dispose renderer extras, preserved PTY history reattaches. No interactive native-chat/Swift shell/hidden parked xterm substitution; absent emulator provider is an explicit prerequisite. Remapped commands obey terminal-input policy and do not accidentally emit shell input.

## Industry insights
No research swarm under LOOP. Evidence is the nine feature docs, locked roadmap/architecture, prior decisions and the current single scout source map; source observations are not product runtime proof.

## Deferred ideas and glossary
No extra feature ideas. Unavailable means an exact requested owner/capability cannot fulfill the operation, not consent or successful fallback. Authoritative probe means a successful provider-owned complete catalog snapshot for one host. Sleep is view parking; cleanup is destructive canonical removal. Unbuilt inventory remains an obligation, not an exemption.

## Technical contracts and ownership
Contracts are committed before implementation, in the owning files. No semantic dependency between the three implementers; width3 in one wave. All workers use absolute component-worktree paths; no worker touches parent/sibling files, runs checks or commits.

### A — Ask/provider/status/recipes
Scope: plugins/quirky.ask/**, quirky.agents/**, quirky.agent-status/**, quirky.session/**, quirky.terminal-dock/**, quirky.orchestration/**, quirky.heimdall/**, quirky.git/**, quirky.hosting/**, quirky.mobile/** and apps/mobile/src/** only for the named wire caller migration; packages/daemon/src/plugins/** only for caller-preserving dispatch/confirmation; packages/protocol/src/model.ts and plugins.ts only for exact Ask/caller contract growth. Do not edit desktop bridge/node/UI routing files owned by B or terminal/worktree source owned by C/parent. Parent-created runtime-types.ts and discovery-types.ts are real contracts: consume them, remove unused declarations rather than leave scaffolding. AskRegistration={askId}|{status:'unavailable',reason}; successful registration stays existing shape. AskHandoffIdentity has runId/dispatchId/workerId/sessionId; receiving owner authenticates all fields. ModelDiscovery has agent/host/observedAt/status/authoritative/models/reason, ModelDecl[] uses existing catalog. Only successful authoritative nonempty data is destructive authority. API/schema signatures declared in owning manifests; grow authenticated public forwarding rather than forge role=plugin as another session. Preserve existing lifecycle fences. AskEnvelope adds terminal unavailable plus reason when needed; every consumer must migrate in the same component, including kernel/mobile. Tests are owned alongside changed behavior.

### B — CLI/runtime/native bridge
Scope: packages/cli/**; packages/protocol/src/desktop-capabilities.ts, packages/protocol/src/index.ts (desktop exports only), packages/protocol/src/node/**; apps/desktop/**; packages/daemon/src UI/window routing files outside plugins/** only if required; packages/ui/src shell host/desktop bridge files (not terminal plugin). Parent-created runtime-types.ts and desktop-capabilities.ts define selected target, install status, folder chooser and window DTOs. Consume their types and expose schema-declared public owning methods/CLI. B may update agent-status Dashboard window entry only by sending parent an integration patch, not editing A's files. Pairing must reuse existing mobile E2EE primitive; no bespoke encryption or local fallback. Public folder/window API is exact caller/window-scoped. Report any protocol/plugin source needed outside this scope before editing it. Tests authored only; parent executes final typecheck/smoke.

### C — Worktree parity
Scope: plugins/quirky.worktree/** only, including tests/docs/manifest. No sidebar-extras/automation or terminal source edits. Consume parent parity-types.ts for reference/external/status/project/cleanup metadata. Extend existing control-types/options/store with append-only migrations and keep old persisted rows readable. Schema declarations must use supported flat subset. All create/remove flows end in existing canonical services; no parallel create authority. Public namespaced APIs/CLI and UI use same operations. Source contracts in C1-C5 govern enum/filter/precedence details. Exact sleep routing can consume B's public bridge only after parent integrates; until available keep honest ambiguity refusal and provide required integration notes. Real remote hosts cannot be invented.

### Parent — terminal extras and integration
Scope: plugins/quirky.terminal/**, cross-component docs/decision/notes, minimal remaining contract integration, root lock only if dependencies actually change. Reuse existing plugin public destinations and mounted view lifetimes. Parent owns smoke scripts outside repo, final typecheck, one roadmap merge, full incoming decision reconciliation, at most one exact unbuilt-flow successor and canonical queue land. No protected LOOP/queue script edits or direct queue/index mutation. Nontrivial behavior is not declared verified until exercised against a fresh temporary QUIRKY_HOME; no real provider homes/native storage/Keychain credentials are mutated.
