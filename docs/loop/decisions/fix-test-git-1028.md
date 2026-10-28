# fix-test-git-1028 decisions

## D1: Repair the entire assigned Git failure inventory at its consumer boundary
- **Question:** Which failures and workflow belong to this end-phase fix?
- **Options:** rerun the reported baseline; repin presentation/default/catalog copies; diagnose the evidence and repair consumer behavior and meaningful regression coverage.
- **Chose:** Treat baseline failures as ground truth, trace each assigned file, delete incidental assertions rather than repinning them, and retain acceptance checks for actual actions, ownership, refusal, persistence and state transitions.
- **Why:** The end-phase item names the entire plugins/quirky.git group; no flow may be silently discarded. Fix items skip brainstorming and specifications.
- **Evidence:** docs/loop/reports/m7-test-triage.json groups.plugins/quirky.git; complete compressed transcript; authoritative build/roadmap:docs/loop/LOOP.md Fix items and The end phase.
- **Reversibility:** easy (repair scope and test ownership)
- **Confidence:** high
- **Revisit if:** root-cause evidence identifies a separately owned upstream change.
- **Source:** locked by docs/loop/LOOP.md

## D2: Use the canonical test host and isolated runtime ownership
- **Question:** Where may verification run, and what state may it touch?
- **Options:** direct local suites against inherited state; canonical suite runner with its remote placement and explicit native exceptions, fresh temporary runtime homes.
- **Chose:** All test commands use bun scripts/suite.ts <paths>, retaining the runner's macOS exceptions. Real CLI/API smoke uses fresh HOME/QUIRKY_HOME and owned process cleanup. Preserve unrelated .quirk/.serena files. No asks, authentication changes, or real provider launches.
- **Why:** Prior operator instruction forbids competing local suite load and LOOP forbids real-state mutation. Existing agent-status hooks manifest correction is inherited; do not create a compatibility alias for its historical missing setting.
- **Evidence:** docs/loop/decisions/fix-test-agent-status-1028.md D4,D7; scripts/suite.ts:8-19,96-117; docs/loop/LOOP.md Hard rules.
- **Reversibility:** easy (execution placement only)
- **Confidence:** high
- **Revisit if:** the authoritative execution policy changes.
- **Source:** locked by docs/loop/decisions/fix-test-agent-status-1028.md D7

## D3: Partition three disjoint repair slices without changing public contracts
- **Question:** Which execution, ownership, backend and specification choices apply to this fix?
- **Options:** one broad worker; concurrent edits to shared UI files; three isolated slices with a single integration owner.
- **Chose:** One parallel wave of three omp task implementers: daemon/pure/scenarios (src/daemon, test/pure, test/scenarios, plugin manifest/CLI); window integration (test/window only); component UI (other src UI and test/ui plus test/ui.test.ts). Parent owns docs, integration and verification. Existing public API signatures and shared types remain the contract; no new schema/type/API is planned. Fix items skip new specs. Workers do not commit or run checks mid-flight.
- **Why:** All 25 reported files fit these scopes without overlap; shared fixture corrections can repair multiple consumer scenarios without changing product semantics. Window owner requests production changes from the component owner through the parent. External temporary worktrees avoid inherited unrelated files.
- **Evidence:** read-only GitFailureMap inventory; exact triage assertion diffs; docs/loop/LOOP.md Fix items; source fixture locations in scout handoff.
- **Reversibility:** easy (ownership only)
- **Confidence:** high
- **Revisit if:** diagnosis requires an overlapping or upstream file; amend ownership explicitly before writing.
- **Source:** assumed — autonomous

## D4: Use the reachable cross-family reviewer without authentication changes
- **Question:** Which model pairing can execute the required final review unattended?
- **Options:** omp task implementers with opus; next reachable cross-family alias; same-family fallback.
- **Chose:** OpenAI omp task implementers and Gemini google/gemini-3.1-pro-preview:high reviewer. One final review round and one accepted-finding fix batch as LOOP requires.
- **Why:** pi-watch full preflight found opus unavailable (0/8), sonnet unavailable (0/6), Gemini reachable. LSP status found no configured servers, so reference searches fall back to existing source tools.
- **Evidence:** this iteration's pi-watch --check and xd://lsp status output; /tmp/quirky-git26-p2p11C/journal.json.
- **Reversibility:** easy (review backend only)
- **Confidence:** high
- **Revisit if:** the selected reviewer actually fails dispatch.
- **Source:** assumed — autonomous

## Progress
Claimed exactly one item on lane 1 and created build/fix-test-git-1028 from current build/roadmap. Baseline triage inventory and exact error excerpts read; read-only scout is mapping all failures before ownership slices are dispatched. No baseline tests rerun and no implementation edits yet. Next: commit ownership decisions/contracts, implement independent repairs, run affected canonical suite and scripts/typecheck plus actual public runtime smoke, perform one bounded cross-family review, catch up and land through canonical absolute queue path.
