# m3-vault-consent-tip-completion decisions

## D1: Vault owns its one documented search tip, with a real UI consumer
- **Question:** No canonical feature-tip owner exists; where does the related tip live?
- **Options:** Add an unconsumed vault marker; build a generic onboarding subsystem; let Vault own its documented search tip and consume that state in its existing consent surface; block for another owner.
- **Chose:** Vault owns the agent-session-search tip in its existing daemon store, exposes its state through its public API/CLI, and its existing consent surface consumes that state.
- **Why:** The item explicitly requests establishing the owner/state. An unconsumed marker would not complete the flow. A generic registry or separate plugin is unnecessary for one feature; Mobile onboarding is unrelated. Blocking merely because the missing behavior has not yet been implemented would leave reachable work unfinished.
- **Evidence:** ai-vault.md:12,50-55; plugins/quirky.vault/main.ts:7-18; source surveys ConsentTipSurvey and TipSeams; repository search found no feature-tip owner. Mobile owns its independent onboardingSeen setting.
- **Reversibility:** medium (a future global tip owner would migrate this state, not duplicate it)
- **Confidence:** high
- **Revisit if:** A canonical global tip owner is introduced with a migration contract.
- **Source:** assumed — autonomous

## D2: Seen is a consequence of successful local opt-in, never authorization to index
- **Question:** Which enable, failure, restart, disable and remote semantics apply?
- **Options:** Mark on display/click; infer seen from enabled during startup; mark after successful local API enable; mark after any remote enable.
- **Chose:** Mark only after the local setSearchEnabled(true) operation successfully persists/applies policy and confirms enabled status. Repeated successful enables are idempotent. Disable/clear never reset seen. Failed enable, invalid input, remote-only enable and merely reading/displaying tip state do not mark it. Existing local/all selection semantics remain; a successful local portion of all-host enable counts.
- **Why:** This fulfills SC-07 without turning ancillary state into consent or creating a searchable copy before explicit opt-in. Generic setting writes retain existing policy semantics but are not the consent-card tip action.
- **Evidence:** ai-vault.md:54-59,242; m3-vault D5; plugins/quirky.vault/src/service.ts changeLocalPolicy and setSearchEnabled.
- **Reversibility:** hard for privacy, easy for bookkeeping
- **Confidence:** high
- **Revisit if:** Consent semantics are explicitly changed.
- **Source:** locked by docs/quirk/specs/2026-10-27-m3-vault/logic.md

## D3: Use one disclosure surface; seen never removes future consent controls
- **Question:** How is the tip a consumer-visible feature rather than an orphan marker?
- **Options:** Add a second promotional card; suppress all consent after seen; use tip title/description/action on the existing full-disclosure card while unseen, normal consent copy after seen.
- **Chose:** The existing local off-state disclosure uses Search every agent session, the documented description, and Turn on session search when its daemon-owned tip is unseen. It keeps the complete privacy disclosure. After seen, an off-state card still offers Enable. Unknown/loading tip state uses ordinary consent, never guessed unseen. Multiple windows refresh from a committed tip-state event; cold mount reads the public owner API.
- **Why:** One opt-in control avoids duplicate UI and preserves re-enable consent. Title/description/action come from the source feature, not a new onboarding concept.
- **Evidence:** ai-vault.md:12,54-55; plugins/quirky.vault/src/window/HistoryPanel.tsx SearchDisclosure.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** A shared feature-tip presentation owner ships.
- **Source:** assumed — autonomous

## D4: Use current standard loop steps after the night-mode cutoff
- **Question:** Which workflow and backend pairing apply?
- **Options:** Continue expired night-mode shortcuts; follow normal two-spec and review workflow.
- **Chose:** Two markdown specs, self-answer all questions, no research swarm or human ask, one implementation component because all changes implement one small vertical flow, then one final cross-family round/fix batch. OpenAI task implementer; Gemini high reviewer after actual Opus/Sonnet probes reported no authenticated model. Spec review uses reachable Codex as LOOP requests and is labeled same-family. Preserve inherited untracked .quirk/ and .serena/ without committing them. Tests use private state. macOS only.
- **Why:** Actual clock was 2026-10-28T05:40:50-0500. The feature doc/current code settle the bounded design; external industry research would not establish a missing internal owner.
- **Evidence:** pi-watch --check probes: opus/sonnet unavailable; gemini google/gemini-3.1-pro-preview:high ready; codex gpt-6.1-sol:medium ready; terra and flash ready. LSP status: no language servers configured. Initial HEAD 93ea5d004adb00d83dbd23ef2eb21b58eedcc9a2; no tracked inherited changes.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Reviewer dispatch fails or implementation reveals a real dependency.
- **Source:** assumed — autonomous

## D5: Keep model response and raw local event contracts distinct
- **Question:** Why did the cold-window disable scenario leave consent hidden?
- **Options:** Add polling/retries; remove the cold-window case; adapt the actual raw worker event only for the selected local host.
- **Chose:** The raw local SearchStatus event has a separate parser. Public API responses still require the existing status/hosts envelope. Remote/all-host selection is not overwritten by local worker progress.
- **Why:** The diagnostic run proved canonical disabled status and seen true, but the mounted UI remained searchEnabled true; parsing a raw event as a response envelope discarded the transition. Correcting the boundary restores ordinary consent after disable without timers or test corrections.
- **Evidence:** Actual diagnostic artifact31:362-442,748-770; worker.ts emits raw searchStatus, model.ts previously required an envelope. Failing focused case before fix took40.72s; after fix passed1 test19 assertions5.25s. Temporary diagnostics removed. React synchronous-unmount warnings remain disclosed; no passing-without-warnings claim.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Worker events gain a host-qualified envelope with a migration contract.
- **Source:** assumed — autonomous

## D6: Verify real failures without corrective mutations or production test hooks
- **Question:** How can failed enable prove the tip remains unseen and search stays off?
- **Options:** Mock worker success/failure; disable after failure and inspect; obstruct the private SQLite path and use a real store trigger, then observe through a read-only serialized getter.
- **Chose:** The real daemon tests use a private directory occupying the search DB path to make worker application fail, and a SQLite trigger rejecting only the canonical tip write. The latter starts from an already-enabled policy to exercise fail-closed rollback. The read-only getter drains policy work, never changes it.
- **Why:** A corrective disable would mask broken rollback; a marker-only mock would not establish the actual owner or worker privacy boundary.
- **Evidence:** search-tip.test.ts has8 tests60 assertions passing in12.24s, including API/CLI no DB, missing/malformed persisted state, successful consent/query/restart, idempotence/disable/clear, invalid input, actual worker failure/recovery, actual tip-write failure, remote-only/all boundaries. Before implementation, missing getSearchTip failed with RpcError -32009; missing visible tip failed the UI case. Two initial test fixture defects (lazy activation and missing directory parent) were corrected, not product behavior or deadlines.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Vault store or worker policy lifecycle changes.
- **Source:** assumed — autonomous

## D7: Preserve explicit implementation-attribution and review limits
- **Question:** What evidence and deviations can this run actually claim?
- **Options:** Claim a clean spec review and pre-dispatch snapshot; record exact observed limits and parent integration.
- **Chose:** Codex spec gate reported NEEDS_FIXES with5 scratch-copy-relative path findings rejected against the actual sibling links; its sole model rollback claim was refuted, then wording clarified anyway. Reduced same-family independence and near-total model suppression are explicit. The component baseline was captured after dispatch while it still had no implementation/test edits; generated .serena mode644/blob36cd3def was preserved. Parent added the declared searchTipChanged event schema after component scope audit and before green acceptance because it was omitted from the initial contracts commit.
- **Why:** No fabricated clean/snapshot assertion; the final actual scope/HEAD barrier covered all owned writes. The one component returned without commits/checks; parent committed2782314a, merged it and removed its owned worktree.
- **Evidence:** /tmp/quirky-l8-tip-journal.json; /tmp/quirky-l8-tip-review-spec/; component and main HEAD739f3d52 at both barriers, exact7-file component scope plus unchanged generated configuration. Single final roadmap merge brought only sa-browser-design-mode decisions; those are being read before review.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** A review or ownership audit finds an unaccounted write.
- **Source:** assumed — autonomous

## D8: Preserve the actual packaged consent proof and Native boundary
- **Question:** What user-visible evidence and incoming decisions apply?
- **Options:** Infer UI behavior from tests; exercise the compiled surface with private state.
- **Chose:** Guarded web campaign20261028T111325-20fc passed the complete tip-consent goal in6 actions, with no findings, gates, overrides or cleanup errors. The fixture accurately showed28 unavailable roots. Owned daemon/PTY scope stopped exit0 and its private home was removed. No Native guest or real account/agent was used.
- **Why:** Screenshots prove the promotion/disclosure, zero transcript-only matches before opt-in, one highlighted result afterwards, and ordinary consent after Settings disables search. This does not claim unrelated Vault parity or native-window proof.
- **Evidence:** Private report and obs1–7 under .quirk/using-apps-like-a-user/runs/20261028T111325-20fc/. Complete incoming sa-browser-design-mode D1–D37/421lines read by IncomingTipConstraints, plus BLOCKERS Native image boundary read by parent; no Vault conflict. Static TipPluginValidation passes only the new method/CLI/event structure.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** A changed compiled surface or Native-only behavior requires separate end-phase acceptance.
- **Source:** assumed — autonomous

## D9: Retention rollback cannot prevent turning search off
- **Question:** Does final security claim X1 hold when the entire plugin store rejects writes?
- **Options:** Accept Flash's refutation based on a tip-only trigger; reproduce whole-store failure and isolate the safety rollback.
- **Chose:** Parent accepts X1 as MEDIUM. The strengthened real SQLite trigger rejects both tip and retention writes. Before the fix the real API left enabled true; after moving disable operations before retention restoration and retaining both error diagnostics, the same case passes with off/unseen.
- **Why:** Independent SQLite statements do not make a persistent store-write failure disappear. The original tip-only trigger did not test the claimed whole-store failure.
- **Evidence:** Actual parent RED artifact62 expectedfalse/receivedtrue at search-tip.test.ts214; after repair1pass8assertions456ms. First attempted fixer edited the parent instead of its assigned tree; the scope audit caught it, stopped the worker and rejected that component. Its first component test ran unchanged old code and is explicitly not RED evidence. Parent replanned a single sequential service/test fix; empty component worktree removed.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Another failure can bypass independent policy shutdown.
- **Source:** assumed — autonomous

## D10: Qualify the final review rather than claim independent clearance
- **Question:** What did the final review actually establish?
- **Options:** Report all machine PASS gates as clearance; retain exact tool and independence limitations.
- **Chose:** C and S Gemini high promote/refute gates passed; X Gemini refute twice failed its output contract, then Flash fallback refuted X1 and its mechanical gate passed. Parent rejected that refutation and fixed X1 with real RED/GREEN evidence. The prepass Vault suite16/16files passed without retries. No second review round was run.
- **Why:** Reviewers violated read-only constraints: S temporarily patched/restored service.ts, producing a backup; X wrote simulations and a private VaultRig probe. These undermine a clean independent-context assurance. The actual raw traces are retained; no model output was repaired into valid JSON or falsely labeled clean. Flash's valid JSON was transported verbatim to the mechanical gate.
- **Evidence:** /tmp/quirky-l8-tip-review-final/ C/S manifests, X invalid outputs and X-gate-fallback; S-promote stderr patch/checkout trace; X stderr probe creation traces. All7 attributed reviewer-only scratch files were removed after readers established provenance; no unrelated .quirk/ or .serena/ data was removed. Review source snapshot was93ea5d0..db51f807; bun.lock8 incoming lines excluded. Final source repair is verified by the focused regression, not reviewed a second time.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** End-phase review needs stronger read-only isolation or independent closure.
- **Source:** assumed — autonomous

## D11: Land now under the operator's build-first policy
- **Question:** What remains after the operator moved testing/debugging to the end phase?
- **Options:** Continue suites/reviews/dogfood; commit current implementation, typecheck and land.
- **Chose:** Stop all additional test/debug/review/dogfood work. Commit the already implemented flow and rollback repair, run only bun run typecheck, then authoritative queue.ts land. No follow-up: no in-scope flow remains unbuilt. Existing broader Vault parity owner is unchanged. Earlier specs/tests/reports are historical evidence, not a claim of current full-suite acceptance after the final repair.
- **Why:** The operator explicitly superseded the earlier workflow and queue.ts land now checks typecheck only.
- **Evidence:** Operator interjection; current build/roadmap:docs/loop/LOOP.md section Build first, test at the end, read with git show after the interjection.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** m7-test-triage starts the end phase or the operator changes policy.
- **Source:** locked by docs/loop/LOOP.md

## Progress
All in-scope flows implemented. All workers, review processes, suites and the owned UI service have finished; no additional testing/debugging/reviews are authorized before the end phase. Commit current source/tests/docs, make bun run typecheck pass, detach and land m3-vault-consent-tip-completion through the authoritative queue controller. No new follow-up and no second item. An ordinary successful land does not print LOOP_DONE.
