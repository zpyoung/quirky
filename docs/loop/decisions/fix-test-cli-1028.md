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

## Progress
Current canonical failure reproduced both via suite and local focused file. Test-only correction written; focused verification running. Next: actual isolated CLI/API smoke, affected canonical suite/scripts/typecheck, one roadmap catch-up and incoming decisions, final receipt and canonical land. No runtime, timeout, alias, platform or native UI change intended.
