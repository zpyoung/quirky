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

## Progress
Step 5 ready. Both specs reviewed with actual Codex promote/refute and confirmed findings corrected (D12). Baseline remote suite green with one load flake (D14). Next commit specs/log; fork four component worktrees and dispatch D13 through OpenAI task agents, keep main tree untouched during wave; audit scopes/HEADs, run narrow acceptance then merge/required whole gate. Required final catch-up, read incoming decisions, one Gemini final round/fix batch, built smoke/web/native handoff and queue land remain. No implementation changes yet. Scratch /tmp/quirky-m3-accounts-lane10.BBUvf8; review /tmp/m3-accounts-spec-review.vqOBOP.
