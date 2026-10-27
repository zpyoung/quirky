# sa-browser-agent decisions

## D1: Build the queue item's automation and cookie-import slice
- **Question:** Which browser flows belong to this item, given the roadmap's four slices?
- **Options:** automation alone; automation and cookie import named by the claimed item; all browser UI and design mode too
- **Chose:** automation and cookie import, including profile lifecycle and their public API/CLI; the dependent sa-browser-ui owns visible pane, screencast presentation and design mode
- **Why:** queue.ts wait --lane 5 returned sa-browser-agent with that exact title; sa-browser-ui depends on it and names the presentation flows
- **Evidence:** docs/loop/queue.json:411-433; docs/roadmap.md:230-244; research/orca-features/browser.md sections How agents drive the browser and Cookie import in detail (read from external read-only research root)
- **Reversibility:** medium (changes acceptance coverage and successor contracts)
- **Confidence:** high
- **Revisit if:** the shared queue or a binding decision allocates a listed automation/import flow elsewhere
- **Source:** locked by docs/loop/queue.json

## D2: Answer workflow questions autonomously without a visual companion
- **Question:** How are the brainstorming and review approval questions answered unattended?
- **Options:** wait for a person; take and record recommended defaults after coverage; bypass design
- **Chose:** explicitly consider all relevant API/CLI/Data/Integration gray areas, use source requirements and recommended defaults, record answers, and use markdown specs and automated review
- **Why:** the loop prohibits human asks and prescribes autonomous answers; this backend slice has no new visible UI
- **Evidence:** docs/loop/LOOP.md:175-200; docs/architecture.md:180-203
- **Reversibility:** easy (documentation and later amendments)
- **Confidence:** high
- **Revisit if:** a technical proposal conflicts with a locked decision; block rather than overriding it
- **Source:** locked by docs/loop/LOOP.md

## D3: Use the existing authenticated plugin RPC and namespaced browser CLI
- **Question:** API gray area — response format, authentication, versioning and error behavior?
- **Options:** new browser transport; existing schema-declared plugin RPC and CLI; untyped command passthrough only
- **Chose:** existing authenticated RPC with `quirky.browser/<method>` and `quirky browser ...`; preserve structured results and existing CLI exit/error conventions; keep plugin API unstable until M7
- **Why:** every built-in must be replaceable and scriptable on the public plugin API
- **Evidence:** docs/roadmap.md:19-38; packages/protocol/src/plugins.ts:49-80; packages/cli/src/plugin-commands.ts:51-138
- **Reversibility:** medium (consumer-visible names and schemas)
- **Confidence:** high
- **Revisit if:** a required automation operation cannot be expressed through public plugin methods
- **Source:** locked by docs/roadmap.md

## D4: Keep page targeting scoped and snapshot references ephemeral
- **Question:** API/CLI gray area — which page is targeted, what happens to stale references, and how is focus handled?
- **Options:** globally active fallback for all commands; require a worktree or page for text mutations; one unscoped browser session
- **Chose:** explicit page wins; otherwise resolve the cwd's managed worktree or explicit worktree; no unscoped text mutation fallback; FIFO per page; stale refs fail after navigation/switch; headless automation never reveals or focuses a native window
- **Why:** preserves source safety while standalone headless Chrome removes Electron's guest focus defect
- **Evidence:** external browser.md:190-196,251-261; docs/architecture.md:180-200
- **Reversibility:** hard (target safety and command semantics)
- **Confidence:** high
- **Revisit if:** acceptance tests show commands can reach the wrong worktree/page
- **Source:** locked by docs/architecture.md

## D5: Discover browsers only on explicit import discovery and isolate destination profiles
- **Question:** Data/Integration gray area — source detection, credentials, overwrite policy and protected data access?
- **Options:** inspect every browser at daemon startup; inspect on explicit detect/import; reuse the user's live browser profile as destination
- **Chose:** detect/read only on explicit request; read source profiles only, write destination under plugin dataDir; Default plus isolated/named/imported profiles; confirm profile deletion and cookie replace/clear through existing destructive method policy
- **Why:** source detection can trigger macOS protected-data prompts; destination credentials must not alter the user's ordinary browser
- **Evidence:** external browser.md:72-85,391-421; docs/architecture.md:202-203; docs/roadmap.md:39-41
- **Reversibility:** medium (profile model and import semantics)
- **Confidence:** high
- **Revisit if:** any test writes real browser state or import detection starts automatically
- **Source:** locked by docs/architecture.md

## D6: Import cookies with transactional domain-scoped replacement and explicit warnings
- **Question:** Data gray area — accepted input, conflicts, partial failure, idempotency and sensitive data?
- **Options:** merge blindly; replace the entire destination; replace only safely imported registrable families with rollback
- **Chose:** array-of-cookie JSON file, detected Chromium-family DB, Firefox SQLite and Safari binarycookies inputs; validate rows, retain faithful partition identities, skip Google and unsafe families, replace imported scope under destination lock with rollback; summaries disclose skipped/decryption failures; no credential values in logs
- **Why:** preserves unrelated logins and avoids deletion of sessions that cannot be faithfully rewritten
- **Evidence:** external browser.md:408-435
- **Reversibility:** hard (authentication-state mutation)
- **Confidence:** high
- **Revisit if:** source cookie identity cannot be represented faithfully in Chrome CDP
- **Source:** locked by docs/architecture.md

## D7: Time out commands and close owned processes, without speculative retry behavior
- **Question:** CLI/Integration gray area — command progress, error recovery, concurrency and lifetime?
- **Options:** unbounded subprocess; automatic command retries; bounded FIFO execution with explicit lifecycle recovery
- **Chose:** source command time bounds, structured errors, no implicit retries of mutating commands; close in-flight/queued work on page close; daemon/plugin shutdown closes owned Chrome/helper processes; imports return job state and final summary through API/CLI
- **Why:** unattended operation needs bounded work without duplicate interactions
- **Evidence:** external browser.md:192-196,425-435; docs/loop/LOOP.md:30-38
- **Reversibility:** medium (lifetime and error contracts)
- **Confidence:** high
- **Revisit if:** required flows cannot complete within bounded command lifetime
- **Source:** assumed — autonomous

## D8: Keep browser scope within the local backend and record other-platform work
- **Question:** Remaining clarification — purpose, consumers, success bar, boundaries and platform?
- **Options:** port all upstream host variants; local agent backend and imports; visible UI too
- **Chose:** agents and API/CLI consumers automate worktree-scoped pages, reuse logins by explicit imports and manage profiles; every in-scope flow and source defect has API/CLI acceptance coverage; no visible pane/design mode, SSH/client-host routing, artifacts or native chat
- **Why:** the claimed queue item and dependency divide browser work; dropped integrations must not be reintroduced
- **Evidence:** docs/loop/queue.json:411-433; BRIEF.md:67-78; docs/roadmap.md:43-53
- **Reversibility:** medium (acceptance boundary)
- **Confidence:** high
- **Revisit if:** binding roadmap decisions change the local-only scope
- **Source:** locked by docs/roadmap.md

## D9: Build and exercise macOS only with portable primitives where cheap
- **Question:** Platform gray area — which browser roots, launch paths and decryption backends ship now?
- **Options:** implement unverified cross-platform paths; macOS verified behavior with explicit deferred platform entries
- **Chose:** verify Chrome discovery, Keychain decryption, Safari access and process cleanup on macOS; log Linux/Windows launch, keyring/DPAPI, root detection and cleanup verification as deferred platform work wherever introduced
- **Why:** the loop locks macOS-only build/test and requires other-platform decisions
- **Evidence:** docs/loop/LOOP.md:48-49; external browser.md:397-419
- **Reversibility:** easy (additional platform implementations)
- **Confidence:** high
- **Revisit if:** Linux or Windows becomes an accepted build/test platform
- **Source:** deferred: platform

## D10: Pair omp implementation tasks with Gemini after Opus preflight failure
- **Question:** Execution preflight — which cross-family implementation reviewer is reachable?
- **Options:** omp tasks plus Opus; omp tasks plus Gemini; same-family review
- **Chose:** omp OpenAI task implementers, Google Gemini reviewer through pi-watch; actual Codex adversary for the required spec review
- **Why:** pi-watch --check from /tmp returned opus and sonnet unavailable, codex and gemini reachable; Gemini retains cross-family implementation independence, while Codex spec review has explicitly reduced same-family independence
- **Evidence:** iteration 5 pi-watch --check output: codex openai-codex/gpt-6.1-sol:medium, gemini google/gemini-3.1-pro-preview:high; opus 0/8 combos, exit 5
- **Reversibility:** easy (next execution run)
- **Confidence:** high
- **Revisit if:** dispatch fails; follow the required retry/fallback ladder rather than claiming a review happened
- **Source:** assumed — autonomous

## D11: Reuse agent-browser over explicitly owned CDP targets
- **Question:** Option validation — direct CDP only, Playwright-only over CDP, or pinned agent-browser plus direct CDP for missing primitives?
- **Options:** direct CDP reimplements high-level command/ref semantics; Playwright-only needs compatibility translation and has lower-fidelity CDP attachment; agent-browser preserves the source vocabulary with explicit process ownership
- **Chose:** pinned agent-browser 0.27.0 with owned headless Chrome and direct CDP cookie operations
- **Why:** upstream external-Chromium session already uses that command vocabulary; the current package is a native Rust binary with no runtime JS dependency. Per-page targeting, profile mutation and unsupported upstream profile methods are implemented in Quirky, not delegated blindly.
- **Evidence:** /Users/zpyoung/PycharmProjects/orca/src/main/orcad/external-chromium-browser-session.ts:163-205; /Users/zpyoung/PycharmProjects/orca/node_modules/agent-browser/package.json:1-46; https://developer.chrome.com/blog/remote-debugging-port; https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp
- **Reversibility:** medium (internal driver; public behavior unchanged)
- **Confidence:** medium
- **Revisit if:** pinned helper target/lifecycle semantics cannot preserve ownership or command behavior
- **Source:** assumed — autonomous

## D12: Explicit imports use tracked one-shot daemon operations, not recurring scheduler jobs
- **Question:** Technical survey — does the existing job contribution implement user-triggered import semantics?
- **Options:** recurring scheduler import; synchronous-only import; tracked explicit importStart/Get/List plus synchronous importCookies
- **Chose:** tracked explicit imports owned by the plugin, with cancellation on deactivate; no automatic recurring source access
- **Why:** existing JobHandler runs fixed-delay recurring work. Treating a selected login import as a recurring scheduled task would repeatedly read protected state and overwrite credentials.
- **Evidence:** packages/daemon/src/plugins/scheduler.ts:201-373; packages/protocol/src/plugins.ts JobHandler/PluginModule; external browser.md:391-421; docs/architecture.md:202-203
- **Reversibility:** medium (observable import job API)
- **Confidence:** high
- **Revisit if:** the public scheduler gains explicit one-shot job lifecycle support
- **Source:** assumed — autonomous

## D13: Keep implementation in one component with focused internal modules
- **Question:** Decomposition — split cookie policy, Chrome/profile coordination and API glue into separate sequential waves, or one vertical component?
- **Options:** separate backend/cookie/glue waves; one component with focused runtime/profile/cookie files and complete API acceptance
- **Chose:** one OpenAI task component owns the entire new plugin, required helper packaging and tests; one final review round with three lenses
- **Why:** profile locks, close/cancellation and cookie rollback share behavioral invariants; splitting them introduces interfaces and gated waves without independent shippable behavior. The work remains modular internally. There is no successor wave and therefore no checkpoint review.
- **Evidence:** docs/quirk/specs/2026-10-27-sa-browser-agent/tech.md Architecture and Contracts; subagent-driven-development Step 7; writing-plans Granularity Economics
- **Reversibility:** easy (redispatch if a substantive dependency emerges)
- **Confidence:** medium
- **Revisit if:** the worker cannot implement the complete contract as one scoped task
- **Source:** assumed — autonomous

## D14: Halt the per-page-helper design at the headless feasibility gate
- **Question:** Deep technical validation — can the selected helper deterministically bind separate per-page sessions to Chrome target IDs in the shared profile process?
- **Options:** assume target enumeration order; match duplicate-prone URL/title; provide a new filtering CDP proxy; change to one helper per profile with atomic select-plus-command; halt the approved model under the headless feasibility rule
- **Chose:** halt before implementation and formally block this item; recommend re-authorizing one helper per profile with retained helper-created tab identities and a profile-wide selection/command lock
- **Why:** logic.md's selected model explicitly requires one helper per page connected to its assigned CDP target. Helper 0.27.0's normal CDP path discovers all targets; its tab command accepts helper IDs/labels, not Chrome target IDs. A direct page websocket is accepted here but still enumerates both pages. Enumeration order or URL/title matching is not a safe identity boundary. A proxy or profile-shared helper changes the selected technical model rather than proving the existing one.
- **Evidence:** docs/quirk/specs/2026-10-27-sa-browser-agent/logic.md:21; tech.md Contracts & interfaces; actual isolated smoke report /tmp/quirky-browser-lane5-target-smoke.json; helper v0.27.0 browser.rs connect_cdp_inner/discover_and_attach_targets/tab_switch at https://raw.githubusercontent.com/vercel-labs/agent-browser/refs/tags/v0.27.0/cli/src/native/browser.rs; writing-specs/tech-spec.md Feasibility escalation; docs/loop/LOOP.md:196-197
- **Reversibility:** easy (no implementation or permanent test was written)
- **Confidence:** high for the observed helper behavior; medium for the proposed replacement until its identity/recovery scenarios are exercised
- **Revisit if:** the selected model is amended and reviewed, or a proven target-filtering adapter preserves it without order/URL/title assumptions
- **Source:** locked by docs/loop/LOOP.md

## D15: Prefer runtime evidence over the scout's unsupported-endpoint inference
- **Question:** Investigation — did the helper reject a direct page websocket, or merely fail to pin to it?
- **Options:** repeat the source-only unsupported claim; record the actual accepted-but-unpinned result
- **Chose:** record accepted-but-unpinned. The source-only categorical unsupported claim is retracted.
- **Why:** the first smoke's page-endpoint probe failed on UNIX socket path length, so it did not test endpoint compatibility. After shortening session names, the real helper accepted the page websocket and listed both targets. The actual Chrome target ID remained rejected as a tab label. No wrong-page mutation was attempted or claimed.
- **Evidence:** first smoke stdout retained in this iteration transcript; second report /tmp/quirky-browser-lane5-target-smoke.json: pageEndpointAccepted true, distinctTargetIdSelectionRejected true, b5p returned t1/t2. BrowserDeepValidation independently retracted its unsupported-endpoint wording after reading this result.
- **Reversibility:** easy (corrected evidence record)
- **Confidence:** high
- **Revisit if:** a pinned helper version supplies and passes a deterministic target-ID binding command
- **Source:** assumed — autonomous

## D16: Isolate the browser investigation and remove its executable scaffold
- **Question:** Verification — how can the target-selection seam be exercised without user-state access?
- **Options:** attach to real Chrome; use source inference alone; own a fresh headless process and private home
- **Chose:** createProcessScope allocated a fresh QUIRKY_HOME; Chrome launched headless with a new private profile and two about:blank targets; helper sockets/HOME/target environment were isolated; close helpers and Browser.close, then scope.cleanup in finally
- **Why:** the loop prohibits tests touching real state and requires cleanup of every process started
- **Evidence:** final smoke report: cleanupDone true, homeRemoved true; all three helper close commands exit 0; throwaway /tmp/quirky-browser-lane5-target-smoke.ts removed after proof
- **Reversibility:** easy
- **Confidence:** high for the exercised process scope/cleanup path
- **Revisit if:** the process owner reports surviving children or protected-state changes
- **Source:** locked by docs/loop/LOOP.md

## D17: Preserve the failed spec review and its unapproved contracts with the block
- **Question:** Spec gate — what did the actual Codex review establish, and which findings can be closed before the feasibility halt?
- **Options:** call the raw gate passing; treat all 75 rows as independent defects; preserve the raw result and adjudicate evidenced findings separately
- **Chose:** preserve NEEDS_FIXES. F1 (undefined browser failure transport/CLI exit mapping) and F2 (undefined exact import request/CLI shapes) remain open because the item is halted before an implementation contract can be approved; resolve them with the target-model amendment, not by dispatching a worker against this draft. F3 (missing macOS acceptance routing scope) is addressed in the tech spec, without editing the routing list before tests exist or claiming routing is exercised.
- **Why:** actual promote and a fresh refute upheld all three substantive findings. The gate retained F1 but suppressed F2/F3 because their evidence used a literal brace-expression path; independent source inspection confirms those omissions. The raw 75 blocking rows also include 74 deterministic heuristic rows: future symbols/paths, package/API names, grouped upstream references and missing Purpose|Overview heading. Reject those as material defects where the document explicitly labels future artifacts and the separate anchor audit resolves existing references; retain the raw outputs unchanged. No passing review claimed after documentation amendments.
- **Evidence:** /tmp/quirky-browser-lane5-spec-review-wkl_qmcv/{browser-spec-review-report.md,resolve.json,prepass.json,model.json,claims.json,refute.json,merged.json,gate.json,manifest.json,commands.jsonl,anchor-audit.json}; actual codex openai-codex/gpt-6.1-sol:medium, reduced independence, standard depth, both pi dispatches exit 0; gate exit 1, 75 blocking rows, 2 suppressed, 0 contested/advisory/limitations/questions
- **Reversibility:** easy (no implementation exists)
- **Confidence:** high
- **Revisit if:** revised specifications close F1/F2 and the target binding model is authorized and validated
- **Source:** assumed — autonomous

## D18: Keep the loop's exact verification commands instead of the reviewer's broader reading
- **Question:** Review supplement — must all targeted/script checks use bun run test?
- **Options:** replace every check command; obey LOOP.md's explicit distinction between whole suite, single files and scripts
- **Chose:** retain `bun run test` for the whole suite, `bun test scripts` for the separately required script checks, and name one single targeted acceptance file for local development. No command has run against nonexistent feature code.
- **Why:** LOOP.md explicitly permits a single file locally and separately requires bun test scripts. The review supplement's statement that every test must use bun run test overstates that rule. Corrected the broader plugin-folder test command to a single file, the CliContext path to packages/protocol/src/cli.ts, and the incorrect JS-daemon packaging assumption (0.27.0 contains its native Rust daemon).
- **Evidence:** docs/loop/LOOP.md:121-123; scripts/test-on-macos.txt:1-2; /Users/zpyoung/PycharmProjects/orca/node_modules/agent-browser/package.json:1-46; tech.md Code references/Architecture/Testing strategy; review report supplemental F3 text
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the loop's locked test-runner policy changes
- **Source:** locked by docs/loop/LOOP.md

## D19: Build one agent-browser helper per profile (user ruling)
- **Question:** Which page model replaces one helper session per page, which agent-browser 0.27.0 can't pin to a Chrome target (D14, the BLOCKERS.md entry)?
- **Options:** one helper per profile with a tN-to-page map under a profile lock; a target-filtering CDP proxy in front of per-page sessions; drop agent-browser and drive CDP directly; leave the item blocked
- **Chose:** one helper per profile. The helper creates every page, Quirky keeps the tN it returns mapped to the public page, and one profile lock serializes select-then-command. Specify how identity is recovered after a helper restart.
- **Why:** the user ruled on 2026-10-27, through the build-loop operator, after reading the block
- **Evidence:** docs/loop/BLOCKERS.md, sa-browser-agent entry; D14
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** agent-browser gains a supported way to pin a session to one Chrome target
- **Source:** user ruling 2026-10-27

## Progress
Requeued after the user ruling in D19. Next: amend logic.md with a dated decision for the one-helper-per-profile model, tighten tech.md, close F1 and F2, review the revised specs, then implement and run the item's full acceptance, build, remote suite and packaging workflow.

Iteration 5: stopped at steps 4/5's headless technical-feasibility escalation before implementation. Claimed only sa-browser-agent. Brainstorming/parallel source and option research completed; logic/tech specs written; actual Codex standard promote/fresh-refute review completed with NEEDS_FIXES and documented independent evidence caveats. Live isolated Chrome/helper smoke demonstrates accepted-but-unpinned page websocket and rejection of actual Chrome target IDs by the helper tab command. D14 records the required block and the recommended one-helper-per-profile repair. D17 preserves open F1/F2 public error/import contract findings; F3 scope, CliContext pointer, single-file test command and native packaging wording amended, not represented as re-reviewed.

No implementation task, permanent test, dependency installation, build, whole-suite run, UI run or native handoff was started; no product behavior changed. All research/review agents returned. Smoke helpers and Chrome closed; ProcessScope cleanup removed both temporary homes; executable smoke scaffold removed. Evidence reports remain outside the repo at /tmp/quirky-browser-lane5-target-smoke.json and /tmp/quirky-browser-lane5-spec-review-wkl_qmcv/. Next repository action is commit the three documentation files, rename build/sa-browser-agent to blocked/sa-browser-agent, detach, and invoke queue.ts block with the external blocker entry. Do not claim another item in this iteration. Inherited .serena/ remains untracked, unmodified and uncommitted.
