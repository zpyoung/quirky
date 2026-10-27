# m3-accounts decisions

## D1: Implement meters and only Claude/Codex switching
- **Question:** Which account flows does this queue item own (brainstorming scope)?
- **Options:** all provider switchers; ten read-only meters and Claude/Codex managed switchers; meters only
- **Chose:** ten read-only meters and Claude/Codex managed switchers, with every macOS-local flow from accounts.md
- **Why:** The item explicitly names read-only usage/rate limits and Claude/Codex switching; Cursor/Grok have read-only rows. Remote/WSL behavior belongs to later hosting/platform work, and transcript usage analytics is a separate feature.
- **Evidence:** docs/roadmap.md:171-188; accounts.md sections “Grok and Cursor”, “Other meters”, “Dependencies on other features” (external feature-doc root specified in docs/loop/LOOP.md)
- **Reversibility:** medium (provider contracts and UI scenarios)
- **Confidence:** high
- **Revisit if:** the feature-doc scope contradicts this queue slice
- **Source:** locked by docs/roadmap.md

## D2: Answer unattended design questions without a human gate
- **Question:** How should brainstorming/spec/execution questions be resolved in this unattended iteration?
- **Options:** wait for a user; choose documented or recommended defaults and record them
- **Chose:** documented requirements first, then recommended defaults; markdown specs; no visual companion or adhd offer
- **Why:** LOOP.md explicitly prohibits human questions and prescribes these substitutions.
- **Evidence:** docs/loop/LOOP.md:175-200
- **Reversibility:** easy (decision review)
- **Confidence:** high
- **Revisit if:** the loop contract changes
- **Source:** locked by docs/loop/LOOP.md

## D3: Use OpenAI task implementers and Gemini review fallback
- **Question:** Which model pairing is reachable at execution preflight?
- **Options:** task + opus; task + gemini; same-family review
- **Chose:** IMPLEMENTER=omp task, AUTHOR_FAMILY=openai, REVIEWER_ALIAS=gemini
- **Why:** pi-watch --check opus exited 5 (0/8 available); pi-watch --check found Gemini google/gemini-3.1-pro-preview:high and Flash available, but no Anthropic reviewer aliases. Gemini preserves cross-family independence. Codex is available for the mandated spec review.
- **Evidence:** observed pi-watch --check output during this iteration: codex=openai-codex/gpt-6.1-sol, gemini=google/gemini-3.1-pro-preview; opus/sonnet/haiku/fable unavailable
- **Reversibility:** easy (no implementation dispatched)
- **Confidence:** high
- **Revisit if:** a dispatch fails despite the alias resolving
- **Source:** assumed — autonomous

## D4: Native CLI login and provider-specific usage ports beat custom OAuth or imported snapshots
- **Question:** Which approach meets add/switch/refresh parity, after research?
- **Options:** isolated official CLI homes with native/observed quota protocols; direct HTTP OAuth; imported profiles/snapshots
- **Chose:** native isolated logins, Codex stdio App Server, Claude live/observed quota and ten separately ported meter adapters
- **Why:** custom OAuth duplicates providers; imported snapshots omit live refresh/add flows. Research corrected its initial Codex claim: account/rateLimits/read is documented.
- **Evidence:** https://code.claude.com/docs/en/authentication ; https://code.claude.com/docs/en/statusline ; https://learn.chatgpt.com/docs/app-server ; AccountProviderPorts and corrected AccountSourceResearch surveys
- **Reversibility:** medium (provider adapter boundaries)
- **Confidence:** high for CLI/Codex; medium for observed private quota protocols
- **Revisit if:** provider protocol or credential policy changes
- **Source:** assumed — autonomous

## D5: Required account preparation is separate from launch hooks
- **Question:** How can selected-account safety coexist with best-effort hooks?
- **Options:** fatal hook flavor; skip profile failures; public required preparation before spawn
- **Chose:** call effective quirky.accounts/prepare through public context.call before spawn; keep launch hooks unchanged
- **Why:** actual runLaunchHooks with a missing selected home returned successful empty env/args and one warning. Awaited session plan construction already rejects before spawn. Independent policy survey confirmed ordinary API growth, not a locked conflict.
- **Evidence:** packages/daemon/src/plugins/launch-hooks.ts:50-85; plugins/quirky.session/src/sessions.ts:532-576; m0-daemon-api D20/D22; accounts.md missing/broken account folder; /tmp/quirky-m3-accounts-lane10.BBUvf8/launch-proof.ts observed output
- **Reversibility:** medium (inter-plugin preparation)
- **Confidence:** high
- **Revisit if:** activation cycles or an uncovered spawn path bypass preparation
- **Source:** assumed — autonomous

## D6: Preserve configuration/auth; distinguish shared history
- **Question:** Does history sharing conflict with never editing Claude config?
- **Options:** forbid every default-home write; copy Orca pooling indiscriminately; preserve config/auth and share history without overwriting existing data
- **Chose:** preserve default config/auth bytes; explicitly distinguish history writes, which must not overwrite user data
- **Why:** v1/agent-status prohibit config changes. Orca profile-history writes history, contradicting the feature doc's blanket default-home claim. Conversation-preserving restart needs retained/shared history.
- **Evidence:** docs/v1.md:88-91; m1-agent-status D6; accounts.md profile setup; /Users/zpyoung/PycharmProjects/orca/src/main/claude-accounts/claude-profile-history.ts; AccountPolicySurvey follow-up
- **Reversibility:** hard (history ownership)
- **Confidence:** medium
- **Revisit if:** history sharing cannot preserve user config/data
- **Source:** assumed — autonomous

## D7: Retain documented presentation, errors and freshness defaults
- **Question:** What resolves visual/error/polling/preferences gray areas?
- **Options:** settings-only table; documented status bar/popover/drill-in and preferences
- **Chose:** Compact/Used defaults; Detailed/Remaining; consumed urgency; worst-first roster; inactive usage; +N and visibility/density; focused 15-minute polling, five-minute debounce, Retry-After, 30-minute/24-hour stale boundaries
- **Why:** observable feature-doc flows; missing is not zero and late results cannot cross account selection revisions.
- **Evidence:** accounts.md Read usage, Usage polling, Edge cases
- **Reversibility:** easy (UI); medium (cache)
- **Confidence:** high
- **Revisit if:** authoritative provider windows require different headline mapping
- **Source:** locked by research/orca-features/accounts.md

## D8: Login lifecycle is asynchronous, serialized, owned and scriptable
- **Question:** Which API/CLI/auth/duplicate/confirmation/recovery choices apply?
- **Options:** long blocking login RPC; begin/status/cancel with owned processes
- **Chose:** schema-declared asynchronous login lifecycle; Claude saves without selecting, Codex saves/selects; both reject duplicate identity; removal confirms unless yes; reauth preserves history; newer mutations supersede pending login
- **Why:** native browser login needs cancellable observable state; overlapping mutations cannot lose settings. Missing Codex duplicate detection is hardened, not copied.
- **Evidence:** accounts.md add flows, concurrent edits, cancellation and open questions
- **Reversibility:** medium (API/store)
- **Confidence:** high
- **Revisit if:** native CLI protocol or completed-auth cancellation behavior changes
- **Source:** assumed — autonomous

## D9: Running processes keep old identity until conversation-preserving restart
- **Question:** How should running-session selection and restart behave?
- **Options:** relabel process; force restart; documented provider policy/prompts
- **Chose:** Claude Ask/Always/Never and idle queue; Codex Keep/Restart stale chip; preserve provider ID/cwd; API and readable UI state for each action
- **Why:** running environment cannot change; true identity outranks apparent switching success.
- **Evidence:** accounts.md Claude switch and Codex stale sessions; m1-providers D24/D25; roadmap scriptability
- **Reversibility:** medium (restart state machine)
- **Confidence:** high
- **Revisit if:** existing session primitives cannot safely resume the same conversation
- **Source:** locked by research/orca-features/accounts.md

## D10: Grow generic public status-bar and shell-init seams
- **Question:** Which missing public UI/launch capabilities are required?
- **Options:** account-specific kernel UI; generic ordered status-bar slot and trusted shell-init launch input
- **Chose:** status-bar contribution with owned mount/report; optional shellInit path sourced after rc; accounts owns shell functions and pointers
- **Why:** neither seam exists yet; roadmap explicitly allows needed unstable API growth.
- **Evidence:** packages/protocol/src/ui.ts; packages/ui/src/plugins/host.ts; packages/daemon/src/launch.ts:268-412; AccountUiSurvey and AccountLaunchSeams
- **Reversibility:** medium (public API)
- **Confidence:** high
- **Revisit if:** catch-up brings equivalent seams
- **Source:** assumed — autonomous

## D11: Verify isolated provider boundaries, CLI/API, owned web UI and native handoffs
- **Question:** Which verification surface is safe unattended?
- **Options:** real credentials/native desktop; isolated fixture providers and owned web daemon; omit UI
- **Chose:** fresh HOME/QUIRKY_HOME and bounded fixture subprocesses; every AC gets daemon API/CLI coverage, built smoke and web goals; native browser/Keychain dialogs handed off pending
- **Why:** real-state writes and foreground native UI are forbidden; full suite runs remotely only through bun run test.
- **Evidence:** docs/loop/LOOP.md:30-32,115-137; logic.md AC1–AC16
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** fixtures fail to model an observed protocol
- **Source:** locked by docs/loop/LOOP.md

## D12: Apply confirmed spec findings before dispatch
- **Question:** Which combined Codex review findings should change the specs?
- **Options:** keep vague contracts; apply confirmed interface/race findings and reject prepass noise
- **Chose:** accepted F2 (public terminal accessory), F3 (home override provenance), F5 (restart revision fence), F6 (credential API/private resolver); also corrected independently confirmed reset-credit scope, shared result schemas, statusline ownership and structured path
- **Why:** these are consumer-visible interoperability/identity gaps. The reset-credit finding was upheld by both reviewers but evidence-gate-suppressed due to a brace-expanded nonexistent citation; independently verified real-file gap still merits fixing. Planned-artifact/heading prepass rows do not.
- **Evidence:** /tmp/m3-accounts-spec-review.vqOBOP/{gate.json,manifest.json,adjudication.md}; actual Codex promote/refute both completed, reduced independence correctly labeled; tech.md corrected contracts; lane6 docs/quirk/specs/2026-10-27-m3-session-info/tech.md:81-86 specifies source session-info-claude
- **Reversibility:** medium (public contracts)
- **Confidence:** high
- **Revisit if:** integrated implementation shows a contract cannot preserve identity/safety
- **Source:** assumed — autonomous

## D13: Execute one four-component wave with disjoint scopes
- **Question:** How should subagent-driven development partition the feature?
- **Options:** sequential full feature; many horizontal waves; four isolated independent components against fixed contracts
- **Chose:** public UI/launch/terminal integration, accounts lifecycle/wiring, usage adapters, accounts UI; one task/worktree per component, width cap 4, no semantic dependency edges because contracts are already fixed. Cross-component build gate runs after all return.
- **Why:** source boundaries are disjoint and all rely on published spec contracts, not another worker's mutable choices. A separate hub-only wave would add no independently usable behavior.
- **Evidence:** tech.md architecture/contracts; code survey file map; public API seams
- **Reversibility:** easy (before dispatch)
- **Confidence:** medium (large account domain, contract integration risk)
- **Revisit if:** workers find an undeclared shared write or semantic dependency
- **Source:** assumed — autonomous

## D14: Baseline verification is green with one recorded load flake
- **Question:** Is the starting runtime/test environment viable?
- **Options:** proceed with untested baseline; run required remote suite and web tooling doctor
- **Chose:** observed bun run test suite-result ok=true; window-projects failed under load and passed the runner's isolated retry; web doctor ready at playwright-cli 0.1.22; Bun 1.4.0
- **Why:** baseline test output establishes environment readiness and the precise flake rather than reclassifying a later feature failure by assumption.
- **Evidence:** observed baseline output artifact://51 (raw artifact://50), 406 remote files and 3 macOS-only files; 18 tests passed on isolated window-projects rerun; doctor ok=true
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** post-change gate reports a deterministic failure
- **Source:** assumed — autonomous

## D15: Preserve Gemini consent and complete Codex config-warning parity
- **Question:** Which documented local flows were missing from the initial implementation contract?
- **Options:** leave implicit/untested; explicitly cover Gemini CLI OAuth consent and Codex last-synced configuration warnings
- **Chose:** Gemini OAuth default-off setting and Accounts consent control; required configWarnings projection and safe managed Codex resync/retention (AC18); always force private Codex file credentials even without a default config
- **Why:** accounts.md explicitly gates Gemini OAuth and displays Codex configuration warnings. Source review found automatic Gemini refresh and a missing-config Codex path that omitted file-store enforcement. These are existing parity/security requirements, not optional scope expansion.
- **Evidence:** accounts.md:83,270; usage/local-adapters.ts initial unconditional refresh branch; profiles.ts setupCodex initial conditional write; logic.md AC18 and amended tech shared contracts
- **Reversibility:** medium (profile/credential lifecycle)
- **Confidence:** high
- **Revisit if:** provider credential or configuration semantics change
- **Source:** locked by research/orca-features/accounts.md

## D16: Complete daemon-driven coverage rather than count service tests as flow proof
- **Question:** Does provider-unit and mounted-UI coverage satisfy the loop's acceptance bar?
- **Options:** count direct UsageService tests; add real daemon API/CLI acceptance for missing flows
- **Chose:** a disjoint acceptance-api/acceptance-fixtures test slice maps every AC to actual daemon/API coverage; real daemon/PTY smoke fixture is prepared outside the repo
- **Why:** LOOP.md requires each flow's test to drive the CLI or daemon API, while tests alone cannot prove the changed runtime/UI surface.
- **Evidence:** docs/loop/LOOP.md:115-137; AccountsApiAcceptance task contract; AccountSmokeHarness scratch-only contract; original usage.test.ts service-only seam
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a test cannot exercise a required flow through the public surface
- **Source:** locked by docs/loop/LOOP.md

## D17: Integrate accepted prerequisites before dependent lifecycle acceptance
- **Question:** How should independently implemented fixed-contract components be exercised together?
- **Options:** fake missing sibling modules in tests; merge audited/accepted integration and usage prerequisites into lifecycle tree
- **Chose:** after all original workers returned and authoritative scopes/HEADs passed, commit accepted integration 32bc433 and usage 0e23da3; parent merges them into lifecycle tree (045a86a) before API acceptance
- **Why:** lifecycle runtime imports the real usage engine and required launch seams. Stubbing those modules would not prove the consumer behavior. All worker edits remain within their original disjoint source scopes; temporary dependency installation is parent-owned.
- **Evidence:** /tmp/quirky-m3-accounts-lane10.BBUvf8/audit-barrier.json; component-checks.json; actual targeted shell20/session44/usage17 passing checks; lifecycle API7 passing after cancellation fix
- **Reversibility:** easy (feature branch only)
- **Confidence:** high
- **Revisit if:** any source worker changes another component's committed files
- **Source:** assumed — autonomous

## D18: Bridge dispatcher authorization once and reserve reset scope before validation
- **Question:** Why did confirmed reset and live telemetry fail the real daemon/API tests?
- **Options:** duplicate confirmation or accept guessed nested hook payloads; consume actual direct events and trust the public dispatcher's completed confirmation
- **Chose:** exact authenticated hook.received agent=session-info-claude protocol; recorded prepare identity gates ingestion. Public reset handler passes explicit authorization to its private adapter, which durably reserves request ID→scope before checking current account/offer.
- **Why:** the dispatcher removes yes/confirmation before handler invocation. Rechecking yes returned confirmationRequired instead of rejecting a stale offer. Reserving after validation left a stale confirmed request's ID reusable for another account.
- **Evidence:** actual daemon acceptance initially3pass3fail, then6pass191expects after fix; packages/daemon/src/server.ts direct event; AccountsAuthSeamFix; usage regression17pass110expects
- **Reversibility:** medium (authorization/ledger ordering)
- **Confidence:** high
- **Revisit if:** dispatcher confirmation or authenticated hook wire format changes
- **Source:** assumed — autonomous

## D19: Distinct known Codex users may share a workspace
- **Question:** Is equal provider/workspace ID alone sufficient to reject a saved Codex login?
- **Options:** reject all equal workspace IDs; distinguish known user emails while retaining matching workspace identity for duplicates
- **Chose:** different known emails are not duplicates; identical available user/workspace identity remains rejected
- **Why:** the real restart flow with two distinct fixture users sharing a workspace was rejected as a duplicate, leaving no second account to select. Native tokens carry user email and workspace identity separately.
- **Evidence:** profiles.ts readCodexIdentity/isSameIdentity; failing Codex restart fixture followed by2pass14expects; lifecycle duplicate coverage9pass62expects retained
- **Reversibility:** easy (identity comparison only)
- **Confidence:** high
- **Revisit if:** a documented provider principal ID replaces email as the stable distinguishing identity
- **Source:** assumed — autonomous

## D20: Use native PTY behavior and strict fixture isolation as runtime evidence
- **Question:** How should shell-routing acceptance avoid tool/fixture artifacts?
- **Options:** external script wrapper and lexical-path pins; real Bun PTY, canonical home equivalence, actual input delimiters and bounded cleanup
- **Chose:** native Bun PTY, canonical ownership paths, genuine newline input and SIGKILL cleanup for the owned interactive test shell; scrub provider-home/auth and shell rc override variables; fake Keychain and HTTP boundaries only
- **Why:** an executed-readiness diagnostic proved interactive Bash remains running after SIGTERM. An earlier sentinel matched input echo and was corrected before drawing that conclusion. Tests must not source the user's rc or inherit provider credentials from environment overrides.
- **Evidence:** /tmp/quirky-m3-accounts-lane10.BBUvf8/pty-signal-proof.ts; actual profiles6pass43expects, including pointer reread in an already-open shell; support/index.ts isolation lists
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** native PTY cleanup or platform process semantics change
- **Source:** assumed — autonomous

## D21: Non-macOS account adapters remain explicit platform work
- **Question:** Which platform-specific places require another platform pass?
- **Options:** claim portability from portable TypeScript; test and record only macOS
- **Chose:** defer Windows credential-store/path and Cursor IDE locations, Windows process-tree cancellation, PowerShell shell routing, Windows junction ownership/removal, and Linux Keychain substitutes/native OAuth browser integration
- **Why:** this loop is macOS-only; provider protocols and storage-independent mapping prefer portable APIs, but those OS surfaces were not exercised.
- **Evidence:** docs/loop/LOOP.md Platforms; profiles.ts Keychain access; login.ts process groups; routing.ts bash/zsh; usage/web-adapters.ts Cursor native paths
- **Reversibility:** medium (platform adapters)
- **Confidence:** high
- **Revisit if:** Linux/Windows become an authorized build target
- **Source:** deferred: platform

## D22: Refresh on actual window focus with freshness debouncing
- **Question:** Does the focus-refresh flow work through the real public event rather than a test-only job invocation?
- **Options:** count job.run as focus proof; subscribe to ui.window.changed and retain freshness debouncing
- **Chose:** refresh from the actual focused-window event; repeated focus within the freshness window does not fetch again
- **Why:** the missing subscription left the documented flow unimplemented. The new daemon/API regression failed before the subscription and passed afterwards.
- **Evidence:** commit 28e8b32; plugins/quirky.accounts/src/index.ts; plugins/quirky.accounts/test/acceptance-api.test.ts
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the public window event or freshness policy changes
- **Source:** assumed — autonomous

## D23: Treat failed browser geometry as an application defect
- **Question:** Can status-bar and settings layout be accepted from mounted-component tests alone?
- **Options:** accept the passing component suite; repair actual daemon UI geometry and rerun the user goals
- **Chose:** bottom-footer flex layout, same-root settings and usage selectors, and explicit interactive overlay pointer handling
- **Why:** the first owned browser run showed Usage as a 207px top block and stacked settings navigation. Hide/restore worked, but that does not excuse the layout failure.
- **Evidence:** .quirk/using-apps-like-a-user/runs/20261027T171413-740a/report.md and observations 7/8; commits de88160 and cd39a76; packages/ui/src/styles.css; plugins/quirky.accounts/src/ui.tsx
- **Reversibility:** easy
- **Confidence:** high for the observed defect; replacement geometry awaits a fresh browser run
- **Revisit if:** the fresh empty/seeded user goals still fail
- **Source:** assumed — autonomous

## D24: Preserve real native conversation data across profile changes
- **Question:** Does retaining provider ID and account environment prove native conversation continuation?
- **Options:** keep metadata-only resume; expose all profile history; bridge the exact recorded Codex rollout and share Claude's canonical native history locations
- **Chose:** validate the recorded source home, UUID and dated rollout; link one regular canonical rollout with bounded copy fallback; refuse conflicts and unsafe paths before replacing the old session. Return and persist the destination transcript locator so A→B→remove A→C does not reuse A's removed path.
- **Why:** native Codex resume needs the rollout in the target home. An ID/env echo cannot prove that. Claude uses stable System-default history paths without overwriting existing configuration/auth/history bytes; the obsolete private history pool is removed.
- **Evidence:** logic/tech resume acceptance amendments in cd39a76; session bridge 01d2398; conversation bridge 0f246ca; profiles 7 pass/50 assertions, restarts 3/21, accounts API 15/90, daemon acceptance 7/199 and session launch 44/108
- **Reversibility:** medium
- **Confidence:** high at the daemon/filesystem boundary; strengthened real-PTY fixture smoke still required
- **Revisit if:** native rollout naming/storage or Claude history locations change
- **Source:** assumed — autonomous

## D25: Fix observed suite and fixture failures without changing production lifetime
- **Question:** How should the first remote gate failures be handled?
- **Options:** narrow or re-pin the suite; repair portable fixtures, readiness conditions and ownership-aware cleanup
- **Chose:** platform-aware Cursor fixtures; one shell-ready helper at all callers; condition-based overlay/alternate-screen waits; delete incidental global built-in list/count assertions instead of re-pinning them
- **Why:** the first remote run failed seven of 414 files. The isolated remote PTY-host file passed; that is load-sensitivity evidence, not proof of a prior defect. Production PTY persistence remains unchanged.
- **Evidence:** first gate artifact 151; commits df6e35d, de7cf77 and 3602c48; isolated remote host suite passed in 11.76s; current full gate remains to be rerun
- **Reversibility:** easy
- **Confidence:** high for repaired assertions/fixtures; host race cause not established
- **Revisit if:** the merged full gate reproduces a failure
- **Source:** assumed — autonomous

## D26: Preserve incoming integration contracts during roadmap catch-up
- **Question:** Which side of the two merge conflicts preserves both feature contracts?
- **Options:** discard account preparation; discard incoming session names/process ownership; combine the independent responsibilities
- **Chose:** retain required account preparation and incoming script-only session names; preserve shell-init inputs and the incoming test ProcessScope environment
- **Why:** all eight incoming decision logs were read. None conflicts with accounts. Ordinary first-shell creation, existing session-info statusline ownership, best-effort hooks, shared structured launch resolution and owned test-process cleanup must remain intact. Blocked sidebar/browser items are not dependencies.
- **Evidence:** merge 8bfd81f; incoming logs fix-ask-regex-budget-20261027, fix-sc31-first-shell-race, fix-test-process-leaks, m1-agent-status-scripting, m2-sidebar-extras, m2-source-control-notes-ai, m5-structured-runner and sa-browser-agent; post-merge typecheck passed, shell 20/47 and session launch 44/108
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** final gate or real UI shows a concrete integration incompatibility
- **Source:** locked by docs/loop/LOOP.md

## D27: Apply the operator's core-flow landing deadline
- **Question:** Should the lane finish every extended UI scenario before landing after the operator's deadline ruling?
- **Options:** continue the original full-flow verification schedule; land proven core flows and explicitly queue the remainder
- **Chose:** the operator's one-hour landing deadline; fix blocking findings only; record uncompleted verification and nonblocking findings in BLOCKERS.md; add a dependent completion item
- **Why:** the operator explicitly authorized this scope reduction and replaced the pre-land whole suite with scripts, typecheck and affected-package checks; the landing command still runs the whole suite.
- **Evidence:** operator decision in this conversation, 2026-10-27 at approximately 14:35 -0500; queue.ts add exited 0 for m3-accounts-remaining-flows, depending on m3-accounts
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a confirmed blocking core defect remains or landing verification fails
- **Source:** locked by operator decision

## D28: Accept real core UI and transcript-content proof, not metadata echoes
- **Question:** Which exercised flows are sufficient for the operator-approved core landing?
- **Options:** infer success from component tests; retain actual built-daemon and browser evidence
- **Chose:** preserve each report separately: empty Hide/restore passed; Claude add/select/Ask/restart passed; rebuilt Usage popover and refresh visibly passed; real CLI/daemon/PTY Claude and Codex resumes read prior content in B
- **Why:** recorded transcript digests match A, both resumed agents append continuation markers, and IDs/cwd are preserved. The first empty run used the wrong Quick Commands panel; that operator-navigation error is not an application defect. The actual clipped-popover defect was the generic footer's overflow and missing flex growth, repaired in 291f2f8 and visibly retested.
- **Evidence:** web runs 20261027T192013-82c7, 20261027T193712-824c and 20261027T194043-4c6e; scratch/smoke/observations-6e5f9892-6b75-44a8-8cb7-01d3a0039342.json; source 291f2f8; latest core regressions 48 pass/295 assertions
- **Reversibility:** easy
- **Confidence:** high for named exercised paths; extended paths remain explicitly unverified
- **Revisit if:** the retained reports or native-only run contradict the core behavior
- **Source:** assumed — autonomous

## D29: Preserve failed and timed-out verification honestly
- **Question:** Can the broad affected-package attempt or stale scripts result be reported as green?
- **Options:** infer a pass from narrow tests; retain exact results and use final integration verification
- **Chose:** record the ten-directory suite attempt as a 1,800-second timeout with no test verdict; retain passing typecheck (13.58 seconds) and the separate 48-test core run; rerun scripts after the final catch-up brings the repaired queue order
- **Why:** the captured package record contains only passing typecheck. The scripts failure was the old queue's forward dependency; an actual current build/roadmap object has none. No protected queue/test file was edited and no whole-suite pass is claimed.
- **Evidence:** scratch/affected-all-checks.json, tree bb9d214a5a12b74780f965c3bdee4e3da2a474da; bg68 timeout; core output artifact 321; actual integration object 0152c82cf691a1067fab693222033429de17eb55; scripts output artifact 282
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** final scripts or landing verification still fail
- **Source:** locked by operator decision

## D30: Finish the final catch-up without changing production source
- **Question:** Did the operator's final integration catch-up invalidate the exercised core implementation?
- **Options:** infer compatibility; inspect incoming paths and rerun the repaired scripts gate
- **Chose:** merge current build/roadmap once; read the complete incoming m5-ledger decision log; retain the unchanged production source
- **Why:** incoming changes were only BLOCKERS, DECISIONS, queue and the ledger log. The repaired queue order cleared scripts: 49 tests/417 assertions passed; typecheck also passed.
- **Evidence:** final catch-up after 25c072e; full m5-ledger log including line 224; verification output artifact 330 (67.83 seconds including typecheck)
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** landing verification fails on its merge result
- **Source:** locked by operator decision

## D31: Record incomplete independent review rather than invent clearance
- **Question:** Can the final code review be called complete at the operator's landing cutoff?
- **Options:** equate silence with a clean review; keep the exact partial verdict and open coverage
- **Chose:** record NOT_REVIEWABLE overall; no three-lens clearance. The S gate returned PASS with zero survivors; C and X each reached Gemini but hit the 180-second watchdog without valid output.
- **Why:** the initial Node transport failed on missing libllhttp before model dispatch; Bun-hosted recovery made real requests. The S candidate claimed hook-injected homes are treated as explicit (sessions.ts:130-138); refute upheld HIGH, but the evidence gate suppressed its citation as falsified. That does not establish the consumer behavior safe or broken, so keep S1 HIGH/unconfirmed for the follow-up. No confirmed blocking source finding was produced.
- **Evidence:** scratch/final-review/round1.partial.json; runs/S/{claims,gate,manifest}.json; actual accounts-api prepass passed in 13.44 seconds on frozen cd45c294..291f2f8; C/X watchdog exits 143
- **Reversibility:** easy
- **Confidence:** high for the execution result; no confidence claim for unreviewed correctness/security
- **Revisit if:** independent follow-up produces a reproducible core defect
- **Source:** locked by operator decision

## D32: Fix the authoritative landing failures instead of claiming completion
- **Question:** Which failures blocked the first integration verification?
- **Options:** ignore the Linux failures and generic-agent regressions; repair the actual boundaries and fixture interpreter
- **Chose:** attach account-only resume metadata only for Claude/Codex; preserve unchanged-home and pre-account System-default native Codex resume; retain strict recorded-provenance bridging for cross-home moves and reject unknown sources into managed targets. Generate fake provider executables with the running Bun's absolute interpreter instead of PATH-dependent node.
- **Why:** the first land reached 448 Linux files on the new GCP host but timed out after exposing real invalid-params and over-applied rollout-policy regressions. The new host also lacks node on its noninteractive PATH. The operator deadline was missed during queue contention and verification; no on-time or landed claim is made.
- **Evidence:** landing output artifact 333; fix ca55659; Mac consumer acceptance 135 tests/752 assertions including 37 resume/fork E2Es (artifact 346); updated build, scripts 62/458, typecheck and focused Linux 12 files passed without flaky reruns (artifact 351)
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** retry landing exposes another blocking core failure
- **Source:** assumed — autonomous

## D33: Retain proof and unexpected local state while cleaning owned worktrees
- **Question:** How should temporary implementation trees and evidence be cleaned after the retry fixes?
- **Options:** force-delete dirty state and evidence; remove merged clean trees and preserve unexpected state outside /tmp
- **Chose:** remove eleven clean merged accounts worktrees; move the remaining lifecycle tree with its modified bun.lock and untracked .serena intact under the loop notes directory. Archive spec/source-review and transcript smoke evidence there before temporary-directory cleanup.
- **Why:** the updated loop requires disk cleanup, but unexpected local changes must not be discarded. A fresh built-runtime smoke after the fixes again proved both providers read A's transcript bytes in B, matched digests and appended continuation markers; all owned runtime groups/homes were stopped/removed.
- **Evidence:** loop notes worktree-cleanup.json and preserved-lifecycle-worktree; evidence/post-fix-smoke.json (source 86ff0426, run 7104041d-e953-4b29-b8d8-80c4114295db); supplemental m3-accounts-overflow-verification registration exited 0 under the updated short-lock queue
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a preserved file needs restoring or a named evidence artifact is missing
- **Source:** locked by docs/loop/LOOP.md

## D34: Install the merged workspace graph before typechecking it
- **Question:** Why did clean landing verification fail to resolve every Accounts dependency after product tests passed?
- **Options:** add type aliases/suppressions; change protected loop code; make the existing public typecheck command prepare its current frozen workspace graph
- **Chose:** `bun run typecheck` now runs `bun install --frozen-lockfile` before the unchanged TypeScript command. Preserve ordinary module resolution and every existing compiler option; no fallback source mappings remain.
- **Why:** protected `prepareVerify` installs on the base before merging the lane branch. The Accounts manifest/lock entry is correct, but its dependency links therefore do not exist when merged typecheck runs. An isolated owned checkout with the Accounts node_modules removed repaired those links and passed the new command in 30.62 seconds (install 66ms). This fixes protocol, React and test dependencies together rather than hiding missing imports.
- **Evidence:** scripts/build-loop/lanes.ts:158-167; second land product suite `ok:true` (448 remote files, two Mac files) and scripts 62/460, then typecheck failure; isolated fresh-resolution bootstrap smoke; package.json typecheck script
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** current-tree frozen installation or typecheck fails on the next merge result
- **Source:** assumed — autonomous

## D35: Preserve protected script assertions after an isolated passing rerun
- **Question:** Do three five-second script-test timeouts justify changing protected infrastructure?
- **Options:** weaken caps/assertions; isolate the affected file and retain its actual result
- **Chose:** leave protected code unchanged; record the full scripts run as 59 pass/3 timeouts and its isolated lanes.test.ts run as 23 pass/60 assertions. The new current-tree typecheck passed as well.
- **Why:** the failures occurred while Git-based fixture operations exceeded the existing five-second test budget, followed by fixture teardown errors. The file passed unchanged alone, matching the incoming m1-agent-status-scripting D47 precedent. The landing command must still run its complete required gates.
- **Evidence:** script timeout output artifact 372; isolated typecheck plus lanes.test.ts passed in 60.89 seconds
- **Reversibility:** easy
- **Confidence:** high for the observed load-sensitive result
- **Revisit if:** the isolated file or authoritative gate fails persistently
- **Source:** locked by docs/loop/LOOP.md

## Progress
Ready for the next authoritative landing retry. Core native boundaries are repaired and runtime smoke passed; 135 Mac consumer tests/752 assertions and 12 focused Linux files passed. The second land's complete product suite passed 448 remote files plus two Mac files with five runner-confirmed load flakies, and scripts passed 62/460; only post-merge dependency setup blocked typecheck. D34 repairs that setup without protected-loop edits or compiler fallbacks, proven in an isolated checkout with missing Accounts dependency links. Extended UI/native flows, incomplete independent review and unconfirmed S1 remain tracked in the two dependent items and BLOCKERS. Deadline miss remains explicit. Commit the dependency-setup fix/evidence, detach and retry queue.ts land; do not claim done until its verified result.
