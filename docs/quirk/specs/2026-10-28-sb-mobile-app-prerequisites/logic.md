# Phone workspace prerequisites

## Status & amendments
Approved autonomously under authoritative LOOP.md on 2026-10-28. One logic spec with final technical contracts. Locked chat/voice exclusions are not overridden. Self-review against mobile.md flows 6,7,9 retains all requested categories and distinguishes consumer adapters from producer capability work.

## Purpose and conceptual model
Complete permitted missing phone workspace flows by building the real producer capabilities they require, preserving the working direct encrypted terminal/ask companion. A workspace origin is durable creation evidence, not a guess from its surface label. Sleep is a reversible session lifecycle with retained history and resume identities, not a delete or status change. Nonterminal tabs have actual daemon-owned UI tab IDs and narrowly projected content.

## Scope and non-goals
Build reversible workspace Sleep/Wake/Hide sleeping, genuine automation/other-client origin filters, and safe phone Markdown tabs. Assess Browser streaming against the existing Native-human/Chrome-agent boundary; implement it only with an actual supported safe producer. No generic browser/editor authority, daemon-origin web embedding, remote path fetches, fake terminal tab identities, or arbitrary JS. Interactive native chat/attachments/queued-chat/options/background-task UI and voice dictation/model/settings remain conditional on the absent authorized architecture/roadmap ruling; they are not implemented as terminal injection or ask-card aliases. Existing panels, push and distribution remain separate owners.

## Data flow
Phone requests traverse the existing native credential owner, page grants, literal bridge policy and daemon authorization. Producer-owned state and provenance methods return bounded caller-relative DTOs. Public session operations persist recovery intent before stopping PTYs and retain history; wake resumes only from captured identities. Markdown operations resolve the actual worktree/tab/buffer relation and return only the current bounded text/revision, not private buffer metadata or filesystem authority. Revocation/disconnect continues to disable mutations and never automatically replays uncertain requests.

## Decisions locked
- Visual: retain current responsive list/session/dock; enable only actual controls, show durable partial failures and recovery choices, keep sheets scrollable at narrow/keyboard heights. No native-chat success claims.
- API: exact method parameters, worktree-bound IDs, no caller-supplied identity or generic event grants; schema/CLI for all new feature methods. New producer contracts are implemented, not mocked.
- Data: record trustworthy creation provenance prospectively; old/external unknowns stay visible under filters. Only authenticated stable device identity or kernel plugin identity can establish origin, never caller name/createdBy=api.
- Lifecycle: persist before irreversible stop, preserve history/provider resume identity, verify all owned process teardown, keep partial records on failure and allow explicit retry; serialize sleep/wake per workspace and reject or reconcile concurrent session launches. Never mark asleep while a targeted process remains live.
- Rendering: Markdown text is bounded and escaped/sanitized, never execute raw HTML/script or external resource fetches. Actual UI tab/buffer identity survives refresh. Browser needs supported phone-safe frames/control; existing agent Chrome is not permission to replace Native human rendering.
- Platform: macOS build implementation; OS-specific stop behavior and phone device behavior need explicit platform/native handoff where applicable.

## Key decisions & rationale
Recommended: implement permitted producer prerequisites plus phone consumers; retain a single explicit follow-up for any truly unavailable/locked flows. Rejected: block every category for missing adapters (roadmap requires growing public APIs); override native-chat/voice exclusions (not authorized); fake provenance/sleep/tabs (loses state or misrepresents authority). One wave of at most three implementers uses disjoint producer/UI ownership, with parent integration of shared mobile authorization, CLI/schema registration and workspace controls.

## Acceptance scenarios
### A1 Reversible Sleep and Wake
Before: workspace has a shell with unique history and an agent with durable provider resume identity. Sleep captures the recovery records before stopping processes, leaves history/session records, and reports asleep only after teardown. Example: shell output SLEEP_HISTORY remains readable after stop and daemon restart; Wake restores the shell history and resumes the agent with its captured provider identity rather than starting a blank conversation. Partial stop/resume failures retain exact session-level errors and retryable records. Repeat Sleep/Wake is idempotent; concurrent creates cannot leave an asleep workspace with unrecorded live sessions. Unsupported/nonresumable active agents fail before destructive work. Workspace options Hide sleeping removes only authoritative asleep rows; clearing it restores them. No close/forget/delete shortcut is used.

### A2 Trustworthy origin filters
Before: old workspace with createdBy=api and no evidence, a workspace created by the actual automation plugin, one created by this paired device, and another paired device's workspace. Hide automation-created removes only the automation-evidenced row. Hide other-client removes only proven other-client rows; old unknown remains visible, this device remains visible. Forged params, names, surface labels and ordinary API creates cannot establish automation or device identity. Evidence persists across daemon restart and works through public API/CLI; no raw device credential/identifier leaks to the page.

### A3 Markdown session tab
Before: workspace with terminal and existing Markdown editor UI tab. Session lists actual Markdown tab IDs alongside terminals. New Markdown Note creates a real editor document/tab; edit, preview, refresh, copy, rename and close use its actual worktree-bound identity. Example: a note containing '# Phone note' round-trips through the public API, preview shows the heading, and reopening retains saved bytes; a stale revision cannot overwrite a newer draft. A dirty close requires an explicit decision and cancelled close preserves text. Wrong-workspace tab IDs, oversized content and untrusted Markdown HTML/resource URLs are rejected or rendered inert. Leaving Markdown reattaches the correct terminal without losing asks/driver behavior. Save failures preserve the draft.

### A4 Browser prerequisite and locked chat/voice
Existing human tabs must use the current Native browser architecture and need actual safe phone frames/navigation before the New tab Browser action becomes enabled. If the installed host lacks that primitive, record the exact host/source evidence, preserve unavailable UI, and name that flow in the single follow-up. Chat/voice require an authorized ruling amending architecture background-only/native-chat and roadmap dictation exclusions plus owned public APIs. No permission broadening or placeholder UI ships for them.

### A5 Mobile defect and authority preservation
New controls fit 320px and keyboard-height sheets, cancellation preserves layout, text/icon terminal keyboard controls retain their existing behavior, terminal driver leases remain exact-connection scoped, and asks use real authoritative answer states. Tests cover meaningful state transitions, cross-workspace/identity errors, recovery and unsafe rendering. All process fixtures own fresh temporary QUIRKY_HOME and tear down descendants.

## Industry insights
No external research swarms per LOOP.md. Source evidence: external mobile.md flows 6,7,9 and edge cases; parent sb-mobile-app D5/D8/D10/D11/D13/D18/D21/D24; architecture structured/browser boundaries; actual protocol/store/PTY/editor/browser implementations. One read-only feasibility scout confirms the nonlocked categories can grow public producer APIs.

## Deferred ideas
Only flows with an actual locked/outside limit may be named in one follow-up immediately before land; native chat/voice need the authorized ruling. No testing/review/debug follow-up. Browser Native frame availability is assessed by the tab implementer. Other permitted flows remain implementation work, not deferred merely because an adapter is absent.

## Glossary
Origin view: caller-relative durable producer evidence with null for unknown. Sleep record: persistent recovery intent and per-session teardown/resume outcome. Tab ID: actual daemon UI identity distinct from Session ID. Native guest: human browser WebView, not agent Chrome.

## Technical decisions and shared contracts
### Shared DTOs
packages/protocol/src/mobile-workspaces.ts is committed before implementers and exported publicly. WorkspaceOriginView is {worktreeId,automation:boolean|null,otherClient:boolean|null}. WorkspaceSleepState carries state awake/sleeping/asleep/waking/partial, updatedAt and per-session pending/stopped/restored/error. MobileWorkspaceTab carries actual tabId/worktreeId/kind/title/dirty. MobileMarkdownDocument carries tabId/worktreeId/title/text/revision/dirty/readOnly. No existing SessionKind migration or fake sessions.

### Producer methods
Origin owner adds quirky.worktree/origins({}) -> WorkspaceOriginView[] using kernel-authenticated caller at creation and query. Old data is unknown; no raw origin identity in response. Sleep owner adds public quirky.session/sleepWorkspace({worktree}), wakeWorkspace({worktree}) -> WorkspaceSleepState, workspaceSleepStates({}) -> WorkspaceSleepState[], with session CLI/schema entries and underlying real public PTY stop-with-history as required. Tabs owner implements plugins/quirky.mobile/src/daemon/session-tabs.ts registering mobile/sessionTabs({worktree}) -> MobileWorkspaceTab[], markdownCreate({worktree}) -> MobileMarkdownDocument, markdownRead({worktree,tabId}) -> MobileMarkdownDocument, markdownWrite({worktree,tabId,text,expectedRevision}) -> MobileMarkdownDocument, markdownSave({worktree,tabId,expectedRevision}) -> MobileMarkdownDocument and sessionTabAction({worktree,tabId,action,name?,discard?}) for rename/close/refresh. Maximum UTF-8 document64KiB; wrong-workspace identity fails before reading/writing. Producer module exports registerMobileSessionTabs(context:PluginContext):void|Promise<void>; parent wires it. Use existing public editor/UI methods only. If actual upstream operations require a signature amendment, notify parent first.

### Scope and execution ownership
Sleep component owns packages/pty-host/**, PTY client/protocol stop contracts and adapters, plugins/quirky.session/** and their fixtures. Origin component owns plugins/quirky.worktree/** plus actual automation producer callsites needed for trustworthy origin. Tabs component owns apps/mobile/src/pages/SessionPage.tsx, new tab-related page components, plugins/quirky.mobile/src/daemon/session-tabs.ts and its new tests. Parent owns apps/mobile/src/pages/WorkspacesPage.tsx, mobile main/manifest/CLI, authorization.ts, bridge-policy.ts, shared docs/contracts and integration. Workers must not edit parent hubs or one another's files. No worker commits/checks. Parent commits each component after all return; no unfinished workers at turn end.

### Verification
Write acceptance/regression tests without running suites/reviews/dogfood under current LOOP.md; parent runs bun run typecheck as the land gate. Developer-required smoke exercises new behavior through disposable script/real API with fresh owned home and teardown. Record exact evidence and limits, never claim a phone/native pass from a portable script. Catch up once with build/roadmap immediately before land and respect incoming decisions. All temporary artifacts are removed after land.
