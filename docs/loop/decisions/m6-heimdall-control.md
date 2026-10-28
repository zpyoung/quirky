# m6-heimdall-control decisions

## D1: Ship controls and fleet together on the core plugin
- **Question:** scope, purpose, consumers and approach during brainstorming
- **Options:** separate private-import controls plugin; daemon-native UI; operator layer in quirky.heimdall
- **Chose:** operator layer in the built-in plugin, public methods/CLI/UI; no second store. Include all ten commands and fleet/detail page; no New objective sheet, owner runtime, concrete kind algorithms, leases or remote mirrors.
- **Why:** queue combines both feature slices; roadmap orders the core before its controls/kinds. UI/CLI must share authority and outcomes.
- **Evidence:** heimdall.md Act on a watcher/Command results/Read the fleet; docs/roadmap.md:216-228; m6-heimdall-core D1/D3
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** core contract cannot safely fence commands
- **Source:** locked by docs/loop/queue.json

## D2: Resolve observable gray areas with the source defaults
- **Question:** brainstorming layout/density/loading/empty/error/interaction; API errors/authority/idempotency; CLI flags/output/exits; integration conflict/recovery
- **Options:** ask a person; choose arbitrary new UX; use documented outcomes and existing public conventions
- **Chose:** every area selected and source defaults accepted. Exact fleet column/sort/bucket semantics; retained last snapshot/error banner; confirmation leaves workers running; exact approval scope and optimistic fence; budget zero/null; cap1..1024/folder1; specific refusals and indeterminate outcomes; CLI source names; bare JSON debug. No retry after uncertain effect. Reasons remain visible without cards, including operator edits/rejected plan.
- **Why:** unattended loop requires autonomous answers; supplied doc establishes primary flows and both defects. Logic spec AC1..9 covers outcomes and boundaries; self-reviewed against each included source section.
- **Evidence:** external heimdall.md:18-64,229-271,277-289,335-338; logic.md Decisions locked
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** supplied kind projection cannot provide a reason
- **Source:** locked by docs/loop/LOOP.md

## D3: Night mode uses one combined specification and a three-component wave
- **Question:** spec format/reviews, execution and backend preflight
- **Options:** normal two-spec multi-review pipeline; current night-mode override
- **Chose:** markdown logic.md with technical section; no research swarms, companion/adhd/human gates or separate spec review. Contracts committed first. IMPLEMENTER=omp-task, AUTHOR_FAMILY=openai, REVIEWER_ALIAS=gemini. Cap3, one wave, disjoint controls, API/CLI/fleet and UI files; parent owns integration. No mid-flight builds/tests/formatters; parent runs checks at barrier. One final cross-family review and blocking fix batch.
- **Why:** current LOOP night mode overrides normal skill phases. pi-watch --check resolved Gemini google/gemini-3.1-pro-preview:high; Opus/Sonnet unavailable. Codex/Terra/Flash available. Untracked .serena/ is inherited tool state, excluded from commits/work scopes rather than removed.
- **Evidence:** current LOOP Night mode; actual pi-watch --check output exit5 (7/12 ready); initial git status detached with only .serena/
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** real reviewer dispatch fails
- **Source:** assumed — autonomous

## D4: Keep remote and worker authority honest
- **Question:** local core versus source fleet transport and worker controls
- **Options:** simulate remote support or process identity; refuse unsupported/unknown authority
- **Chose:** local fleet only; foreign connection/owner refused. Worker stop/answers use public orchestration service authority, exact identities and real outcomes. No raw PID kill or forged runtime evidence. Kernel barrier must fence effects before draining a tick; delete does not stop workers.
- **Why:** core explicitly excludes leases/remotes, and orchestration's binding service identity separates plugin from worker runtime authority.
- **Evidence:** m6-heimdall-core D6; core contracts; control-contracts.ts KernelControlHost
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** remote fleet dependency lands separately
- **Source:** locked by docs/loop/decisions/m6-heimdall-core.md

## D5: Verify only macOS and isolate process state
- **Question:** platform/native notification verification
- **Options:** claim cross-platform parity; portable APIs plus macOS proof
- **Chose:** fresh temporary QUIRKY_HOME for every process scenario, cleanup owned daemons/workers, web UI dogfood once. Native notification banner pending scenario; Linux/Windows integration verification deferred.
- **Why:** locked platform/isolation constraints. Web notification records are not native banner evidence.
- **Evidence:** LOOP Hard rules/platform/UI/native sections
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** other platforms authorized
- **Source:** deferred: platform

## Progress
Claimed this iteration; merged current build/m6-heimdall-core type contracts (dependency implementation pending). Feature doc, dependency spec/log and source integration patterns read. Combined spec and control contracts authored; next commit these, dispatch three disjoint implementers, integrate core barrier/service and public worker authority, then runtime/API/CLI/UI proof and required checks. No behavior has been verified yet.
