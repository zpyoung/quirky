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

## Progress
Combined spec/contracts committed at b59ba608 before three disjoint implementers. All three component HEADs began there with empty dirty snapshots; no checks/commits allowed mid-flight. Parent prepared isolated packaged-browser fixture, verified web driver readiness, and wrote fresh pending native handoff while preserving historical failure evidence. No implementation acceptance claim yet. Next: barrier scope/HEAD audits, red/green consumer checks, build and full browser campaign, affected runner/scripts/typecheck, one catch-up/review and supported queue landing. Inherited untracked .serena/ is not item work.
