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

## Progress
Step 5 catch-up complete (8bfd81f), with all eight incoming decision logs read. Account/history integration and compiler repairs are committed. Latest targeted evidence: typecheck passes after catch-up; shell 20/47, session launch 44/108, accounts API 15/90, profiles 7/50, restarts 3/21, daemon acceptance 7/199. No green whole gate yet: the first remote run failed seven files, repaired as D25. The initial owned web run failed geometry; D23 repairs require fresh empty and seeded browser verification. Next: commit this log, build and run the exact full gate, execute strengthened real-daemon/PTY data smoke and all UI goals, then one actual cross-family Gemini Final Round 1 and one fix batch, rebuild/retest, native-only pending handoff, documentation and queue land. Scratch /tmp/quirky-m3-accounts-lane10.BBUvf8 retains source-bound audit/gate evidence and the smoke harness. Never claim completion from IDs/environment alone or reuse stale gate/tree hashes.
