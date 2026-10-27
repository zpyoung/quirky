# m6-orchestration-core decisions

## D1: Preserve both combined parts of the claimed item
- **Question:** brainstorming scope, purpose, consumers, success criteria and exclusions
- **Options:** core only; core plus mailbox/questions/gates; full orchestration feature including worker lifecycle UI
- **Chose:** both parts of the queue title, with all listed source sections; exclude only separately assigned worker-start/fleet/resource/federation/legacy/settings UI flows.
- **Why:** title explicitly says a Part 1 exclusion does not override Part 2 inclusion. Coordinators/workers consume the daemon API/generated CLI; acceptance is durable DAG, fenced delivery, resumable questions and coordinator gates.
- **Evidence:** queue.ts wait --lane 1 output; orchestration.md The database, Task model and DAG semantics, Messaging, Blocking ask and reply, Decision gates
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** queue owner changes this item's combined scope
- **Source:** locked by docs/loop/queue.json

## D2: Follow unattended night mode and elect recommended defaults
- **Question:** brainstorming workflow, gray-area selection, approval and spec format
- **Options:** wait for a person; autonomously resolve standard gray areas and record each answer
- **Chose:** API/CLI/Data/Integration classification; all relevant response/auth/errors/output/flags/recovery/idempotency/mapping areas. No external research swarm, visual companion, adhd or human ask. One markdown logic.md with final technical section and self-review; no separate tech.md/spec-review round.
- **Why:** LOOP explicitly selects this workflow and nobody watches the lane. Essential purpose/consumer/primary flow/constraints/success/scope are established by source docs and queue before design.
- **Evidence:** docs/loop/LOOP.md Night mode, Answering a skill's questions; docs/roadmap.md M6 and When a milestone is done
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** unattended night mode expires or the loop protocol changes
- **Source:** locked by docs/loop/LOOP.md

## D3: Choose one lazy durable plugin, not an in-memory broker or scheduler
- **Question:** brainstorming alternative approaches and storage ownership
- **Options:** private SQLite plugin; in-memory coordinator broker; automatic scheduler/global orchestration kernel
- **Chose:** quirky.orchestration, a lazy built-in on PluginContext.openStore/call/subscribe. Synchronous transactions own lifecycle/mail/receipts; async waits/pointers happen after commit.
- **Why:** SQLite provides restart durability and atomic DAG/report/delivery changes; memory loses them and a scheduler is not the selected source behavior. Public plugin API is mandatory.
- **Evidence:** packages/protocol/src/plugins.ts:48-80,214-234; packages/daemon/src/plugins/stores.ts; orchestration.md The database
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** the public store cannot express required atomic invariants
- **Source:** locked by docs/architecture.md

## D4: Keep Quirky session identity, not Orca pane compatibility
- **Question:** authentication, declared caller aliases and provider-session mapping
- **Options:** copy Orca handle/pane remint tables; stable Quirky session parties; trust arbitrary from strings
- **Chose:** stable Quirky session ID as party; reject declared aliases inconsistent with caller. Provider conversation ID is a name, never a credential. Coordinator binding and Dispatch ownership fence operations. Caller.sessionId is authenticated-connection metadata, not independent process attestation; implementers must use/grow a public evidence seam before treating it as proof of exact worker ownership.
- **Why:** m1-agent-status D2 fixes identity; current client.hello accepts session metadata, so merely checking that a named session exists does not prove that a lifecycle report came from its process. User/agent retain full shared-token access, but stale/copied Dispatch IDs cannot settle current work accidentally.
- **Evidence:** docs/loop/decisions/m1-agent-status.md D2; packages/protocol/src/plugins.ts:199-209; packages/daemon/src/methods.ts:163-176; orchestration.md Caller identity and authority
- **Reversibility:** hard
- **Confidence:** high
- **Revisit if:** exact ownership cannot be attested through a public API without changing locked trust decisions
- **Source:** locked by docs/loop/decisions/m1-agent-status.md

## D5: Preserve schema-generated CLI and native JSON-RPC shapes
- **Question:** response format, flags, progress and exit codes
- **Options:** recreate Orca envelope; use existing Quirky protocol/generated CLI
- **Chose:** quirky.orchestration/ methods and orchestration CLI alias; documented kebab-case verbs, named reason codes and exact recovery commands. No extra Orca envelope. Ask timeout/cancel exits 1; wait keepalives go to stderr. No Experimental toggle.
- **Why:** all built-ins share one API; CLI docs must reflect the actual plugin surface, not Orca packaging strings.
- **Evidence:** packages/protocol/src/catalog.ts:29-59; packages/cli/src/plugin-commands.ts; orchestration.md CLI reference and Verified in the app
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** CLI generation cannot express long-wait/resume semantics, then add a declared plugin CLI module
- **Source:** assumed — autonomous

## D6: Preserve transactional DAG and attempt state graphs
- **Question:** update precedence, failure recovery, race semantics and nesting
- **Options:** permissive status assignment; documented invariants and CAS state graphs
- **Chose:** existing same-Run dependencies only, immutable deps, transactional promotion, exact active-attempt report authority, expected-state CAS, infrastructure failure budget 3 carried over retry lineage, default depth 1 based on deepest active role even after creating another Run. Worker-reported failure is not infrastructure failure.
- **Why:** Task IDs are not completion authority and independent retry/Run creation cannot bypass circuit/nesting caps.
- **Evidence:** orchestration.md Task model and DAG semantics, Races and fencing, Constants and limits
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** a later supervised-worker contract needs a documented graph amendment
- **Source:** locked by research/orca-features/orchestration.md

## D7: Match FIFO replay and generation-fenced acknowledgements
- **Question:** mailbox consumption, filtering and cancellation
- **Options:** destructive reads; replayable acknowledged Deliveries
- **Chose:** at most 50 FIFO messages per outstanding mailbox Delivery; replay exactly until ack; type filters only gate wait wakeups, not consuming batch content; peek/all filter nonconsumingly, 100 max. One actionable Run waiter; preserve committed ack on subsequent interruption.
- **Why:** lost responses must not lose work, type-filtered waits must not strand other mail and old coordinator generations must not consume current mail.
- **Evidence:** orchestration.md Reading the mailbox with check, Delivery rules, Races and fencing
- **Reversibility:** hard
- **Confidence:** high
- **Revisit if:** the feature's delivery contract changes explicitly
- **Source:** locked by research/orca-features/orchestration.md

## D8: Match durable address routing and fail closed group membership
- **Question:** recipient mapping, broadcast scope and enqueue meaning
- **Options:** raw terminal writes; durable Run/Dispatch routing with supported direct fallback
- **Chose:** explicit run:/dispatch:, current/historic coordinator routing, documented live direct fallback warning, group fanout within caller Run or explicit workspace. Group lifecycle types refused; provider groups use published provider identity, not title. Missing or ambiguous recipients fail; enqueue success never proves reading.
- **Why:** mailbox identity survives coordinator changes; titles and missing evidence cannot grant membership.
- **Evidence:** orchestration.md Messaging/Mailboxes and addresses, Bare-handle resolution, Groups, Sending
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** the eventual public session catalog cannot enumerate the required evidence
- **Source:** locked by research/orca-features/orchestration.md

## D9: Questions time out without duplication and gates are separate
- **Question:** ask retry/resume/reply and gate policy
- **Options:** timeout deletes/reissues; durable question ID resumed until answer/settlement
- **Chose:** pending question survives timeout, resume original ID, current coordinator replies, same answer duplicate and different answer conflict; answer already read. Close pending threads when attempt settles, not on uncertain start. Gates block Task, refuse live supervised worker, and resolution records text then readies Task without injecting a prompt. Dispatch admission still checks dependencies.
- **Why:** a local wait timeout is not a new question or proof of failed work. A worker ask is not a human decision gate.
- **Evidence:** orchestration.md Blocking ask and reply, Decision gates
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** dependency/gate readiness needs a source-backed amendment
- **Source:** locked by research/orca-features/orchestration.md

## D10: Pointer delivery is bounded, identity-checked and non-consuming
- **Question:** nudge behavior, safe submission and restart uncertainty
- **Options:** paste message bodies immediately; idle-only command pointers through existing send safety
- **Chose:** only command pointer to exact idle Run/Dispatch party; live safe-send/quiescence checks; one flight, durable reserve/write/Enter phases; separate terminal Enter after500ms and no Cursor auto-Enter. Respect outstanding Deliveries and waiter reservations. Structured pointers use idempotent normal structured send; uncertain submit does not repeat Enter after restart.
- **Why:** pointer pushes are best-effort hints; no timeout/status absence authorizes unsafe typing or consumption.
- **Evidence:** orchestration.md Waking waiters and nudging idle agents, Pointer push into terminal/chat; docs/loop/decisions/m5-structured-runner.md D17
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** public safe-send/idempotent structured APIs lack required safety receipts
- **Source:** locked by research/orca-features/orchestration.md

## D11: Durable receipts must cooperate with kernel request IDs
- **Question:** mutation idempotency, retries, ambiguous outcome and retention
- **Options:** trust transient Promise cache; persist orchestration accepted/completed receipts; duplicate conflicting kernel ledger
- **Chose:** plugin-local durable atomic receipt checkpoints for orchestration transitions and accepted long waits; preserve kernel transport request semantics and inspect its ledger before wiring. Same UUID/input replays, changed payload fails, abandoned pending returns operation_unknown, absent is not proof. Retain30days/max10000/prune64 completed rows.
- **Why:** ask/check acceptance and crash recovery cannot be inferred from a lost socket response; two layers must not obscure recovery.
- **Evidence:** packages/daemon/src/plugins/dispatch.ts:131-133; orchestration.md Mutation idempotency and request IDs
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** a public kernel receipt API already provides the full checkpoint semantics
- **Source:** locked by research/orca-features/orchestration.md

## D12: Reset is plugin-scoped and preserves receipts
- **Question:** destructive flags and persisted survivors
- **Options:** delete whole store; documented all/tasks/messages transactions
- **Chose:** exactly one mode, kernel destructive confirmation, tests pass --yes. Keep mutation receipts for every reset. No Orca legacy tombstones/federation state or unrelated plugin deletion.
- **Why:** retrying reset must not repeat ambiguous effects and this is a clean Quirky implementation without compatibility paths.
- **Evidence:** orchestration.md Reset; docs/architecture.md Decisions/Scriptable by agents
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** future features add dependent rows requiring reset participation
- **Source:** locked by docs/architecture.md

## D13: Prepare contracts only while the early dependency is not ready
- **Question:** early-item execution gate
- **Options:** implement against missing dependency; block core prematurely; commit design/contracts and resume when ready
- **Chose:** one combined spec and inert shared contract types, no runtime stub or activation. Implementation starts only after queue.ts deps reports ready and the prescribed integration merge.
- **Why:** m5-structured-runner is currently held by lane12, and LOOP's early-item rule expressly permits preparation but gates implementation. Its contracts already define native app-server/resume/checks; orchestration is not part of that dependency's scope.
- **Evidence:** docs/loop/queue.json query (m5 in-progress lane12, m1 dependencies done); docs/loop/LOOP.md:79-83; m5-structured-runner D1-D8,D12,D17,D25; MapOrchestration scout
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** queue.ts deps returns ready
- **Source:** locked by docs/loop/LOOP.md

## D14: macOS only; no new native UI scenario in this slice
- **Question:** platform coverage and UI verification surface
- **Options:** implement cross-platform authority/pointer differences now; macOS acceptance with explicit later verification
- **Chose:** macOS; portable API use where practical. Linux/Windows need independent process-identity, timer/transport and pointer-submit verification. Added visible pointer scenarios are checked via web UI at final dogfood; no new OS window/menu/tray/dialog behavior is introduced.
- **Why:** platform scope and web-only dogfood are locked. Settings/terminal links/native custody UI belong to later slices.
- **Evidence:** docs/loop/LOOP.md Platforms/Night mode/Verify; logic.md AC9
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** another platform is authorized
- **Source:** deferred: platform

## D15: Contract preparation is inert and keeps source-level recovery combinations
- **Question:** shared-contract review before the early-item checkpoint
- **Options:** activate placeholder methods now; commit inert types and explicit API/CLI normalization boundaries
- **Chose:** type-only domain/request/result/CAS/receipt contracts in plugins/quirky.orchestration/src/contracts.ts. Public rows use camelCase and resolved mailbox unions; the manifest-declared CLI adapter must preserve the documented string-address/JSON/CSV flags and long-wait/resume behavior. Low-level dispatch has no public retry flag; internal admission retains retry lineage for the later worker-start slice. No redundant store facade: reuse PluginStore.
- **Why:** no runtime feature can ship while the early dependency gate is false. Parent review strengthened caller evidence to require independent runtime process/lease attestation (live lookup alone is insufficient), added canonical Run/Dispatch senders, raw-vs-structured payload exclusivity, report rejection reasons, ask target/format, and durable acknowledgement even with non-consuming peek/history.
- **Evidence:** queue.ts deps returned ready:false, pending m5-structured-runner; contracts.ts; orchestration.md:291-307,427-435,477-488,530-554. LSP references attempted for changed public contracts: no language server available; there are no runtime consumers in this preparation.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** dependency integration exposes a conflicting public identity/send contract
- **Source:** assumed — autonomous

## D16: Retain the early checkpoint while the dependency remains pending
- **Question:** iteration 4 resumption after the loop's previous check reported `not done: item`
- **Options:** start runtime implementation before readiness; block the item; retain its committed early checkpoint
- **Chose:** retain the checkpoint and lane ownership, without runtime changes, integration merge, landing or queue blocking.
- **Why:** `queue.ts wait --lane 1` returned this same early item, and the completed dependency query still reports `ready:false` with `m5-structured-runner` pending. LOOP's early-item rule requires ending the iteration at this gate; a nonterminal item check is not a product failure.
- **Evidence:** iteration 4 `bun scripts/build-loop/queue.ts wait --lane 1` returned kind item; `bun scripts/build-loop/queue.ts deps m6-orchestration-core` returned `{"ready":false,"pending":["m5-structured-runner"]}` after 510.24 seconds.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the dependency query returns ready
- **Source:** locked by docs/loop/LOOP.md:79-83

## D17: Iteration 5 retains the same pending early-item gate
- **Question:** whether the repeated `not done: item` check changes the permitted next step
- **Options:** bypass dependency readiness; block the item; preserve the early checkpoint
- **Chose:** preserve the checkpoint and lane ownership; no runtime edits, integration merge, landing or queue block.
- **Why:** the queue still returns the held early item, and its dependency query still reports the prerequisite pending. The early-item rule explicitly requires ending the turn after preparation while readiness is false.
- **Evidence:** iteration 5 `queue.ts wait --lane 1` returned `kind:item`, `m6-orchestration-core`, `early:true`; `bun scripts/build-loop/queue.ts deps m6-orchestration-core` completed after 510.15 seconds with `{"ready":false,"pending":["m5-structured-runner"]}`.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the dependency query returns ready
- **Source:** locked by docs/loop/LOOP.md:79-83

## D18: Iteration 6 preserves the early checkpoint
- **Question:** whether the held item can begin implementation in iteration 6
- **Options:** bypass readiness; block the item; preserve the prepared checkpoint
- **Chose:** preserve the checkpoint and lane ownership; no runtime changes, integration merge, landing or queue block.
- **Why:** the early prerequisite remains pending. The repeated `not done: item` check does not override the dependency gate.
- **Evidence:** iteration 6 `queue.ts wait --lane 1` returned this held early item after 245.60 seconds; `queue.ts deps m6-orchestration-core` completed after 510.20 seconds with `{"ready":false,"pending":["m5-structured-runner"]}`.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the dependency query returns ready
- **Source:** locked by docs/loop/LOOP.md:79-83

## D19: Iteration 7 remains at the early dependency gate
- **Question:** whether the held item can start implementation after the previous `not done: item` check
- **Options:** bypass readiness; block the item; preserve the early checkpoint
- **Chose:** preserve the checkpoint and lane ownership; no runtime changes, integration merge, landing or queue block.
- **Why:** the completed dependency query still reports the prerequisite pending. LOOP's early-item rule requires ending this iteration without implementation.
- **Evidence:** iteration 7 `queue.ts wait --lane 1` returned `kind:item`, `m6-orchestration-core`, `early:true`; `queue.ts deps m6-orchestration-core` completed after 510.23 seconds with `{"ready":false,"pending":["m5-structured-runner"]}`.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the dependency query returns ready
- **Source:** locked by docs/loop/LOOP.md:79-83

## D20: Iteration 8 preserves the dependency-gated checkpoint
- **Question:** whether this iteration can start runtime implementation
- **Options:** bypass readiness; block the item; preserve the early checkpoint
- **Chose:** preserve the checkpoint and lane ownership; no runtime changes, integration merge, landing or queue block.
- **Why:** the prerequisite remains pending. The early-item rule requires ending the iteration after preparation while readiness is false.
- **Evidence:** iteration 8 `queue.ts wait --lane 1` returned the held early item; `queue.ts deps m6-orchestration-core` completed after 510.58 seconds with `{"ready":false,"pending":["m5-structured-runner"]}`.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the dependency query returns ready
- **Source:** locked by docs/loop/LOOP.md:79-83

## Early preparation verification
- `bun run typecheck`: exit0 on the final contracts, no diagnostics.
- Actual Bun import of contracts.ts: `CONTRACT_MODULE_INERT_OK`; the module exports no runtime values. No daemon, model, process, real user state or placeholder contribution was started/installed.
- All preparation subagents and the dependency query completed. No background work remains from this iteration.
- No runtime acceptance claim: AC1–AC13, cross-family review, UI pointer dogfood and queue-controlled landing remain gated on implementation after dependency readiness.

## Progress
Iteration 8 rechecked the held item: `ready:false`, pending `m5-structured-runner`. Early preparation remains complete through the combined spec and inert shared contracts; runtime implementation is not installed. Per LOOP.md:79-83, end this iteration at the committed checkpoint. Next iteration: resume this item, read this log and logic.md, and run deps again. If false, preserve the checkpoint; if true, merge build/roadmap, read incoming decisions and implement all three specified slices. Resolve public runtime attestation and idempotent safe-send seams before trusting worker identity or pointer outcomes. AC1–AC13, product verification, dogfood, cross-family review and landing remain unexecuted. Both queue commands completed; no subagents or background work remain from iteration 8. No terminal marker: wait returned item, not done or stuck.
