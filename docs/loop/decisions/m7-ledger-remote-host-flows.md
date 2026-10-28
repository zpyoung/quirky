# m7-ledger-remote-host-flows decisions

## D1: Block on missing public host authority
- **Question:** Can SSH ledger ownership, routing, import, evidence and selected-runtime availability use the current public API?
- **Options:** consume shared host authority; implement ledger-private SSH routing; block until the named prerequisite lands.
- **Chose:** block before specification or implementation; do not add speculative contracts.
- **Why:** Public Repo and Worktree records contain local paths, with no execution-host registration/incarnation identity. PluginContext provides no host registry or generation-fenced remote filesystem/execution service. A remote-looking origin URL is repository equivalence metadata, not authority to read a host. The claimed item explicitly requires blocking when this prerequisite is absent.
- **Evidence:** packages/protocol/src/plugins.ts:50-129; packages/protocol/src/model.ts:5-17,77-117; plugins/quirky.ledger/src/daemon/owners.ts:7-48,135-169; docs/loop/decisions/m7-sweep-automation-completion.md D4,D10; read-only manifest probe on 2026-10-28 enumerated 29 built-ins and 644 declared methods and printed the repo/worktree/creation/checks/structured/ledger parameter contracts.
- **Reversibility:** easy (resume after the public foundation lands)
- **Confidence:** high for checked-out declarations and source; no SSH runtime behavior claimed
- **Revisit if:** public host registration/incarnation lookup, remote repo/workspace identity and generation-fenced filesystem/execution owners land.
- **Source:** locked by docs/loop/decisions/m7-sweep-automation-completion.md D4,D10

## D2: Never interpret remote scope as a local filesystem root
- **Question:** How should Data/Integration gray areas resolve when the selected SSH host is unavailable or its registration changes?
- **Options:** local fallback; synthetic ledger generations and cached remote identity; authoritative host-bound routing with explicit unavailability until supported.
- **Chose:** preserve current local ledger behavior unchanged; no local SSH-path reads, synthetic host generations, fallback, source mutation or automatic remote retries. Future routing must retain authoritative source identity, existing import anchors/conflict/tombstone semantics and advisory-only evidence.
- **Why:** Ledger currently selects roots from local repo/worktree catalogs, normalizes with local canonical paths, imports with local filesystem reads and checks evidence with local fileExistsSafely. Passing SSH roots to those operations would inspect unrelated local state. The internal catalog reconciliation counter is not a remote host incarnation fence. Missing files never prove resolution.
- **Evidence:** plugins/quirky.ledger/src/daemon/content.ts:32-40,89-104; imports.ts:195-250; engine.ts:130-160,213-240,740-784; external ledger.md Import, Review and Edge cases; m5-ledger D8.
- **Reversibility:** hard (durable origin/import identity must not be fabricated)
- **Confidence:** high
- **Revisit if:** a public host-bound filesystem service supplies current identity and fences every read/result.
- **Source:** locked by docs/loop/decisions/m5-ledger.md D8

## D3: Keep the remote ledger flow whole and preserve existing owners
- **Question:** Can an independently complete flow ship from this follow-up while its shared host prerequisite is missing?
- **Options:** metadata-only remote selectors; re-deliver already shipped local behavior; block this remote-only item without queue duplication.
- **Chose:** block the whole item; add no follow-up, partial implementation, private transport or duplicate automation owner.
- **Why:** All requested new behavior depends on the absent host authority. Independent local ledger behavior already exists. Mobile client admission and host-power lifecycle are not SSH execution-host registration; structured session incarnations fence sessions, not remote filesystems. OpenClaw external-action host/generation fields explicitly support only local authority. Existing remote automation dispatch remains its separately blocked owner.
- **Evidence:** packages/protocol/src/plugins.ts:86-129; executable probe's structured send/stop, automations externalList/externalAction and Heimdall command declarations; docs/loop/decisions/m5-automations-dispatch.md D3; docs/loop/decisions/m5-automations-dispatch-remote-and-args.md D1,D3.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** shared public host execution and registration contracts become available.
- **Source:** assumed — autonomous

## D4: Resolve unattended design defaults and stop at feasibility
- **Question:** Which brainstorming questions and workflow gates apply to this prerequisite-blocked item?
- **Options:** ask a person; invent API contracts and dispatch implementers; investigate the required contracts and record the block.
- **Chose:** API/CLI/Data/Integration scope. Preserve current authenticated JSON/error/CLI surfaces, revision guards, stable owner/source mapping, import idempotency and explicit availability. No UI redesign, raw SSH command transport, local fallback or remote automation expansion. Purpose is safe selected-host ledger access for agents and people; success requires actual remote ownership/import/evidence on that host with stale registration rejection. No visual/adhd offer, external research swarm, speculative spec, contracts, implementers or review.
- **Why:** The feature doc, roadmap and earlier decisions establish purpose, consumers, success criteria, hard constraints, scope and primary behavior. LOOP.md forbids human asks and requires blocking this unavailable prerequisite rather than misleading scaffolding. API/Integration defaults are authoritative mapping and explicit unavailable/stale-owner errors; Data defaults preserve partial import truth and no overwrite/resurrection. Every newly requested flow remains unbuilt, not passed.
- **Evidence:** authoritative git show build/roadmap:docs/loop/LOOP.md; docs/roadmap.md:19-38,43-53,211-212; external /Users/zpyoung/PycharmProjects/PERSONAL/quirky/research/orca-features/ledger.md:35-46,177-189,211-225; LedgerHostPrereqs read-only scout; bun /tmp/quirky-ledger-host.p7Hr6n/inspect.ts exited 0.
- **Reversibility:** easy
- **Confidence:** high for inspected contracts only
- **Revisit if:** the item resumes with the missing public foundation implemented.
- **Source:** locked by docs/loop/LOOP.md

## Progress
Blocked at step 3 prerequisite/feasibility research, before spec or implementation. Only this decision log changes the branch; no product code, tests, schema, runtime or user state changes. Read-only executable inspection completed successfully; broad candidate matches were inspected as session-incarnation guards, local-only OpenClaw actions, Heimdall control metadata or unrelated text, not falsely treated as absent results. No tests, typecheck, build, daemon launch, review or dogfood pass is claimed. The scout has returned. Commit this log, rename build/m7-ledger-remote-host-flows to blocked/m7-ledger-remote-host-flows, detach and invoke the canonical absolute queue.ts block command with the external evidence entry. End the iteration after that single block; do not claim another item or print LOOP_BLOCKED unless queue.ts wait itself returns stuck. Resume after the public prerequisite lands.
