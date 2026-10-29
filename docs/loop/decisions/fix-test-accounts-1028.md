# fix-test-accounts-1028 decisions

## D1: Repair demonstrated fixture failures without changing account authority
- **Question:** Which assigned baseline failures still require changes?
- **Options:** alter account/confirmation production paths; diagnose the current canonical Accounts suite and retain existing consumer regressions.
- **Chose:** current canonical diagnosis and minimal fixture repairs; keep account selection, removal, profile ownership, and native continuation authority unchanged unless new evidence disproves them.
- **Why:** The current twelve-file Accounts run fails Codex discovery with `the provider executable is not installed`. The three other assigned confirmation/removal/history/resume regressions pass. Kernel confirmation consumption now inspects a durable Ask outcome rather than calling connection-bound `quirky.ask/wait`.
- **Evidence:** docs/loop/reports/m7-test-triage.json groups.plugins/quirky.accounts; current canonical suite output retained in this iteration's evidence; packages/daemon/src/plugins/confirm.ts:123-142; plugins/quirky.accounts/test/accounts-api.test.ts:186-263,584-603,699-753; plugins/quirky.accounts/test/profiles.test.ts:70-110.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a truthful initialized provider fixture still cannot discover the selected account's model or preserve its snapshot.
- **Source:** assumed — autonomous

## D2: Remove stale presentation assertions rather than repinning the restyled DOM
- **Question:** How should additional current Accounts UI failures be handled?
- **Options:** restore old markup; repin CSS classes and badge wording; remove incidental assertions while retaining behavioral interactions and state transitions.
- **Chose:** delete stale presentation assertions; retain the substantive removal, confirmation, selection-policy, and single-flight scenarios.
- **Why:** Current Accounts canonical output fails only old `.account-row-main`/`.badge.active` assertions in those scenarios. The restyle explicitly preserves behavior while replacing local markup with public shared controls.
- **Evidence:** plugins/quirky.accounts/test/remaining-ui.test.tsx:667,890,963 at diagnosis; docs/loop/decisions/ui-restyle-accounts.md D1,D10; authoritative LOOP triage requirements.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** public semantic state or interaction fails independently of private markup.
- **Source:** locked by docs/loop/LOOP.md and ui-restyle-accounts D10

## D3: Preserve process isolation and qualify retry evidence
- **Question:** Which runtime and timing claims are supported?
- **Options:** use real provider homes; increase deadlines after an isolated timeout; preserve private fixtures and distinguish original failure from configured retry.
- **Chose:** fresh private HOME/QUIRKY_HOME, fake providers/security, no real authentication or native Keychain access; no timeout changes.
- **Why:** The canonical run initially timed out the Always/Never scenario at five seconds, while its configured isolated retry passed. This does not establish a production timing defect. The discovery failure persisted through retry and remains actionable.
- **Evidence:** canonical Accounts diagnosis, suite-result ok=false/flaky=[]; plugins/quirky.accounts/test/support/index.ts:237-315; remaining-flows.test.ts:153-195.
- **Reversibility:** easy
- **Confidence:** high for observed outcomes; no timeout root cause established
- **Revisit if:** the final current suite reproduces a deterministic lifecycle failure.
- **Source:** locked by docs/loop/LOOP.md

## D4: Pin the owned provider executable through public configuration
- **Question:** Is adding the private search directory and refreshing enough to isolate the discovery fixture?
- **Options:** trust the initial remote pass; change production PATH precedence; configure the absolute owned executable through the supported agent API.
- **Chose:** public `quirky.agents/configure` with the quoted absolute private Codex fixture command and Bun interpreter.
- **Why:** The initial search-directory repair passes the twelve-file remote suite, but the actual macOS runtime returns `gpt-6-astra` instead of the synthetic model. Detection searches login-PATH entries before the extra install directories, so an ambient executable can win. The final fixture fixes its launch identity rather than modifying normal application lookup.
- **Evidence:** plugins/quirky.agents/src/detect.ts:68-89; service.ts:809-825; failed private runtime model assertion; final accounts-api fixture and local21/21 pass; corrected private runtime returns the account-owned model and preserves it after malformed discovery.
- **Reversibility:** easy
- **Confidence:** high for source precedence and corrected runtime behavior
- **Revisit if:** configured absolute commands no longer bypass ambient executable selection.
- **Source:** assumed — autonomous

The preliminary model mismatch occurred under the fixture's private HOME and prepared synthetic managed CODEX_HOME. No real authentication or native acceptance was requested. It is not evidence that no real provider executable ran; the safety fix explicitly prevents that ambiguity. All runtime attempts awaited fixture cleanup. Two earlier smoke-only assertions incorrectly expected history bootstrap not to create an empty canonical file and completed login metadata to be null; they were deleted from the throwaway script without changing production or permanent regressions.

## D5: Close the assigned account boundary without absorbing the Agents repair
- **Question:** How should the broader Accounts-plus-Agents gate be reported?
- **Options:** change foreign tests; claim the combined run passes because Accounts passes; preserve the failing evidence and existing repair ownership.
- **Chose:** preserve the51-file result46pass/5fail, append an explicit BLOCKERS entry, and send the full failing-file inventory to lane5 `fix-test-agents-1028`.
- **Why:** All five failing files are in Agents and cover unrelated catalog/CLI inventories, provider protocol fixtures, and URI validation. The subsequent live Accounts-only prepass passes12/12 with no flaky files. No foreign code/aliases/deadlines are needed for the owned account fixture repair.
- **Evidence:** docs/loop/BLOCKERS.md Accounts entry; scratch accounts-agents-after.txt; accepted terminal request32c91c57-e4c6-43ce-b494-41045fbb13f1 (acceptance only, not reading proof).
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a failure is traced to these two Accounts test-only changes.
- **Source:** locked by docs/loop/LOOP.md cross-plugin ownership

## D6: Distinguish API/filesystem smoke from native provider acceptance
- **Question:** What does the executed runtime prove?
- **Options:** extrapolate native SDK/OS/UI parity; report exact exercised public boundaries.
- **Chose:** isolated real daemon socket/API and generated CLI handler, synthetic executable and fixture PTY, exact selected model/effort, malformed snapshot preservation, confirmed Claude removal preserving shared bytes, and Codex A→B→remove-A→C carrying B's additional transcript bytes.
- **Why:** The final private runtime completes with status ok and three named scenario results only after cleanup. C's actual returned UUID rollout contains389bytes including the B continuation; A's home is gone and B remains. The first smoke draft only selected C, so it was rejected before execution and extended to perform the actual C preparation.
- **Evidence:** runtime-smoke.ts and runtime-smoke-result.txt in the evidence archive; actual run1.49s; local Accounts API21pass/0fail/142assertions6.54s.
- **Reversibility:** easy
- **Confidence:** high for named boundaries only
- **Revisit if:** native provider/OS acceptance supplies a contradictory observation.
- **Source:** assumed — autonomous

## D7: Preserve all incoming decisions in the sole integration catch-up
- **Question:** Does the integration merge require an account-contract change?
- **Options:** skip incoming decisions; absorb unrelated repair work; read every incoming log and preserve independent responsibilities.
- **Chose:** clean merge423d62c77ec3a1734e36d7fc52652ded11f886a3, then read all five incoming logs completely through their Progress sections.
- **Why:** Protocol D1–D5, Repo D1–D10, Scripts UI-review D1–D4, Terminal Dock D1–D6, and final UI review D1–D8 do not conflict. The only incoming production source change is Worktree ownership registration; account contracts remain unchanged. Full integrated typecheck/UI lint/root/mobile/prepared-desktop passes51.82s, and the private runtime repeats its exact three scenarios successfully in2.48s after cleanup.
- **Evidence:** AccountsIncomingDecisions full read report; incoming decision logs; integrated typecheck and runtime receipts in the evidence archive; authoritative queue deps returns ready:true/pending:[].
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** authoritative landing reports an integration conflict or type error.
- **Source:** locked by incoming decision logs and docs/loop/LOOP.md

## D8: Preserve the actual bounded review verdict and suppression limit
- **Question:** What did the independent review clear, and should its Keychain-assertion suggestion be applied?
- **Options:** describe the review as finding nothing; restore mock argument echoes; preserve the machine result and independently adjudicate the one claim.
- **Chose:** standard Gemini3.1ProPreview/google high, fresh promote and refute contexts, full family independence; machine PASS with0surviving/0blocking/0advisory findings and1suppressed claim. Do not restore mock argument echoes.
- **Why:** The live final prepass passes12/12Accounts files with no flaky files in31.045s. Promote raises removed security.log checks asHIGH; fresh refute retains the observation but reduces it toLOW because production is unchanged and those mock arguments do not prove credential ownership. The evidence gate suppresses it as falsified because its file-line quote is a patch hunk rather than live source. That anchor failure is not proof the conceptual observation is false. The caller rejects the proposed restoration because incidental mock echoes must be removed; the replacement verifies actual selected-profile deletion and other-account credential bytes/selection. Native Keychain behavior remains unclaimed.
- **Evidence:** review-final/{promote,refute,merged,gate,manifest,prepass}.json and raw prompts/responses; artifact81a93030ca34ddafd8508b4a4c885298be0da899dca18056b8a2fd5788469ad6; fixed two-file range ececceed..7e75168a.
- **Reversibility:** easy
- **Confidence:** high for executed review and scoped fixture/API observations; no completeness guarantee
- **Revisit if:** a stateful native Keychain scenario demonstrates wrong credential targeting.
- **Source:** assumed — autonomous

## Progress
Verified and ready for canonical land. Source-only fixes dd457205 and7e75168a, docs b59259ec, sole integration merge423d62c77ec3a1734e36d7fc52652ded11f886a3. Final canonical Accounts12/12/no flakes31.045s; local API21/21/142assertions; full integrated typecheck51.82s; scripts127/0/1125assertions93.56s; actual private API/generated-CLI-handler/filesystem smoke before and after integration passes, with awaited cleanup. Standard independent review machine PASS is qualified byD8. All implementers, review/scout/check/runtime jobs returned; no owned runtime remains. Queue deps ready:true. Preserve final evidence, commit this receipt, detach and canonical queue land, then read back exact item done and remove only owned scratch. No all-consumer, native Keychain, real provider SDK, native PTY or UI acceptance claim.
