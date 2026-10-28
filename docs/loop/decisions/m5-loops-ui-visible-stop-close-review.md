# m5-loops-ui-visible-stop-close-review decisions

## D1: Apply the current build-first policy to this older verification follow-up
- **Question:** the title requests visible verification and one bounded review, but the authoritative LOOP.md now moves all testing/debugging/review/dogfood to the end phase.
- **Options:** run the old campaign; leave the lane waiting; write missing acceptance coverage, record limits and land with typecheck.
- **Chose:** write coverage and land; no suite, dogfood or review run, and no verification-only follow-up.
- **Why:** the current explicit policy overrides older workflow gates and says typecheck is the only build-phase gate. The implementation already exists; this item is not a reason to weaken or duplicate it.
- **Evidence:** `git show build/roadmap:docs/loop/LOOP.md`, Build first, test at the end; parent decision D18; BLOCKERS.md345–354; LoopUIScout source map.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** m7-test-triage begins or the operator changes policy.
- **Source:** locked by docs/loop/LOOP.md

## D2: Preserve product behavior and add actual native Stop/Close coverage
- **Question:** which scope and fixture behavior are missing, and may native ownership checks be changed?
- **Options:** production refactor; mocked button forwarding; real native fixture plus rendered controls and public state.
- **Chose:** existing LoopView/close handlers unchanged; new native UI acceptance scenarios S1–S3, using UUID-backed fresh thread IDs and exact resume identity.
- **Why:** Stop and Close choices are implemented. Existing API close tests do not exercise visible Stop choices. Parent D22 attributes visible crashes to the reused scripted-thread fixture, not to the exclusive-owner guard.
- **Evidence:** LoopView.tsx560–586,990–1015; src/ui.tsx240–320; main.ts346–399; structured/test/fakes/codex-app-server.ts26–38,171–180; parent U07/U11 and D22.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** end-phase native execution finds a product defect with distinct conversation IDs.
- **Source:** locked by docs/loop/decisions/m5-loops-ui.md

## D3: Finalize setup as tool-limited, not failed or passed
- **Question:** what can be concluded from the earlier setup Start verdict?
- **Options:** label app failed; invent a formal pass; preserve the evidence boundary.
- **Chose:** prior Start remains UNSETTLED/tool-limited despite recorded successful background creation and focus preservation. No fresh visible pass claimed.
- **Why:** the tool's last-action verdict guard prevented formal completion; no product failure was established. Raw private report is not present in this worktree, so its summary is attributed to the committed parent record.
- **Evidence:** BLOCKERS.md351; m5-loops-ui Progress and D18; report reference 20261028T060845-277a.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the end phase executes the same visible goals.
- **Source:** locked by docs/loop/decisions/m5-loops-ui.md

## D4: Resolve skill questions autonomously with one combined specification
- **Question:** brainstorming domains, gray areas, essential coverage, alternatives, approval and spec format without a person watching.
- **Options:** interactive questions/research; autonomous feature-doc defaults and self-reviewed markdown.
- **Chose:** Visual/API/Integration/Data domains; interaction/error/loading, authoritative state, identity/isolation and lifecycle gray areas resolved by S1–S5. Purpose, consumers, scope, behavior, constraints and success explicit. No human ask, companion, ADHD, research swarm or separate spec review. One logic.md with technical section.
- **Why:** current LOOP supplies approval/defaults and requires one combined spec. The shipped UI and its binding decisions settle behavior.
- **Evidence:** current LOOP Answering a skill's questions and Build first policy; item logic.md.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** repository evidence cannot settle a production behavior change.
- **Source:** locked by docs/loop/LOOP.md

## D5: One isolated OpenAI implementer; no review model dispatch
- **Question:** SDD component shape, inherited dirt, backend pairing and contract ownership.
- **Options:** several overlapping test workers; one native fixture/acceptance component; parent-only implementation.
- **Chose:** one omp OpenAI task implementer, two test-owned files, isolated worktree, no checks or commits mid-flight. Parent commits fixture interface/spec first, then audits HEAD/scope. Existing untracked .quirk and .serena metadata stay untouched. No review backend is probed/dispatched because review is postponed by D1. No LSP is configured.
- **Why:** fixture and consumer are one coupled slice; splitting buys no parallelism. No new product interface or production behavior is necessary.
- **Evidence:** xd://lsp status returned no configured servers; known fixture consumer enumeration; one-component plan in combined spec.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** an implementation need exceeds the two-file test scope.
- **Source:** assumed — autonomous

## D6: Isolate processes on macOS and leave other platforms unclaimed
- **Question:** process state, teardown and platform support.
- **Options:** real profiles; fresh temporary homes and owned teardown.
- **Chose:** test fixtures use disposable HOME/QUIRKY_HOME/CLAUDE_CONFIG_DIR/CODEX_HOME; every native process is stopped by its owner before home removal. macOS typecheck only in this phase; no Linux/Windows claim.
- **Why:** tests must never edit real provider state or stop other lanes' children.
- **Evidence:** LOOP Hard rules/platform decision; existing loop rig and shared native fixture.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** platform verification starts.
- **Source:** deferred: platform

## D7: Preserve fixture teardown even when window shutdown fails
- **Question:** native acceptance must not leak a process or altered environment if headless window cleanup rejects.
- **Options:** sequential teardown; nested finally blocks around window, geometry and rig cleanup.
- **Chose:** native test afterEach always restores geometry and awaits the rig's owned cleanup; the rig restores environment and runner overrides after stopping its harness.
- **Why:** a window teardown failure must not skip native subprocess ownership cleanup. Default scripted tests and product source remain unchanged.
- **Evidence:** NativeControlCoverage two-file component at e84e568c; unchanged HEAD and exact source scope audited; component f12b67e8 committed by parent, integrated and worktree removed.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** end-phase process ownership checks expose a cleanup failure.
- **Source:** assumed — autonomous

## Progress
Native fixture and three rendered-control acceptance tests implemented in component f12b67e8; HEAD/scope audit passed, component merged and isolated worktree removed. No product source or existing test assertions changed. No tests, dogfood or review were run. Append-only end-phase handoff recorded in BLOCKERS. Next: catch up once with build/roadmap, read incoming decisions, typecheck, commit evidence, detach and canonical land.
