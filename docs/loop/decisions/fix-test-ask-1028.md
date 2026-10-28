# fix-test-ask-1028 decisions

## D1: Repair the recorded end-phase failures without changing Ask ownership policy
- **Question:** Which behavior is authoritative when older tests differ from later Ask work?
- **Options:** Restore legacy defaults; follow the current source feature and later decisions.
- **Chose:** Follow current FIFO, authenticated registration, connection-bound waits, exact-session panel reveal and inert preview contracts. Use reported baseline failures as evidence rather than rerunning merely to confirm them. Fix items skip brainstorming/spec creation.
- **Why:** m7-test-triage names the actual failed tests; later terminal completion work intentionally changed presentation and registration behavior.
- **Evidence:** docs/loop/reports/m7-test-triage.json plugins/quirky.ask; plugins/quirky.ask/README.md; docs/loop/decisions/m7-sweep-terminal-completion.md D3,D11,D12; docs/loop/LOOP.md Fix items.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Canonical verification demonstrates a consumer-visible contract mismatch.
- **Source:** locked by docs/loop/LOOP.md

## D2: Use disjoint omp implementers and an available cross-family reviewer
- **Question:** How should unattended decomposition and backend selection work?
- **Options:** Ask a person; use unavailable Opus; select the next reachable cross-family reviewer.
- **Chose:** IMPLEMENTER=omp task, AUTHOR_FAMILY=openai, REVIEWER_ALIAS=gemini. Two concurrent disjoint worker scopes: presentation/src and service/CLI/migrations; parent owns confirmation dispatcher, panel tests, integration and decisions. Workers skip checks mid-flight; parent runs the combined gates afterward. Leave unrelated .serena untracked and untouched.
- **Why:** pi-watch --check found no authed/shipping Opus/Sonnet and resolved Gemini to google/gemini-3.1-pro-preview:high. No public API signature changes are planned. LSP references were attempted but no language server is configured.
- **Evidence:** This iteration's pi-watch readiness output; xd://lsp references result; task scope contracts.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** The selected reviewer cannot complete a real review.
- **Source:** assumed — autonomous

## D3: Read kernel confirmation outcomes through the public snapshot API
- **Question:** How can the kernel consume a confirmation after Ask wait became connection-bound?
- **Options:** Bypass connection admission; borrow the requesting client's authority; add another public get API; use the existing public list snapshot.
- **Chose:** Match the exact confirmation Ask ID in `quirky.ask/list` and inspect its durable envelope. Retain the digest, answered-true and atomic one-time-use checks. Missing/expired asks refuse as unavailable. Preserve `wait` connection admission and disconnect cancellation.
- **Why:** Confirmations.request creates local asks as the kernel, but consume still called connection-only wait as the kernel. That deterministically fails at Dispatcher.dispatch before Ask's handler executes, for both client and plugin destructive consumers. The existing read-only snapshot works for either source without authority fabrication or API expansion. Its list scan is the tradeoff for reusing the existing contract.
- **Evidence:** packages/daemon/src/plugins/confirm.ts; packages/daemon/src/plugins/dispatch.ts connection admission; plugins/quirky.ask/quirky-plugin.json wait and list; baseline confirmation.test.ts three errors. Accounts lane11 notified via accepted Orca terminal receipt, no duplicated consumer shim.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Ask snapshot volume warrants a separately justified exact-get public API.
- **Source:** assumed — autonomous

## D4: Keep safe inert links and exact-session reveal rather than restore old defaults
- **Question:** Do failures in preview and panel tests identify forbidden elements or obsolete assumptions?
- **Options:** Strip inert anchors to satisfy an inventory assertion; restore session-null auto-open; verify navigation safety and current focus policy.
- **Chose:** Retain sanitized anchors with no URL/navigation attributes; replace the anchor-absence assertion with visible-text and navigation-attribute checks. A session-null ask stays available without selecting a panel; explicitly select Questions before checking that later asks leave it alone.
- **Why:** Neither an inert link nor an unrelated session-null question should change current user policy. README documents both behaviors, and main-ui tests already cover exact active-session reveal and user-selected-panel preservation.
- **Evidence:** plugins/quirky.ask/test/ui.test.ts SC-23; plugins/quirky.ask/test/panel.test.ts; plugins/quirky.ask/test/main-ui.test.ts; plugins/quirky.ask/README.md Presentation.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Real browser proof exposes navigation or focus stealing.
- **Source:** locked by docs/loop/decisions/m7-sweep-terminal-completion.md D3

## D5: A known resolved Ask cannot re-enter pending presentation from a stale snapshot
- **Question:** Why does a terminal summary restore the pending row and badge?
- **Options:** Alter durable FIFO; weaken the summary assertion; fence recently resolved IDs when refreshing.
- **Chose:** Reuse the existing bounded resolved-ID set when accepting pending snapshots. Keep the four-second flash and pending badge separate.
- **Why:** Resolution creates a flash and triggers a refresh; the recorded Q2 failure is the stale pending response reintroducing that same Ask. A terminal Ask ID does not revert to pending.
- **Evidence:** plugins/quirky.ask/src/store.ts refresh and resolve; plugins/quirky.ask/test/presentation-store.test.ts Q2.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Ask IDs ever become reusable (currently unique).
- **Source:** assumed — autonomous

## D6: Exercise public admission and uniqueness behavior rather than mirror storage inventories
- **Question:** Why did queue, CLI and migration fixtures fail after caller-authority changes?
- **Options:** Trust unauthenticated hello session labels; weaken admission; use supported create attribution and attach the CLI's question surface.
- **Chose:** Queue tests pass explicit `create.session` values and retain FIFO/promotion/deadline/restart assertions. The credential-metadata CLI case no longer supplies a fake session label; the actual-binary case attaches a window before registration. Migration coverage verifies both imported rows remain owner/request-null and duplicate non-null request IDs are refused; remove column/index inventory checks.
- **Why:** Direct local create attribution and authenticated register admission are different contracts. Register must not accept a session claim without a live owner; an attached surface admits an ordinary session-null caller. SQLite PRAGMA output has incidental metadata that is not the uniqueness guarantee.
- **Evidence:** plugins/quirky.ask/test/asks.test.ts SC14–SC19; plugins/quirky.ask/test/cli.test.ts SC3/SC20; plugins/quirky.ask/test/v1-import.test.ts migration4; main.ts registerAsk.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Canonical suites show registration or migration behavior differs from its public contract.
- **Source:** assumed — autonomous

## D7: Migrate the W2 fixture and retain failures under their existing canonical owners
- **Question:** What did the wider affected-consumer gate establish?
- **Options:** Treat every consumer failure as Ask; skip all consumers; migrate Ask mocks and retain named remaining failures with their owners.
- **Chose:** Migrate W2's fake Ask from wait to the existing list envelope contract. Keep real Ledger destructive confirmation, Accounts removal, resume-after-removal and first-account history assertions unchanged. Route remaining failures to `fix-test-{accounts,ledger,packages-cli,worktree}-1028` and the active Accounts owner; do not create duplicate items or bypass missing methods.
- **Why:** The affected run covered114 remote files plus1 macOS file:102 passed,13 failed. Only W2's fake Ask lacked the method this cutover now consumes. The actual confirmation consumers passed. Remaining failures show worktree/ownedIds, isolated Accounts session/create, Codex discovery and CLI wording/theme mirrors, not the connection-bound wait error.
- **Evidence:** affected suite artifact17, remote run1793224745065-84401; Ledger destructive test passed; Accounts accounts-api removal and Codex resume-after-remove passed; profiles file passed. Lane3 and lane11 accepted coordination receipts. W2 migration is under packages/daemon/test/w2-integration.test.ts.
- **Reversibility:** easy
- **Confidence:** high for observed outcomes; no all-consumer-suite pass claimed
- **Revisit if:** The final daemon gate or reviewer finds an introduced Ask consumer regression.
- **Source:** assumed — autonomous

## D8: Separate the trusted preview document head from untrusted preview content
- **Question:** Why did the first repaired SC23 attempt still fail?
- **Options:** Remove the trusted stylesheet; allow user style; scope the hostile-content assertion to its actual boundary.
- **Chose:** Check forbidden elements in the sanitized body, retain navigation-attribute and attacker-URL checks across the document, and add a hostile style payload. Keep the trusted head stylesheet and restrictive CSP.
- **Why:** The first canonical run passed19/20 files and failed only on the renderer's own HTMLHeadElement style. The current fixture then passed the complete19-file Ask suite with no flakes after this correction.
- **Evidence:** first suite artifact14 lines28–75 and summary; corrected `bun scripts/suite.ts plugins/quirky.ask`:19 passed/0 failed, suite-result ok:true/flaky:[],102.65s.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Actual browser behavior permits untrusted styles or external requests.
- **Source:** assumed — autonomous

## Progress
Both scoped implementers returned and scope audit passed; no production API/schema/manifest changes. Canonical Ask + daemon confirmation suite, scripts, typecheck and build are running. Current root fixes and fixture migrations are recorded above. Next: observe gates, actual isolated daemon/UI smoke, catch up roadmap, one cross-family final review and canonical land.
