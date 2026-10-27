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

## D20: Preserve existing RPC failures with stable browser reason prefixes
- **Question:** How are D17 F1/F2 closed without adding a second error transport or ambiguous import input?
- **Options:** extend public error data; success-shaped error unions; existing ctx.error kinds with reason prefixes and exact discriminated import schemas
- **Chose:** existing invalid-params/not-found/conflict errors with stable browser reason prefixes; generic CLI failure handling exits 1, local usage exits 2. Define file/browser source variants, source/destination profile distinction, exact import flags, job filters and activation-local retention in tech.md.
- **Why:** public PluginContext.error accepts only kind and message. Existing dispatch/RPC/CLI already transports those reliably; no protocol extension is needed for this feature.
- **Evidence:** packages/protocol/src/plugins.ts:70-71,191-230; packages/daemon/src/plugins/runtime.ts:214-223; packages/daemon/src/rpc-handler.ts:76-100; packages/cli/src/main.ts:162-220; BrowserContractSurvey focused review
- **Reversibility:** medium (public input/error parsing contracts)
- **Confidence:** high
- **Revisit if:** callers need independently typed browser error data beyond the stable prefix
- **Source:** assumed — autonomous

## D21: Reconstruct pages after a lost helper epoch instead of guessing identities
- **Question:** D19 requires safe identity recovery; what survives helper restart?
- **Options:** reuse tN by number/order; match duplicate-prone URLs/titles; independently prove live target identity; fail current work and reconstruct after owned process teardown
- **Chose:** helper epoch loss invalidates all refs/mappings, fails triggering work with browser_tab_changed without retry, tears down only provably owned Chrome/helper processes, and recreates retained managed-page IDs from saved URLs with newly returned helper tN IDs on the next explicit operation. Durable credentials survive, transient DOM/history/input do not.
- **Why:** helper IDs are stable only inside a session. A real disposable helper probe returned t2/t3 then t4 after closing t2; it does not establish restart identity. Reconstructing only after owned teardown cannot alias an old target into another worktree. The transport must also prevent CLI auto-respawn from executing a command against recycled IDs; this remains under direct native-source investigation before approval.
- **Evidence:** D19; logic.md Status & amendments recovery amendment; agent-browser v0.27.0 tab command reference and ProfileIdentityProbe report; prior isolated owned-CDP report /tmp/quirky-browser-lane5-target-smoke.json
- **Reversibility:** medium (recovery preserves durable profile, not transient pages)
- **Confidence:** high for fail-closed policy, pending transport proof
- **Revisit if:** a supported epoch-bound helper transport or deterministic target identity supports transparent recovery
- **Source:** assumed — autonomous

## D22: Reject explicit native focus in the headless automation slice
- **Question:** How should the source tab switch --focus option behave before the visible-pane slice ships?
- **Options:** silently ignore focus; reveal native Chrome; reject true while implementing ordinary tab selection
- **Chose:** `focus` defaults false; true fails invalid_argument/invalid-params before mutation with a visible-pane ownership explanation. Ordinary tab selection remains real and invalidates refs.
- **Why:** the current slice explicitly excludes visible pane/native presentation, and its focus-isolation contract forbids stealing native focus. A successful no-op would falsely claim focus occurred.
- **Evidence:** external browser.md:245,254; logic.md Scope & non-goals and SC-02; BrowserMethodContracts clarification
- **Reversibility:** easy (sa-browser-ui can implement the explicitly separate presentation intent)
- **Confidence:** high
- **Revisit if:** the visible pane feature supplies a public UI reveal capability
- **Source:** locked by docs/quirk/specs/2026-10-27-sa-browser-agent/logic.md

## D23: Own the pinned native daemon and call its socket without CLI autostart
- **Question:** How is D19's helper epoch enforced despite CLI ensure_daemon automatically starting a replacement between liveness check and command?
- **Options:** precheck PID then invoke CLI; trust stable tN across restarts; foreground owned native daemon plus direct private IPC
- **Chose:** start pinned native agent-browser with AGENT_BROWSER_DAEMON=1, explicit private session/socket directory and cleared inherited target environment. Hold the actual child and one epoch-bound Unix socket. Send newline-delimited native action requests directly; initialize only with explicit owned CDP URL. Never call CLI ensure_daemon or retry a disconnected mutation.
- **Why:** pinned source provides foreground native mode and attach-only launch. Runtime probe created identical-URL pages, selected returned IDs and independently observed isolated values. Killing the helper made retained-socket requests reject with EPIPE/EOF without helper autostart; fresh owned processes recreated pages using newly returned (coincidentally reused) IDs. A closed CDP launch failed without launching other Chrome. Profile lock must still serialize select plus complete action; the protocol itself is not a multi-request transaction.
- **Evidence:** pinned v0.27.0 cli/src/main.rs:488-497,760; connection.rs:574,757-770; native/daemon.rs:357-419; commands.rs:1222-1269; native/actions.rs:1806-1815,1943,3706-3770. Actual /tmp/quirky-browser-lane5-native-probe.json: 158/158 assertions, exit 0; epochDeath socketEOFObserved true, cliEnsureDaemonInvocations 0; cleanup verified true, helpersExited/chromesExited/homeRemoved true.
- **Reversibility:** medium (internal pinned driver protocol, public API unchanged)
- **Confidence:** high for exercised action/epoch boundary; full API concurrency still requires acceptance tests
- **Revisit if:** helper upgrade changes native action framing or implicit launch behavior
- **Source:** assumed — autonomous

## D24: Bound owned Chrome termination after graceful detach
- **Question:** Does helper close or CDP Browser.close prove owned Chrome exits?
- **Options:** assume detach closes Chrome; kill arbitrary discovered Chrome; await graceful close then signal only the retained owned child/process group
- **Chose:** helper close is detach; separately request Browser.close, bound waiting, then signal the retained owned Chrome/group if still alive. Never discover-and-kill an unrelated process.
- **Why:** actual native close detached while Chrome remained reachable; Browser.close returned success without root termination within three seconds in the probe. Bounded owned-process cleanup was necessary and succeeded. The baseline Chrome root was observed but untouched.
- **Evidence:** /tmp/quirky-browser-lane5-native-probe.json native close and cleanup observations; ProcessScope-owned PID records; NativeTransportProbe report
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a platform's child/process group semantics require a different owned cleanup mechanism
- **Source:** deferred: platform

## D25: Package native dependencies through private generic asset-copy metadata
- **Question:** How does the pinned native helper ship without adding browser-specific kernel logic or a runtime manifest field?
- **Options:** rely on source node_modules/upstream; vendor a platform binary in source; generic package.json build metadata copied by desktop bundler
- **Chose:** generic private `package.json` metadata `quirky.assets`, with each entry naming a declared `dependency`, package-relative `source`, plugin-output-relative `destination`, and optional `executable`. Permit only `{platform}`/`{arch}` placeholders resolved from the build host; browser declares agent-browser's matching native binary into `bin/agent-browser`. Runtime prefers that packaged path, otherwise resolves its own pinned source dependency; installed bundle never falls back to upstream/source checkout.
- **Why:** current bundlePlugins copies only main/cli/UI/sounds. Public PluginManifest rejects unknown fields; asset packaging is not a runtime API capability. Validated relative source/destination paths, package-local resolution, explicit failure on missing assets and executable mode make missing helper a build failure rather than an installed runtime surprise. No arbitrary build commands/hooks are introduced.
- **Evidence:** apps/desktop/scripts/bundle-plugins.ts:1-72; actual tests apps/desktop/test/bundle-plugins.test.ts:1-119; packages/protocol/src/plugins.ts:313-336; packages/daemon/src/plugins/manifest.ts:13-27,55-75,209-250; BrowserAssetSurvey
- **Reversibility:** medium (private build metadata consumed by packager)
- **Confidence:** high for current macOS build-host target; other-platform runtime remains D9 deferred
- **Revisit if:** desktop distributions are cross-built for an OS/architecture different from the build host
- **Source:** assumed — autonomous

## D26: Resolve dialog-lock deadlock with exact-session CDP control
- **Question:** Codex spec finding F1 showed eval awaiting prompt/confirm holds the helper/profile command lock; how can dialog methods respond without retargeting?
- **Options:** queue dialog behind eval; assume native pre-arming/concurrent socket commands; patch/fork helper; trusted fresh-page CDP identity handshake plus independent dialog control
- **Chose:** helper creates each managed page blank, before untrusted navigation. Correlate a primitive non-throwing evaluate script's unpredictable sourceURL through trusted Debugger.scriptParsed/sessionId events; retain its exact target/session mapping for this epoch. Disable Debugger after binding. Direct dialog accept/dismiss validates that page's current pending event/generation and responds on the mapped session outside the normal helper FIFO; native auto-dialog behavior is disabled. No helper tab selection or implicit mutation retry occurs in this control path.
- **Why:** pinned native daemon holds one global state mutex across awaited evaluate; its dialog command neither pre-arms nor executes concurrently. Native protocol omits target/session IDs. A page-global marker, page URL/title match or target-order guess is unsafe. Trusted script-debugger metadata on a fresh opaque blank page establishes positive target identity before any caller content. Source safety review found this preserves D19 given the blank-page/nonce/session lifetime invariants; actual two-page runtime proof observed unique bindings, exact Unicode prompt return and false confirm dismissal while helper evaluations were pending.
- **Evidence:** pinned native/daemon.rs:404-413; native/browser.rs:760-785,1007-1078,1310-1329; native/actions.rs:4616-4646. Actual /tmp/quirky-browser-lane5-dialog-binding-smoke.json: exitCode 0, 29/29 assertions, cleanup verified/homeRemoved/noOwnedProcessGroupMembersRemain true. DialogBindingSafety read-only source review. Logic amendment precedes tech.md Trusted page binding and dialog control. Executable smoke script removed.
- **Reversibility:** medium (internal target handshake and control scheduling)
- **Confidence:** high for the exercised fresh-blank/explicit dialog path; production API concurrency still needs permanent acceptance
- **Revisit if:** native helper exposes trusted target IDs or Chrome changes primitive scriptParsed metadata behavior
- **Source:** assumed — autonomous

## D27: Preserve and adjudicate the bounded Codex specification review honestly
- **Question:** Did the revised specs pass the actual review, and which rows require changes?
- **Options:** label raw NEEDS_FIXES passing; accept all heuristic rows as independent defects; retain raw outputs and separately adjudicate material evidence
- **Chose:** raw verdict remains NEEDS_FIXES, 26 blocking rows, zero advisory/suppressed/contested. Accept the single model/refute-standing F1 (dialog deadlock) and remedy it through D26's logic-first amendment and observed feasibility smoke. Reject the 25 prepass rows as material implementation blockers: planned new plugin files/API command names are not existing paths; package/API namespaces are not paths; comma selectors and inherited upstream directory prefixes exceed the resolver's path grammar; protected tilde homes are fences, not artifacts to inspect; source command words are not PATH binaries; the mandated tech rubric has no Purpose/Overview-heading requirement and the logic Conceptual model supplies purpose. Raw chain/gate/manifest are unchanged; no passing re-review claimed.
- **Why:** parent read the actual gate, manifest and every prepass row. The real F1 is independently confirmed from native source and closed at the specification mechanism level with runtime proof; permanent API behavior is not yet implemented. Rewriting raw gate data to green would erase the actual review.
- **Evidence:** /tmp/quirky-browser-lane5-spec-review-v6-7EUTtP/{combined-browser-spec.md,criteria.md,commands.jsonl,prepass.json,claims.json,refute.json,merged.json,gate.json,manifest.json}; actual Codex openai-codex/gpt-6.1-sol:medium promote and fresh refute both exit 0; final gate exit 1; source artifact SHA256 9f7c845971082aa5d65323ebfae181eeea6b73b6596afefbb4788f56d24616e7. One initial gate command used a missing merged filename and exited 2; byte-for-byte copy then final gate completed, recorded without hiding the error.
- **Reversibility:** easy (raw artifacts retained)
- **Confidence:** high for review/evidence scope; no implementation completion claim
- **Revisit if:** downstream implementation reveals a rejected reference truly cannot be resolved from its stated source root
- **Source:** assumed — autonomous

## D28: Use Chromium's real non-backed headless clipboard, not a fake store
- **Question:** Can SC-04's real browser clipboard be exercised without touching macOS NSPasteboard?
- **Options:** assume navigator.clipboard is host-isolated; JS echo state; trace actual modern headless initialization before invoking clipboard
- **Chose:** use real navigator.clipboard through the owned modern headless Chrome. Its startup installs HeadlessClipboard derived from ClipboardNonBacked before platform initialization. Tests may round-trip the private browser clipboard, never inspect or modify NSPasteboard.
- **Why:** the scout initially inferred the normal ClipboardMac factory applied to headless; parent challenged the missing startup override and the scout retracted that conflict. Parent fetched exact installed Chrome156.0.8078.48 source, not just current-main/old shell: PreBrowserStart installs SetHeadlessClipboardForCurrentThread, whose implementation explicitly declares independence from any platform clipboard. No OS clipboard probe was necessary or performed. Actual clipboard API acceptance still belongs to implementation verification.
- **Evidence:** actual smoke Browser version at /tmp/quirky-browser-lane5-dialog-binding-smoke.json:749; https://raw.githubusercontent.com/chromium/chromium/156.0.8078.48/chrome/browser/headless/chrome_browser_main_extra_parts_headless.cc ; https://raw.githubusercontent.com/chromium/chromium/156.0.8078.48/components/headless/clipboard/headless_clipboard.cc ; HeadlessClipboardBoundary correction/source review. Exact googlesource tag fetches returned 503/504; GitHub primary mirror succeeded.
- **Reversibility:** easy (internal browser platform verification)
- **Confidence:** high for observed installed version's source wiring; no unexercised clipboard runtime pass claimed
- **Revisit if:** Chrome stops installing a non-backed headless clipboard, or a configured alternative browser uses a platform clipboard
- **Source:** assumed — autonomous

## D29: Make the full public command catalog explicit without dropping scope
- **Question:** Tech fidelity found that method names plus feature-doc references left implementers guessing schemas; which exact bindings govern implementation?
- **Options:** untyped helper passthrough; implicit source defaults; explicit per-method requests/results and CLI bindings
- **Chose:** the normative per-method table in tech.md, derived from exact upstream CLI/RPC declarations and local transport conventions. Public refs bind a fresh projection UUID to the page/generation; every PageTarget command exposes common --page/--worktree flags. HAR stop returns actual HAR records; interception lists every installed pattern; cookie deletion selects exact scoped/partition identity and refuses ambiguity. Profile clone uses an explicitly empty isolated destination and actually copies cookies. Exec is closed typed dispatch, never raw helper forwarding.
- **Why:** these contracts make all SC/DF flows implementable and observable without weakening target safety or providing successful no-ops. Source focus/client-routing differences remain the already documented slice boundary; ordinary automation behavior is retained.
- **Evidence:** tech.md Per-method public API and CLI bindings, Source anchors; BrowserMethodContracts authored table; BrowserTechFidelity finding and parent contract corrections; logic SC-02/03/07/08/09/11/18
- **Reversibility:** medium (public schemas/flags)
- **Confidence:** high for specified contract; implementations still require acceptance
- **Revisit if:** live source/API feasibility exposes an incompatible locked user behavior
- **Source:** assumed — autonomous

## D30: Isolate test Chrome's credential encryption path with its supported mock keychain switch
- **Question:** How should future browser acceptance/smoke avoid Chrome's ordinary Safe Storage Keychain path?
- **Options:** infer all headless internals are isolated; global Chrome configuration; per-test-owned-process mock-keychain launch argument plus synthetic importer key providers
- **Chose:** pass --use-mock-keychain only to fresh test/smoke Chrome through internal trusted constructor dependencies. Production launches retain normal credential protection. Import fixtures inject keys and never call the real source Keychain provider.
- **Why:** exact installed Chrome156 keychain_key_provider.mm chooses in-memory FakeKeychainV2 for this switch; the Apple switch is explicitly for testing. This is the cookie/password provider boundary, not proof every unrelated Chrome component avoids Security.framework. Earlier blank-page feasibility probes predated this discovered flag: they did not call a source importer or security CLI, but no audit established absence of every internal Chrome Keychain access; do not overstate that isolation.
- **Evidence:** https://github.com/chromium/chromium/blob/156.0.8078.48/components/os_crypt/async/browser/keychain_key_provider.mm ; https://github.com/chromium/chromium/blob/156.0.8078.48/components/os_crypt/common/os_crypt_switches.h ; https://github.com/chromium/chromium/blob/156.0.8078.48/crypto/apple/fake_keychain_v2.mm ; HeadlessClipboardBoundary exact-tag follow-up; tech.md test/smoke launch boundary
- **Reversibility:** easy
- **Confidence:** high for exact-tag provider behavior, explicitly bounded for other components
- **Revisit if:** browser credential storage no longer honors this test switch
- **Source:** assumed — autonomous

## D31: Preserve safe native exec navigation without permitting launch
- **Question:** Does categorically rejecting exec open incorrectly exclude native scoped navigation?
- **Options:** reject every open; forward native open including its launch form; normalize URL-bearing open/navigate to scoped goto
- **Chose:** open/navigate with a required URL normalize through the existing typed goto handler; bare open and all targeting/lifecycle overrides remain rejected. Parent amended component logic first, then tech, before retry implementation.
- **Why:** pinned commands.rs:261-299 maps open/goto/navigate with URL to the same navigate packet; native handlers call Page.navigate on the selected existing page. Bare open maps to launch at271-272. Positive normalization preserves vocabulary without exposing helper lifecycle.
- **Evidence:** ProfileIdentityProbe source follow-up; pinned v0.27.0 cli/src/commands.rs:261-299; native/actions.rs:2205; native/browser.rs:652; component logic compatibility amendment and tech exec contract
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** pinned helper navigation grammar changes
- **Source:** assumed — autonomous

## D32: Hand off OS focus rather than claiming a headless focus pass
- **Question:** Does a backend-only item still need a native scenario for SC-02/DF-05?
- **Options:** infer focus isolation from headless flags; run prohibited foreground UI in this lane; pending nightly native scenario
- **Chose:** docs/loop/native/sa-browser-agent.json records the real-window focus goal as pending. Web dogfood remains inapplicable because no web UI is added.
- **Why:** LOOP.md explicitly names focus among native-only scenarios. API/CLI behavior and no native Chrome window are separate observations; headless tests do not establish where actual macOS typing focus remains.
- **Evidence:** docs/loop/LOOP.md:133-136; docs/loop/NATIVE.md:60-82; logic SC-02/DF-05; pending native scenario
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** nightly native run records an actual result
- **Source:** locked by docs/loop/LOOP.md

## D33: Retry the failed complete component without suppressing checks or coverage
- **Question:** What did the first implementation handoff and parent checks establish?
- **Options:** accept the worker report as complete; narrow tests/claim source-only success; retain work, audit, and repair the full component
- **Chose:** retain the uncommitted source and use one fresh scoped repair implementer. No implementation completion, final review or landing is claimed. First return HEAD/scope audit passed: expected72be708, all34 changed paths in declared scope, parent main unchanged apart from its pre-existing metadata baseline.
- **Why:** worker honestly returned FAILED/incomplete acceptance. Actual automation run failed before tests on missing @quirky/git/testing. Cookie-policy run was5pass/2fail (private suffix normalization and an incidental Safari leading-dot expectation). Typecheck reported45 diagnostics across7files: inconsistent runtime fields, duplicate methods, unsupported Schema additionalProperties values, unavailable Bun Database.backup, missing imports/types/test helper. Import acceptance is unrun because the same harness prerequisite is known. These are actionable assembly/coverage defects, not a missing platform prerequisite.
- **Evidence:** parent actual targeted outputs; artifact://126 (policy), artifact://127 (full typecheck), audit journal /tmp/quirky-browser-lane5-v6-bZl06I/journal.json; BrowserFeatureImplementation FAILED report
- **Reversibility:** easy (no source commit or integration)
- **Confidence:** high
- **Revisit if:** retry exposes an actual locked-decision conflict rather than repairable code
- **Source:** assumed — autonomous

## D34: Repair native packaging's import/schema causes and replace incidental wording checks
- **Question:** Why did the new generic asset-copy tests fail, and did the packager need behavior changes?
- **Options:** alter expected error prose; bypass package validation; restore imports and respect the existing schema subset
- **Chose:** restore the missing node:path import; use boolean additionalProperties:true for dynamic dependency names and validate their string values at the named boundary. Delete the failing combined English-wording test and add distinct real boundary fixtures for existing outside-source bytes and a literal unknown-placeholder filename. Keep absolute-path negative fixtures inside the owned temp root.
- **Why:** initial15fail all hit missing join; next8pass/7fail rejected valid dependencies because the public validator supports only boolean additionalProperties, not a schema object. After those fixes,14pass/1fail was solely the correct traversal error missing the incidental word path. No runtime error was suppressed or message re-pinned. Final actual packager run:16pass/0fail/37assertions; its intentionally missing-module fixture still prints its expected compiler error.
- **Evidence:** artifact://125, artifact://129, artifact://131; final bun test apps/desktop/test/bundle-plugins.test.ts exit0/311ms; packages/protocol/src/schema.ts:4-15,168-183
- **Reversibility:** easy
- **Confidence:** high for generic copy/boundaries; real packaged helper smoke still pending
- **Revisit if:** actual plugin build reveals a dependency asset provisioning issue
- **Source:** assumed — autonomous

## D35: Add the missing ordinal field instead of dropping nth locator parity
- **Question:** Can the declared find nth locator be represented faithfully by locator/value/action/text alone?
- **Options:** remove nth; invent an encoded selector/index string; add the native ordinal as an explicit field
- **Chose:** find.index is a signed32-bit integer required only for nth; value remains its CSS selector, zero is first and negative values count from the end. Other locators reject index. CLI --index and native exec nth grammar map to the same method. Parent amended logic then tech before requesting a test-only continuation; implementation remains blocked on observing the correct red.
- **Why:** pinned parser requires separate index and selector; upstream mapper emits only one value token and is itself defective. This supplies an existing declared locator's missing parameter, preserving all command families and D19 topology rather than shrinking scope or changing the conceptual model.
- **Evidence:** pinned v0.27.0 cli/src/commands.rs:2145-2298; upstream external-chromium-command-arguments.ts:175-176; ProfileIdentityProbe source report; test-only SC-05 nth case in automation.test.ts. Actual targeted run after D36 reaches params.index is not allowed (-32602), proving the missing schema field rather than an import/syntax failure.
- **Reversibility:** medium (public field addition while API is unstable)
- **Confidence:** high
- **Revisit if:** native ordinal semantics change
- **Source:** assumed — autonomous

## D36: Accept valid CDP event parameter maps without weakening envelope types
- **Question:** Why did the repaired runtime still fail the fresh-page identity handshake before the nth regression could reach its request?
- **Options:** suppress handshake failure; guess target identity; repair the transport's schema mismatch
- **Chose:** keep params typed as object but explicitly allow its dynamic domain fields. Domain handlers still validate the fields they consume. No handshake bypass, target-order fallback or extra retry was added.
- **Why:** the public validator rejects undeclared object properties unless additionalProperties is exactly true. Generic CDP params was declared only type:object, so the first valid Target/Debugger event failed the whole connection as a malformed envelope. An isolated real WebSocket peer reproduced CdpConnection rejecting a valid targetCreated event and dropping it. After the one-property fix, the actual daemon/owned-Chrome nth test progressed through page binding and eval to its expected missing-index rejection.
- **Evidence:** src/runtime/cdp.ts MESSAGE_SCHEMA.params; actual pre-fix nth output browser_tab_changed; throwaway WebSocket probe result CDP response had a malformed envelope/events[]; actual post-fix targeted nth run params.index is not allowed (-32602). Native fresh-blank challenge mechanism is unchanged.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** CDP envelope shape changes or a domain handler assumes unvalidated parameter fields
- **Source:** assumed — autonomous

## D37: Ship only the operator-authorized browser core
- **Question:** How should the overdue browser item unblock the browser pane and design-mode items before the operator's night target?
- **Options:** continue full parity; block the item again; land a complete core and queue the remaining flows
- **Chose:** the user's explicit core cutover: one helper per profile; managed profile/page lifecycle; page commands through API and CLI; atomic profile-wide selection plus complete command. Exactly fifteen public methods are enumerated in the revised logic spec. Remove deferred API/CLI/runtime paths rather than leave stubs or hidden exec access.
- **Why:** the operator explicitly authorized the scope reduction and prescribed affected-directory checks, one blocking-only review round, one catch-up and landing. This supersedes the full-parity implementation scope in D29/D33/D35, not D19's target-safety invariants.
- **Evidence:** operator note in iteration6; authoritative core contract commit913723c; pre-cutover full-source/spec commit1d05b63 retained on build/sa-browser-agent-full-snapshot
- **Reversibility:** medium (deferred APIs return under a separately reviewed follow-up)
- **Confidence:** high
- **Revisit if:** the core cannot satisfy its real API/CLI/locking acceptance
- **Source:** supersedes sa-browser-agent D29

## D38: Queue every unshipped flow with recoverable source
- **Question:** Where does unfinished work go without misrepresenting this core as full browser parity?
- **Options:** keep advertised incomplete methods; discard work; remove them from shipping HEAD and retain a dependent follow-up
- **Chose:** queue.ts add created sa-browser-agent-extras, Side A, dependent on sa-browser-agent. It owns cookie detection/import/rollback and cookie/storage APIs; profile default/switch/clone/delete; history; advanced interactions/keyboard/find/mouse/upload/download; full screenshots/PDF; network/HAR/interception; device/emulation/permissions/clipboard/dialog; identity settings; explicit bulk CLI file/stdin inputs. Full source and original specs remain at1d05b63.
- **Why:** the operator authorized deferral, not fake successful implementations or a permanent loss of the completed portions. CLI data must remain literal: the old implicit @file: expansion read a real synthetic file and substituted its contents, so remove that interpretation rather than add more convenience controls now.
- **Evidence:** queue.ts add /tmp/quirky-browser-lane5-v6-bZl06I/deferred-item.json exited0; integration queue observed id sa-browser-agent-extras/status todo/deps[sa-browser-agent]; core logic Deferred flows and C5
- **Reversibility:** easy (archive commit retained)
- **Confidence:** high
- **Revisit if:** a deferred flow becomes necessary for an approved dependent item's acceptance
- **Source:** deferred: cookie import and advanced automation

## D39: Repair the fixture and pinned helper-reference contracts, not browser symptoms
- **Question:** Why did the real browser show empty titles, missing controls and failed snapshot clicks?
- **Options:** synthesize titles/DOM or sleeps; change Chrome; correct fixture MIME and pinned reference handling
- **Chose:** serve actual HTML as text/html; map validated native eN reference keys to @eN selectors; avoid redundant tab_switch, and invalidate refs when actual switching/lifecycle clears the helper map. Keep actual loaded URL after page creation.
- **Why:** Bun served the old string responses as text/plain, so Chrome correctly rendered markup. Pinned0.27 tab_switch clears its ref map. NativeRuntimeRepair then observed two isolated API-created pages sharing one Chrome/helper pair, real fills/evals, named Submit ref/click, CLI fill exit0 and selected-page metadata.
- **Evidence:** /tmp/quirky-browser-lane5-v6-bZl06I/{runtime-diagnostic,daemon-binding-probe,snapshot-refs-diagnostic,native-action-diagnostic}.json; NativeRuntimeRepair return scope audit: six paths, none outside authorization; all owned diagnostic scopes stopped
- **Reversibility:** easy
- **Confidence:** high for the exercised path; final core suite still required
- **Revisit if:** helper snapshot/tab-switch semantics change
- **Source:** assumed — autonomous

## D40: Skip unstarted review and dogfood under the latest sprint ruling
- **Question:** Should this overdue item start its planned review and additional dogfood before landing?
- **Options:** follow the earlier one-review instruction; obey the newer accelerated landing direction
- **Chose:** skip both unstarted passes; land once the core's affected tests and typecheck pass, retaining the earlier explicit scripts check. Catch up once, then queue.ts land. Keep NativeRuntimeRepair's already-observed real API/CLI smoke as limited evidence, not a claim that the prepared additional smoke or review ran.
- **Why:** the operator's latest note explicitly replaces the earlier review/dogfood requirement and sets night mode to two hours per item. Deferred work is already queued under D38.
- **Evidence:** latest iteration6 operator sprint note; core review and additional smoke were prepared but never started
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** an affected test or typecheck exposes a core blocker
- **Source:** supersedes sa-browser-agent D37

## D41: Pass the core's affected acceptance before integration
- **Question:** What did final core verification actually establish?
- **Options:** rely on worker completion; run the prescribed affected gates and repair actual failures
- **Chose:** run affected browser/desktop tests, scripts and typecheck. The final affected runner passed all8 remote files and1 macOS browser file, zero failures/flaky reruns (19.92s). Scripts passed49 tests/0fail/223assertions; corrected typecheck exited0 (21.93s).
- **Why:** initial typecheck exposed three references to removed history methods and an unused requestedUrl property; removed them. The initial affected run enumerated deleted tracked tests before staging deletions, and C4's gate fixture omitted the input whose real DOM state it asserted. Staged the actual deletions and supplied the fixture input; did not weaken C4, skip files, increase timeouts or alter browser behavior. Initial isolated rerun also recorded startup timeouts; final full affected run passed without reruns.
- **Evidence:** bun scripts/suite.ts plugins/quirky.browser apps/desktop final output8/8 remote plus1/1 macOS, suite-result ok:true/flaky:[]; bun test scripts artifact://238; initial compiler artifact://237 and final bun run typecheck exit0. NativeRuntimeRepair's prior real API/CLI smoke is scoped in D39.
- **Reversibility:** easy
- **Confidence:** high for exercised core acceptance, not deferred flows
- **Revisit if:** integrated landing gate exposes an interaction absent from the affected run
- **Source:** assumed — autonomous

## Progress
Iteration6 holds exactly sa-browser-agent. Core affected tests, scripts and typecheck passed (D41). Full pre-cutover work is preserved at1d05b63/build/sa-browser-agent-full-snapshot; queued sa-browser-agent-extras owns every deferred flow. Review and additional dogfood were not started, per D40. Original parent metadata and copied metadata stash remain untouched.

Next: commit/merge component into build/sa-browser-agent, remove its clean worktree, catch up once/read incoming decisions, detach and queue.ts land; wait for its integrated gate. No second item and no whole-queue completion claim.
