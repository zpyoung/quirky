# Mobile panels and notifications

## Status & amendments
Approved autonomously on 2026-10-28 under authoritative build/roadmap LOOP.md. Night-mode combined logic/technical spec; source-grounded self-review replaces human and separate spec review. No scope reduction is implied by dependency APIs that are currently absent.

**Amendments:** 2026-10-28: D8–D10 record three independently deferred prerequisite-dependent flows under LOOP's explicit deferral rule: native APNs/FCM delivery credentials/service/entitlements; GitLab/Linear/Jira provider-owned Tasks APIs (GitLab predecessors already blocked); and terminal-artifact authority/producer/read/conditional-write grants. These remain requirements in the single completion follow-up, not completed acceptance criteria. Required public API growth that is reachable now, including guarded Git branch switching and notification-only replay, is implemented in this item rather than deferred merely for lacking a method.

**Operator amendment:** testing and debugging now belong to the end phase. Until m7-test-triage, the only landing gate is `bun run typecheck`; no new suite, review or dogfood pass runs. Prior observations are recorded as historical evidence, not exhaustive acceptance. The one follow-up contains only the unbuilt flows below, never testing or debugging work.

## Purpose and conceptual model
The paired phone is a consumer of the same Quirky public plugin API as desktop and CLI. Add worktree Source Control, Review, Files and Agent History routes, host Tasks and Accounts routes, and host notification subscription/settings to the existing Expo shell and desktop-delivered page bundle. Every route belongs to the selected pinned host; worktree operations always retain that worktree. No second backend or Orca-compatible RPC aliases.

## Scope and non-goals
Own mobile.md flow8, Notifications and push, and notification settings in flow9, on direct LAN/tailnet hosts. Existing pairing/encryption/secure storage, home/session shell and bundle implementation belong to sb-mobile-app. Do not duplicate them. Cloud relay, upstream push gateway, upstream installation URLs, dictation and interactive native chat are not authorized. APNs/FCM delivery requires real operator-controlled service credentials; inspect existing notification capability before choosing any native delivery claim. If an external prerequisite prevents an independent flow, record its exact missing prerequisite and queue one follow-up before land, not a fake implementation. Unsupported providers retain their existing authoritative availability errors; never fabricate tasks or accounts.

## Data flow
A granted page calls the native bridge, which sends authenticated encrypted JSON-RPC to the chosen host. Feature-owned public APIs own Git, file containment, provider credentials, task mutations, account selection, session resume and notification filtering. Pages hold presentation state only, except per-host/worktree review progress/preferences. Disconnection visibly marks content stale and disables mutations; revocation invalidates the paired host. Never automatically replay an uncertain mutation.

## Decisions locked / gray-area answers
- Layout/density: compact phone list/detail views, responsive bounded scrollable sheets; explicit Back and refresh. Source Control tabs are Changes, Pull Request, Commits, following verified app behavior.
- Loading/empty/error: expose loading and specific retry errors independently; empty lists are not failures. Clear data on host/worktree change so slow old responses cannot populate the new route.
- Interactions: destructive discard/force push/branch replacement/unsaved navigation require explicit confirmation and existing guards. Pending buttons prevent duplicate writes. Keep notes until an authoritative send succeeds.
- API/auth: use literal Quirky methods and exact schemas; extend mobile allowlist narrowly for used consumer operations only, never generic configure, arbitrary file paths or caller identity. Public methods stay the source of truth for confirmation and error outcomes.
- Data/idempotency: per-host/worktree route state and reviewed flags; provider IDs and opaque session IDs never inferred from display text. Preserve binary/media limits and containment. Account secrets remain on desktop, never rendered/transferred.
- Integration/retry: refresh read paths explicitly; reconnect restores subscription, de-duplicates notification identity, and catches up only through actual available replay APIs. No cloud routing or socket-as-background-push claim.
- Alternatives: selected thin independent React web route modules on the existing native bridge; rejected wholesale Orca UI copy (incompatible RPC/security and hosted services), desktop-panel embedding (desktop-only window/context contracts and poor phone layout), separate mobile backend (duplicates authoritative state).

## Acceptance scenarios
All backend flow assertions use real daemon API/CLI with temporary QUIRKY_HOME; UI scenarios use built phone-width pages. Boundary tests target consumer-visible state/errors, not source-text or mock-forwarding copies.

### P1 Source Control
Before: temporary worktree with staged/unstaged/untracked files, branch history and optional real hosting fixture. Open Source Control: correct branch/ahead/behind/counts and Changes/Pull Request/Commits. Stage/unstage one or all, enter/generate/cancel commit message, commit and observe actual Git state. Existing push/pull/sync/publish/fetch/force-push/switch/conflict/PR actions use exact API contracts and confirmations. Empty tree shows clean; absent PR shows create/link; permission/hosting/conflict errors remain actionable and never say success. History selects a commit and its file diff. Legacy pr/history route forms enter the corresponding hub tab.

### P2 Diff review and notes
Before: changed multi-file worktree. Per-file real diff supports previous/next, stage/unstage, confirmed discard, line/range note add/edit/delete and reviewed toggle. Review actions stage reviewed files, mark unreviewed, format/copy notes, send unsent notes to an actual session target, clear only sent notes, open/create agent session and return to session. Notes remain unsent on cancellation/failure. Review completion reflects actual file set; PR context remains available. A renamed/deleted/binary file is not presented as editable text.

### P3 Files
Before: nested files, markdown, text, image/media, outside symlink and dirty edit. Explorer lists folders before files and expands/collapses within the worktree. Preview supports source/rendered markdown, syntax text, bounded safe images/media, copy path/content and actual supported editor/save-artifact operations. Loading, missing/binary/oversize and read/save failures are distinct. Dirty navigation asks discard; cancelled discard retains draft. Containment prevents worktree escape even through symlinks. Revoked/disconnected host shows waiting/stale instead of current-file claims.

### P4 Tasks
Before: actual configured provider or isolated provider executable/HTTP fixtures through real daemon integrations. Host Tasks exposes available GitHub/GitLab/Linear/Jira providers, query/repo/status/assignee/review filters and list/board presentation. Detail shows description/comments/fields and supported edits/comment/close/external/copy actions. Create Workspace In uses selected repository, suggested/custom name and supported agent/options and creates a real linked worktree through authoritative API. Dismiss with keyboard open restores page geometry. Missing credentials/capability/provider error is explicit, not empty success.

### P5 Accounts
Before: desktop account records and usage. Accounts shows Claude/Codex System default and configured rows, active selection, 5h/7d usage/reset or unknown, refresh and authoritative select. Failure retains the previous active state. Only public safe account metadata crosses bridge; add/reauth points to desktop Settings. Never create a second credential store.

### P6 Agent history
Before: sessions across two repositories/workspaces. Default Workspace scope, Project and All; query supports existing repo:/path: syntax; refresh/grouping/title/provider/message/age/preview follow real vault API. Resume uses authoritative prepare/resume flow, displays queued only after success, navigates to resulting actual session, and surfaces missing/unready/error cases. No interactive structured chat replacement.

### P7 Notifications
Before: authenticated direct host and actual notification source. Enable/subscription/settings operate on this device and host, respect desktop-away, sound and focused-workspace suppression where supported, test delivery through real service and reconcile reconnect by actual replay identity. Disable/unmount disconnects subscriptions and releases resources; token/device identity cannot be caller-spoofed. Never label a foreground socket event as delivered background push. Native APNs/FCM registration, lease renewal, OS permission/settings and tap routing require real platform/service capability, otherwise defer with exact prerequisite and single follow-up. Filtered notifications do not reappear on reconnect; duplicate events do not create duplicate alerts.

### P8 Defect regressions and native handoff
At320px width and short keyboard viewport, Tasks Create Workspace fields/actions and filter sheets stay inside viewport and scroll; cancel restores header/content bounds and body scroll. Every panel has reachable navigation, loading/empty/error and refresh. Actual mobile OS keyboard, system notification banners/permissions and background/tap delivery are pending native scenarios, not inferred from browser proof. Linux/Windows/Android runtime execution is deferred platform work per roadmap; macOS browser proof is required.

## Industry insights
No research swarm per LOOP night mode. Evidence is external research/orca-features/mobile.md flow8, settings row Notifications, Notifications and push, verified flow8 and new Tasks clipping defects; docs/architecture.md mobile decision; sb-mobile-daemon and sb-mobile-app decision logs.

## Deferred ideas
One completion follow-up must name native background push, non-GitHub Tasks provider operations, and authorized terminal artifact save/preview. Its prerequisite contract and exact evidence are in decisions D8–D10. No unrelated additions or claim that disabled capabilities passed.

## Glossary
Panel route: host/worktree-scoped phone page. Bridge: native authenticated RPC proxy, no secrets in page. Reviewed: per-file review progress, not Git staging. Sent note: note whose actual target send succeeded. Push: OS delivery while backgrounded, not a socket event.

## Technical contracts and decomposition
Three disjoint implementer components under apps/mobile/src/panels: source-control/** (hub and review); files-tasks/** (explorer/preview and Tasks); activity/** (Accounts, History, Notifications). Shared apps/mobile/src/panels/contracts.ts commits first and defines PanelRoute/PanelBridge/PanelProps. Each component exports one React component accepting PanelProps, dispatching by route.kind. React web and MobilePageBridge conventions are inherited from sb-mobile-app. No worker edits shared contracts, native shell, pages hub, plugin authorization or root tooling. Parent integrates these after dependency commits arrive and owns all shared-file changes. Narrow public APIs may be added only in explicitly assigned feature-owned files after prerequisite mapping, never private daemon imports.

Acceptance and defect tests are retained alongside implementation, and native-only scenarios remain pending in the nightly handoff. Under the operator's build-first rule, parent and controller run only `bun run typecheck` before landing; all remaining suites, reviews, UI campaigns and debugging wait for m7-test-triage. Dependency readiness remains required.

### Scoped notification API
`quirky.mobile/notificationPoll {after?,epoch?,waitMs?(0..25000),onlyWhenDesktopAway?,suppressWorktree?,subscriptionId?}` returns `{epoch,cursor,notifications:[{id,seq,at,title,body,worktreeId?,sessionId?,desktopAway:boolean|null}],reset,truncated,presenceAvailable}`. A 256-entry process-local replay log advances cursors over filtered records; old epochs reset, future cursors reject, one pending poll per authenticated device, disconnect aborts waiters. `notificationCancel {subscriptionId?}` returns `{cancelled}` and releases only the authenticated caller's matching generation, preventing stale page cleanup from cancelling its replacement. No unrestricted kernel event subscription. `notificationTest {}` appends a real subscription test alert and returns `{sent:true}`, bypassing away filtering without native desktop delivery. macOS IOHIDSystem idle >=180 seconds or IOConsoleLocked marks away; query failure means unknown, never silence. The page root owns one DirectNotifications manager across all routes, with shared settings, bounded in-app alerts and authoritative worktree/session navigation. APNs/FCM background delivery remains a distinct prerequisite, not claimed by this API.

