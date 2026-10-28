# m7-sweep-automation decisions

## D1: Audit all three documents; preserve explicit exclusions
- **Question:** What is the parity boundary during brainstorming scope selection?
- **Options:** Reimplement all features; audit remaining flows against shipped features and queue owners.
- **Chose:** Audit automations.md, fork-loops.md and ledger.md completely, fixing confirmed bounded gaps and queuing larger work once.
- **Why:** The claimed item's title explicitly permits follow-ups for large gaps; no flow may silently disappear.
- **Evidence:** docs/loop/queue.json item m7-sweep-automation; docs/roadmap.md:27-28,43-53,259-266.
- **Reversibility:** easy (follow-up items remain explicit)
- **Confidence:** high
- **Revisit if:** A flow lacks either shipped evidence or a named queue owner.
- **Source:** locked by docs/roadmap.md

## D2: Resolve unattended workflow questions locally
- **Question:** Who approves design, defaults and scope choices in brainstorming/spec/execution skills?
- **Options:** Ask a human; use documented behavior and recommended safe defaults.
- **Chose:** Use standard gray areas, self-review markdown specs and record each consequential answer; no human questions or visual companion.
- **Why:** The unattended loop forbids questions. The feature documents, roadmap and prior decisions are the research sources; code mapping uses read-only scouts, not external research swarms.
- **Evidence:** docs/loop/LOOP.md, authoritative build/roadmap version read at claim.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** A safe choice conflicts with a locked decision (block rather than override).
- **Source:** locked by docs/loop/LOOP.md

## D3: Keep structured background execution and public plugin boundaries
- **Question:** Should parity reproduce Orca's hidden terminal background execution?
- **Options:** Copy terminal implementation; preserve structured execution with equivalent observable controls.
- **Chose:** Preserve structured sessions for background agents, existing public plugin API and generated namespaced CLI methods.
- **Why:** Architecture explicitly locks structured background agents and plugins on the third-party API; terminal compatibility cannot override it.
- **Evidence:** docs/architecture.md:145-178,290-324; docs/roadmap.md:19-40.
- **Reversibility:** hard (cross-feature runtime contracts)
- **Confidence:** high
- **Revisit if:** User changes the architecture decision.
- **Source:** locked by docs/architecture.md

## D4: Preserve existing follow-up ownership
- **Question:** Should this sweep duplicate previously queued gaps?
- **Options:** Add duplicate work; retain owners and record only newly uncovered obligations.
- **Chose:** Existing m5-automations-dispatch-remote-and-args owns remote execution/generations/pin/re-adoption/raw args; m5-automations-ui-remote-authorities owns remote UI and OpenClaw; m5-loops-ui-visible-stop-close-review owns prior visible Stop/Close/setup verdict and review.
- **Why:** Canonical queue status and queue records show these as todo; no evidence they are complete.
- **Evidence:** docs/loop/queue.json named records, read 2026-10-28T10:17Z.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Another lane lands one of those owners during this item.
- **Source:** assumed — autonomous

## D5: Use OpenAI task implementers and verified Gemini reviewer fallback
- **Question:** Which cross-family pairing is reachable for the omp execution workflow?
- **Options:** omp task + Opus; omp task + Gemini; same-family review.
- **Chose:** IMPLEMENTER=omp task, AUTHOR_FAMILY=openai, REVIEWER_ALIAS=gemini. Required spec review uses codex as the loop specifies.
- **Why:** pi-watch --check on /tmp returned no authed/shipping Opus or Sonnet model; Gemini resolved google/gemini-3.1-pro-preview:high. Cross-family fallback is explicitly allowed.
- **Evidence:** pi-watch --check, 2026-10-28T10:16Z; exit5 because Anthropic aliases unavailable; codex, terra, gemini, flash resolved.
- **Reversibility:** medium (review independence record)
- **Confidence:** high
- **Revisit if:** Gemini dispatch fails (record actual failure and use verified fallback ladder).
- **Source:** assumed — autonomous

## D6: Leave inherited Serena state untouched
- **Question:** How should the execution preflight handle inherited untracked .serena/?
- **Options:** Commit unrelated state; stash/delete it; exclude it from explicit commits and worker scopes.
- **Chose:** Preserve .serena/ unchanged; all implementers use isolated scoped worktrees and explicit staged paths.
- **Why:** It predates the iteration, as the previous notes and initial git status establish. Removing or committing it would modify user state.
- **Evidence:** .orca/loops/omp-until-done-154f6a6c/notes.md:14; initial git status --short --branch.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** The user explicitly assigns ownership of that directory.
- **Source:** assumed — autonomous

## D7: Apply normal two-spec workflow after the night-mode deadline
- **Question:** Does the one-spec night-mode override still apply?
- **Options:** Use its shortcut indefinitely; apply normal steps after its stated 04:00 deadline.
- **Chose:** Write logic.md and tech.md, combined spec review, one final review round and accepted-finding fix batch; scoped gates before canonical land.
- **Why:** Observed clock is 2026-10-28T10:16:20Z, after 04:00 local even in this macOS workspace. The deadline-qualified override has elapsed.
- **Evidence:** date -u output 2026-10-28T10:16:20Z; docs/loop/LOOP.md Night mode heading.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Authoritative LOOP.md changes its deadline or override.
- **Source:** assumed — autonomous

## Progress
Claimed lane1 at approximately 2026-10-28T10:14Z; branch build/m7-sweep-automation created from build/roadmap. Initial state detached, only inherited untracked .serena/. Three read-only scouts mapping automation, loop and ledger feature flows, code/tests and binding decisions. Next: integrate evidence matrix, select bounded fixes, write both specs, spec review and commit before isolated implementation. Scratch /tmp/quirky-automation-sweep.LlsERn. No implementation or checks started; no daemon started.
