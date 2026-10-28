# m3-vault-parity-completion decisions

## D1: Finish the queued matrix without reopening the landed core
- **Question:** What is this item's acceptance boundary?
- **Options:** Rebuild Vault; accept core evidence as parity; complete each explicitly queued flow against the landed implementation.
- **Chose:** Complete SC-02/03/06/08/10/11/15/16/18/19/20/21/22/23/24 and hand off native-only SC-17/18. Keep original scenario numbering and source requirements.
- **Why:** The core landing explicitly did not claim these obligations passed. Most gaps concern consumer proof; SC-21 and restarted-child lookup also need implementation.
- **Evidence:** docs/loop/BLOCKERS.md:157-176,247-249; docs/quirk/specs/2026-10-27-m3-vault/logic.md:49-153.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** A locked decision prevents a required flow.
- **Source:** locked by docs/loop/LOOP.md

## D2: Answer workflow gates autonomously and retain the source defaults
- **Question:** Which design questions require a person, and which gray areas matter?
- **Options:** Wait for approval; invent a new product; apply the existing approved behavior with recorded choices.
- **Chose:** No human asks. Markdown combined logic/technical spec, no research swarm, no visual/ADHD offer. Resolve Visual loading/density/empty/error/interaction, API errors/pagination/auth, CLI flags/exits, Data format/idempotency/error handling and Integration mapping/ownership using the original contract.
- **Why:** LOOP.md explicitly supplies the autonomous defaults. Workspace then Project then All contextual default, stable view settings, explicit unknown-scope refusal, honest degraded/limit/retry states, source-safe actions and same-token access are already decided.
- **Evidence:** docs/loop/LOOP.md; docs/loop/decisions/m3-vault.md D3–D15,D20,D29,D35,D38,D48.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Source evidence contradicts an inherited decision; record a superseding decision before changing it.
- **Source:** locked by docs/loop/LOOP.md

## D3: Use three disjoint vertical components and existing public contracts
- **Question:** How should implementation avoid shared-file races?
- **Options:** Serial monolith; split every scenario; three components with one owner for each source and test file.
- **Chose:** Window browse/settings/search/presentation; scanner/index/Worker/recovery; public actions/service/CLI/hosts and owner integrations. Actions belongs only to the third component, scanner child re-resolution only to the second. Parent owns spec, native handoff, built-browser campaign, integration and landing.
- **Why:** This keeps the HistoryPanel and actions hubs single-owned while allowing real parallel progress. Shared Vault types and canonical public result envelopes stay unchanged. Existing handoff SourceRef is the archived-source authority.
- **Evidence:** plugins/quirky.vault/src/actions.ts; src/window/HistoryPanel.tsx; src/scanner/index.ts; plugins/quirky.handoff/src/daemon/types.ts:7-19; original tech.md:49-125.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** An implementation requires a cross-owner interface change; amend contracts before edits.
- **Source:** assumed — autonomous

## D4: Pair OpenAI task implementers with the available Gemini reviewer
- **Question:** Which cross-family backend can execute this omp run?
- **Options:** omp plus Opus; omp plus Gemini; same-family review.
- **Chose:** IMPLEMENTER omp task, AUTHOR_FAMILY openai, REVIEWER_ALIAS gemini (google/gemini-3.1-pro-preview, high). One final review round and one blocking-fix batch under LOOP.md.
- **Why:** Fresh pi-watch --check found Opus/Sonnet unavailable and Gemini available. Bun1.4.0 is installed. No language servers are configured, as observed through xd://lsp status.
- **Evidence:** iteration6 pi-watch --check exit5 listing7/12 ready; bun --version1.4.0; xd://lsp status.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** The reviewer cannot execute; use the documented verified fallback ladder and record it.
- **Source:** locked by docs/loop/LOOP.md

## D5: Native observations are handed off, not fabricated as web passes
- **Question:** How can unattended work complete the native obligations without foreground control?
- **Options:** Take the foreground; call web effects native proof; preserve nightly evidence and submit precise pending scenarios.
- **Chose:** Keep the historical native report intact; fix web-visible action accessibility, then submit fresh pending SC-17 focus and SC-18 Finder/clipboard scenarios for the nightly runner.
- **Why:** Existing native clipboard scenario failed because Copy Log Path was clipped and Copy First Prompt was not visible. Those visible defects belong to this item; actual macOS clipboard/Finder/focus certification belongs to NATIVE.md.
- **Evidence:** docs/loop/native/m3-vault.json:5-27; docs/loop/NATIVE.md:60-80.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** A native failure identifies another reachable product defect.
- **Source:** locked by docs/loop/LOOP.md

## D6: Keep platform and unrelated feature ownership boundaries
- **Question:** Does parity authorize new transports, native chat or tip bookkeeping?
- **Options:** Expand into missing adjacent products; retain the explicit queued scope.
- **Chose:** No native-chat UI, SSH/WSL, pairing transport, Linux/Windows packaging or separate consent-tip completion. Same-token authenticated web enablement remains supported; remote paths remain redacted. Verify macOS product behavior with temporary owned state, and use the required suite runner for affected tests.
- **Why:** These exclusions and independent follow-ups are explicit. They do not excuse the enabled archived handoff and Session Info integrations named here.
- **Evidence:** docs/loop/decisions/m3-vault.md D8,D10,D11; docs/loop/BLOCKERS.md:178,247-249; docs/roadmap.md:13-56,282-286.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** The operator changes the queued scope.
- **Source:** deferred: platform

## D7: Implement Session Info navigation in its actual owner
- **Question:** Where does the queued SC-21 Open Vault action belong?
- **Options:** Add it to the old session UI reference; implement it in the installed Session Info plugin.
- **Chose:** Narrow source/manifest/test scope in `plugins/quirky.session-info`, with the existing public Vault open command; include the actual owner in affected verification.
- **Why:** The action component located Session Info there; source search found no existing Vault navigation. Adding it to the unrelated worktree view would not complete the user's Session Info flow.
- **Evidence:** plugins/quirky.session-info; plugins/quirky.session/src/ui.tsx; inherited BLOCKERS.md:170,249.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** The effective Session Info owner is overridden.
- **Source:** assumed — autonomous

## D8: Express project-only context through existing public view input
- **Question:** How can Project be the default without an active worktree when the shell has no separate selected-project field?
- **Options:** Fake a missing primary worktree; add a new caller/protocol identity; recognize an explicit repo in the already-public active view input.
- **Chose:** `UiLayout.view.input.repo` is an explicit project selector when worktree is absent; resolve it through the public repo owner in service and window. Worktree takes precedence. Unknown identity remains bounded.
- **Why:** Real projects synthesize a primary worktree, so a cwd fixture cannot represent project-only UI selection. Existing public view input accepts plugin JSON, avoiding a new project page or kernel protocol field. Real API opening of an installed view with registered repo input proves the context without mocked sources.
- **Evidence:** plugins/quirky.vault/src/service.ts scopeIdentity/defaultScope; src/window/model.ts resolveScope; public UiLayout.view.input contract; actions implementer mapping.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** A future shell owner declares another canonical project-context representation.
- **Source:** assumed — autonomous

## D9: Preserve the handoff owner's last-prompt meaning
- **Question:** Does archived `prompt` contain the first or last user prompt?
- **Options:** Put first prompt under a misleading Last user prompt label; expand the owner schema; preserve last-user semantics and full transcript access.
- **Chose:** Existing `prompt=lastUserPrompt`, `lastMessage=latestAssistant`, with validated transcriptPath retaining full source. Full first-prompt inspection/copy remains SC-18.
- **Why:** The completion spec accidentally over-specified first prompt in the archived bridge. The owner's established brief labels this field Last user prompt. Original SC-21 requires the selected-source owner flow, not a second first-prompt field.
- **Evidence:** docs/loop/decisions/m3-handoff.md:64-69,208-211; plugins/quirky.handoff/src/core/compose.ts:28-29; original Vault logic SC-18/21.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** A consumer requires a separately labelled first-prompt handoff hint.
- **Source:** locked by docs/loop/decisions/m3-handoff.md

## D10: Persist child ownership, not caller-supplied source paths
- **Question:** How can an already selected Claude/OMP child resolve after Worker restart?
- **Options:** Require re-listing the parent; encode arbitrary paths in the caller ID; persist a derived child-ID to parent-ID relation and rediscover both.
- **Chose:** Parent ownership in the existing parse-cache database, re-enumerated through current validated roots/kinds before child access. Invalidation clears related mappings. Same opaque public IDs and envelopes.
- **Why:** The baseline real API regression returned null immediately after plugin restart. Persisted ownership fixes that loss without turning a public ID into filesystem authority.
- **Evidence:** baseline worker-parity.test.ts:298 failure, artifact18; corrected child test in the four-case API file passes as part of bg4.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** A stale or forged child mapping escapes parent/root validation.
- **Source:** assumed — autonomous

## D11: Reset failure holdout when the source signature changes
- **Question:** Can a corrected source remain held out when its mtime is preserved?
- **Options:** Use mtime alone; use the already-defined complete source/sidecar signature.
- **Chose:** Persist failed_signature and reset the retry count on signature change. Rebuild only disposable search schema2 as schema3.
- **Why:** mtime alone misses a changed source/sidecar signature. Reusing discovery's canonical signature avoids a separate freshness policy, while unchanged repeated failures remain held out.
- **Evidence:** plugins/quirky.vault/src/search/index.ts; bg4 real same-mtime recovery, JSONL/JSON/sidecar/SQLite mutation and schema-replacement API tests pass.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Discovery's signature stops reflecting a supported source dependency.
- **Source:** assumed — autonomous

## D12: Correct source-aligned regression oracles and fixture bootstrapping
- **Question:** Do the initial new-test failures justify changing query fallback, resume forms or production Worker startup?
- **Options:** Special-case production for the tests; preserve existing contracts and repair the faulty fixture boundaries.
- **Chose:** Use disjoint single-token source markers for mutation absence checks, retain Claude provider-ID versus OMP transcript-path resume, and buffer the fault fixture's messages during its dynamic production-handler import.
- **Why:** Shared hyphenated fixture markers legitimately overlap under the documented OR/identifier ladder. The Claude command was correct. Recovery's five rejection assertions passed before the fixture dropped its initial applySearch during an asynchronous import; no production handshake or timeout increase was needed.
- **Evidence:** bg3 1pass3fail; bg4 mutation/retention/SQLite/schema pass followed by recovery timeout; bg6 corrected recovery1pass8assertions. bg5 existing six-file chain29pass420assertions; total targeted Worker acceptance37pass477assertions.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** A real packaged Worker loses a request without the fault fixture wrapper.
- **Source:** assumed — autonomous

## D13: Stop verification/debugging and land under the operator's typecheck-only gate
- **Question:** What happens to the ongoing parity verification after the operator moved it to the end phase?
- **Options:** Continue fixing failed tests and running browser/review campaigns; freeze the built work, make types pass and land now.
- **Chose:** Freeze implementation components and commit them, skip every unfinished suite/dogfood/review and test-failure fix, run only typecheck, catch up once and land through the current queue tool.
- **Why:** The operator explicitly changed the workflow, and the authoritative Build first, test at the end section now makes this the current-item landing rule. Failures are evidence for the end phase, not reasons to invent verification follow-ups.
- **Evidence:** Operator interjection in iteration6; git show build/roadmap:docs/loop/LOOP.md, Build first, test at the end.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** m7-test-triage is claimed or the operator changes the gate.
- **Source:** locked by docs/loop/LOOP.md

## D14: Preserve incoming authorities and correct only compiler-reported contracts
- **Question:** What remains before the operator-authorized immediate landing?
- **Options:** Restart semantic verification; preserve the one catch-up and fix only the typecheck diagnostics.
- **Chose:** Merge build/roadmap once without conflicts; read every incoming decision delta; retain account source-home/mandatory preparation, canonical Session.launchSettings, exact-session navigation, PTY incarnation policy and public optional-host boundaries. Fix four type errors only: optional subagent count, missing row error callback, optional test-call params and a test's nullable discovered row.
- **Why:** The incoming decisions do not conflict with this implementation. The operator's only remaining gate is typecheck; test failures are intentionally not chased.
- **Evidence:** frozen components c42ba3dd,27f078f5,7c8bc2a5; ReadIncomingDecisions complete-read report; first merged typecheck4diagnostics; corrected `bun run typecheck` exits0 including apps/mobile/tsconfig.json in24.17s.
- **Reversibility:** easy
- **Confidence:** high for compilation; no additional behavioral assurance claimed.
- **Revisit if:** The land-owned merged typecheck reports a new conflict.
- **Source:** locked by docs/loop/LOOP.md

## D15: Preserve the incoming consent tip and parity controls during land retry
- **Question:** How should the two conflicts reported by authoritative queue land be resolved?
- **Options:** Drop incoming tip state; drop parity search/retry controls; combine the independent changes.
- **Chose:** Keep SearchTipState and HISTORY_AGENTS imports; pass the incoming searchTip to the same disclosure while retaining per-limit/error/retry rendering. Preserve the incoming raw local status-event boundary and fail-closed consent rollback. Keep Session Info's additive narrow-text wrapping.
- **Why:** The consent-tip completion is a separately landed owner flow, not canceled by this parity item. The retry was explicitly requested by queue land; no extra test/debug/review campaign was started.
- **Evidence:** failed land bg26; resolved two recorded conflict blocks; merge52d4900d; all eight incoming decision logs read; root/mobile `bun run typecheck` passes22.41s.
- **Reversibility:** easy
- **Confidence:** high for compilation and additive contract preservation; end-phase behavior remains unverified.
- **Revisit if:** The land-owned merged typecheck reports another conflict.
- **Source:** locked by docs/loop/decisions/m3-vault-consent-tip-completion.md

## Progress
Frozen parity components and compiler fixes are committed. Initial land reported two additive conflicts with the separately landed consent-tip item; the supported retry catch-up52d4900d preserves both tip ownership and parity controls. All incoming decisions were read; root/mobile typecheck passes22.41s. No suite/dogfood/review or test-failure fixing resumed. Existing failures and pending native scenarios remain end-phase work. Next: commit this receipt, detach and retry authoritative queue land for this item only. No unbuilt-flow follow-up identified.
