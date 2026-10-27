# Project ledger

Reader: feature reviewer — Decision: whether the complete ledger behavior matches the roadmap and feature evidence.

## Status & amendments

Status: Autonomous design approved under docs/loop/LOOP.md; Tech spec: requested. One Codex promote/refute review completed; confirmed findings corrected and prepass false positives recorded in the decision log.

Amendments: 2026-10-27 — specify stable identity equivalence/stickiness and plugin-scoped runtime/profile labels after Codex review; clarify that only standard dispatcher confirmation or explicit yes authorizes irreversible calls.

## Purpose

A ledger is a durable typed record of engineering observations, owned by one project or project group rather than a checkout. Sibling worktrees share their project ledger; origin metadata permits worktree-specific views. Removing a workspace never removes its observations. Removing an owner detaches its ledger, preserving bodies and history for reading, attachment or explicit deletion.

Entries are bugs, deferred work, test gaps, proposals or decisions. Each has a ledger-wide monotonic sequence, an immutable type, state, reviewed flag, revision and append-only successful-change history. Edits require the revision the caller read. A stale writer receives a conflict, never an automatic overwrite.

## Scope & non-goals

All flows in `/Users/zpyoung/PycharmProjects/PERSONAL/quirky/research/orca-features/ledger.md` are in scope: CLI, panel, chooser/page, detail/form, triage/bulk, settings, retention, attach, import and evidence. Quirky uses its unified local authenticated API instead of Orca-specific IPC, compatibility envelopes, profile files or UI HMAC attestation. No new SSH/paired-runtime transport, hierarchical group model, native-only surface, network service, automatic resolution, or unrelated Heimdall ledger is introduced. Existing owner catalogs define eligible groups; a flat catalog has a one-element membership chain. Existing runtime routing remains authoritative.

## Key decisions & rationale

Use the public plugin store rather than standalone JSON files: it supplies migrations and atomic writes while preserving the locked plugin data boundary. Normalize ledger, entry, history and anchor records instead of rewriting every entry/history on each change. JSON content/history snapshots remain typed payloads inside those records.

Ledger project identities must survive re-add: derive a stable codebase key from a normalized origin remote when present, otherwise canonical repository root. Only a unique live match can auto-reattach. Groups retain their catalog identity and never auto-reattach to another group. Explicit project attachment asserts codebase equivalence and refuses import-anchor collisions.

Equivalent SSH/scp/HTTPS URLs for the same host/repository identify the same codebase: ignore credentials/transport/default ports, lowercase host, strip trailing slash and `.git`; preserve repository path case except on github.com. Nondefault ports remain distinct. Local remotes use canonical absolute paths. Once a live repo is mapped, remote changes do not silently move its ledger; deliberate attachment changes ownership. Runtime/profile labels identify the ledger plugin activation and persistent plugin store, not nonexistent global Orca profile identifiers.

Expose every operation to authenticated agents and people, including approve, settings, detached edits and deletion; do not preserve Orca's UI-only bans. Record caller-derived provenance honestly. Content/state changes from UI callers mark reviewed; other callers reset reviewed. Approval changes history/revision but not latest content actor. Irreversible deletion/attachment and bulk state changes use standard confirmation, with explicit `--yes` bypass for scripts.

## Decisions Locked

- Targeting: cwd/workspace defaults to its project; group selects membership; explicit owner selects a live project/group; direct ledger selection reaches detached ledgers. Conflicting selectors fail.
- Responses: use Quirky's existing JSON/CLI envelope, stable domain error identifiers and current revision on conflicts; import with skipped records exits 1 while preserving its successful result.
- Revision semantics: no-op edits/state do not bump; revert restores known editable content/state as a new revision, retains extra legacy fields, and follows actor/review rules.
- Ownership: records are outside checkouts; lifecycle reconciliation happens on startup/catalog change and before requests, fixing Orca's delayed re-add recovery.
- Imports: explicit source identity plus last imported baseline; no source writes, no external-file dereference, tombstones prevent resurrection.
- UI: chooser, full view, right panel, owner-menu links and repository staleness settings; no default shortcut; action footer remains reachable in a constrained viewport.
- All defaults are autonomous under LOOP.md, not human sign-off. Authoritative feature constants remain unchanged: 90 stale days; strict age comparison; 0.6 title overlap; maximum 10,000 selections; stale days 0–3650.

## Data flow

A caller selects a managed workspace, owner or ledger. The plugin reads the owner catalog through public methods, reconciles ownership, normalizes host observations and validates the request. One synchronous store transaction validates revision preconditions and commits each mutation with its history. Changed events refresh visible ledger clients; generation fencing discards responses for obsolete targets. Review adds filesystem/git evidence without changing records. Import reads local legacy records and applies each independently through stored anchors; one skip does not undo earlier imports.

## Behavior & acceptance scenarios

Every scenario must have a real daemon API or CLI acceptance test; UI scenarios also require the built web-app unattended smoke run. Tests use fresh temporary QUIRKY_HOME and clean up their processes.

### SC-01: File every type, validate, and share a project ledger

Given sibling worktrees and no ledger, reads are empty without creating one. Filing each of the five types requires its documented nonblank fields and valid enums; bugs/test gaps require a scoped location. File creates on demand, starts open/unreviewed at revision 1, snapshots origin and returns advisory duplicates. Sequence is shared across types and never reused.

- Data before: **Project Alpha** has no ledger; two worktrees belong to it.
- Walkthrough: an agent files a high-severity bug in one worktree, then deferred work in its sibling; another caller lists the project.
- Data after: **Project Alpha ledger** contains `bug-1` and `deferred-2`, both r1; both worktrees see both records. A blank title or invalid severity is rejected without a new record.

### SC-02: Resolve targets and normalize locations

Default cwd, current/active aliases and explicit workspace resolve the correct managed worktree. Group/group-selector chooses eligible membership by exact id or unique name; missing/ambiguous scope fails with eligible choices. Folder workspaces target their group; standalone folders have no project ledger. Direct ledger reads work when detached. Conflicting target selectors, unmanaged cwd, missing workspaces and unavailable host fail explicitly. Normalize inside-root absolute/relative paths; parse positive safe line numbers; outside paths are external with host; historical structured locations remain editable unchanged.

- Data before: **Workspace Alpha** belongs to **Group Tools**; **Workspace Folder** has no group.
- Walkthrough: caller chooses Tools by id and files `src/../src/x.ts:42`; caller attempts group selection on Folder.
- Data after: **Tools ledger entry** stores scoped `src/x.ts`, line 42; Folder request fails `group-missing`. External paths require a host and are never read during triage.

### SC-03: List, show, filter, search and sort

List supports type/state/reviewed/stale/origin workspace/origin branch. Show returns full history and latest content actor. UI search matches title or id; sorting is newest activity, sequence or title. Stale means strictly older than the per-ledger threshold. A read of a missing entry fails not-found; empty reads do not allocate a ledger.

- Data before: **bug-1** is open/unreviewed; **deferred-2** is resolved/reviewed.
- Walkthrough: list open bugs, then show bug-1; search `bug-1` in the UI.
- Data after: only **bug-1** matches; show includes r1 and its creation history; no revisions change.

### SC-04: Optimistic edits, transitions and revert

Edit requires at least one content field and merges/revalidates the full content. Every state can transition to every state. Revert selects a historical revision and restores editable content/state as a new change. No-ops do not advance counters. Stale revisions reject with currentRevision and no partial history. Concurrent writers using the same revision have one winner.

- Data before: **bug-1** r1, severity high, state open.
- Walkthrough: edit severity critical at r1; resolve at r2; revert to r1 at r3; retry old r1 edit.
- Data after: **bug-1** r4, severity high/open, history r1–r4; last request conflicts with currentRevision 4. A same-content edit at r4 stays r4.

### SC-05: Provenance and review approval

Authenticated caller context supplies actor information; arbitrary human/agent claims are not trusted. UI content/state edits mark reviewed, non-UI changes reset it. Approve uses immutable id/revision selections and adds a revision only where reviewed changes; it never changes latest content actor. No-op state does not approve.

- Data before: **bug-1** r1 unreviewed, latest content actor unknown.
- Walkthrough: approve at r1, then an agent edits title at r2.
- Data after: **bug-1** r3 unreviewed; approval r2 recorded separately; latest content actor follows the content edit, not the approval.

### SC-06: Atomic bulk operations and confirmations

Approve, bulk-state and delete-entries reject duplicate/stale selections before any write. Bulk state, deletion, attachment and ledger deletion require confirmation or explicit script consent. Confirmation displays immutable ids/revisions/titles; conflicts reload and require renewed consent. Same-state selections are skipped. Deletion preserves import tombstones and never reuses sequence numbers. Delete-ledger requires its current ledger revision and removes all its persisted records/history.

- Data before: **bug-1** r2 and **deferred-2** r1 selected.
- Walkthrough: submit a bulk resolve using bug-1 r1; then submit correct revisions with explicit consent.
- Data after: first request writes nothing; second resolves both atomically. Deletion with no consent changes neither entry.

### SC-07: Advisory review evidence and ordering

Review never mutates or auto-resolves. Rank unreviewed stale, unreviewed fresh, reviewed stale, reviewed fresh; unknown actor first within bands, then oldest activity/sequence. Evidence reports originating workspace availability, baseline/current git revisions and safe file presence. External, missing or outside-scope files get explicit unavailable notes, not a guessed resolution.

- Data before: **bug-1** records baseline A and a local file; **bug-2** references an external host.
- Walkthrough: request review after the local file is removed.
- Data after: candidates retain state/revisions; bug-1 evidence says absent, bug-2 says external locations are not dereferenced; neither is resolved.

### SC-08: Legacy formats and partial failures

Import reads BUGS.md, DEFERRED.md, TEST_BACKLOG.md, proposals.md and non-directory docs/adr/*.md. Support pipe tables, heading records with plain/bullet/bold labels, legacy ids and ADR frontmatter/sections. Required fields and enums remain type-specific; extra legacy fields survive. Missing source files are silent; invalid/missing ids, required fields, bad enums, read errors and duplicated anchors are skips. All copies of a duplicate anchor are skipped. Empty import creates no ledger. Never modify sources.

- Data before: **BUGS.md** has valid BUG-12 plus a malformed row; **ADR 001** is a valid decision.
- Walkthrough: run ledger import in its worktree.
- Data after: two typed entries created; malformed row reported skipped; CLI exits 1 with successful import details; source bytes unchanged.

### SC-09: Idempotent import, conflicts and tombstones

Anchor identity includes source base kind/id/host, source path and explicit legacy id. Unchanged source is already-present; changed source updates only when current ledger content still equals its prior imported baseline. Ledger edits produce a conflict skip. Deleting an imported entry leaves a tombstone; re-import never resurrects it. Independent records commit independently, including after a failed record.

- Data before: **BUG-12 anchor** points to **bug-1**, imported baseline title Old.
- Walkthrough: import unchanged; edit source title New and import; edit ledger title Local and source title Newer and import; delete ledger entry and import again.
- Data after: unchanged is already-present; source-only change increments revision; local edit is preserved with conflict skip; deletion remains deleted.

### SC-10: Staleness settings and durable restart

Per-ledger integer days default 90, range 0–3650, guarded by ledger revision and logged in metadata history. No global setting. No-ledger settings surface explains filing first. Restart preserves entries, histories, sequence, settings, anchors and detach state; malformed persisted payloads make the ledger service explicitly unavailable without replacing data.

- Data before: **Alpha ledger** revision 2, stale days 90.
- Walkthrough: set days 0 at ledger r2; restart daemon; list immediately and after time advances.
- Data after: settings remain 0; strict staleness boundary is honored; a stale metadata revision conflicts.

### SC-11: Owner removal, retention and eager recovery

Project/group removal dialogs report retained entry/ledger counts. Removal preview includes immutable ledger revisions and stale supplied previews fail before owner removal. Worktree deletion retains its project ledger and original origin snapshot. Owner removal detaches records with metadata history; chooser/direct ledger read remains available. Re-add of the same uniquely identified project automatically restores the same ledger/sequence on catalog reconciliation, without a mutation trigger. Group deletion never attaches to a namesake automatically. Catalog failure is explicit until reconciliation succeeds.

- Data before: **Alpha ledger** contains bug-1 and remembers its stable codebase identity.
- Walkthrough: preview/remove Alpha; read its detached ledger; re-add the same project, then only list.
- Data after: the same ledger and bug-1 are attached before that read; filing later continues sequence 2. A different group with the same name does not claim a detached group ledger.

### SC-12: Explicit detached attachment

Catalog lists attached/detached ledgers. Attach is revision-guarded, confirmed, same-tier, and targets a live owner with no ledger. Cross-project attachment records source equivalence; reject canonical import-anchor collisions before writes. Detached ledgers can be read and mutated through the unified authenticated API.

- Data before: **Detached project ledger** former owner Old; **Project New** has no ledger.
- Walkthrough: confirm attachment at its current ledger revision.
- Data after: owner New, former owner retained in metadata history, equivalence Old/New recorded; subsequent duplicate/import matching uses that equivalence. Attachment to an occupied owner fails.

### SC-13: Panel entry points, scopes and states

Right sidebar Ledger panel follows active workspace. Refresh, Triage and New are accessible. Worktree/Folder, Project (git only), Group (membership only) tabs implement the documented scope filters, owner label and Filed here badges. Include search, type/state/review/freshness filters and row detail. Show no-workspace/loading/empty/no-group/missing-workspace/missing-owner/ambiguous/error Retry states. Refresh spinner waits 200 ms. Discard obsolete responses after target changes; events refresh visible views.

- Screen states: no workspace shows “Open a workspace to see its ledger.”; empty scoped result shows “No entries match this view.” and New entry; error exposes Retry. Worktree scope shows only that workspace's origin entries.

### SC-14: Chooser, full page and owner menu navigation

Left sidebar Ledger opens “Open ledger” with attached/detached catalog. Unbound Open Ledger command and project/group “Open ledger” menus open the same full-page view. Owner page heading is its name; summary shows tier/count/ledger revision and runtime identity. Full page includes refresh, triage, new, settings, delete, search/all filters/origin filters/sort, selection/bulk controls and per-row edit/review/delete. Detached view exposes attachment owner selection. Every navigation/control command has a routed API equivalent and reported state.

- Screen states: chooser row “Alpha, Project · 2 entries”; open shows “Alpha”, not “Alpha ledger”. Detached chooser rows identify their tier and retained count.

### SC-15: Typed entry forms and historical bases

Create offers all five types and type-specific required fields; edit locks type and shows source revision. Location inputs include path/positive line/base/external checkbox and required host. Historical unchanged bases remain selectable. Validate required strings/enums/line/host visibly. Save uses the captured revision; conflicts show the current revision without silently retrying. Show advisory duplicate entries after create.

- Data before: **bug-1** r1, high severity.
- Walkthrough: open edit, change title, another caller edits first, then save.
- Data after: stale form receives conflict; other caller's data remains. Creating with blank external host displays “External host is required”.

### SC-16: Detail history and reachable action footer

Detail shows sequence/revision/time, origin, scoped content, latest actor and complete before/after history with changed fields. Edit, Review, all state actions, revert revision selector and Close remain reachable with a long history at 1452×1050 and at a smaller viewport. Body scrolls independently and footer is pinned; current state action is disabled. Detail actions use the same API and revision semantics.

- Screen states: long detail body scrolls while Edit/Review/state/Revert/Close remain visible and usable. This is the regression test for Orca's clipped non-scrollable footer.

### SC-17: Triage and settings UI

Triage displays advisory text, reason/staleness/evidence, immutable selection snapshots, approval counts and confirmed bulk resolve/archive. Conflict refreshes candidates and states that revisions changed. Ledger settings opens owning repository settings with Ledger Staleness, Save/Saved and the no-ledger explanation. Per-row review and selection bulk controls share the same API behavior.

- Data before: **bug-1** r1 unreviewed.
- Walkthrough: triage selects/approves it, then sets staleness in project settings.
- Data after: **bug-1** r2 reviewed, latest content actor unchanged; threshold persists with metadata history.

## Industry Insights

- Revision preconditions prevent lost updates; never retry a stale edit invisibly ([RFC 9110 If-Match](https://www.rfc-editor.org/rfc/rfc9110#section-13.1.1)).
- Validate all selections and commit state/history in one transaction ([SQLite transactions](https://www.sqlite.org/lang_transaction.html), [atomic commit](https://sqlite.org/atomiccommit.html)).
- Retain import identities and deleted markers to make replay safe ([AWS idempotency](https://docs.aws.amazon.com/durable-execution/patterns/best-practices/idempotency/), [S3 delete markers](https://docs.aws.amazon.com/AmazonS3/latest/userguide/DeleteMarker.html)).
- Distinguish writer, initiator and evidence; provenance is not proof of resolution ([W3C PROV-O](https://www.w3.org/TR/prov-o/)).
- Canonicalize source/evidence paths before dereferencing, since normalized text alone does not contain symlinks ([Node fs.realpath](https://nodejs.org/api/fs.html#fspromisesrealpathpath-options)).

## Deferred Ideas

None — implementation mechanics belong to tech.md; remote transport expansion and hierarchical groups are separate features, not ledger behavior changes.

## Glossary

- Project: a codebase represented by the public repository catalog, not one worktree.
- Origin: immutable workspace/branch/host/baseline snapshot at filing.
- Revision: monotonic accepted-change counter; ledger and entry counters are distinct.
- Anchor: stable legacy source identity plus imported baseline and deletion state.
- Detached: no live owner, with content retained and former owner recorded.
- Approval: reviewed-only mutation, not a content edit or automatic resolution.
