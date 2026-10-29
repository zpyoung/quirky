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

## Progress
Source-only fixes committed as dd457205 and7e75168a. No production changes. Current local API21/21, private runtime, scripts127/0/1125assertions and full typecheck pass; exact final Accounts prepass and bounded independent review are running on the final source. Next: collect actual verdicts, catch up build/roadmap once, read incoming binding decisions, rerun integrated typecheck and affected regression/runtime, then canonical queue land. Broader Agents failures remain explicitly owned and retained; no native OS/provider SDK/UI acceptance claim.
