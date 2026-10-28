# Mobile terminal artifacts and remaining prerequisite-bound flows

## Status & amendments
Approved autonomously 2026-10-28 under the current canonical LOOP. Combined logic and technical specification; self-reviewed against mobile.md flow8 Files/Tasks and Notifications and push. No human, research swarm or separate review gate. No acceptance pass claimed before execution.

**Amendments:** 2026-10-28: D7 fixes the two artifact route grant lists at rpc/storage/navigate; storage preserves the existing shared foreground notification manager's preferences/checkpoints. The artifact-specific namespace exception must not grant generic terminal driving. Daemon bundle admission grows with exact route/path/grant metadata while preserving original base-only bundles.

## Purpose and conceptual model
A paired phone can open an actual file named by its selected local terminal, including outside-worktree artifacts, without receiving a general absolute-path file API. The terminal plugin discovers source paths from real host-owned terminal text and mints a caller-bound capability. The phone carries only the opaque identity/grant in its source-aware routes. Ordinary Files remains worktree-contained.

This follow-up also retains native APNs/FCM and GitLab/Linear/Jira Tasks requirements. Those categories cannot become complete by relabeling foreground socket events or GitHub results. Their outside prerequisites remain explicit below and in the single implementation-only successor; they are not terminal implementation non-goals masquerading as passes.

## Scope and non-goals
Build the permitted terminal artifact producer, public API/CLI, preview/read/conditional-write/grant refresh and phone list/preview/save/navigation. Preserve existing pairing/E2EE, terminal driving, normal file editor, foreground notification replay and GitHub Tasks. Do not modify other lanes' phone Sleep/origin/nonterminal tabs or editor lifetimes. No arbitrary client path, remote-host absolute path forwarding, cloud relay, upstream push service, invented entitlements/provider fixtures as shipped data, unbounded file reads, rich HTML or new bulk-transfer protocol.

## Data flow
The terminal plugin validates selected local session and worktree, reads bounded unwrapped terminal text through the public PTY plugin capability, reuses existing terminal path detection, resolves discovered candidates against host CWD, and issues opaque grants for existing regular files. Preview validates caller/source/grant and the pinned real file identity. Save verifies complete writable text and the exact preview revision before modifying that same file. Phone presentation owns a draft but no file authority. Refresh renews authorization only after revalidating source and file identity; it does not acknowledge new disk content or replay a mutation.

## Decisions locked and alternatives
- Integration/authentication: exact worktree and terminal session; local execution only. Device identity comes from PluginCaller, never parameters. CLI grants use a local-only principal stable across authenticated local connections, never the mobile principal. Expired grants remain distinct from invalid grants and lost provenance.
- Data mapping: source is explicitly terminalArtifact. Public artifact metadata may show the path; navigation cannot carry an arbitrary path. Artifact identity/grant are unguessable and bounded; no token persists in desktop layout or durable settings.
- Errors/retry: preserve drafts on expiry/conflict/refusal; explicit Refresh authorization can renew an expired capability but cannot replace the draft base revision. Explicit Reload content needs discard confirmation when dirty. No automatic uncertain save replay.
- Visual/loading: compact phone list, metadata/source label, refresh, preview, back to its exact source session, connected/loading/empty/read-only/refused states. Text/Markdown preview is bounded to48KiB; only complete valid UTF-8 writable text enables Save terminal artifact. Safe bounded raster images render as data URLs; other binaries are metadata-only. Large text visibly says truncated and cannot save. Unsaved navigation must confirm, including shared topbar navigation.
- Chosen approach: extend the terminal plugin's public namespace and the phone's existing route/bridge conventions. Rejected exposing generic absolute-path editor access (breaks containment), manufacturing grants from phone path strings (no producer authority), and embedding desktop editor panels (wrong mobile/runtime contract).
- Platform: macOS implementation and narrow runtime proof only. Linux/Windows path/descriptor semantics and actual iOS/Android platform delivery remain explicit deferred platform work.

## Acceptance scenarios
### A1 Discover and open a real outside-worktree terminal artifact
Before: isolated real daemon/PTY; worktree W, local terminal S and a text file A outside W. A's path has actually been printed by S. A different file B exists but is not printed.
Walkthrough: Session > Terminal artifacts lists A using actual host output. Open A using its opaque grant; it shows source terminalArtifact, path and exact text. No phone input can request B by path. Returning to source retains W/S.
After: A/B unchanged; grant belongs only to authenticated caller, W and S. Another device or a wrong session/worktree cannot use it. Remote execution session is refused rather than reading an unrelated local path.

### A2 Guarded save and stale disk refusal
Before: A is complete valid writable UTF-8 within48KiB and preview revision R. Edit a draft and Save terminal artifact.
Walkthrough: exact R saves and returns new disk revision; actual bytes change. Preview again, edit, then independently modify A or replace it with a symlink/different inode before save.
After: second save refuses file-changed/source-unavailable and preserves draft; unrelated/new file bytes are not overwritten. An incorrect revision never writes. A binary, invalid UTF-8, truncated or nonwritable file has no writable save path.

### A3 Expired authorization and explicit refresh
Before: actual producer-issued grant with expired five-minute authorization but retained source identity. Draft differs from preview.
Walkthrough: preview/save returns grant-expired. Refresh authorization revalidates exact caller/W/S and the source path in host output before rotating its grant. Refresh does not adopt changed disk content. Save still uses R, so intervening edits conflict. Old/foreign/malformed grants never renew. If source terminal/path is gone or replaced, classify source-unavailable/file-changed rather than promise refresh.
After: draft remains unless the user explicitly confirms reload/discard; no automatic retry or false saved state.

### A4 Bounded format previews and navigation
Before: Markdown, safe raster image, binary, large text and escaping/repointed symlink candidates actually present in terminal output.
Walkthrough: Markdown renders with the existing safe renderer and source toggle; raster uses a bounded safe data URL; binary metadata and truncation are explicit. Source pane navigation, header Back and panel reload preserve the draft unless discard is confirmed. Disconnect disables reads/writes and marks stale data.
After: no arbitrary file authority, unsafe HTML/network execution, oversized string transfer or silent truncation-as-editable content.

### A5 API and CLI scriptability and lifecycle
Before: same isolated real daemon plus owned session/temporary homes.
Walkthrough: use quirky terminal artifacts list/preview/refresh/save with exact IDs/grants and compare actual filesystem bytes. Two mobile callers cannot share grants. Bounds cap retained capabilities and scan/results; deactivation clears owned state and callbacks. Normal worktree-contained editor paths retain their current refusal behavior.
After: public schema, CLI group and phone bridge agree; no process or real user home survives the fixture.

## Retained unmet implementation requirements
- **P1 native push:** operator-controlled gateway contract/endpoint and APNs/FCM native delivery credentials/entitlements must exist. Then implement native token registration, authenticated per-host leases/15-minute foreground renewal/seven-day expiry, OS permission/settings/sound, background/tap routing and revoke/delete lifecycle from mobile.md429–438. Current direct replay is not this flow.
- **P2 provider Tasks:** provider-owned GitLab/Linear/Jira public list/filter/board/detail/comments/field mutations/workspace-link APIs must land; GitLab API/UI/workspace items remain blocked. Then consume them from the existing phone Tasks surface. No invented rows or reimplementation inside the mobile component.
One successor names only P1/P2 and their unblocking conditions. No test/review/debug-only successor.

## Industry insights
No research swarm under controlling build-first policy. Evidence: read-only external mobile.md flow8 Files/Tasks, flow9 Notifications and Notifications and push; parent decisions D8–D10; current terminal link/CWD/PTY contracts; current provider queue status. Parent implementation findings are historical, not new runtime proof.

## Deferred ideas
Only P1/P2 and platform execution above. No unrelated additions. Larger editable artifact transfer needs a separate concrete requirement; this bounded preview never implies full-file editing for truncated input.

## Glossary
Artifact: regular file whose path is found by the daemon in actual terminal output. Grant: ephemeral caller/source-bound authorization, not a path. Revision: fingerprint of the preview's current file identity/content. Refresh: authorization renewal, never content overwrite approval.

## Technical decisions and shared contracts
Public method quirky.terminal/artifacts has action list|preview|refresh|save and exact worktree/session. Later actions require artifactId/grant; save also requires expectedRevision/content. Client-supplied paths and unsupported fields are rejected. Shared DTOs live in packages/protocol/src/terminal-artifacts.ts and are exported once from protocol index. Result kinds: listed, preview, refreshed, saved, refused. Refusal reasons: grant-expired, grant-invalid, source-unavailable, file-changed, unsupported, too-large, read-only. Complete text byte ceiling48KiB, limit50 listed candidates, bounded scan and bounded retained capability storage. Five-minute grant lifetime; retained provenance at most30minutes. Repeated list must not invalidate unrelated live previews or create unbounded entries.

The backend must pin canonical realpath/device/inode, refuse changed symlinks/nonregular files, bound bytes before allocating, use a verified descriptor and compare revision before writing. Serialize saves for the same underlying file, recheck descriptor/path immediately at the write boundary, preserve normal file permissions and report any failure rather than claim save. Refresh must not silently repin another inode. Prefer existing filesystem/CAS conventions; do not claim an OS-level compare-and-swap against uncooperative external writers.

Phone routes terminal-artifacts {worktreeId,sessionId} and terminal-artifact {worktreeId,sessionId,artifactId,grant} are explicit members of shared route unions/manifest metadata, never generic path variants. Both routes receive exactly rpc/storage/navigate grants, with a narrow route-bound artifact-method exception rather than generic terminal control; existing shared notification polling/cancellation remains available. Admission binds artifact calls to the route's exact W/S/identity; preview starts from the route grant and an authenticated refresh may rotate that token for the same identity without changing source authority. Normal base pages do not get artifact RPC access.

Contract-first commit precedes one wave with two independent components: TerminalArtifacts owns terminal plugin backend/main/CLI/new tests, using committed manifest/DTOs; PhoneArtifacts owns apps/mobile artifact presentation/routes/policy/generation/native metadata and new mobile tests. Parent alone owns plugins/quirky.mobile admission changes, docs, final integration and smoke. No shared file between concurrent workers. Max2 workers, no semantic successor edge after the shared contract. Implementers do not commit or run build/lint/test/formatters. Acceptance tests are authored against real daemon API and temporary homes; deferred commands are bun test plugins/quirky.terminal/test/artifacts.test.ts and bun test apps/mobile/test/terminal-artifacts.test.tsx. Parent runs bun run typecheck and a narrow disposable public daemon/PTY/filesystem smoke, not permanent tests/review/dogfood campaigns, then one roadmap catch-up and final typecheck before canonical land.
