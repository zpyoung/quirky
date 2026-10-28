# m6-orchestration-ui decisions

## D1: Build the complete skill and local orchestration UI slice
- **Question:** brainstorming purpose, consumers, primary flow, success, scope and constraints
- **Options:** settings only; terminal UI only; complete queue title
- **Chose:** skill installation/update/retry/copy/recheck and detected-agent coverage; five usage examples and generated agent instructions; persisted nested depth; task-ID terminal navigation; nested worker rows and user takeover reporting.
- **Why:** users need setup/discovery and honest runtime visibility; each is expressly named in the item. Coordination remains agent-driven CLI/API, not a new task-board product.
- **Evidence:** orchestration.md sections1–3,10,UI; queue wait --lane2 m6-orchestration-ui; docs/roadmap.md:43–53,216–228
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** queue scope changes
- **Source:** locked by docs/loop/queue.json

## D2: Apply unattended night mode with one combined spec
- **Question:** brainstorming research, gray areas, approval and execution process
- **Options:** wait for human approval; elect documented defaults autonomously
- **Chose:** Visual/CLI/API/Integration domains; resolve layout/density, empty/loading/error states, interaction, install conflicts/idempotency, output, settings authority and data mapping. No visual companion, adhd, external research swarm or human asks. Write one logic.md with final technical section and self-review; commit contracts before at most three implementers.
- **Why:** authoritative LOOP night mode is active at00:43 CDT and explicitly replaces these interactive gates.
- **Evidence:** git show build/roadmap:docs/loop/LOOP.md Night mode, Answering a skill's questions
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** loop workflow changes
- **Source:** locked by docs/loop/LOOP.md

## D3: Extend existing plugin and renderer conventions
- **Question:** architecture alternatives, layout, density and integration ownership
- **Options:** extend built-in orchestration/settings/terminal/sidebar public seams; build standalone dashboard; duplicate worker runtime state in UI
- **Chose:** existing settings shell and plugin-owned orchestration pane; existing skill install engine; public runtime projections and terminal focus commands; compact nested worker rows. Renderer never decides settlement or destructive cleanup.
- **Why:** locked plugin architecture and daemon-owned focus prohibit a second authority model. Existing workers already own exact input-origin custody and meaningful titles; reuse them.
- **Evidence:** docs/architecture.md:312–324; orchestration.md UI; m6-orchestration-workers D5,D18,D23,D25
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** existing public seams cannot express the feature
- **Source:** assumed — autonomous

## D4: Keep depth policy separate from ordinary worker-writable settings
- **Question:** persisted depth normalization, authorization, paired clients and scriptability
- **Options:** ordinary mutable setting; separate explicit operator policy API using the single enforced core getter; unscriptable renderer-local value
- **Chose:** default1, integer minimum1; invalid persisted values normalize to1. Explicit operator policy changes persist and affect both admission and preamble through the same core getter. Ordinary settings writes and authenticated worker/session callers cannot raise the cap. Paired clients do not show the control. Provide an operator CLI/API rather than renderer-only state.
- **Why:** source excludes the key from worker settings RPC while the locked roadmap requires scripting parity. Full-trust shared-token agents are not sandboxed: do not claim protection against a malicious actor impersonating a separate operator connection.
- **Evidence:** orchestration.md section2 and nesting depth; docs/roadmap.md:31–41; m6-orchestration-workers D18 explicitly allows this item's authorized persisted policy; packages/daemon/src/plugins/dispatch.ts:230–244
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** the kernel provides stronger desktop provenance or access-control architecture changes
- **Source:** assumed — autonomous

## D5: Preserve uncertainty, identity and terminal ownership
- **Question:** missing dispatch, stale labels, nested lineage and takeover races
- **Options:** infer worker identity from title; use exact current dispatch/session provenance
- **Chose:** task links resolve latest dispatch and exact local session, report missing/unsupported destination honestly without launching terminals. Rows prefer displayName then taskTitle only for current assignment, flatten deeper nesting at one visible indent, preserve all workers when coordinator absent. Human typing uses existing input-origin custody path; no programmatic writes report takeover.
- **Why:** task titles and old IDs cannot confer live assignment or release authority. Background structured workers do not become visible chat terminals.
- **Evidence:** orchestration.md sections10,UI,Stop release and retry boundaries; docs/architecture.md structured sessions; m6-orchestration-workers AC14
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** public remote navigation capability lands
- **Source:** locked by research/orca-features/orchestration.md

## D6: Use OpenAI implementers and reachable Gemini review
- **Question:** SDD immutable backend pairing, environment and scope isolation
- **Options:** omp tasks plus Opus; omp tasks plus verified cross-family fallback
- **Chose:** IMPLEMENTER=omp-task, AUTHOR_FAMILY=openai, REVIEWER_ALIAS=gemini; maximum three disjoint implementation worktrees. Preserve unrelated untracked metadata; clean feature dispatch trees only. No language servers are configured; use existing semantic tools where available.
- **Why:** pi-watch check found no authenticated Opus/Sonnet model; Gemini resolves google/gemini-3.1-pro-preview:high. Codex and Terra are same-family alternatives, not preferred reviewers.
- **Evidence:** iteration5 pi-watch --check from/tmp; xd://lsp status returned no language servers configured
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** actual Gemini review fails
- **Source:** assumed — autonomous

## D7: Verify macOS with private homes and no real agent configuration writes
- **Question:** platform scope, installer smoke and UI verification safety
- **Options:** test real home installs; private HOME/QUIRKY_HOME and agent fixtures
- **Chose:** every process test/smoke uses temporary homes and cleans owned processes. Installation writes only private detected-agent targets. Run affected suite, scripts/typecheck and one real web dogfood campaign; native-only clipboard/window behavior is handed off if added. Linux/Windows installation/path/modifier/input verification is deferred platform work.
- **Why:** locked macOS scope and test isolation; source's install flow was not exercised, so Quirky must actually verify it rather than copy its claim.
- **Evidence:** LOOP Hard rules and Verify; orchestration.md Verified in the app; docs/roadmap.md platform policy
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** another platform is authorized
- **Source:** deferred: platform

## Progress
Iteration5 scoped and merged current build/m6-orchestration-workers dependency. Research scouts are mapping exact settings/skill and renderer contracts. Next: commit combined spec and shared contracts, implement disjoint slices, verify and land. No feature implementation or passing verification is claimed yet.
