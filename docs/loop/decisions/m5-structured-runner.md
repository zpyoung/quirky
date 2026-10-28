# m5-structured-runner decisions

## D1: Build the shared background seams, not the downstream products
- **Question:** brainstorming purpose, consumers, success criteria and scope boundary
- **Options:** build shared seams; pull automation, loop and objective products forward
- **Chose:** Codex app-server structured execution; Claude and Codex structured resume; catalog-driven model/effort; reusable checks API. No automation/loop scheduling, editors, evaluators or objectives.
- **Why:** M5 explicitly lists seams first; no automation/loop/objective plugins exist in the starting tree. Consumers will call the shared methods when their items land.
- **Evidence:** docs/roadmap.md:202-228; RunnerSurvey research
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** downstream consumers cannot express their check execution through the shared contract
- **Source:** locked by docs/roadmap.md

## D2: Classify API, CLI and integration; resolve every relevant gray area autonomously
- **Question:** brainstorming process and who approves the design
- **Options:** wait for humans; accept recommended defaults and record each answer
- **Chose:** unattended default election. Skip visual companion and adhd; markdown specs; no UI/native scenarios in this seam item. Research context and alternatives via scouts; Codex reviews both specs.
- **Why:** nobody is watching and LOOP forbids human questions. Existing structured methods already provide the API/CLI surface.
- **Evidence:** docs/loop/LOOP.md:175-200; plugins/quirky.structured/quirky-plugin.json
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/loop/LOOP.md

## D3: Native provider runners share the existing structured journal and ask path
- **Question:** integration data mapping: app-server, exec JSON adapter, or terminal harness
- **Options:** native app-server behind StructuredRunner; codex exec per turn; reuse PTY harness
- **Chose:** native app-server stdio JSONL with initialization, thread/start or thread/resume, turn/start and turn/steer. Claude retains its SDK. Unsupported providers fail before registration.
- **Why:** only app-server supplies long-lived turns, resumable threads and bidirectional approvals without a terminal; the other approaches violate the locked architecture.
- **Evidence:** docs/architecture.md:145-178; https://developers.openai.com/codex/app-server
- **Reversibility:** medium
- **Confidence:** high
- **Source:** locked by docs/architecture.md

## D4: Resume creates a new session in the original directory, replaying original structured options
- **Question:** data mapping and conflict resolution: which identity, location and settings survive resume
- **Options:** mutate the old record; create a new session preserving provider conversation and launch snapshot; fresh conversation
- **Chose:** new structured record with resumedFrom, same cwd/worktree/agent, original launchSettings and recorded runner options. Persist provider thread ID for Codex and native session ID for Claude. Missing identity or directory is a conflict, never a fresh-session fallback. Expose structured/resume and delegate session/resume for structured records. Resume does not fork or change picks.
- **Why:** matches terminal resume contract and launch snapshot immutability; prompt starts a new turn when supplied, otherwise the resumed connection is ready for send.
- **Evidence:** plugins/quirky.session/src/sessions.ts:225-275; docs/loop/decisions/m1-launch-settings.md D16; docs/architecture.md:164-167
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** downstream consumers require structured conversation forks
- **Source:** assumed — autonomous

## D5: Error and approval paths fail closed, and stop bounds process lifetime
- **Question:** integration error responses, authentication, progress and CLI exit semantics
- **Options:** ignore unknown requests/errors; report failures and deny unsupported approvals
- **Chose:** use daemon auth and existing ask envelopes. Native execution/file approvals become asks; cancellation or invalid answers deny. Unknown server requests receive a protocol error. Transport/protocol failure journals diagnostics and exits, never done. Successful turns settle done; active send steers, idle send starts a new turn. Stop cancels asks, interrupts then closes/kills subprocess with bounded wait. No automatic retries.
- **Why:** unattended consumers must distinguish completion from failure and must not hang on approvals or orphan children.
- **Evidence:** docs/architecture.md:164-167; plugins/quirky.structured/main.ts:74-94,183-210; https://developers.openai.com/codex/app-server
- **Reversibility:** medium
- **Confidence:** high
- **Source:** assumed — autonomous

## D6: Reuse launch resolution unchanged; reject structured raw arguments
- **Question:** input format, precedence and output provenance
- **Options:** duplicate runner-specific catalogs; reuse quirky.agents/resolveLaunch
- **Chose:** existing model/options shape and validation; same resolver and snapshot for both providers. Pass model/effort as native SDK/protocol fields, not argv. Unset selections stay unset. Extra arguments remain refused. Reused/resumed sessions retain their original settings.
- **Why:** one catalog must yield both launch paths and snapshots must match execution.
- **Evidence:** docs/loop/decisions/m1-launch-settings.md D8-D19; launch-settings.md "Reused runs keep the session's original settings"
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/loop/decisions/m1-launch-settings.md

## D7: Checks are a built-in plugin with run and cancel methods
- **Question:** API response format, flag design, execution policy and cancellation
- **Options:** duplicate check processes per consumer; shared internal import; shared public plugin methods
- **Chose:** quirky.checks/run accepts command, worktree or absolute cwd, timeoutSeconds (1..600, default 60), optional caller-owned checkId. Returns ran/pass/exitCode/timedOut/aborted/stdoutTail/stderrTail/stdoutTruncated/stderrTruncated/durationMs/error. quirky.checks/cancel targets checkId. Consumer chooses defaults (loops pass 300), skip policies and evidence persistence; runner does not schedule or evaluate.
- **Why:** plugin consumers can use only public API and CLI users need the same behavior. The common operation is local shell execution; workflow policies differ.
- **Evidence:** docs/roadmap.md:204-208; automations.md "Prechecks"; fork-loops.md "Check-command mode"; packages/protocol/src/plugins.ts:48-80
- **Reversibility:** medium
- **Confidence:** high
- **Source:** assumed — autonomous

## D8: Checks preserve bounded tails and terminate process groups
- **Question:** performance mode, timeout, abort, nonzero status and empty output semantics
- **Options:** collect whole output; bounded streaming tails
- **Chose:** last 4000 characters of each decoded stream, truncation flags; exit 0 passes only without error/timeout/abort. Missing cwd, pre-aborted execution and spawn errors fail explicitly. Local detached process groups get TERM then KILL after 2 seconds, including descendants keeping streams open. Daemon/plugin shutdown cancels every run. Nonzero exit is evidence, not RPC transport failure.
- **Why:** inherited check contracts require bounded memory and cannot mistake timeout or cancellation for success.
- **Evidence:** automations.md:315-321; fork-loops.md:282-289
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by research/orca-features/automations.md and fork-loops.md

## D9: Implement with omp OpenAI tasks and review with Gemini fallback
- **Question:** subagent-driven-development preflight backend pairing
- **Options:** omp task + opus; omp task + Gemini
- **Chose:** IMPLEMENTER=omp-task, AUTHOR_FAMILY=openai, REVIEWER_ALIAS=gemini. Codex spec reviewer as required separately. Run journal /tmp/m5-runner-KYwwFv/journal.json. Width cap 4.
- **Why:** pi-watch --check in /tmp verified codex, terra, gemini and flash; opus/sonnet had no authenticated shipping model. Gemini is reachable and cross-family.
- **Evidence:** preflight output in this iteration; docs/loop/LOOP.md:99-105
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D10: macOS execution is the acceptance target
- **Question:** portability of process group cleanup
- **Options:** implement all OS process control now; portable APIs with POSIX cleanup and documented Windows gap
- **Chose:** build and test on macOS. Node subprocess and stream APIs where possible; Windows needs taskkill/process-tree handling and separate acceptance before support is claimed. Linux process-group behavior needs platform verification.
- **Why:** platform scope is locked; no silent cross-platform guarantee.
- **Evidence:** docs/loop/LOOP.md:48-49; docs/roadmap.md "Platforms"
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Linux or Windows milestone starts
- **Source:** deferred: platform

## D11: Smoke processes must isolate HOME as well as QUIRKY_HOME
- **Question:** initial missing-seam smoke unexpectedly logged writes to six real agent hook files
- **Options:** ignore the side effect; remove only Quirky-managed additions and isolate future processes
- **Chose:** removed the six managed additions using the existing targeted installer remove methods (codex, gemini, cursor, opencode, pi, omp), preserving foreign hooks/config keys. Future smoke processes use temporary HOME and QUIRKY_HOME, NODE_ENV=test or an explicit subset of built-ins, and clear agent home overrides.
- **Why:** startHarness defaults to a temporary daemon home, but hook installers intentionally resolve user HOME. The real-home guard only runs under NODE_ENV=test, absent from a standalone bun script. No byte-for-byte prior backups existed, so exact prior formatting is not claimed.
- **Evidence:** /tmp/m5-runner-KYwwFv/before.ts output; plugins/quirky.agent-status/src/install/common.ts:14-22; plugins/quirky.agent-status/src/hooks.ts:97-99; removal command reported all six managed paths
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** any new smoke starts the full real built-in set
- **Source:** assumed — autonomous

## D12: One connected runner owns each native conversation
- **Question:** Codex spec finding F2: resume while the original is connected or concurrent resumes
- **Options:** permit competing connections; automatically stop the old connection; reject live-owner conflicts
- **Chose:** reject conflicts, with atomic reservation before asynchronous registration/start. Stop/exit releases ownership; restart has no live owners.
- **Why:** avoids competing turn/approval routing without silently interrupting another consumer.
- **Evidence:** /tmp/m5-runner-KYwwFv/spec-review/gate.json F2; logic.md AC4
- **Reversibility:** medium
- **Confidence:** high
- **Source:** assumed — autonomous

## D13: Ask owns cancellation when its creating plugin is disabled or the daemon stops
- **Question:** confirmed Codex spec F1: structured context.call is revoked before deactivate
- **Options:** change kernel revocation ordering; add a general cleanup API; persist private ask owner and cancel from ask lifecycle
- **Chose:** private creating-plugin metadata from PluginCaller. On plugin.changed cancel pending asks for unavailable owners; on ask shutdown cancel plugin-owned approvals before closing store; startup cancels stale persisted plugin-owned approvals. User asks keep existing persistence semantics. No kernel lifecycle change.
- **Why:** cancellation belongs to the service owning the durable ask; preserves the locked revocation invariant and needs no new abstraction or permission API.
- **Evidence:** packages/daemon/src/plugins/host.ts:656-684; packages/daemon/src/plugins/runtime.ts:187-191; plugins/quirky.ask/main.ts:51-63; spec-review F1 reproduction
- **Reversibility:** medium
- **Confidence:** high
- **Source:** assumed — autonomous

## D14: Adjudicate every spec finding and build one wave of three disjoint components
- **Question:** Codex spec review reported NEEDS_FIXES with 16 findings plus a verified parser/resolver pointer correction
- **Options:** accept every generic prepass report literally; distinguish real contract defects from resolver limitations
- **Chose:** accept F1/F2 and fix via D12/D13. Address F3 with Purpose/Overview headings. F4/F6/F10/F12/F13/F14 are parser false positives over local names, comma ranges or commands: qualify names, separate ranges and label commands. F5/F7/F8/F9/F11/F15/F16 are deliberately new paths, not stale references: explicitly mark creation. Correct actual resolver pointer to core/resolve.ts and mandate Codex structured key mappings. No confirmed finding left unaddressed.
- **Why:** prepass cannot distinguish new files/commands from missing existing anchors; it is evidence of its own check failure, not proof the feature is unbuildable. Both Codex promote and fresh refute completed at high; review was same-family as required by LOOP step4, recorded reduced independence.
- **Evidence:** /tmp/m5-runner-KYwwFv/spec-review/{gate,manifest}.json; tech.md Code references
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

Implementation wave: T1 structured/session/catalog, T2 checks plugin, T3 ask ownership cleanup. Components have disjoint write scopes and no semantic build dependency, so all fork the committed specs and run concurrently. Width 3, cap 4 does not bind; no successor wave and therefore no checkpoint review. Final review remains three Gemini lenses after catch-up and green gates.

## D15: Gate component reports with observed behavior and repair root causes
- **Question:** implementation reports were unverified; first structured gate exposed omitted state and fixture defects
- **Options:** trust reports; weaken tests; repair observed defects and keep consumer acceptance
- **Chose:** initialize active/starting state, fix optional-prompt typing and fixture model/env types, correct newline framing in the scripted server log, preserve bidirectional RPC ID namespaces, and assert error codes rather than incidental wording. Use real temporary cwd for subprocess API tests. Preserve the first startup protocol failure rather than overwrite it with a later generic not-running error.
- **Why:** the parent observed runtime/type failures and actual malformed-frame diagnostics; none establishes acceptance without repaired passing commands. An ask worker's relative-path contamination was removed precisely and main audited clean before retry. Checks workspace setup prospectively added bun.lock scope; no competing lock writer existed.
- **Evidence:** structured component gate artifacts 72,74,77,79,81,83,85,92,94; checks 16 pass; ask 46 pass; authoritative scope/HEAD barrier before component commits ef16bc5,a1e87e6,6afe921
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D16: Installed Codex schemas define wire enums, not documentation shorthand
- **Question:** does the runner's camel-case approval/sandbox spelling match the installed protocol?
- **Options:** trust prose examples and permissive fake server; generate the installed CLI schema in an isolated home
- **Chose:** approvalPolicy on-request and sandbox workspace-write. The scripted app-server rejects invalid enum spellings so request acceptance tests detect the real failure.
- **Why:** actual generated ThreadStartParams schema lists these spellings. The stronger fixture failed before the source fix with -32602; after the fix provider/API acceptance passed. No model invocation or credentials were used.
- **Evidence:** env HOME=/tmp/m5-runner-KYwwFv/native-home CODEX_HOME=... codex app-server generate-json-schema --out /tmp/m5-runner-KYwwFv/native-schema; v2/ThreadStartParams.json definitions AskForApproval/SandboxMode; red artifact88, green94
- **Native smoke:** the installed Codex binary accepted initialize and thread/start with these enums in an isolated HOME/CODEX_HOME, then closed cleanly. Printed NATIVE_PROTOCOL_SMOKE_PASS; no turn or model invocation. Scripted real-daemon/CLI smoke separately exercised approvals and full resumed turns. Throwaway smoke scripts were removed.
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D17: A send waits for native startup, including immediately after resume
- **Question:** integrated CLI smoke resumed successfully but immediate send failed while app-server was still initializing
- **Options:** force every consumer to poll; await the already-owned startTasks promise in send
- **Chose:** await startup before provider send, retain failure if startup itself failed, and never start a new conversation as fallback.
- **Why:** asynchronous registration is existing API behavior, but initialization latency must not make valid immediate continuation unreliable. The actual CLI flow and permanent restart-resume test failed before the barrier and passed after it. Keep the Claude SDK lazy so Codex-only sessions do not load that provider.
- **Evidence:** integrated-smoke.ts initial failure; resume.test.ts immediate-send red artifact101 and passing rerun; real daemon/CLI smoke prints INTEGRATED_CLI_SMOKE_PASS with matching native ID/options and new Quirky ID
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D18: Preserve caught-up process ownership and unrelated scope decisions
- **Question:** integration merge brought three decision logs and test-process ownership changes
- **Options:** alter them for this feature; preserve their contracts and verify compatibility
- **Chose:** retain fix-sc31-first-shell-race, fix-test-process-leaks and m2-sidebar-extras decisions unchanged. No source conflict. New tests use temporary homes and existing harness ownership. Final campaign baseline is pinned integration commit 1f65c0de467e78bbcf73dc2ae82873ce4f666c94 so review covers this item rather than re-reviewing unrelated landed work.
- **Why:** the catch-up changes are test ownership or separate product scope, not new structured/check semantics. Review baseline is fixed before discovery; subsequent verdicts will not move it.
- **Evidence:** git merge build/roadmap result; all three imported decision logs read; integrated CLI smoke after merge
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/loop/decisions/fix-test-process-leaks.md

## D19: Lifecycle ownership excludes kernel confirmations
- **Question:** the first full required suite failed the existing destructive-confirmation flow
- **Options:** exempt the literal kernel ID; change dispatcher identity globally; classify lifecycle owners through the public plugin registry
- **Chose:** only registered plugin callers own asks. Kernel confirmations share role plugin but have no plugin.list entry, so they retain manual confirmation persistence. No special-case caller string or private kernel import.
- **Why:** the new cleanup incorrectly cancelled the synthetic kernel caller's confirmation on plugin.changed. The remote suite and its isolated rerun reproduced the missing pending ask; existing confirmation tests pass after the registry classification fix. Targeted ownership tests still pass.
- **Evidence:** final-round1/check.stdout: 409 remote files,408 passed,1 failed; check.stderr isolated confirmation failure; confirmation.test.ts now2pass, asks.test.ts36pass; scripts48pass; typecheck clean after typed fixture response/SQLite query corrections
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D20: Preserve the full gate and record slow-suite cost without changing runner configuration
- **Question:** required prepass took1613seconds and failed before script/type checks could run
- **Options:** skip or narrow the suite; tune protected runner mid-item; fix the owned regression and rerun the exact gate
- **Chose:** retain full remote suite, scripts and typecheck. No review over a red gate. Advisory: investigate remote-run concurrency and browser-context reuse where applicable; pytest-xdist is not applicable to this Bun repository. No runner configuration change.
- **Why:** all required checks must pass on the final source; the failed suite is evidence, not a pass. The native binary smoke used no model calls and no real home.
- **Evidence:** final-round1/check.json duration_ms1613188; full logs outside repo; subsequent targeted confirmations, ownership, migration and checks all pass with clean typecheck
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/loop/LOOP.md

## D21: Keep one-shot generation separate and pin the latest pre-review integration baseline
- **Question:** another catch-up landed source-control AI generation and the repaired SC-31 item before final discovery
- **Options:** migrate generation into checks; preserve the distinct contracts and rerun all gates on the merge
- **Chose:** preserve m2-source-control-notes-ai D15–D17,D23–D24,D32,D34,D36–D39,D43–D44 and fix-sc31-first-shell-race D1–D10. One-shot generation belongs to quirky.agents/generate, not shell checks or native structured conversations. Codex model/effort structured mappings survived the automatic manifest merge and unset choices remain unset. Pin final campaign baseline e7155edf410a6dfb14af32f6933d1988b8cf5187, replacing D18's earlier pre-discovery baseline.
- **Why:** the complete incoming logs were read in the CatchupDecisions survey; no conflicting decision was found. The final model discovery has not started. Run typecheck and script checks before the same complete remote suite to fail fast without reducing coverage.
- **Evidence:** CatchupDecisions report; plugins/quirky.agents/quirky-plugin.json Codex launchOptions and oneShot; core/resolve.ts structured resolution; merge result104files
- **Reversibility:** easy
- **Confidence:** high
- **Source:** supersedes m5-structured-runner D18 (review baseline only)

## D22: Complete all three final review lenses without treating transport failure as a pass
- **Question:** Final Round1 security refute could not start because an empty-claims fallback expanded the prompt beyond Darwin's argument limit
- **Options:** infer a pass from empty promote; rerun discovery; recover the unchanged empty-claims refute stage
- **Chose:** retain C/S results and all failed transport evidence. Stage empty artifact excerpts for the genuinely empty X claims, dispatch a fresh Gemini refute, then run merge/gate/manifest on the original chain. No second promote or source change during recovery.
- **Why:** both failed X attempts were exec Argument list too long, not reviewer judgments. Actual recovered refute returned valid []; deep X PASS has zero findings/advisories/limitations/exclusions. All final reviewers were google/gemini-3.1-pro-preview at high, full cross-family independence from OpenAI implementation.
- **Evidence:** final-round1-green/lenses/X/refute.attempt-{1,2}.stderr; refute-recovered.*; gate-recovered.json and manifest-recovered.json; C/S gate and manifest files
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D23: Accept the real close hang despite the evidence gate's line-range suppression, then close it with one fix batch
- **Question:** C1 was upheld by promote/refute but mechanically dropped because its quote named lines133–135 instead of the actual130–132
- **Options:** trust a line-mismatch suppression as substantive refutation; validate the claim and repair if real
- **Chose:** accept C1 HIGH. The source awaited child close indefinitely after group termination while an escaped child held inherited pipes. Added owned-stdio destruction and a bounded500ms final wait. Process group remains the ownership boundary; do not globally hunt or kill independent detached services. S1 was refuted because createAsk already clears tracking in finally. No other accepted finding remains.
- **Why:** a guardian-owned process reproduction hung until its watchdog killed the pipe holder (1505ms,exit1). The same reproduction after fix returned in253ms without watchdog intervention. A permanent escaped-stdio regression and all10 prior Codex tests pass; typecheck passes. No second final discovery round, as LOOP requires.
- **Evidence:** final-adjudication.json; C/merged.json standing HIGH and C/gate.json line mismatch; close-smoke runtime red/green; commit edda245; Codex tests11pass/43assertions; isolated fix HEAD/scope barrier passed
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## Verification before the accepted final fix
- Required gate on fc4ae09: typecheck clean; scripts48pass/217assertions;425remote files and2macOS-only files pass, no flaky reruns. Duration1118555ms. Exact logs: /tmp/m5-runner-KYwwFv/final-round1-green/check.{stdout,stderr,json}.
- Actual runtime: real daemon/CLI + scripted native Codex create, approval, stop/resume and immediate send; native ID/model/effort preserved; shared check succeeded. Installed Codex initialize/thread/start succeeded in isolated HOME with no model turn.
- C1 fix verification: native runner tests11pass and typecheck clean; owned runtime reproduction changed from watchdog-required hang to bounded close. Final required suite and packaged build still need rerunning on the fixed source.

## D24: Land only through the queue after the complete final gate
- **Question:** finishing-a-development-branch integration choice in the unattended lane
- **Options:** queue-controlled local integration; manual integration, push or PR
- **Chose:** commit the verified item, detach, then queue.ts land m5-structured-runner. Never check out main/build-roadmap or push. No human decision needed.
- **Why:** LOOP.md explicitly selects this integration path and independently rechecks the merge. Final required gate exits0 on fixed source: clean typecheck, scripts48pass, packaged macOS build, full suite passing after the runner's two successful isolated reruns.
- **Evidence:** final-verification/check.json command `bun run typecheck && bun test scripts && bun run build && bun run test`, exit0, duration1590659ms; source tree153adf1ce6cd8a9e3a2b1e9d49c2dab61ae2fa95
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/loop/LOOP.md

## Final verification
- `bun run typecheck`: exit0, no diagnostics.
- `bun test scripts`:48pass,0fail,217assertions across6files. Fixture suites intentionally print their own failing examples; the outer scripts suite passes.
- `bun run build`: exit0; UI, daemon, PTY host, CLI and11plugins bundled; packaged apps/desktop/build/Quirky.app. Warnings: optional macOS icon source missing, release.baseUrl unset so delta patch skipped.
- `bun run test`: exit0;425remote files plus2macOS-only files. Initial remote result423pass/2fail; isolated reruns passed pty-client.test.ts (9tests) and window-projects.test.ts (18tests). Final suite-result ok:true with these two flaky paths. No exclusions or test weakening.
- Targeted/native proof and Final Round1 outcomes are recorded above. No UI/native scenarios added, and no open accepted review findings.

## D25: Resolve public workspace types directly rather than requiring generated plugin links
- **Question:** the first queue land passed426remote files,2macOS files and49script tests, then integration typecheck could not resolve the new checks plugin's protocol imports
- **Options:** edit the protected queue to install dependencies; install during every typecheck; map the public workspace source entries explicitly
- **Chose:** root tsconfig paths for exactly the two existing public package exports: @quirky/protocol -> packages/protocol/src/index.ts and @quirky/protocol/node -> packages/protocol/src/node/index.ts. No private wildcard mapping, type suppression, runtime fallback or per-plugin special case. Preserve package exports and every consumer import.
- **Why:** the source graph is present in every worktree, but queue merge verification does not regenerate per-plugin node_modules links. These mappings select the same public modules as package.json and fully typecheck them without installer side effects. Do not modify the integration worktree or protected loop.
- **Evidence:** failed land output:426remote+2mac files pass without retries,49scripts pass, only3 missing-module TypeScript errors; lanes.ts mergeVerified verify sequence has no install; package exports lines7–8. Isolated fresh worktree with checks/node_modules removed: typecheck exit0, checks16pass, packaged build exit0. Commit3470472; scope audit changed only tsconfig.json.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** protocol public exports change; keep source mappings aligned with them
- **Source:** assumed — autonomous

## D26: Preserve the final catch-up's regex semantics and browser feasibility block
- **Question:** failed-land catch-up brought fix-ask-regex-budget-20261027 and sa-browser-agent decision logs
- **Options:** alter their contracts; preserve them and verify compatibility
- **Chose:** read both complete logs. Retain sound mandatory-literal prefilter plus original JavaScript regex semantics, unchanged100ms budget and runner retry policy. Browser agent remains blocked before implementation on target binding; no browser code or helper is introduced here. Neither changes creating-plugin ask ownership or the structured/check API.
- **Why:** these are independent contracts. The regex owner changed only matching predicates; the browser entry records no implementation. The caught-up merge introduced no source conflict. No new final discovery round is needed for the compiler's equivalent public-entry mapping.
- **Evidence:** fix-ask-regex-budget-20261027 D1–D7; sa-browser-agent D1–D18 and Progress; catch-up integration979b524dd2de7e3204d2fa30e14045ddf83a3f8c
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/loop/decisions/fix-ask-regex-budget-20261027.md

## D27: Preserve the implemented item and block on the protected queue-order gate
- **Question:** second queue land passed runtime verification but failed the queue's own dependency-order test
- **Options:** edit protected queue/test paths; suppress the gate; retry unchanged; formally block with the completed source preserved
- **Chose:** block at step7. No product flow is being deferred or stubbed: the complete core cannot be shipped through its mandatory integration gate until queue maintenance fixes the ordering.
- **Why:** m6-objective-landing is at zero-based queue index56 and depends on m6-sitter-github at57. scripts/build-loop/queue.test.ts:82-87 requires every dependency earlier in the file. Both queue.json and loop scripts are protected; supported CLI operations add items or change status, not reorder existing items. Latest integration has no pending queue/loop repair. Do not bypass or weaken the check.
- **Evidence:** second land:426remote files and2macOS files pass after window-projects' successful isolated rerun; then scripts48pass/1fail at queue.test.ts:85. Static queue query returns exactly the56->57 forward dependency. Current typecheck passes after catch-up. Latest integration9f15461fa22c0510b9e2ed0342cfe4553acf415a; updated LOOP.md and queue CLI read completely.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** authorized maintenance restores the queue's topological order and the scripts gate passes
- **Source:** locked by docs/loop/LOOP.md

## D28: Resume after the operator's authorized queue-order repair
- **Question:** whether D27's protected infrastructure blocker still prevents landing
- **Options:** remain blocked; change protected infrastructure locally; resume the restored branch against the operator's repaired integration branch
- **Chose:** resume build/m5-structured-runner, merge build/roadmap, leave the operator's build-loop commits untouched, rerun verification and land only through queue.ts.
- **Why:** the operator explicitly identified the authorized ordering repair as 4cf9720 and restored the branch and lane claim. queue.ts wait returned m5-structured-runner in-progress for lane12. The catch-up merged only shared queue/index/blocker state and the m5-ledger decision log, not product source.
- **Evidence:** operator interjection; queue.ts wait --lane12 output; successful git switch/merge; incoming m5-ledger D1–D20 and Progress read completely.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the required scripts gate still fails or the queue landing reports a new conflict
- **Source:** supersedes m5-structured-runner D27 (infrastructure blocker resolved by operator)

## D29: Preserve incoming ledger contracts without treating its blocked implementation as shipped
- **Question:** whether the incoming m5-ledger decisions conflict with the structured/check seams
- **Options:** revise the seams; preserve independent public-plugin contracts and the ledger's explicit blocked status
- **Chose:** retain the ledger's public SQLite/API ownership, authenticated actor provenance, revision/import semantics and exact partial visual evidence. Its D17 queue-order limitation has the same operator repair; its own final-review and landing work remain owned by that lane.
- **Why:** the merge brought the ledger's decision record, not ledger product source. None of D1–D20 changes native conversation ownership, ask cleanup, structured launch picks or checks execution. No second final discovery round or product edit is needed here.
- **Evidence:** docs/loop/decisions/m5-ledger.md:1–224; catch-up merge file list.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** future ledger source changes a shared public contract
- **Source:** locked by docs/loop/decisions/m5-ledger.md

## D30: Diagnose the scripts fixture timeout without weakening its assertion or budget
- **Question:** why the first resumed gate failed after the queue-order repair
- **Options:** edit the scripts test or extend its budget; block on one timing failure; isolate the failing test and rerun the unchanged complete gate
- **Chose:** isolate the exact failed test, then rerun the complete unchanged gate. No code, timeout or assertion changes.
- **Why:** typecheck passed and the queue-order test no longer failed. scripts/suite.test.ts:54 timed out at5002ms; its afterEach removed the fixture cwd while rerunAlone continued, producing the secondary git spawn ENOENT. The exact isolated test passed in4.37seconds with its intended nested fail-then-pass behavior. This supports a load-sensitive timeout, not a product regression.
- **Evidence:** first resumed gate artifact://5:54pass/1fail/1error; scripts/suite.test.ts:9–14,54–58; scripts/suite.ts:82–101; isolated run artifact://7:1pass/0fail/12filtered. The first gate stopped before build/full suite.
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** the unchanged full gate repeats the failure or queue landing cannot pass it
- **Source:** assumed — autonomous

## D31: Preserve partial verification and clean the exact timed-out remote run
- **Question:** how to proceed after the outer3600second command deadline interrupted full-suite verification
- **Options:** claim the partial suite passed; leave remote processes running; clean only the identified run, verify affected consumers without an outer deadline, and retain queue landing's complete gate
- **Chose:** preserve the incomplete run as no verdict. Typecheck, scripts55pass/303assertions and packaged build passed. The two macOS files passed; the426file remote run did not finish. Terminated only the named worker/process-scope groups after checking their commands, removed its exact remote copy, and started affected-consumer verification with no outer deadline. queue.ts land remains the authoritative full-suite gate.
- **Why:** full output reported one SC-29 git window waitFor failure (other5tests passed), then the outer deadline terminated the local command before the runner's final rerun/verdict. Ownership inspection found worker4052114 and guardian2015192 under only /home/quirkyci/runs/1793129625748-96573; cleanup verified both absent. No foreign queue lock, lane process, tests or timeout budgets were changed.
- **Evidence:** bg_4 full output; successful cleanup exit0; no-deadline command covers structured/checks/ask/session/agents/daemon/CLI/protocol plus the exact SC-29 file.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** affected verification or queue landing reports a repeatable failure
- **Source:** assumed — autonomous

## D32: Repeat affected verification on the operator's replacement host
- **Question:** whether the operator-stopped old-host affected-suite run establishes a product failure
- **Options:** act on overloaded-host timings; repeat the exact command on the operator's new idle16core host
- **Chose:** repeat the identical affected-consumer command without code or test-budget changes and retain the stopped run as inconclusive.
- **Why:** the operator reported old-host load35, stopped that run, and instructed the exact retry against the updated remote configuration. The old run ended137 after timing-sensitive failures and a process-scope guardian start failure; it has no successful suite verdict. Its runRemote finally reached cleanup before announcing local fallback.
- **Evidence:** operator interjection; bg_5 output for runs/1793133181848-37851; identical command restarted as bg_6 with no outer deadline.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the replacement-host run reproduces a failure
- **Source:** assumed — autonomous (operator-directed environment repair)

## D33: Supply the scripted native fixture's existing Node prerequisite on the replacement host
- **Question:** why Codex tests fail immediately and consistently on the otherwise working replacement host
- **Options:** change the production transport or fixture interpreter; provision the host's missing existing prerequisite
- **Chose:** install Ubuntu nodejs through noninteractive sudo on quirkyci@34.122.38.64, verify /usr/bin/env node --version, then repeat unchanged affected verification.
- **Why:** the fixture is an executable JavaScript app-server with #!/usr/bin/env node. NativeStartupFix's throwaway shebang probe reproduced exit127 because node was absent from the suite PATH; Bun was present. No transport request could occur. Host installation completed successfully and node reports v18.19.1. No source/test assertion or timeout change is justified by that missing interpreter.
- **Evidence:** NativeStartupFix diagnosis/history; replacement-host affected suite162files158pass4fail, isolated resume failure persists; apt-get update/install exit0 and /usr/bin/env node --version v18.19.1 (artifact://19).
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** post-install native tests still reproduce stdout closure
- **Source:** assumed — autonomous

## Resumed verification after host provisioning
- `bun run typecheck`: exit0, no diagnostics.
- `bun test scripts`:55pass,0fail,303assertions across6files. The earlier timed-out fixture run remains recorded in D30.
- `bun run build`: exit0; packaged Quirky.app, with unchanged optional icon/release.baseUrl warnings.
- `bun scripts/suite.ts plugins/quirky.structured plugins/quirky.checks plugins/quirky.ask plugins/quirky.session plugins/quirky.agents packages/daemon packages/cli packages/protocol plugins/quirky.git/test/window/remote.test.ts`: exit0 on quirkyci@34.122.38.64;162files passed,0failed,flaky:[],129.59seconds. This includes all affected native/API/resume/check/approval paths and the prior SC-29 failure.
- No product source changed during resumption. The earlier real daemon/CLI/native-process smoke and single final-review/fix batch remain applicable. No new UI/native scenarios.
- Next mandatory gate is queue.ts land's full merge-result verification; interrupted/old-host runs are not represented as passes.

## D34: Preserve verified source when foreign dirty integration state prevents both landing and blocking
- **Question:** how to finish the mandatory queue landing after its clean-worktree precondition fails
- **Options:** alter the integration queue manually; force a commit of foreign entries; preserve the verified source and register an infrastructure blocker through the supported API
- **Chose:** never modify the integration worktree or its queue. Preserve the verified item and attempt formal block registration through queue.ts, retaining any registration failure as evidence.
- **Why:** land exited1 before running merge verification because integration docs/loop/queue.json is modified. Read-only investigation found only appended race-item and active-item entries; their origin is unknown. One process snapshot found no live queue owner. The source contains neither identifier under scripts. All queue mutations, including block, use the same requireClean guard; no supported command removes/reconciles these entries.
- **Evidence:** queue.ts land output after2525760; LandingStateScout inspection of integration diff, lanes.ts:78–83,218–224,278–350 and process snapshot; literal scripts search returned no matches. Implementation remains unchanged and all162affected test files pass.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** authorized owner reconciles the dirty integration queue; then restore/requeue as needed and retry landing without rebuilding the implementation
- **Source:** locked by docs/loop/LOOP.md

## D35: Resume operator-prioritized landing after the queue repair
- **Question:** whether to stop after the landed window-projects fix or resume structured-runner integration
- **Options:** retain the earlier blocked state; follow the operator's explicit priority and ownership reassignment
- **Chose:** resume build/m5-structured-runner, merge build/roadmap, resolve conflicts, verify affected consumers/scripts/typecheck and retry queue.ts land for this item.
- **Why:** the operator removed the fake queue entries, restored this item in progress, attempted its land, then returned ownership to lane12 because m3-accounts, m4-hosting-api-github and the window-projects fix caused integration conflicts. This instruction supersedes the one-item stop and earlier operator-owned landing. D34's infrastructure blocker is repaired by the operator, not bypassed by this lane. The known PTY manager flake has its own fix item.
- **Evidence:** operator interjections in iteration4; git switch build/m5-structured-runner and git merge build/roadmap reported conflicts in plugins/README.md and four quirky.structured files.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the supported land gate exposes another unresolved prerequisite
- **Source:** assumed — autonomous (operator-directed resumption)

## D36: Compose incoming account preparation with the existing native runner
- **Question:** whether the newly landed account/hosting decisions require changing m5's design
- **Options:** choose one branch's runner; compose required account preparation with native provider start/resume and preserve independent hosting methods
- **Chose:** preserve both contracts. The incoming decision inventory found no design conflict: account preparation stays a required public API call before spawn, native provider identity/options/snapshot and single-owner resume remain m5's responsibility. Keep both public protocol TypeScript paths and workspace-install gates. Retain additive structured/checks and hosting documentation.
- **Why:** IncomingDecisionScout read all incoming decision logs (m1-agent-status-scripting, m3-accounts, m4-hosting-api-github, window-projects fix; m5 identical at incoming tips) and the account/hosting specs. M3's real prior-conversation cross-account resume and fail-closed preparation do not replace m5's native conversation lifecycle. M4's guarded GitHub API is independent. The merge touches shared protocol/daemon/CLI/UI consumers, so broad package/app/plugin verification is warranted rather than only structured tests.
- **Evidence:** IncomingDecisionScout completed report; docs/loop/decisions/m3-accounts.md; docs/loop/decisions/m4-hosting-api-github.md; docs/loop/decisions/m1-agent-status-scripting.md D45; docs/loop/decisions/fix-flaky-quirky-worktree-window-projects.md; additive plugins/README.md conflict resolution.
- **Reversibility:** medium (cross-plugin launch contract)
- **Confidence:** high for compatibility; reconciliation verification pending
- **Revisit if:** tests or native/CLI smoke expose a concrete integration mismatch
- **Source:** locked by docs/loop/decisions/m3-accounts.md

## D37: Close the concrete structured-Codex account gap before landing
- **Question:** whether preserving only the incoming Claude preparation path also preserves managed Codex account selection
- **Options:** land the syntactically resolved merge; compose Codex preparation and per-run environment before native app-server spawn
- **Chose:** repair the integration before landing, with a failing-before/passing-after scripted-process regression. Do not claim account support based on mock forwarding assertions.
- **Why:** targeted IncomingDecisionScout inspection confirmed that create/resume prepares accounts only for Claude; session resume delegates structured sessions before its terminal account path. CodexRunner also projects options down to model/effort and uses deps.env or process.env for the subprocess. Therefore a selected managed Codex account's CODEX_HOME never reaches structured execution and can authenticate the wrong identity. M3 already ships this account behavior; honoring it for m5's newly enabled Codex structured path is required composition, not a new account feature. Await current gates before changing their source snapshot.
- **Evidence:** plugins/quirky.structured/main.ts:496–527,610–654; plugins/quirky.session/src/sessions.ts:386–405,430–438; plugins/quirky.structured/codex-runner.ts:68–78,214–217; plugins/quirky.structured/codex-connection.ts:47–54; plugins/quirky.accounts/src/service.ts:386–475.
- **Reversibility:** medium (credential identity at spawn)
- **Confidence:** high for the observed code path; red/green execution pending
- **Revisit if:** process-boundary regression disproves the environment gap
- **Source:** locked by docs/loop/decisions/m3-accounts.md

## D38: Preserve the first merged scripts failure without altering protected tests
- **Question:** how to interpret the first merged local gate before the account integration correction
- **Options:** change protected test code/budgets; report the failed gate and rerun unchanged after integration stabilizes
- **Chose:** retain the failure, leave scripts and their timeouts untouched, and rerun the exact required commands after the integration fix.
- **Why:** frozen install succeeded (183 installs/188 packages, no changes). bun test scripts returned54pass/8fail, with five-second fixture/land timeouts and a cleanup-hook timeout. Their fixture teardown then produced secondary missing-cwd/git errors. Typecheck was not reached because the command used &&. A subsequent uptime snapshot showed local load averages236.36/256.13/164.63; load sensitivity is supported but does not turn the failed gate into a pass. No foreign processes were killed, no protected source changed, and the known separate PTY manager flake remains separate.
- **Evidence:** bg_15, artifact://34; uptime output in this iteration. Earlier identical scripts gate before this resumption passed62tests (window-projects item D10).
- **Reversibility:** easy
- **Confidence:** high for observed failure/load; final gate pending
- **Revisit if:** unchanged final scripts still fail when runnable
- **Source:** assumed — autonomous

## D39: Preserve the first broad merge snapshot's green result without mistaking it for account coverage
- **Question:** whether a passing full suite permits ignoring the directly observed Codex account gap
- **Options:** land because existing tests pass; add the missing consumer-visible regression and repair D37 first
- **Chose:** repair the account integration and rerun final verification. The first broad snapshot did pass457remote files plus2macOS files under the supported isolated-retry policy, but it had no structured-Codex managed-account coverage.
- **Why:** remote worktree/create's background-ref-refresh wait failed initially and passed its isolated40test rerun. The macOS terminal/features-pane file timed out initially and passed all5tests alone. The suite exited0 after927.35seconds; no assertions or budgets were changed. PTY manager did not fail this run. A passing suite cannot establish a behavior it never exercises.
- **Evidence:** bg_16; suite-result {\"ok\":true,\"flaky\":[\"plugins/quirky.worktree/test/create.test.ts\"]}; separate macOS file rerun output.
- **Reversibility:** easy
- **Confidence:** high for the exercised snapshot only
- **Revisit if:** new regression or final snapshot verification fails
- **Source:** assumed — autonomous

## D40: Use actual child identity and failure-before-spawn as the account regression
- **Question:** which permanent test demonstrates the account-composition defect rather than copying mock options
- **Options:** keep a fake-runner forwarded-options assertion; observe the scripted native app-server child's CODEX_HOME through the daemon API and require preparation failures to refuse create
- **Chose:** retain two process/API scenarios: selected Codex home on create/resume with destination transcript locator, and fail-closed preparation with no spawned app-server. Removed the integration agent's newly added forwarding-only Claude-resume test; existing unrelated assertions were preserved.
- **Why:** before any production correction, both new scenarios failed on the remote host and on the runner's isolated retry:26pass/2fail each. The actual child observed CODEX_HOME=null instead of the managed path; failed account preparation incorrectly allowed creation. Separate fixture environment evidence leaves exact native protocol request comparisons unchanged. StructuredMerge is now authorized to apply provider preparation, per-run env overlay/null deletion and the optional relocated resumeTranscriptPath.
- **Evidence:** bg_18 exit1,48.21seconds; plugins/quirky.structured/test/structured.test.ts; test/fakes/codex-app-server.ts; test/fakes/world.ts. Unchanged scripts retry bg_17 passed62tests/460assertions in81.86seconds.
- **Reversibility:** easy (targeted coverage)
- **Confidence:** high for reproduced wrong-account and fail-open behavior; green pending
- **Revisit if:** repaired process behavior or existing contracts fail
- **Source:** assumed — autonomous

## D41: Re-exercise the merged native lifecycle through the real CLI
- **Question:** whether account integration preserves the existing end-to-end native/session/check behavior
- **Options:** rely only on tests; run an isolated real daemon/CLI smoke with the scripted native app-server
- **Chose:** run the standalone smoke and preserve its observed failures as scaffolding corrections, not product changes.
- **Why:** the final smoke passed production Codex routing, native approval and accept reply, stop/resume with a new Quirky ID and same native thread, immediate send, immutable launch snapshot/original journal, and shared checks without PTYs. It printed M5_MERGE_SMOKE_PASS and exited0 in9.40seconds. Earlier attempts exposed three smoke assumptions: /var and /private/var needed canonical path comparison; fixture request logs record inbound traffic rather than its outbound approval request; resumed provider metadata is captured asynchronously, so validate it after the immediate continuation succeeds rather than in the initial registration response. No product behavior was changed for those assumptions. Every attempt awaited owned process-scope cleanup with temporary HOME/QUIRKY_HOME and cleared credential overrides.
- **Evidence:** bg_20, bg_21, bg_23 failures; bg_25 pass; /tmp/lane12-m5-merge-smoke.ts (removed after proof). Scripted provider only, no paid model call or real account state.
- **Reversibility:** easy
- **Confidence:** high for exercised native/CLI paths; no UI/native-window scenario added
- **Revisit if:** final merge-result verification fails the same lifecycle
- **Source:** assumed — autonomous

## D42: Deduplicate identical protocol path maps after the automatic merge
- **Question:** how to handle the smoke's duplicate compilerOptions.paths warning
- **Options:** leave the duplicate and rely on last-key precedence; keep one identical map
- **Chose:** remove the first duplicate paths block and retain the identical map for @quirky/protocol and @quirky/protocol/node.
- **Why:** both sides added exactly the same source mappings at different positions, so Git's clean merge produced duplicate JSON keys. Keeping one map preserves both binding public-protocol-resolution decisions without changing resolution semantics or suppressing the warning. The incoming frozen-install typecheck command remains intact.
- **Evidence:** bg_25 warning tsconfig.json:26; both original maps pointed to packages/protocol/src/{index.ts,node/index.ts}; surgical removal of only the duplicate block.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** final typecheck shows another mapping requirement
- **Source:** assumed — autonomous

## D43: Accept the repaired integration only after fresh green consumer and local gates
- **Question:** whether the account-composition fix and conflict resolutions are ready for the supported merge-result gate
- **Options:** rely on the first broad snapshot or partial commands; require final affected consumers, scripts, typecheck and smoke
- **Chose:** proceed only after final green verification. All171affected files passed on the remote host with no flakes (434.14seconds), including the previously red actual-child account scenarios. The full earlier merged snapshot passed457remote+2mac files (D39).
- **Why:** the final local scripts attempt had61pass/1five-second fixture timeout; its exact isolated case passed in2.73seconds and the unchanged complete scripts retry passed62tests/460assertions in65seconds. No protected test/budget changed. Independent typecheck initially exposed a missing StructuredLaunchOptions type-only test import from conflict reconciliation; the owner added the import without runtime changes. Fresh bun run typecheck then passed (frozen install183/188, no changes;11.64seconds). The standalone native CLI smoke passed (D41). These are final-source checks, not a claim that prior failed runs passed.
- **Evidence:** bg_19 suite-result {\"ok\":true,\"flaky\":[]}; bg_24/artifact://48; bg_27/artifact://51; bg_26 diagnostic; bg_28 exit0; bg_25 smoke. plugins/README.md and logic/tech specs now describe existing-account composition; no new UI/native scenario.
- **Reversibility:** easy
- **Confidence:** high for exercised final integration
- **Revisit if:** queue.ts land fails its merge-result verification
- **Source:** assumed — autonomous

## D44: Check the account reconciliation without reopening the completed feature review
- **Question:** how to review new cross-feature identity handling after the original final review/fix batch
- **Options:** repeat whole-feature discovery; inspect only the operator-directed account reconciliation against its concrete invariants
- **Chose:** a narrow cross-family evidence review of the merged main/runner/Codex source, retaining the original final review as the feature's authoritative review.
- **Why:** Gemini through pi-watch reviewed actual source for preparation-before-spawn, fail-closed cleanup/ownership, explicit-home precedence, null deletion, transient environment and relocated resume identity. It returned STATUS: PASS with no confirmed defects. No further fix batch or full discovery round was opened. All implementing/research agents, reviewer, load/suite and smoke processes returned; external smoke scaffolding was removed after proof.
- **Evidence:** bg_22 (google/gemini-3.1-pro-preview:high),191.09seconds,exit0; D37–D43; successful removal of /tmp/lane12-m5-merge-smoke.ts.
- **Reversibility:** easy
- **Confidence:** high for the scoped reviewed invariants
- **Revisit if:** merge-result tests show a concrete integration defect
- **Source:** assumed — autonomous

## D45: Reconcile a newer integration tip instead of discarding verified m5 work
- **Question:** how to proceed when the next supported land conflicts after cc631cf passed verification
- **Options:** stop on the conflict; discard m5 source to match the new integration tree; merge the new tip and preserve both intended features
- **Chose:** merge the latest build/roadmap and reconcile its changes while retaining the verified m5 implementation/account composition. Trace incoming deletion provenance and all silent backouts before final verification.
- **Why:** queue.ts land exited1 before merge-result tests (4.78seconds), naming a branch conflict. The next merge exposed deleted/modified m5 native files/specs plus structured-source and documentation conflicts. The incoming log's competing Progress is only the stale D34 infrastructure blocker, superseded by the operator's D35 instruction; it does not authorize dropping m5. New Session Info documentation must coexist with structured/checks/hosting guides. Automatic merges can silently remove unchanged m5 files too, so restoring only marker blocks would be incomplete.
- **Evidence:** bg_29; subsequent git merge build/roadmap output; decision-log conflict had current D44-ready progress versus old D34-blocked progress; plugins/README.md interleaved Session Info with structured sections; missing checks/native transport files observed by StructuredMerge.
- **Reversibility:** medium (cross-feature integration)
- **Confidence:** high for the observed conflict; incoming deletion provenance still being traced
- **Revisit if:** a new binding decision explicitly reverses the operator's requested m5 scope
- **Source:** assumed — autonomous (operator-directed landing continuation)

## D46: Restore the unlanded candidate removed by handoff's cleanup, not an obsolete feature design
- **Question:** what the incoming native/check/spec deletions mean for the operator-requested m5 landing
- **Options:** interpret the cleanup as a new design prohibition; retain shipped handoff changes while reintroducing m5 as its own item
- **Chose:** restore m5-native/check/schema/test/spec surfaces from verified cc631cf while preserving incoming Session Info and account-source provenance.
- **Why:** IncomingDecisionScout traced deletion to2aba9d9c4d19160376415f4e6e532d642bc7eb20, “fix(handoff): preserve shipped schema and exclude unlanded candidate.” This removed an unlanded m5 candidate from the handoff branch, not the requested m5 item. Latest integration still marks m5 in-progress lane12. Two merge bases explain why triple-dot history against9871d322 hid the backout while ab2c87db contained m5. Restore both explicit modify/delete conflicts and silent native transport/path/test/check removals; keep new accounts/sessionHome and handoff's recorded-source-home lookup, plus Session Info/public JSON-argument composition.
- **Evidence:** Scout report HEADcc631cf/MERGE_HEAD1df36ca, bases9871d322/ab2c87db; cleanup commit2aba9d9c; docs/loop/decisions/m3-handoff.md D79/D80; incoming structured manifest explicitly reverted to Claude-only while the queue retains the m5 item.
- **Reversibility:** medium (cross-feature merge composition)
- **Confidence:** high
- **Revisit if:** final source/gates reveal a genuine new incoming contract not preserved
- **Source:** assumed — autonomous (operator-directed feature landing)

## D47: Preserve the three new binding decision logs and their public contracts
- **Question:** which incoming decisions arrived after the first integration verification
- **Options:** treat the cleanup as authority to replace m5; compose all newly shipped contracts with the verified candidate
- **Chose:** preserve the incoming handoff, Session Info and Git-flake decisions. Scout read all three new logs and the only changed existing log (m5's stale D34); no other decision file changed between9871d322 and the new integration tip.
- **Why:** handoff D77–D84 requires recorded effective source-home lookup without account switching, explicit-unset provenance, bounded/contained transcript recovery, and both openSession/addTab/NewTabIds APIs. Session Info's finishing decisions preserve names/settings/metadata, cloned replay launch records, required Accounts preparation, visible focus/accessory contributions and immutable composable JSON arguments. The Git repair replaces event sleeps with ordered subscription-receipt barriers without weakening assertions. None prohibits m5's native/check features or its account-composition fix.
- **Evidence:** docs/loop/decisions/m3-handoff.md D77–D84; docs/loop/decisions/m3-session-info.md D28–D36 and finishing records; docs/loop/decisions/fix-flaky-quirky-git-files-scenarios.md D1–D7; IncomingDecisionScout completed inventory.
- **Reversibility:** medium (shared public launch/UI contracts)
- **Confidence:** high
- **Revisit if:** final combined tests expose an actual incompatible contract
- **Source:** locked by docs/loop/decisions/m3-session-info.md

## D48: Verify restoration at both the type and real consumer boundaries
- **Question:** whether marker-free restored files alone prove complete m5 restoration
- **Options:** trust the restoration report; require types and real default-catalog native execution
- **Chose:** treat both observed failures as incomplete restoration and repair them without dropping assertions or launch picks.
- **Why:** the first restored typecheck found20test-only diagnostics from missing startAsk/createAgent/provider-session fixture declarations; the owner restored those exact helpers from cc631cf. A standalone real CLI/native smoke then refused Codex model selection before spawn, proving that the incoming cleanup also removed the actual agent catalog's structured model/effort mapping. FakeWorld resolver tests do not exercise that catalog. Restore its verified mappings and keep a focused real CLI/catalog/native-process regression for AC5, rather than masking the failure by omitting model/effort. The broader remote run is an isolated snapshot of the pre-helper-correction tree and cannot establish final green by itself.
- **Evidence:** bg_44/artifact://89 (20diagnostics,3testfiles); owner test-helper correction; bg_45 invalid-params “Agent codex does not support launch-time model selection.” bun install saved restored workspace metadata (185installs/190packages,46ms).
- **Reversibility:** easy (restoration/coverage)
- **Confidence:** high for reproduced omissions
- **Revisit if:** focused real consumer regression or final combined verification fails
- **Source:** assumed — autonomous

## D49: Keep a real CLI/default-catalog/native-process regression for launch and resume
- **Question:** how to prevent fake resolver/session fixtures from masking public contract backouts
- **Options:** only restore data and rely on fake-plugin tests; exercise the default catalog, generated CLI and native app-server together
- **Chose:** add one isolated native lifecycle scenario in cli-native.test.ts: create with model/effort, stop, public session resume, immediate send, and verify native thread/picks plus stored identity/snapshot.
- **Why:** the first permanent scenario failed before catalog restoration with the exact unsupported-model error (bg_46,2.96seconds). Restoring Codex's model/effort structured mappings made creation pass. Extending the same flow then failed before registration-schema restoration with “params.cwd is not allowed” (bg_49,6.24seconds), then exposed resumedFrom=null after schema repair (bg_50,4.89seconds). The registration implementation accepted the parameters but ignored them. The corrected implementation validates/applies original cwd and source identity before SessionRecords.insert. The final complete real scenario passed35assertions in5.17seconds, and the full native approval/resume/check smoke passed.
- **Evidence:** artifact://92 and artifact://97; bg_45/bg_46/bg_47/bg_49/bg_50/bg_53; plugins/quirky.agents/quirky-plugin.json; plugins/quirky.session/{quirky-plugin.json,src/sessions.ts}; plugins/quirky.structured/test/cli-native.test.ts. No paid model calls or real account state; all processes/homes are owned and cleaned.
- **Reversibility:** easy (consumer regression and faithful restoration)
- **Confidence:** high for observed launch/resume behavior
- **Revisit if:** final remote or merge-result gate fails this lifecycle
- **Source:** assumed — autonomous

## D50: Restore fixture contracts and delete obsolete copies instead of repinning them
- **Question:** how to handle old fixture declarations and catalog-copy assertions reintroduced by the cleanup merge
- **Options:** weaken runtime validation or repin implementation copies; restore fixture APIs and retain behavior-level checks
- **Chose:** restore fake session setProviderSession declaration and fake agent resolveLaunch implementation/declaration, retaining incoming prepareLaunch/prepareResume behavior. Delete two obsolete raw Codex catalog/structured-key copy tests and the structured method-name-list wiring test; remove their unused helper/import. Keep unsupported-agent validation using a genuinely unsupported provider and error codes, not Claude-only wording.
- **Why:** older isolated snapshots failed on undeclared fake methods, obsolete Claude-only assumptions and raw object equality after adding real Codex support. No production alias, fake fallback or assertion suppression fixes those. The real CLI/native lifecycle now covers actual support/picks/resume, while meaningful existing API and provider tests remain. The corrected five-file local run passed ask36, structured27, Claude23, session-resume23 and agents-manifest20 tests.
- **Evidence:** bg_51/artifact://100 (207/211files initially passed,4failed); bg_54/artifact://109 (all five corrected files pass,15.99seconds). LSP reference lookup was attempted for removed catalog-test import and reported no server; narrow fallback search confirmed its only use.
- **Reversibility:** easy
- **Confidence:** high for corrected fixture and consumer coverage
- **Revisit if:** a behavior-level failure identifies a lost contract
- **Source:** assumed — autonomous

## D51: Preserve all historical snapshot failures and reconcile the actual Git index before committing
- **Question:** whether working-tree restoration and later passing targeted tests justify claiming older full snapshots passed
- **Options:** erase/relabel old failures; retain exact snapshot outcomes and stage every restored path explicitly
- **Chose:** retain the failures and reverify the final source. Stage restored plugin directories, specs, docs and lockfile so no silent staged deletion survives the merge.
- **Why:** the earlier500file snapshot had496pass/4fail from omitted test scaffolding; the next501file snapshot had old fixture/copy failures and a PTY host bulk-output timeout whose isolated32test rerun passed. Both full commands exited1 and remain failures. Later source/test corrections are independently verified, not retroactively attributed to those runs. Scout confirmed restored source was on disk but the merge index still contained deletions/unmerged entries; parent git add explicitly reconciled all m5 paths after restoration. Incoming handoff/Session Info contracts remain intact.
- **Evidence:** bg_43/artifact://87 and bg_48/artifact://94; Scout restoration audit; parent git add of restored feature directories/specs/README/bun.lock/tsconfig and m5 decision log.
- **Reversibility:** easy
- **Confidence:** high for recorded outcomes and index operation
- **Revisit if:** current final consumer or supported land verification fails
- **Source:** assumed — autonomous

## D52: Land the fully reconciled final source after consumer and smoke proof
- **Question:** whether the second catch-up restoration is ready to retry the supported landing gate
- **Options:** accept only disk restoration/typecheck; require final real consumer, native smoke, scripts and remote affected consumers
- **Chose:** retry landing after all final checks passed. The corrected affected suite passed211files with no flakes in379.46seconds. The real CLI/default-catalog/native create+resume scenario passed35assertions; typecheck/frozen install, native approval/resume/immediate-send/shared-check smoke and scripts62tests/462assertions passed. Corrected ask/structured/Claude/session/agents files also passed locally (D50).
- **Why:** these checks run the restored native/provider/account/session boundaries rather than trusting fake forwarding or old snapshot results. Source audit found no further lost m5 contract; parent staged restored paths to reverse the cleanup's index deletions while retaining incoming handoff/Session Info code. The external smoke script was removed after proof. Original feature final review and narrow account reconciliation review remain authoritative; no new discovery round or open accepted finding. A fresh full merge-result gate remains queue.ts land's responsibility.
- **Evidence:** bg_55 suite-result {\"ok\":true,\"flaky\":[]}; bg_53/artifact://107; bg_54/artifact://109; source/provenance audit; explicit git add and successful external smoke removal.
- **Reversibility:** easy
- **Confidence:** high for final exercised integration
- **Revisit if:** queue.ts land reports a conflict or failing merge-result check
- **Source:** assumed — autonomous

## D53: Use the operator's immediate landing gate ownership
- **Question:** whether to repeat long semantic/full-suite verification after another integration conflict
- **Options:** repeat local scouting and semantic suites while integration moves again; resolve the conflict, typecheck/scripts and let land run the full suite
- **Chose:** follow the operator's explicit 4am sprint instruction: stop scouting, run only bun run typecheck and bun test scripts, commit/detach and land immediately. For any further land conflict, resolve it, typecheck and retry land immediately.
- **Why:** m5 gates the orchestration chain and repeated long reverification permitted the integration tip to move. The next conflict was only bun.lock: preserve both checks and browser workspace/package-link entries. Frozen install passed after that additive resolution (one package installed,54ms). Scouting was stopped and returned; no further semantic re-verification is required before the supported land command, which owns the full merge-result suite.
- **Evidence:** operator's latest interjection; bg_56 conflict; lock conflict blocks6/7 retained both entries; bg_57 frozen-install exit0; Scout stopped; bg_58 is the exact typecheck/scripts gate.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** typecheck or the supported landing gate names a concrete failure
- **Source:** assumed — autonomous (operator-directed verification ownership)

## Progress

The latest incoming source snapshot records D43's pre-merge gates: 171 affected files passed with no flakes; the unchanged scripts retry passed 62 tests/460 assertions; typecheck and the scripted native daemon/CLI smoke passed. D44 records a scoped account-reconciliation review PASS. These are dependency-snapshot results, not verification of this current merge result.

The incoming fast-path note also records `bun run typecheck` (including frozen install 190/195, no changes) and `bun test scripts` (63 passed, 0 failed, 478 assertions; 115.68 seconds; bg_58/artifact://119), and directs commit/detach/land after that gate. That direction remains an incoming-branch record, not current merge-result verification or authority to land. This resolution lane ran no tests, build, lint, or formatter; Main must run the supported merge-result gate before landing.
