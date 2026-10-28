# m7-sweep-sessions decisions

## D1: Sweep all five session feature docs through their canonical owners
- **Question:** What is the purpose, consumer, scope and success criterion of this iteration?
- **Options:** Rebuild the features; only run inherited suites; inventory every flow and repair missing behavior in the existing built-ins.
- **Chose:** Inventory accounts, AI Vault, handoff, Session Info and terminal dock; implement missing kept flows through their existing public owners and verify the actual changed paths.
- **Why:** The queue names all five docs and roadmap parity requires every kept flow without Orca's defects. Existing implementations and decisions bind this work.
- **Evidence:** docs/roadmap.md:13-55,171-188; external accounts.md, ai-vault.md, handoff.md, session-info.md, terminal-dock.md; canonical queue wait receipt for m7-sweep-sessions.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** A required flow conflicts with a locked architecture decision.
- **Source:** locked by docs/roadmap.md and queue item

## D2: Apply the end-phase verification policy now that triage is claimed
- **Question:** Does build-first mode still suppress testing and dogfood?
- **Options:** Assume the old policy remains; inspect the canonical queue and follow the phase transition.
- **Chose:** Normal end-phase sweep verification; m7-test-triage is in-progress on lane8. Do not run implementer checks mid-flight; parent verifies after the barrier.
- **Why:** LOOP explicitly ends build-first suppression when m7-test-triage is claimed, and this sweep became available after that transition.
- **Evidence:** docs/loop/queue.json m7-test-triage status in-progress/lane8; authoritative build/roadmap:docs/loop/LOOP.md.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** The operator changes verification policy.
- **Source:** locked by docs/loop/LOOP.md

## D3: Resolve unattended gray areas using the existing product contracts
- **Question:** Which Visual, API, CLI, Data and Integration choices apply?
- **Options:** New layouts/auth/persistence conventions; preserve existing defaults, ownership and explicit failures.
- **Chose:** Existing panels, menus, settings and daemon-authoritative view state; visible empty/loading/waiting/stale/error states; schema-generated CLI and existing error envelopes; exact source/account/provider/host identity; bounded data and generation guards; no automatic uncertain resend, scope widening or destructive replay. Usage urgency follows consumption even in Remaining mode; search remains opt-in; edited handoff previews and newer dock drafts survive failures.
- **Why:** These are observable requirements in the five feature docs, not new product design. Standard relevant gray areas are layout/density/interaction/empty/error/loading, auth/errors/pagination, output/flags/recovery, input/error/idempotency, and mapping/conflict/retry. Purpose, consumers, scope, constraints, main behavior and success are established by D1 and the source docs. Markdown combined spec and autonomous approval follow LOOP; no research swarm, companion, ADHD or human ask.
- **Evidence:** External feature docs What the user can do and Edge cases; m3-* decision logs; docs/loop/LOOP.md Answering a skill's questions.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** An actual flow shows a missing public capability.
- **Source:** locked by feature docs and docs/loop/LOOP.md

## D4: Preserve explicit dropped features and other owners
- **Question:** Does the broad parity title authorize native chat, dictation, quarantine, new transports or deferred hosting products?
- **Options:** Reintroduce dropped dependencies; preserve the locked adaptations and implement only kept session flows.
- **Chose:** Interactive terminal plus dock, no native chat or dictation or input-quarantine refusal; no global Claude settings writes; no GitLab/Bitbucket/Gitea/Forgejo/Azure, Objective runner or PR sitter. Reuse authenticated host owners rather than invent authority or widen phone grants. Preserve inherited untracked .serena untouched.
- **Why:** These exclusions are locked by roadmap/architecture or explicit queue scope. A source code path is not authorization to recreate a dropped product.
- **Evidence:** docs/architecture.md:175-178,290-324; docs/roadmap.md:173-181; m3-terminal-dock D10; m3-session-info D5; queue title.
- **Reversibility:** hard
- **Confidence:** high
- **Revisit if:** An authorized product ruling changes the locked scope.
- **Source:** locked by docs/architecture.md and docs/roadmap.md

## D5: Apply normal end-phase specification and caught-up review gates
- **Question:** Does the triage transition end only test suppression, or every build-first shortcut?
- **Options:** Combined spec/typecheck-only shortcut; normal logic+tech, combined spec review, affected tests/build/web and final review.
- **Chose:** Normal gates. Corrected the initial combined-spec assumption before implementation; authored sibling tech.md and performed actual Codex standard promote/refute review. Use omp-task/OpenAI implementer and Gemini final review after actual Opus unavailable/Gemini reachable probes.
- **Why:** LOOP's build-first overrides last only until m7-test-triage is claimed. The semantic spec review proposed F1 opener outcome ambiguity (refuted: contract already distinguishes accepted spawn from eventual browser/login), F2 too-narrow suffix allocation (contested below-deep, caller clarified reserved minimum and220px acceptance), F3 post-review catch-up ambiguity (standing MEDIUM, gate suppressed due stale LOOP line evidence; caller independently accepts and fixes ordering to catch-up/recheck before final review). No semantic blocker remains after corrections; no fabricated green gate.
- **Evidence:** /tmp/quirky-session-sweep.2Whr6x/spec-review raw promote/refute/gate/manifest; tech.md Contracts and Testing strategy; canonical queue triage in-progress.
- **Reversibility:** easy
- **Confidence:** high for observed review and corrections; Codex same-family independence is reduced.
- **Revisit if:** Final gate or actual flow reveals a new boundary mismatch.
- **Source:** supersedes D3 combined-spec shortcut; locked by docs/loop/LOOP.md

The deterministic combined-scratch prepass returned25 path findings, not a clean result. Caller dispositions: F4–6 abbreviated account paths expanded/located under the explicitly named Accounts plugin; F8–15 abbreviated Vault/Dock/Info paths expanded to full plugin paths; F20 protected index path expanded. F7 is an RPC name, not a file. F16–19 are explicitly new helper/test targets or a command naming those future targets. F21 names the newly authored native handoff (created during review, absent from the prepass's tracked snapshot). F22–28 are valid sibling relative links in the actual committed spec directory, relocated by the combined scratch artifact. These are resolved references/planned artifacts/command grammar, not missing product behavior. The gate remains NEEDS_FIXES with25 deterministic findings and3 suppressions; caller adjudication supplies the recorded correction/false-positive disposition rather than changing reviewer JSON.

## D6: Repair the two current Accounts defects and verify, not rewrite, completed flows
- **Question:** Which apparent gaps remain in current source after historical follow-ups?
- **Options:** Reimplement old Vault/Dock fixes; trust done queue labels; inspect current source and execute every retained flow.
- **Chose:** Accounts gap-aware layout/contained measurement and native-compatible Open invocation are the initial repairs. Vault copy-first/log portal, dock stacking/cards/cache/lifecycle/fractional-height fixes and Session Info wrapping already exist and receive actual verification. No shared API change; reuse the public terminal opener and existing validated pending URL.
- **Why:** SessionParityMap corrected its historical-gap shortlist against current source and complete later logs. Accounts overflow D8 explicitly made no source fix and native link remains target=_blank; the other named gaps were repaired before their verification campaigns stopped.
- **Evidence:** Accounts Usage.tsx403–434/styles.ts39–44/AccountsSettings.tsx28–49; m3-accounts-overflow-verification D7–D8; native m3-accounts AC6–7; Vault HistoryPanel324/570–572/styles27; dock fix D6–D19; Session Info followup D7–D8.
- **Reversibility:** medium
- **Confidence:** high for source/failure records; no current runtime pass claimed.
- **Revisit if:** Actual smoke/UI/suites expose another kept flow defect.
- **Source:** assumed — autonomous, source-grounded parity inventory

## Progress
Specs/contracts committed f60971f8, then spec review corrections/native handoff ready to commit. Mapper returned, no code worker launched yet. Accounts component worktree exists under /tmp/quirky-session-sweep.2Whr6x/accounts; update it to the final spec checkpoint before dispatch. Next: two disjoint tasks (Accounts implementation; external real-runtime/API/CLI/web fixture preparation), authoritative scope/HEAD barrier, parent checks and full guarded campaign. No test/build/UI result is claimed yet.
