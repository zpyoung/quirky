# m7-terminal-provider-host-and-worktree-remainder decisions

## D1: Extend existing owners and retain the complete inherited obligation
- **Question:** What purpose, consumers, success criteria, constraints and boundary govern the new remainder item?
- **Options:** Replace authorities; equate related shipped features with missing flows; extend owners and account for every inherited flow.
- **Chose:** Extend existing public provider/status/recipe, CLI/kernel, worktree and terminal/editor/Browser owners. Entire predecessor Landing disposition and queue title remain acceptance inventory; exact shipped/unbuilt disposition required.
- **Why:** Roadmap parity/API/plugin rules bind, and current owner map shows most gaps are engineering rather than outside blockers.
- **Evidence:** predecessor logic.md:95-126; docs/roadmap.md:13-56; RemainderOwnerMap source report.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** Incoming decisions reveal an exact flow already implemented by another owner.
- **Source:** locked by docs/roadmap.md and predecessor decisions D1-D18

## D2: Keep executing host, grant and incarnation as authority
- **Question:** How should API/authentication, host mapping, remote selection and retry gray areas resolve?
- **Options:** Caller labels and local fallback; phone-grant escalation; exact authenticated owner and typed refusal.
- **Chose:** Exact host/window/session/process/dispatch and existing transport; separately authenticate owner CLI, never widen mobile grant. No explicit remote-to-local fallback. Model snapshot/retirement keyed to actual execution and automation owner; failed/empty probes preserve choices. Public schemas keep existing CLI JSON/request/confirmation/error conventions.
- **Why:** Current discoverModels accepts arbitrary host but runs local and caches by agent; this is not authoritative remote evidence. Phone permission is deliberately narrower than owner token.
- **Evidence:** agents/service.ts:230-246,498-551; cli/paired-link.ts; predecessor D2,D13,D18; launch-settings.md:175-179.
- **Reversibility:** hard
- **Confidence:** high
- **Revisit if:** Existing peer authority supplies a stronger exact execution/grant primitive.
- **Source:** assumed — autonomous; locked by docs/architecture.md

## D3: Route workspace view lifecycle by live kernel window identity
- **Question:** How do visual interaction, state persistence, ambiguity and recovery behave with multiple windows?
- **Options:** Global layout writes; infer focused window; exact connId routes with compare-and-close.
- **Chose:** Public ui.window.state/view.open/view.close/command.run uses live connId; expectedView close CAS; worktree optional window selector, independent history. Preserve singleton calls, refuse ambiguous/missing/stale targets. Sleep parks views, never kills processes/history/buffers. Loading/empty/refusal/errors remain explicit and drafts survive.
- **Why:** Auxiliary Dashboard registry is not generic workspace lifecycle, and existing navigation/sleep explicitly refuses multi-window state. CAS prevents closing a view selected after inspection.
- **Evidence:** layout.ts:211-252,364-372,401-482; worktree navigation.ts:47-61; controls.ts:143-214.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** Kernel window lifetime contract changes or actual smoke shows cross-window mutation.
- **Source:** assumed — autonomous

## D4: Use one canonical creation/removal pipeline and actual cleanup evidence
- **Question:** How should data/error/idempotency/performance gray areas resolve for prepared pools, recipes, tabs and cleanup?
- **Options:** Parallel create authority; unsupported-looking success; existing pipeline with preflight and bounded pool.
- **Chose:** Existing create/remove, setup trust and terminal/tab owners. Prepared detached/locked pool max3/5min, exact-base matching and stale/dirty refusal. Invalid selected recipes/tabs/host refuse before mutation; actual selected supported options apply. Cleanup volatile/connectivity/desktop-origin evidence comes from real owner producers, never caller death assertions or phone-origin substitution; fingerprint and recheck canonical safety.
- **Why:** Source feature explicitly describes pool and recipe/tab composition. Refusing them is not implementation. Unknown context cannot authorize deletion.
- **Evidence:** worktrees.md:255-275,292-299; create.ts:46-83,164-170; controls.ts; parity-types.ts.
- **Reversibility:** medium
- **Confidence:** high for contract, implementation unverified
- **Revisit if:** A public owner reports selected composition is unsupported or exact safety proof cannot be established.
- **Source:** assumed — autonomous; locked by worktrees.md

## D5: Separate names, graphics, themes and floating document authority
- **Question:** Are existing summaries/SIXEL/global theme/related destinations equivalent to missing names/Kitty/themes/floating flows?
- **Options:** Treat related features as parity; duplicate renderer/document stores; extend the exact owning paths.
- **Chose:** Distinct branchName and conversationName recipes through canonical generation/resolver; bounded actual Kitty support, independent terminal light/dark/custom colors, explicit authorized floating document root and exact hosted group. Existing Browser/Markdown/editor/native policies remain owners. Unimplemented distinct flows are retained explicitly, not relabeled complete.
- **Why:** A summary/reply draft is not a generated name; SIXEL/iTerm is not Kitty; synthetic workspace ID alone grants no disk authority.
- **Evidence:** predecessor D8,D14; ai-recipes.ts:6-16; terminal README:11-28; term-ui.md:142-160,245-265.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** Existing owner already implements an exact named flow.
- **Source:** assumed — autonomous

## D6: Keep native external prerequisites truthful
- **Question:** Can notification permission/click/dismiss and production signed host be built against current external authority?
- **Options:** Invent callback acknowledgement or ad-hoc production identity; patch private SDK; preserve actual prerequisite.
- **Chose:** Current security find-identity -v -p codesigning returned zero valid identities (exit0). No production signed helper/TCC/launchd/admission/upgrade claim. Supported SDK notification callbacks remain unavailable per predecessor audit/current capability declarations; void showNotification never proves delivery. Continue reachable source independently.
- **Why:** Source routing cannot supply nonexistent credentials/callbacks. No private SDK fork or fake permission success is authorized.
- **Evidence:** observed signing command this iteration; apps/desktop README:55-59; predecessor D9; desktop-capabilities.ts:23-38.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** Authorized packaging identity or supported callback-capable SDK becomes available.
- **Source:** deferred: signed production helper and native notification callbacks

## D7: Apply contract-first build-first execution with three isolated components
- **Question:** Which skill defaults, architecture split and verification gates apply unattended?
- **Options:** Human questions/research/review/suites; skip all evidence; autonomous standard gray areas and scoped source work.
- **Chose:** No person/ask, companion, adhd, research swarm, formal review, suite or dogfood campaign. One combined self-reviewed spec and shared protocol signatures committed first; three disjoint isolated omp task components plus parent integration. IMPLEMENTER=omp task, AUTHOR_FAMILY=openai; eventual cross-family reviewer preference Opus, no review/probe/pass claimed in build-first. LSP status attempted: no servers configured. Parent narrow real changed-path smoke and typecheck; one catch-up before land. Preserve foreign .serena/.
- **Why:** Authoritative LOOP overrides normal skill gates; developer still requires significant path smoke. Shared contract makes B/C implementation independent.
- **Evidence:** git show build/roadmap:docs/loop/LOOP.md; lsp status result; initial git status; combined spec technical section.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** End phase starts or LOOP changes.
- **Source:** locked by docs/loop/LOOP.md

## D8: Preserve macOS-only and overlapping feature ownership
- **Question:** Which platform/overlap gray areas must not become duplicated work?
- **Options:** Build new phone/Browser/orchestration authorities; expand excluded platforms; retain exact landed owners.
- **Chose:** macOS build/smoke only; Linux/Windows/WSL paths remain unclaimed platform work. Retain phone origins/parking/tabs/Watch/artifacts/foreground notifications, editor leases, Browser controls/import/routing, automation provenance/sidebar, dock/native clipboard, host power/shutdown and worker federation. Preserve hosting/Objective/sitter/native-chat/voice exclusions. Remote provider composition extends canonical paired/federation owner only.
- **Why:** Related mobile evidence is not desktop identity, and generic worker heartbeat already has an owner.
- **Evidence:** predecessor D5,D16,D18; docs/architecture.md Decisions; claimed queue title.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** Incoming authoritative decisions amend ownership or platform scope.
- **Source:** deferred: platform

## D9: Prepare provider probes through the account owner without fake sessions
- **Question:** How can a Codex model-list process use the selected managed account while session prepare requires a real registered session?
- **Options:** Spawn with generic process.env; fabricate a session ID for prepare; factor the actual account resolution into a no-session public preparation path.
- **Chose:** Public quirky.accounts/prepareProviderEnv takes only agent/cwd/homeOverrides and returns the existing account preparation result with shellInit:null, no resume, no account_sessions insert/update. Share actual selection/home precedence/ownership/auth/config-sync behavior with prepare; existing session preparation still persists genuine identity. Explicitly materialize the probe's effective home environment. A's scope expands only to this account owner extension/tests/docs; parent commits the shared input type before resuming A.
- **Why:** A probe must use the selected account, but fake provenance would corrupt restart/stale-session identity. A missing public method is reachable API growth, not an outside blocker.
- **Evidence:** accounts/service.ts:392-480,988-1026; structured pre-spawn public prepare flow; ProviderPrepareInput in accounts/src/types.ts.
- **Reversibility:** medium
- **Confidence:** high for contract; source and smoke unverified
- **Revisit if:** Existing account boundary cannot supply effective env without changing genuine session identity.
- **Source:** assumed — autonomous

## Progress
Claimed after twenty-one busy waits. Branch created from current integration. All predecessor decisions and source map read; combined spec self-reviewed. Shared exact-window type and RPC signatures authored; next commit spec/contracts, create isolated component trees and dispatch three implementers. No tests/reviews/dogfood run, no runtime smoke or typecheck pass yet. Foreign .serena preserved.
