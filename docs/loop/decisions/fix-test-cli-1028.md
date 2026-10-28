# fix-test-cli-1028 decisions

## D1: Repair the current failure without adding obsolete API aliases
- **Question:** Which baseline failures still require a change?
- **Options:** restore dotted API aliases; change credential storage; diagnose the current canonical suite.
- **Chose:** diagnose current source and preserve camelCase public methods and private storage.
- **Why:** The canonical CLI suite reproduced one failure at runtimes.test.ts:78: decoded deviceToken is absent as a literal substring of the store. The complete secret-bearing URL is retained with the token inside its base64url offer. Malformed-offer rejection and owner routing passed. The baseline's unknown dotted method and missing-file assertion failures did not recur.
- **Evidence:** docs/loop/reports/m7-test-triage.json groups[plugins/quirky.cli]; canonical bun scripts/suite.ts plugins/quirky.cli (2 files, 1 failed, isolated retry same assertion); packages/protocol/src/node/paired-runtimes.ts:182-204; plugins/quirky.cli/main.ts:167-180.
- **Reversibility:** easy (test-only repair).
- **Confidence:** high
- **Revisit if:** a current public call leaks credentials or a malformed offer creates a store.
- **Source:** assumed — autonomous

## D2: Prove retained credentials by encrypted use, not JSON encoding
- **Question:** What should replace the storage-text expectations?
- **Options:** duplicate the token in plaintext to satisfy the test; assert another serialized store shape; exercise a saved encrypted connection and reject fresh resolution after removal.
- **Chose:** remove encoding-dependent positive/raw-negative token assertions; authenticate a saved mobile link against the real daemon, compare its scoped API to the direct daemon result, then verify a fresh saved link cannot resolve the removed target.
- **Why:** Raw token containment fails for the valid encoded URL and raw non-containment after removal could pass even if the encoded credential remained. Usability and removal are the consumer contracts. Keep mode 0600 and credential exclusion checks for every named public response, including add (previously omitted from the loop).
- **Evidence:** plugins/quirky.cli/test/runtimes.test.ts; packages/cli/src/paired-link.ts:54-82; packages/protocol/src/node/paired-runtimes.ts:165-180,226-237.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the saved transport or scope contract changes.
- **Source:** assumed — autonomous

## D3: Keep removal local and preserve explicit CLI consent
- **Question:** Does removal revoke the remote pairing, and what did the CLI smoke establish?
- **Options:** silently revoke the remote grant; document and exercise local saved-selector removal with explicit confirmation.
- **Chose:** preserve local removal, the required `--yes`, and existing remote grant lifetime.
- **Why:** `removeSavedRuntimeTarget` deletes the saved row only. New saved links resolve that row before transport setup; existing links and the remote grant have independent lifetimes. An isolated real CLI/daemon smoke exercised malformed add without store creation, valid add/list/show/status, 0600 mode, encrypted saved-link authentication and exact scoped API response, confirmed remove, empty list, and fresh-link refusal. Captured CLI output excluded the full URL, encoded code, decoded token and public key. Initial throwaway harness assumptions were corrected: InvalidParams is CLI exit 1 (not 2), and removal needs `--yes`; both failed attempts cleaned their private scope. No product change was needed.
- **Evidence:** packages/protocol/src/node/paired-runtimes.ts:207-237; packages/cli/src/paired-link.ts:54-82; actual smoke exit 0 with CLI_SAVED_RUNTIME_PRIVACY_SMOKE_OK and CLI_SAVED_RUNTIME_SCOPE_CLEANED (3.12 seconds).
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** removal is explicitly specified to revoke the remote grant.
- **Source:** assumed — autonomous

## D4: Land the bounded test repair after complete exercised checks
- **Question:** What acceptance evidence applies to this test-only item?
- **Options:** claim a production credential defect; widen into unrelated feature work; land the demonstrated regression correction with exact receipts.
- **Chose:** land the test-only repair and existing-file documentation clarification.
- **Why:** Final canonical CLI suite passed 2/2 files without flaky reruns (88.36 seconds). Final `bun test scripts` passed 126/126 tests and 1,101 assertions (277.51 seconds); its deliberate nested failure fixtures are not enclosing-suite failures. Final `bun run typecheck` passed UI lint, root, mobile and prepared desktop checks (175.83 seconds). Static reviewer approved source and README with no actionable findings. The actual CLI/API smoke independently passed and removed its private home. No changed production importers or plugin manifests require migration, and no UI/native scenario changed.
- **Evidence:** final commands above; focused runtimes 3/3 tests, 43 assertions; CLI_SAVED_RUNTIME_PRIVACY_SMOKE_OK and CLI_SAVED_RUNTIME_SCOPE_CLEANED; static CliRuntimeReviewer approval.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** merged-result typecheck or subsequent end-phase acceptance exposes a concrete regression.
- **Source:** assumed — autonomous

## Progress
All bounded acceptance checks completed as recorded in D3–D4. Source commit cbd82a0d; single roadmap catch-up was already up to date (no incoming decisions). Runtime test and README preserve existing private storage, public summaries, encrypted use, malformed-offer refusal and local removal semantics. No runtime, timeout, alias, platform, UI or native acceptance change. Ready to commit final receipts, detach and run canonical queue land; then remove the owned temporary smoke script.
