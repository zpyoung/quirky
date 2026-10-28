# m7-vm-and-owner-bound-host-workspaces decisions

## D1: Preserve genuine VM and owner boundaries
- **Question:** Which inherited purpose, consumers, success criteria and exclusions govern autonomous brainstorming?
- **Options:** Treat remote results as mirrors; use local shell tabs as VMs; build actual lifecycle and authenticated owner bindings.
- **Chose:** Combined spec scenarios 1–7, real Lima backend, separate registered remote mirrors, same-connection authenticated host-generation and workspace-instance fencing.
- **Why:** Predecessor D4/D15 expressly retains these unbuilt flows; missing installed executables alone is not source infeasibility. Remote source paths and UI UUIDs are not host identity.
- **Evidence:** predecessor decisions D2,D4,D6,D7,D15; worktrees.md hooks/host duplicates; cli.md Hosts and servers; scout MapVmOwnerContracts.
- **Reversibility:** medium
- **Confidence:** high for required boundary
- **Revisit if:** Source integration cannot preserve exact guest/owner execution authority.
- **Source:** locked by docs/roadmap.md and predecessor decisions

## D2: Select API, identity, trust and lifecycle gray-area defaults autonomously
- **Question:** How do API/authentication, CLI/output, identity mapping, sync/conflict, errors and VM attachment gray areas resolve?
- **Options:** Duplicate crypto/transport; infer labels/local paths; reuse existing owner transport with explicit identity and conservative failure.
- **Chose:** Existing owner-cli saved grants; remotely generated durable host UUID plus fresh activation generation; owner-qualified mirror records; fresh instance/fingerprint evidence for mutations; explicit confirmations; no destructive replay. Full recipe hash trust, verified Lima backend and guest owner attachment, durable failed/interrupted operations, no fallback to local worktree execution. Existing generated plugin CLI and structured errors.
- **Why:** These defaults preserve actual observable owner authority and make unknown/offline distinct from safe/inactive. Recipe source is trusted executable provisioning configuration, not a terminal template.
- **Evidence:** combined logic spec Decisions locked and scenarios 1–6; protocol runtime-owner.ts; CLI main.ts55–108; worktree create.ts265–287.
- **Reversibility:** hard
- **Confidence:** medium pending implementation and bounded smoke
- **Revisit if:** Real backend output or existing public API cannot express a required attachment safely.
- **Source:** assumed — autonomous

## D3: Apply autonomous contract-first build-first execution
- **Question:** Which skill gates, implementation pairing and review/testing policy apply unattended?
- **Options:** Human prompts/swarms/reviews/suites; skip source evidence; contract-first isolated omp components with narrow parent verification.
- **Chose:** Combined self-reviewed markdown spec and shared protocol committed first. Three isolated omp task implementers at most, AUTHOR_FAMILY=openai; Opus is eventual review preference but no formal review or availability claim under build-first. Parent owns integration hubs and migrations; no overlapping component scope. Workers skip all builds/tests/lint/formatters. Parent runs required changed-path smoke and root typecheck, catches up once before landing. No separate tech.md, asks, research swarm, dogfood campaign or suite.
- **Why:** Canonical LOOP overrides skill human/test/review gates. Developer requires significant changed-path runtime evidence. LSP reports no configured servers.
- **Evidence:** git show build/roadmap:docs/loop/LOOP.md; xd://lsp status; combined spec Technical decisions.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** End phase begins or authoritative LOOP changes.
- **Source:** locked by docs/loop/LOOP.md

## D4: Keep platform and native prerequisites separate from reachable source
- **Question:** Do absent VM binaries, notification callbacks or production signing justify claiming success or blocking all source work?
- **Options:** Fabricate lifecycle/delivery; block all source; implement core while preserving exact external prerequisites.
- **Chose:** Lima is an explicit external dependency with doctor/preflight; source implementation proceeds. No native notification permission/click/dismiss or signed terminal-host launchd/TCC/admission/upgrade claim without supported SDK and authorized packaging identity. Linux/Windows host work unclaimed. Existing automation/browser owners remain canonical.
- **Why:** Prior actual inventory reports absent callbacks and zero valid signing identities; these are independent of reachable VM/host source engineering. No new credential was supplied and those observations are not rerun.
- **Evidence:** predecessor D6,D15; m7-terminal-provider-host-and-worktree-remainder D6,D8; packages/protocol/src/desktop-capabilities.ts.
- **Reversibility:** medium
- **Confidence:** high for inherited prerequisites
- **Revisit if:** Supported callbacks, authorized signing identity or platform scope changes.
- **Source:** deferred: platform

## Progress
Claimed lane6 on build/m7-vm-and-owner-bound-host-workspaces from build/roadmap. Requirements, locked roadmap/architecture and predecessor decisions read; source scout returned. Combined logic/technical spec self-reviewed, shared OwnerHostIdentity/RegisteredOwnerHost and expectedHost forwarding contract prepared. Next: commit contracts/spec and dispatch disjoint CLI-owner, remote-workspace and VM components, integrate their hubs, then narrow isolated runtime smoke/typecheck, single roadmap catch-up, record disposition and canonical land.
