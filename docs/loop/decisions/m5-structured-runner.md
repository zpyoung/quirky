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

## Progress
Verified and ready to land. Final code, specs, public method schemas, generated CLI surface, consumer tests and user docs are complete. All agents/check jobs returned and smoke processes/homes were cleaned. Commit this final evidence, detach and run queue.ts land m5-structured-runner; its integration gate must pass before the queue marks the item done. Then end this iteration without claiming another item.
