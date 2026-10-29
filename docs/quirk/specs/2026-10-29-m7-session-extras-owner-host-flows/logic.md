# Paired-owner session features

## Status & amendments
Status: implemented; autonomous approval and bounded combined Codex specification review recorded in the decision log. Operator build-first override makes typecheck the land gate; acceptance repairs are assigned to fix-test-session-extras-owner-host-1029.

**Amendments:** 2026-10-29 — the operator explicitly replaced the remaining acceptance-debugging/UI/build/final-review campaign with a typecheck-only land and recorded fix-test item. Feature scenarios and authority requirements remain unchanged; no passing acceptance result is implied.

## Purpose and conceptual model
Accounts, Agent Session History (Vault), and Handoff must use the real computer owning the selected workspace or session. A registered owner is an authenticated full-owner saved runtime, pinned to its producer-issued host ID, activation generation and saved grant. A remote workspace mirror additionally binds an exact canonical worktree ID, filesystem instance and fingerprint; its path is display data, never local execution authority.

Consumers are desktop feature UIs and the existing plugin APIs/generated CLI groups. The current local features remain independently usable. The item is complete only when the production built-ins compose the already-shipped owner authority, not when a test-only contributor can emulate it.

## Scope and non-goals
Build focused-owner Accounts state/usage/switching and remote browser-sign-in gates; a shipped production paired-owner Vault contributor with authenticated host-qualified inspection/resume/handoff; Handoff remote target identity, exact-host agent detection and transcript probing, cross-host warning/brief delivery and host-qualified lineage.

No new transport or credential scope. No SSH/WSL/native chat/dictation/quarantine. No GitLab/Bitbucket/Gitea/Forgejo/Azure, Objective runner or PR sitter. No reimplementation of already-shipped local quota adapters, parsers, account provisioning, indexer, template editor, terminal readiness, or VM lifecycle. Remote Trash, remote Finder/system-open and exposing remote resume shell commands remain unavailable rather than executed locally. Browser OAuth completion, native OS focus/menu/notifications and real Lima lifecycle are not API acceptance claims.

## Data flow
The local feature resolves registered owner and optional remote mirror through the Worktree owner. It verifies the consumer's captured binding against current registration; CLI runtime forwarding verifies both saved-grant and host-generation pins before dispatch. Workspace actions also verify the selected instance on the owning runtime immediately before execution. Results retain host-qualified identities, with remote filesystem/env/credential details removed at the public feature boundary. Offline or replaced owners return explicit unavailable/conflict states, never local results under the remote label.

## Key decisions & rationale
Recommended: compose the existing three built-ins with common immutable owner/workspace reference types and their existing public feature APIs. This preserves the canonical owner transport and avoids introducing another host authority or activation lifecycle. Rejected: synthetic installed forwarding plugin as production authority (test-only precedent); borrowing phone/worker credentials (wrong scope); changing generic owner/worktree transport to accept arbitrary caller paths (weakens authority).

## Behavior and acceptance scenarios

### S1: Focused-owner Accounts
Before: local and paired host have distinct saved accounts/usage; a real remote mirror owns the focused workspace. Walkthrough: focus the mirror in one window, open Usage and Accounts, refresh and select a different saved remote account. After: both surfaces show the named remote host's snapshots and active account; only that host's selection changes. Switching back to a local workspace restores local data. Another window's focus does not retarget this window. Remote loading/errors clear incompatible old-host data; late responses/events cannot overwrite a newer scope. Offline remote scope never shows local snapshots. Existing Used/Remaining urgency, stale snapshot and account-revision semantics remain intact.

### S2: Remote sign-in gates
Before: Accounts is remote-scoped. Walkthrough: inspect Add Account, reauthentication, pending-link and local restart policy controls; attempt the corresponding scoped API operations. After: browser sign-in/reauthentication is visibly unavailable remotely and the scoped daemon route rejects it before any local or remote login starts; no local auth/profile bytes change. Existing remote account selection/refresh remains usable. Local sign-in and local running-session policy remain unchanged; local preferences must not become remote host settings accidentally.

### S3: Production Vault hosts and partial search
Before: two genuine registered owner runtimes, one local index and duplicate provider session IDs on different computers; no fixture forwarding plugin. Walkthrough: open Host menu, choose each paired host and All, browse/search/status, enable on all. After: hosts come from the shipped contribution and canonical registered owners; identities stay distinct; public remote records omit source file path, managed-home env and executable resume command; local enable executes first, then each remote sequentially. Offline/old/changed hosts are explicit partial outcomes; good hosts retain results and no unavailable host falls back locally. Search stays opt-in and unknown workspace scope does not widen to All. Stale cursor and superseded host responses retain current behavior.

### S4: Authenticated Vault actions
Before: a present remote archived source selected by opaque host-qualified Vault ID; target is a current registered workspace on that host. Walkthrough: inspect details/first prompt/subagents; resume; open Handoff. After: source lookup and resume occur on the authenticated source owner, not a local path or matching local provider ID; exact canonical workspace instance is checked before creating a child. Returned public data remains redacted and host-qualified. Handoff opens the local review dialog with an owner/source reference resolved on its owner. Missing/unverifiable/replaced source or stale grant/generation/instance refuses with no extra spawn and preserves UI state. Remote copy-command/path-open/Trash do not gain local fallbacks.

### S5: Exact-owner Handoff target and probe
Before: local source and remote mirrors (including a duplicate path/name) are available. Walkthrough: choose a remote target, switch targets while detection is pending, choose an enabled detected agent; request Full transcript. After: host is visible, selection identifies the exact owner and instance, enabled-agent detection runs there, and stale responses cannot seed the new target. Transcript probing executes on the target, within that host's provider roots; caller source paths do not grant reachability. Full is available only on positive target-side evidence, otherwise Focused plus bounded capture/reason. Missing/ambiguous/unavailable targets and replaced instances block Start. Local target/create behavior remains unchanged.

### S6: Cross-host reviewed delivery and lineage
Before: source stays live, editable brief includes a potential secret, destination is another execution host. Walkthrough: edit/detach preview, inspect host-change and secret warnings, Start; inspect both lineage ends and retry state. After: target launch uses its verified host/workspace instance and exact enabled agent; only the reviewed body plus locked untrusted-reference notice is delivered through that target's existing readiness/delivery mechanism. Source is not stopped or typed into. Revalidate target/agent before launch; source changes require re-review as today. Failure preserves draft and reports delivery uncertainty without duplicate automatic resend; explicit resend remains tied to the original target. Parent and child lineage include execution-host identities so same provider/session/worktree IDs on different hosts cannot match or jump locally. Cross-host secret scan warns without pretending to be a security boundary.

### S7: Authority and defect boundaries
Replay old owner/grant/generation/mirror/instance after registration replacement or remote daemon restart; supply a phone-scoped saved target; reuse identical path/provider/session IDs on the wrong host. Every operation refuses before side effects, never silently resolves locally. Preserve Orca-defect protections: stale target detection ignored; unreadable transcript is unverifiable not missing; source retained on launch/delivery failure; uncertain delivery never falsely reported delivered; local-first enable-all partial availability; remote paths/commands redacted; unknown search scope never widens; browser-only remote login not launched locally; usage matches its actual selected account/host.

## Decisions Locked
- **UI:** existing panels/dialogs and exact-window focus; explicit host/error/loading labels; no incompatible stale-host display; preserve edits and selected identity through errors.
- **API/auth:** canonical full-owner grants plus both pins; exact workspace instance; server-owned source lookup; no caller-path or synthetic contribution authority.
- **CLI:** existing generated feature groups; schema-declared host/workspace arguments; existing error envelopes and redacted JSON results.
- **Data/integration:** opaque host-qualified source IDs and lineage; opt-in index; local-first sequential enable-all; no local fallback, destructive replay or uncertain automatic resend.
- **Platform:** macOS product target, runner-controlled test placement; native outcomes separately identified.

## Industry Insights
No external research swarm: feature docs, roadmap and binding predecessor decisions supply the required product behavior and supported owner contract. Current source maps confirm the prerequisite is implemented; test forwarders are not production composition.

## Deferred Ideas
None added. Explicit excluded flows remain with their existing owners; this item must not create a test/review/debug successor.

## Glossary
- **Owner binding:** registered host ID, producer generation and saved runtime/grant pin captured for a feature operation.
- **Mirror:** canonical registered projection, not a local worktree or credential.
- **Instance fence:** producer filesystem-instance identity of the selected canonical workspace.
- **Host-qualified source:** opaque source identity with its authenticated execution-host binding, not a file path.
- **Full owner:** owner-cli scope, distinct from phone and worker federation.
