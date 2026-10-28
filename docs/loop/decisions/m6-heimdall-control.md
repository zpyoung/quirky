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

## D6: Preserve conditional confirmations and unified notification ownership
- **Question:** binding-log review found API confirmation, non-consuming reads, glyph ownership and sole-notifier details missing from the first spec
- **Options:** UI-only confirm/direct notifier/consuming mailbox; existing public confirmation, producer events and owner read projection
- **Chose:** command declares destructive:true with read-only describeCommand returning null for reversible controls and exact deletion text for delete; only UI-confirmed delete supplies yes:true. Heimdall emits declared notification transition events; quirky.notifications reuses its normal enabled/focus/cooldown/marker/sound gates and remains sole context.notify caller. Worktree UI owns its glyph using public fleet API/events, clearing it when unavailable. Fleet/detail/debug use non-consuming owner service inspection only.
- **Why:** m0 confirmation and UI contracts, m1 D5/D18/D40 sole-notifier policy and orchestration D7/D9 prohibit the shortcuts. Source titles/bodies remain unchanged; policy gating is deliberate inherited behavior, not a second notifier.
- **Evidence:** daemon/plugins/confirm.ts:67-80; m0-ui-api D6/D10; m1-notifications D5/D18/D40; m6-orchestration-core D7/D9; amended logic.md AC2/3/6/9
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** notifications policy cannot accommodate watcher event semantics
- **Source:** locked by docs/loop/decisions/m1-notifications.md

## D7: Preserve typed owner config and reserve owner runtime integration
- **Question:** lane12 owner item requires compatible CLI enrollment and exact owner escalation answer without competing hub edits
- **Options:** reject owner config until later; invent owner runtime in controls; consume published typed config and delegate exact owner effect
- **Chose:** merged be27618f config/enrollment contracts into root/components. CLI supports owner Claude/model/effort with explicit flags overriding spec and intervention capability default off. Owner modules and ownerReady/ownerInspect reserved lane12. Host escalation hook delegates OwnerController.answer; only reason owner-answer-sent maps applied, never uncertainty. Controller does not save/unpark/revise enrollment; plane does so once after positive send. Core/main/manifest/service hub edits serialized after core, then owner merges lane10.
- **Why:** explicit user/lane12 integration contract; structured owner conversation authority must not be simulated or duplicated. Generic Resume cannot bypass owner-escalation.
- **Evidence:** user interjections; be27618f; owner contract63ec64f9; /tmp/quirky-lane12-owner-control-reply.md
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** controller cannot positively attest the native human-reply send
- **Source:** assumed — autonomous

## D8: Translate CLI creation flags from the actual source contract, not inferred payload names
- **Question:** component review left plan-file and hosted branch-update mappings marked as inference
- **Options:** keep guessed fields and a payload-copy objective view; read the supplied kind docs and cited CLI implementation
- **Chose:** objectiveText/existingPlan, merged roleAgents assignments, named command gates with 1800-second timeout, string branch-update merge-base-update|rebase and merge-method default|merge|squash|rebase (default null). Apply kind capability defaults, then spec and flags; normalize owner-intervention to the root capability. Objective CLI delegates the real public objectiveDetail provider owned by the objective-plan item and propagates its absence; show remains kernel inspection. No fake plan projection or legacy field alias.
- **Why:** external heimdall-objective.md and hosted-review-sitter.md identify the flag contract. Their cited create-flag-values.ts/create-spec.ts resolve the exact JSON mapping. Registered kind authorization still owns workspace/host identity and payload validation.
- **Evidence:** external heimdall-objective.md:59,101,219; hosted-review-sitter.md:101; /Users/zpyoung/PycharmProjects/orca/src/cli/fork-heimdall/create-flag-values.ts:103-250 and create-spec.ts:111-160; new real-daemon CLI acceptance scenarios
- **Reversibility:** medium
- **Confidence:** high for source mapping; public runtime proof still pending core integration
- **Revisit if:** a Quirky kind publishes a different explicit public request contract
- **Source:** locked by docs/roadmap.md

## D9: Use one fleet selector contract and preserve concurrent kernel writes
- **Question:** source integration review found divergent API/browser selectors and stale whole-enrollment command writes
- **Options:** keep duplicate projections and old snapshots; shared pure selectors and transactional latest-row patch
- **Chose:** one fleet-selectors.ts for API/CLI/UI; explicit tick-error evidence, not a regex on arbitrary reason text. Preserve source urgency/buckets including paused inactive and held tick-error active unless contact is actually lost. persistMutation reloads/rechecks owner+revision inside the transaction and patches current state. Positive question/escalation answers resolve their exact linked park records; group: folder identities also enforce cap1.
- **Why:** API and UI must not disagree about urgency/attention; an entered effect may finish during a non-draining control await. RED/GREEN regressions proved lost orchestrationRunId, lingering park escalations and a folder-group concurrency escape. Mock forwarding/copy assertions were removed, not repinned.
- **Evidence:** focused tests38pass184assertions; RED artifacts45/48/51/64; canonical core control-reply journal vocabulary; notifications/service.ts folder identity convention
- **Reversibility:** easy
- **Confidence:** high for exercised state boundaries; actual daemon/worker/UI remains required
- **Revisit if:** final core integration exposes another concurrent-state transition
- **Source:** assumed — autonomous

## Progress
All original components integrated (3bb747ea/85b7f6d7/45dfd2c4), component trees removed; shared selectors/race fixes94d43503 plus later CLI/source-vocabulary corrections. Focused checks38pass184assertions; regression failures fixed with passing state checks. UI build succeeded; whole desktop build initially failed on an omitted dependency codex-path, then core restored the exact landed source (runtime/build recheck pending). Parent control host/lifecycle, real daemon/CLI/notification acceptance and native handoff authored. Core implementation/services still pending; authoritative deps waits continue in this same turn. Next: integrate actual core main/manifest/service and worker hook (reply field worker), execute public daemon/CLI/worker and web UI proof, affected suite/scripts/typecheck, deps-ready/catch-up/incoming decisions/final review/queue landing. No runtime feature pass or completion claim.
