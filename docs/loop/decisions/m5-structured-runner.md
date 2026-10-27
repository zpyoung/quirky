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

## Progress
Research complete for starting code and feature scope. Author logic/tech specs, perform Codex adversarial review, commit specs, then implement one wave of two disjoint components: structured lifecycle (including session delegation) and checks plugin. No UI/native scenarios.
