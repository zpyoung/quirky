# m3-accounts-complete-user-acceptance-20261028 decisions

## D1: Complete the inherited acceptance contract on the existing plugin
- **Question:** What scope and approach resolve unattended brainstorming?
- **Options:** rewrite Accounts; mounted-only checks; extend existing public implementation and exercise remaining flows
- **Chose:** extend existing implementation; all inherited remaining flows, not a new switcher or narrowed acceptance
- **Why:** queue title and prior D9 explicitly enumerate the missing user observations. Existing ownership/history/authority rules bind this work.
- **Evidence:** accounts.md; docs/roadmap.md:13–55,183–188; m3-accounts D1–35; m3-accounts-remaining-flows D1–20; BLOCKERS Accounts entries
- **Reversibility:** medium (public behavior)
- **Confidence:** high
- **Revisit if:** a required flow conflicts with a locked decision
- **Source:** locked by docs/loop/LOOP.md and preceding Accounts decisions

## D2: Resolve gray areas with documented conservative defaults
- **Question:** Which purpose/consumer/success/constraints/scope/main-behavior and visual/API/integration defaults apply?
- **Options:** new design and auth protocols; existing layout/protocols with truthful error, identity and scope handling
- **Chose:** existing Usage/settings, Compact/Used defaults, durable preferences, last-good/error semantics, native CLI login, scoped idempotent resets and explicit removal confirmation; every UI flow uses public APIs
- **Why:** feature docs settle layout, information density, loading/empty/error state, interaction, auth, retries, mapping and idempotency. No human asks, visual companion, ADHD or research swarm; self-review the markdown combined specification.
- **Evidence:** completion logic.md AC1–11 and Technical decisions; external accounts.md
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** live source contradicts the acceptance contract
- **Source:** locked by accounts.md and docs/loop/LOOP.md

## D3: Preserve inherited metadata and use isolated implementation trees
- **Question:** How should untracked .serena and execution preflight be handled?
- **Options:** stage/delete inherited metadata; preserve it and isolate implementation
- **Chose:** leave .serena untouched; owned external temporary worktrees, at most3 implementers; IMPLEMENTER=omp task, AUTHOR_FAMILY=openai, REVIEWER_ALIAS=gemini
- **Why:** opus and sonnet probes returned unavailable; Gemini and Flash are reachable cross-family alternatives. Codex and Terra resolve as OpenAI. Bun1.4.0 and guarded web doctor playwright-cli0.1.22 are ready. LSP reports no configured server.
- **Evidence:** actual preflight outputs; initial tracked-clean detached checkout; /tmp/quirky-l11-accounts.fqr6gS
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** actual reviewer dispatch fails
- **Source:** assumed — autonomous

## D4: Resume failed cancellation observation and offer only executable restart choices
- **Question:** What should resolve tracked X1/G2 without hiding errors or changing process identity?
- **Options:** ignore cancel errors; silently relabel background runners; recover polling and restrict terminal restart candidates
- **Chose:** cancellation failure retains/reobserves the pending login with generation fencing; terminal-only stale restart projection while retaining stored background account identity and endpoint refusal
- **Why:** model.ts invalidates polling before cancel RPC and leaves it stopped on rejection. service.ts projects every session kind while restarts.ts rejects non-terminal execution. UI should not advertise an action the backend cannot execute.
- **Evidence:** BLOCKERS:463–464; model.ts:629–669; service.ts:886–926; restarts.ts:45–54
- **Reversibility:** easy
- **Confidence:** high for source-confirmed defect paths; post-fix runtime evidence recorded separately
- **Revisit if:** a public background restart capability is intentionally added
- **Source:** assumed — autonomous

## D5: Preserve native-only handoffs and historical limits
- **Question:** Can synthetic web/API observations close native clipboard/browser/Keychain/OS-focus or past incomplete reviews?
- **Options:** infer native success; retain explicit pending handoffs and exact evidence scope
- **Chose:** retain pending synthetic-only native scenarios; no real provider data, foreground control, credentials or native pass
- **Why:** authoritative LOOP requires web-only unattended dogfood and permits native handoff. Old reduced-independence/timeouts remain historical facts even after new checks.
- **Evidence:** docs/loop/native/m3-accounts-remaining-flows.json; preceding decisions D4/D10/D13
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** authorized native runner supplies results
- **Source:** locked by docs/loop/LOOP.md

## D6: Execute end-phase verification, not the former build-only waiver
- **Question:** Which test policy applies at claim?
- **Options:** typecheck-only build-first phase; normal end-phase testing
- **Chose:** normal verification, affected tests/scripts/typecheck/build and reachable user-surface scenarios
- **Why:** canonical status at claim shows m7-test-triage in-progress on lane8; LOOP says build-only overrides end once it is claimed. Combined logic/technical spec and fixed existing contracts avoid redundant schema work.
- **Evidence:** canonical queue status at claim; authoritative LOOP Build first/The end phase
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** explicit operator policy changes
- **Source:** locked by docs/loop/LOOP.md

## D7: Gate the actual integrated implementation and repair fixture boundaries
- **Question:** What did the isolated implementation and first gates establish?
- **Options:** trust worker completion; weaken failing assertions; audit scopes and repair the observed fixture/compile errors
- **Chose:** three disjoint components at4624dd97; parent-owned audit, targeted gates and integration71009b45/2ee40246; scratch-only runtime support
- **Why:** first UI gate exposed a removed import, then duplicate local declaration, then an incidental expanded-button text pin and ReactDOM input feature-detection before DOM registration. Repairs restore imports, remove the incidental pin in favor of visible Active/disabled selection, and intentionally initialize UI after test DOM. API gate exposed missing quirky.cli prerequisite and reset tests stopping at confirmation instead of intended errors; install the actual prerequisite and choose the public opt-out before capturing scope. No producer assertion or authority fence was weakened.
- **Evidence:** renderer23pass/0fail/200assertions4.82s, with React act warnings; daemon9pass/0fail/55assertions12.33s. typecheck/build exit0, combined132.26s; packaged build warns missing icon source. Component HEADs unchanged until parent commits; source writes matched scopes. Runtime1200-line helper moved outside repo rather than retained as permanent dead weight.
- **Reversibility:** easy
- **Confidence:** high for exercised gates
- **Revisit if:** post-catch-up evidence differs
- **Source:** assumed — autonomous

All three component clones lacked the same parent-only .serena entries; workers report no metadata operations. Parent metadata stayed untouched. Clone metadata was archived before owned trees were removed with the prescribed force removal; temporary branches were deleted only after merge (empty runtime branch was an ancestor). No unsupported attribution to a worker or deletion of parent metadata.

## D8: Prove actual continuation and native login recovery at their real boundaries
- **Question:** What smoke evidence can be claimed without real provider credentials?
- **Options:** account/ID echoes; actual daemon/PTY native-format transcripts with isolated external CLIs
- **Chose:** real daemon, transport, PTY and production AccountsUiStore; fake only external provider CLI/quota/security and one explicit Cancel transport-delivery failure
- **Why:** Codex A→B→remove-A→C read accumulated A/B user messages in C, appended continuation and rendered A/B/C identities after A's home vanished. A separate real native pending login retained its pending state after injected transport failure, resumed status reads and projected the completed account into the renderer store. This is not a browser/native OS pass.
- **Evidence:** codex-smoke result passed3.26s, all seven content/identity/home booleans true; cancellation smoke passed2.14s including teardown, actualDaemonNativeLoginCompleted/failedCancelTransportRetainedPending/statusPollingResumed/completionReachedRendererAccountState=true. Both owned smoke services exited0 after explicit stop.
- **Reversibility:** easy
- **Confidence:** high for named runtime boundaries only
- **Revisit if:** provider native formats or public resume contract changes
- **Source:** assumed — autonomous

Runtime fixture repairs were not product changes: match current main.js/vendor asset layout; use POST for loopback transport carrying external POST bodies; declare metadata state; include quirky.cli prerequisite; emit Codex's actual native URL marker and invoke Claude's run-owned BROWSER capture script. The smoke originally awaited an unobserved poll and later incorrectly required a null login after completion; production retains a completed status envelope, so readiness now waits for the trusted link and the consumer assertion requires completion rather than a spinning pending state. No URL allowlist or login parser was relaxed.

## D9: Coordinate shared repairs instead of duplicating owners
- **Question:** Which incoming failures belong to this item versus active repairs?
- **Options:** duplicate confirmation/model/CLI/overflow fixes; preserve named owners and merge their final contracts
- **Chose:** lane12 owns fix-test-ask-1028 confirmation repair; lane3 owns usage geometry/public Open/CLI key alignment and Codex discovery diagnostics; this item owns cancel polling, terminal eligibility and the isolated Accounts fixture prerequisite
- **Why:** explicit operator messages identify the owners and forbid aliases/bypasses. Current scripts gate113pass/13fail/945assertions157.72s exactly matches the already-done fix-test-scripts-1028 queue item, not a new defect to repair here. Final catch-up must bring that repair; no second queue item added.
- **Evidence:** operator interjections; canonical queue inspected m7-test-triage done and fix-test-scripts-1028 done; scripts/ui-review review+CLI failures; support/index.ts prerequisite communicated explicitly
- **Reversibility:** easy
- **Confidence:** high for ownership and observed failure signatures
- **Revisit if:** merged repaired source still fails
- **Source:** locked by operator coordination

## D10: Bound final review clearance to the actual source and valid dispatches
- **Question:** What assurance did the single final review round produce?
- **Options:** infer approval from empty or invalid attempts; preserve valid machine verdicts and operational limitations separately
- **Chose:** C/S/X final Gemini promote/refute and mechanical deep gates each PASS, zero findings, suppressed, advisory or contested records; Accounts code/tests/README only at4624dd97..e0ac29f2
- **Why:** the shared exact four-file remote prepass passed25.093s without flakes. Author decision-log reasoning was withheld from the bounded model artifact. Empty-claims mechanical excerpts unexpectedly fell back to the full target; contaminated refutes were discarded and replaced with actual fresh Accounts-only dispatches. C's final grants exclude bash; final source-only stages add no reproduction evidence.
- **Evidence:** review/{C,S,X}/{gate,manifest}.json; C/protocol-events.json; S/protocol-limitations.json; X/scope-and-limitations.json; actual prompts/raw replies/stderr
- **Reversibility:** easy
- **Confidence:** high for the recorded bounded machine verdict, not a completeness guarantee
- **Revisit if:** a changed source seam or runtime scenario fails
- **Source:** assumed — autonomous

Invalidated reviewers attempted prohibited commands despite prompts: S ran `bun test plugins/quirky.accounts/test/completion-api.test.ts`; X added the inactive-test filter; C invoked `npm run test` and later attempted a guarded single-file suite. Individual test outputs/exits and historical descendant cleanup were not captured, so none is verification evidence. C's latter shell guard was present, not proof the command executed. Parent's source check found no diff from the frozen source after the first incidents; a later PID/cwd snapshot found no matching test/suite command owned by lane11, while unrelated lanes' commands were left untouched. The final valid review attempts and the unauthorized attempts remain separately archived; absent output is never clearance.

## D11: Repair two defects exposed by genuine UI acceptance
- **Question:** Why did inactive account meters stay empty and stale reset dialogs offer only generic Retry?
- **Options:** click nonexistent row expanders; loosen scope fences or error matching; repair the producer/consumer contracts
- **Chose:** desktop inactive lookup uses `provider:accountId`, matching the daemon and mobile; four reset authority errors use public PluginContext Conflict errors, leaving provider-attempt errors and durable ledger ordering unchanged
- **Why:** real expanded Claude/Codex choices stayed placeholders although the daemon cached composite keys. The mounted fixture had bare keys, masking the defect. Correcting the fixture first produced22pass/1fail remotely; the lookup repair passed. Plain reset authority Errors were wrapped/prefixed by the dispatcher as internal errors, breaking the existing exact safe-message classifier; typed public conflicts preserve both authority and actionable refresh guidance.
- **Evidence:** presentation run20261028T220631-5ca5 obs6/19; switch/reset run20261028T220355-cbe0 obs65/72; Usage.tsx189; usage/index.ts451/462/469/477; new public Conflict/no-redemption/key-binding regressions. Corrected UI+API two-file remote gate passed16.29s; final usage/authority/UI/API four-file remote gate passed27.27s without flakes.
- **Reversibility:** easy
- **Confidence:** high for source/public-API proof; fresh guarded UI repair observations recorded separately
- **Revisit if:** an inactive consumer uses a different key contract or a reset error loses its public Conflict type
- **Source:** assumed — autonomous

This is the one accepted actual-UI-finding fix batch after the bounded review, followed by tests/build rather than another review round. Two additional public-API tests preserve nonempty native Claude/Codex conversation bytes, the exact managed home and saved identity through Needs-sign-in refusal, failed reauth and successful recovery. They supplement, not relabel, the lifecycle report's partial history verdict. No tautological nonempty check or incidental error-wording pin is retained in those reauth tests.

## D12: Retain exact browser evidence and continue automatic worker cutoffs
- **Question:** Can automatic worker wrap notices or a driver-refused terminal establish completed acceptance?
- **Options:** call partial runs complete; silently drop remaining flows; preserve partial reports and use fresh bounded verifiers
- **Chose:** retain every original report and continue remaining reachable scenarios with fresh small tasks; native opacity/OS-focus stays pending
- **Why:** the first presentation and switch/reset workers received automatic child wrap notices, not a parent/user scope reduction. Their unfinished provider errors, inactive rows, queued supersession and unknown-outcome retry remain active acceptance obligations. Lifecycle browser is closed and its private daemon stopped. A kept ended switch/reset browser was explicitly closed under the operator's cleanup instruction, without changing its report.
- **Evidence:** lifecycle20261028T220000-eb53: eight goals pass and two reauth-history goals partial; presentation215954-66ee/220443-7ad2/220631-5ca5 preferences pass across two same-home restarts, all details opened and three credential provider save/clear sequences observed; switching220355-cbe0 Ask/Always/Never and true old Codex Keep/resumed B prior contents observed, supersession blocked and retry unstarted. Fresh parent ZCode223128-8f43 passed valid7d25%/30d40% with plan/source; browser and daemon closed.
- **Reversibility:** easy
- **Confidence:** high for named observations only
- **Revisit if:** final reports or screenshots contradict the current acceptance map
- **Source:** locked by the full inherited acceptance contract

The initial ZCode external fixture supplied `usage` as consumed rather than total and omitted `currentValue`. Its error was truthful, not a product bug. The corrected isolated external fixture produced both actual meters through visible Refresh/Usage/ZCode actions. No production quota mapper was changed.

## D13: Run all subsequent tests remotely and close finished surfaces
- **Question:** How does the overload ruling change verification?
- **Options:** continue direct local single-file tests; route every test through the canonical suite runner
- **Chose:** `bun scripts/suite.ts <file-or-dir>` for every later test, including single files and scripts; only the runner's named macOS exceptions/native packaging remain local
- **Why:** explicit operator instruction names Mac load260 and idle remote capacity. Already-completed local checks predate that ruling. Guarded web flows remain actual user-surface checks, with browsers and fixture services closed immediately when finished.
- **Evidence:** operator interjection; scripts/test-on-macos.txt; subsequent single-file red and two/four-file green remote receipts; stopped smoke/lifecycle/ZCode service receipts
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** operator changes the execution policy
- **Source:** locked by operator remote-only verification instruction

## Progress
Initial fixes, one bounded source review and one genuine-UI defect fix batch are complete, with fresh remote four-file gate green. Fresh bounded verifiers are finishing inactive/error/read-only, queued supersession and reset retry/actionable stale-scope observations; opacity-refused keyboard/native handoffs stay explicit. Next: commit the accepted fix batch, catch up current roadmap once (Ask/scripts repairs landed), read incoming decisions, run final remote Accounts/scripts and typecheck/build, finish/close the remaining browser/daemon surfaces, retain evidence and canonical land. No broad-suite or native pass claimed.
