# fix-test-agents-1028 decisions

## D1: Repair the reported agent failures without weakening behavior
- **Question:** Which behavior controls this unattended fix item?
- **Options:** Re-pin incidental output; repair runtime boundaries and meaningful behavior coverage.
- **Chose:** Repair confirmed causes; delete incidental inventory assertions rather than re-pin them.
- **Why:** The triage names discovery, raw-home safety, CLI inventory, and HTTP(S) link validation failures. Existing behavior and locked decisions remain authoritative.
- **Evidence:** docs/loop/reports/m7-test-triage.json groups.plugins/quirky.agents; docs/loop/LOOP.md Fix items.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Diagnosis identifies a conflicting locked contract.
- **Source:** assumed — autonomous

## D2: Use isolated implementers and the canonical test runner
- **Question:** What execution and review environment is available?
- **Options:** Direct local suite; canonical routed suite. Opus; fallback Gemini.
- **Chose:** Canonical bun scripts/suite.ts; two disjoint omp task components at de41878d, OpenAI author family, Gemini reviewer after Opus probe failed. No separate feature spec for this fix item.
- **Why:** The runner isolates homes and routes remote work. pi-watch --check opus exited 5; --check gemini selected google/gemini-3.1-pro-preview:high. No language servers are configured. Preserve inherited untracked .serena/ without edits.
- **Evidence:** Actual queue wait, backend probes and LSP status. Component HEAD/scope audit matched service.test.ts and entry.ts/entry.test.ts only; parent only changed cli.test.ts before integration. Both workers returned without commits/checks; parent committed ec2ede9b and 2e40285d and merged them after the barrier. Component trees removed after path-only inherited metadata stashes.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** The verified backend becomes unavailable.
- **Source:** assumed — autonomous

## D3: Fix valid provider fixtures and assert safety outcomes, not reason prose
- **Question:** What explains the two discovery failures?
- **Options:** Relax required declarations; reject inherited Codex homes globally; correct fixtures and check observable authority.
- **Chose:** Add the missing required prompt mode to the custom provider. In the Codex safety case establish installed/discoverable state and an actually unavailable account-preparation method, then assert no provider execution and unchanged catalog. Replace the Node-dependent marker executable with a POSIX shell builtin marker; delete the reason-text assertion.
- **Why:** entry.ts requires prompt before catalog admission; missing prompt explains unknown fixture agent. The triage has no actual Codex reason value, so no claim is made about which early refusal produced it. A failed prose assertion alone does not establish unsafe execution. Inherited System default is a valid route when account preparation succeeds. The harness loads only the curated agents plugin, not accounts; an initial scout inference that it automatically included accounts was rejected after reading helpers.ts75-92. No runtime account-preparation bypass or extra validation is added.
- **Evidence:** service.test.ts custom provider and Codex cases; core/entry.ts84-86; packages/daemon/test/helpers.ts75-92; m3-accounts logic.md System default contract; actual triage errors.
- **Reversibility:** easy
- **Confidence:** high for missing prompt and desired safety boundary; no historical reason-value attribution
- **Revisit if:** A real prepared-account flow demonstrates a different consumer-visible defect.
- **Source:** assumed — autonomous; locked by docs/quirk/specs/2026-10-27-m3-accounts/logic.md

## D4: Restore the existing link validator and fix the actual discovery CLI export
- **Question:** Are the remaining failures solely test drift?
- **Options:** Re-pin command inventory; suppress URL failures; restore runtime contracts and exercise the actual CLI.
- **Chose:** Use existing link() for homepage/install; cover valid HTTP/HTTPS and reject javascript/file/malformed/nonstring/empty values without pinning error prose. Delete the duplicated full CLI inventory; retain actual CLI list coverage. Rename the handler key to the declared discover-models ID and migrate all direct callers, with no camelCase compatibility alias. Upgrade the discovery regression to run the actual CLI subprocess.
- **Why:** parse previously used text() and bypassed its implemented validator. Actual private-daemon smoke then failed with exit1, `the CLI module of quirky.agents has no command "discover-models"`: manifest ID is discover-models but the export was discoverModels; the CLI loader uses the exact final ID segment. The old direct handler tests did not traverse that loader.
- **Evidence:** entry.ts127-128/280-294; quirky-plugin.json4359-4368; packages/cli/src/plugin-commands.ts82-85; actual smoke before fix exit1 and after fix exit0; all former direct discoverModels handler callers migrated, literal caller search found none remaining.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** A public CLI call fails with the exact current manifest.
- **Source:** assumed — autonomous; locked by docs/quirk/specs/2026-10-26-m1-providers/tech.md URL fields

## D5: Preserve incoming ownership and verify actual daemon/CLI behavior
- **Question:** Do integration changes conflict, and what does the smoke prove?
- **Options:** Broaden into Hosting/Git/Dock repairs; preserve independent ownership and report only actual exercised boundaries.
- **Chose:** Sole roadmap catchup retained Hosting parser/test changes and Dock no-patch closure. Read both incoming decision logs in full; no agent-contract conflict. Private actual daemon/CLI smoke passed link rejection, valid HTTP(S) links, provider-authoritative snapshot, and malformed-output preservation; owned home removal printed true. No UI/native surface changes or new native scenario are required. README additions address plugin authors configuring links/probes, not verification history.
- **Why:** These runtime/API changes do not alter UI layout, native integrations or prepared-account semantics. Other owners' broad failures remain theirs, not hidden by a passing Agents claim.
- **Evidence:** Sole git merge output; docs/loop/decisions/fix-test-hosting-1028.md D1-D6/Progress; fix-test-terminal-dock-1028.md D1-D6/Progress; actual smoke bg4 success and cleanup; frozen install/UI lint/root/mobile/desktop typecheck bg3 exit0 in32.88s.
- **Reversibility:** easy
- **Confidence:** high for exercised scope, not whole-feature or whole-repository acceptance
- **Revisit if:** Current canonical checks or integration landing report a concrete conflict.
- **Source:** assumed — autonomous

## D6: Delete newly exposed stale inventory mirrors and repair protocol test ownership
- **Question:** How should four additional failed files from the current affected suite be handled?
- **Options:** Add Pi to copied expected inventories; weaken production catalog ownership; delete inventory mirrors and test the actual protocol boundary.
- **Chose:** Delete the ten-agent inventory tests from manifest and launch-settings E2E, their unused helpers, and the service inventory loop; retain boolean-option and unknown-agent behavior. Replace provider-protocol prose assertions with semantic refusal checks: wrong owner for ownership rejection, correct owner for caller-argv rejection. Preserve successful normalized protocol declarations. No production behavior, deadline or existing supported Pi contract changes.
- **Why:** Canonical agents/scripts run returned 47/51 files passing and four failures. The provider-discovery, Codex-safety, and URL regressions passed; the obsolete CLI inventory assertion had been removed. Remaining failures were duplicated default inventories that excluded now-supported Pi, and malformed-argv fixtures using the wrong owner ID before expecting later error wording. One sequential scoped fixer touched only these four test files; parent audited the complete delta and unchanged HEAD before acceptance.
- **Evidence:** Actual bg1 exit1 in 187.44s; bg5 retained the same earlier snapshot failure in 198.48s, no green claim. AgentAssertionRepair result and parent four-file scope audit. Lane9 separately reported the same five Agents-owned files on older ececceed source; its log confirms 51 files, 46 passing and five failing, while Accounts12/12 passed, without transferring Accounts scope here.
- **Reversibility:** easy
- **Confidence:** high for observed failures and root causes
- **Revisit if:** A current consumer test identifies a production protocol or catalog authority defect.
- **Source:** assumed — autonomous; locked by item title's no-repin requirement

## D7: Land only the exercised repair and retain the review's suppression record
- **Question:** What evidence permits integration, and what does the independent review actually establish?
- **Options:** Treat tests or a suppressed review claim as exhaustive proof; run the bounded required gates and preserve their limits.
- **Chose:** Current canonical Agents/scripts suite passed all 51 remote files without flaky retries; frozen install, UI lint, root/mobile/desktop typechecks passed in the same 224.39s gate. The extended private real-daemon/actual-CLI smoke passed URL admission/refusal, authoritative discovery, malformed-output preservation, missing-account-preparation Codex refusal with no marker execution, unchanged Codex catalog, and home removal. Run exactly one standard cross-family Gemini promote/refute round over the frozen seven-file patch, then land with the canonical queue command, not a manual integration merge or a human prompt.
- **Why:** The final source artifact is 254ff9819f637d001ec75228b6e74e3ec5eb4ebf1826725de652e580e8cf9a90; author rationale was withheld, reviewers had only read capability, and both actual dispatches returned. Promote raised F1 claiming System default uses source `system`; refute rejected it as unchanged code outside the patch. Parent independently rejected its premise: Accounts emits `default`, and AccountIdentity permits only managed/default/custom. Adding a `system` alias would weaken a correct boundary. No accepted finding needs a fix batch. Machine gate PASS has zero blocking/advisory/contested findings and one suppressed claim, not a clean/no-findings review. The complete suppression rate limits review assurance.
- **Evidence:** review-resolve/model/prepass/findings/claims/refute/merged/gate/manifest artifacts in the owned run scratch; promote185.04s/refute32.40s actual outputs; Accounts service.ts421/451 and types.ts87-93; final bg6 gate receipt; extended smoke bg7 with privateHomeRemoved:true. Gate/manifest show no excluded or unreviewed artifact paths; README and decision logs were intentionally outside source review.
- **Reversibility:** easy
- **Confidence:** high for exercised package/API/CLI boundaries; bounded review assurance, no whole-repository/native claim
- **Revisit if:** Merge-result typecheck or an actual supported consumer contradicts this evidence.
- **Source:** assumed — autonomous; locked by docs/loop/LOOP.md

## Progress
Implementation and scoped verification complete. Sole roadmap catchup 8b9e4c35 preserved compatible Hosting/Dock contracts. Current Agents/scripts51/51/no-flake, full typecheck, extended actual daemon/CLI smoke and bounded standard review gate PASS with one explicitly rejected/suppressed claim. All agents, checks, reviewers and smoke processes returned; component trees removed and inherited metadata preserved. Next: commit the repair/README/decisions, detach, run canonical absolute queue land fix-test-agents-1028 and wait for its actual result. Remove only owned /tmp/quirky-agents-repair-lane5-DoHaAy0C after success, record the receipt in loop notes, and end this one-item iteration. No second item or whole-queue completion claim.
