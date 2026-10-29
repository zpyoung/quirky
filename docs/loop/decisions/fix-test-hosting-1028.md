# fix-test-hosting-1028 decisions

## D1: Repair only the assigned PR push boundary
- **Question:** what does the end-phase hosting repair own?
- **Options:** broaden the hosting sweep; repair the two reported review-push failures and their direct boundary coverage.
- **Chose:** the two assigned `pr.test.ts` flows, with exact fork-head destination and unsafe/stale/closed/ambiguous/detached refusal protections unchanged.
- **Why:** the queue names these failures; the fresh provider identity and exact configured URL snapshot remain binding.
- **Evidence:** docs/loop/reports/m7-test-triage.json groups.plugins/quirky.hosting; docs/loop/decisions/m7-editor-source-control-completion.md D14; docs/loop/decisions/m4-hosting-api-github.md D5.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a reproduced failure identifies a directly related consumer-visible defect.
- **Source:** locked by item title; locked by docs/loop/LOOP.md

## D2: Separate invalid acceptance setup from malformed Git line parsing
- **Question:** what explains the two reported assertions and the directly related parser defect?
- **Options:** weaken destination safety or origin inference; build valid saved PR context and seed upstream state, then repair the independently regressed parser.
- **Chose:** create a genuinely linked PR worktree through public `quirky.worktree/create` for base-origin/fork-head acceptance; seed the safety scenario's intended open PR. Use actual line separators for remote names and push URLs. Replace the obsolete configured-upstream assertion with fresh provider head versus genuine saved push-target disagreement.
- **Why:** canonical RED returned `no_linked_review` in the fork test: an unlinked implicit lookup deliberately requires a head matching origin. `set` cannot fabricate a PR link; public PR-source creation persists it. The second test never writes its constructed PR before expecting ready. Separately, both `pushRepository` delimiters match literal backslashes, so Git's newline-separated names/URLs are not separated. D14 deliberately derives review destinations from provider head, not `branch.feature.merge`.
- **Evidence:** canonical hosting run: 17 files, 16 passed, pr.test failed twice with the same two assertions (fork no_linked_review, initial safety ready false); pr-review.ts restHeadMatchesOrigin/headMatchesOrigin/pushRepository; worktree/create.ts persisted linkedPR/pushTarget; worktree/set.ts accepted metadata; m7-editor-source-control-completion D14.
- **Reversibility:** easy
- **Confidence:** high for observed baseline and source causality; corrected runtime verification pending
- **Revisit if:** regression execution identifies another directly related boundary.
- **Source:** assumed — autonomous

## D3: Use a reachable independent reviewer and isolated runtime evidence
- **Question:** how to verify without human decisions or real forge mutations?
- **Options:** live GitHub push; private daemon/API/CLI with local bare transport; tests only.
- **Chose:** canonical hosting and Git suites, full typecheck/scripts, and a private generated-CLI push to a local bare repository with exact destination/ref and closed-review refusal readback. OpenAI implements; Gemini high reviews. No UI/native behavior changes are planned.
- **Why:** private fixture state isolates credentials, home and repository while leaving provider dispatch, Git validation and CLI real. Opus/Sonnet unavailable; Gemini reachable. LSP reports no configured servers.
- **Evidence:** actual pi-watch --check; xd://lsp status; plugins/quirky.hosting/test/helpers.ts bootHosting/cleanup; pr.test.ts local push transport.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** an actual runtime/reviewer operation is unavailable.
- **Source:** assumed — autonomous; locked by docs/loop/LOOP.md

## D4: Keep the broad red consumer snapshot separate from current Hosting closure
- **Question:** does a failed wider consumer run expand this item or invalidate the assigned repair?
- **Options:** rewrite unrelated Git/Worktree behavior; hide the broader result behind a narrower green claim; preserve the red receipt under existing owners and verify this package on current integration.
- **Chose:** preserve the151-file85passed/66failed consumer run as red; append its concrete visible failures and output-retention limit to BLOCKERS.md. Keep `fix-test-git-1028` and `fix-test-worktree-1028` ownership. Read lane8's complete Hosting inventory, without treating its older17unknown-worktree/list failures as a new assignment.
- **Why:** the wider run exceeds its automatic retry cap and reports failures in untouched boundaries. Its prepass retained only the last4000characters; a complete66-file attribution would be invented. The fresh post-catchup canonical Hosting17/17/no-flake result is direct current evidence for the owned package, not a whole-consumer pass.
- **Evidence:** scratch broad-consumer-red.json/review-prepass-broad-failed.json; visible Git conflict-markers.test.ts153/168 and Worktree ui-report.test.ts205; lane8 full-consumer-failures.json; hosting-integrated-suite.log. Git owner accepted precise notification requestff5ba9e8-fb72-4182-a640-e99f0e16d16b; no receiver-reading claim.
- **Reversibility:** easy
- **Confidence:** high for observed checks and ownership; no complete broader root-cause claim
- **Revisit if:** an existing owner demonstrates that a failure is caused by these two Hosting parser lines.
- **Source:** locked by item title; locked by user lane8 heads-up; assumed — autonomous

## D5: Accept only exercised integration and private CLI evidence
- **Question:** what is verified after repair and catchup?
- **Options:** infer runtime success from source; weaken safety/deadlines; require real API/CLI outcomes and distinguish broad failures.
- **Chose:** direct endpoint RED0pass/2fail, then focused GREEN4pass/0fail/30assertions in26.46s. Genuine public PR-source worktree creation selects a preconfigured fork while origin remains the base; push advances only the bare fork's exact ref, then a changed provider ref refuses against the saved target without another push. Safety coverage preserves closed/merged/deleted/mismatched/ambiguous/unsupported-URL/detached refusals. No modified production behavior beyond the two newline delimiters.
- **Why:** the old first fixture had no saved PR link and the old second had no provider PR. Re-pinning those incorrect setups would change the contract. The new fixture drives the supported creation/API path, not a private ledger insertion or mocked authority. The removed `branch.feature.merge` refusal is incidental under D14's provider-head-first contract; actual saved-target mismatch replaces it.
- **Evidence:** actual direct RED artifact12; focused GREEN artifact16; sourcec96115dfa345eb060f46be74939310d4ef5bb1e8. Private generated-CLI smoke exit0/7.96s: targetfork/feature, pushedHead equals captured localHead, exactHTTPSURL+commit:refs/heads/feature transport, closedReview exit1, unchanged log/ref; helper cleanup observed. Full typecheck passed before catchup76.95s and after37.43s; scripts127pass/0fail/1119assertions139.34s. Post-catchup canonical Hosting17/17/no-flake116.73s, actual suite-result ok:true independently checked beyond its logging pipeline exit.
- **Reversibility:** easy
- **Confidence:** high for exercised paths
- **Revisit if:** canonical merge verification or another exact runtime scenario contradicts these receipts.
- **Source:** locked by docs/loop/LOOP.md; assumed — autonomous

## D6: Bound independent review to the repaired source and preserve incoming contracts
- **Question:** what does the final review cover, and do incoming decisions conflict?
- **Options:** include author decision rationale as review context; widen the review to all incoming work; freeze the two-file source artifact and withhold rationale.
- **Chose:** one standard Gemini high promote stage and fresh refute stage over `45268ce1..c96115df`,137changed lines, artifact8e46147c8cfdd8b9c5e5001d7987b7b06dfcb82efd7c8e96b1c342fb8246d6ab. Both actual model outputs are empty arrays; machine gate PASS with0blocking/0advisory/0suppressed/0contested, no excluded or unreviewed source paths. Documentation is parent-authored and not part of that source review.
- **Why:** criteria and actual check facts are provided; author rationale/decision logs are withheld. Existing broad red is disclosed to both stages rather than relabeled. The sole integration mergeb23a6cc5 brought editor/handoff/orchestration decisions; all three logs read in full by the read-only incoming-decision scout, with no Hosting authority or destination conflict.
- **Evidence:** review-resolve-integrated.json, review-model-integrated.json, promote/refute prompts and raw outputs, review-claims/merged/gate/manifest.json; incoming scout reading fix-test-editor-1028, fix-test-handoff-1028 and fix-test-orchestration-1028. No source mutation/check was requested from the implementers or scout.
- **Reversibility:** easy
- **Confidence:** high for review provenance and exercised scope, not a general correctness guarantee
- **Revisit if:** a concrete finding appears in the canonical merge result or actual consumer path.
- **Source:** assumed — autonomous; locked by docs/loop/LOOP.md


## Progress
Implementation and assigned verification complete. Sole integration catchupb23a6cc5 complete; incoming decisions compatible. Sourcec96115df, current Hosting17/17/no-flake, full typecheck, scripts and private generated-CLI smoke pass. Broader consumer151-file run remains85pass/66fail under recorded existing owners. Independent standard two-stage Gemini source review PASS with no findings. All agents/checks/reviewer/runtime processes finished. Next: commit final documentation/evidence, detach and run canonical queue land fix-test-hosting-1028; wait for the actual result, preserve its receipt and remove only owned scratch after success. Do not claim a second item or whole-queue completion.
