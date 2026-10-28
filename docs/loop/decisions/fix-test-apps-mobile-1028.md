# fix-test-apps-mobile-1028 decisions

## D1: Repair reported mobile failures against current authority contracts
- **Question:** Which behavior and evidence bound the repair?
- **Options:** repin incidental assertions; weaken admission; trace the recorded failures and repair their causes.
- **Chose:** repair exactly apps/mobile failures reported in docs/loop/reports/m7-test-triage.json against current source. Keep per-route grants, exact source/grant binding, verified atomic generation activation, independent content-pinned consents, durable automation provenance and real Browser Watch coordinates. Delete incidental wording/source/default/inventory assertions rather than repinning them.
- **Why:** the queue explicitly assigns these failing files and requires consumer-visible repairs without aliases or bypasses. Existing failures are ground-truth RED evidence; do not rerun merely to confirm them.
- **Evidence:** queue wait --lane 8; triage groups.apps/mobile; starting revision e212abde0d3bec208b52d1d642f4ccf4f1b02c83; sb-mobile-app D2/D6/D9/D10/D11; sb-mobile-app-panels-unbuilt-flows D2/D7/D11.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** current source or an owning repair changes a public contract.
- **Source:** locked by docs/loop/LOOP.md; assumed — autonomous

## D2: Use disjoint mobile repair slices and preserve inherited metadata
- **Question:** How to execute safely without human decisions?
- **Options:** edit all shared source concurrently; isolate storage, bridge and UI ownership.
- **Chose:** initial read-only mapping, then at most three OpenAI omp task implementers on disjoint scopes. Parent owns integration, checks, decisions and landing. No worker commits or checks mid-flight. Existing untracked .quirk/ and .serena/ remain untouched. No language servers configured. No human asks. Fix items skip feature brainstorming/specs under LOOP.
- **Why:** storage, page admission and mounted UI failures have separate observable contracts; shared files require explicit owner before dispatch.
- **Evidence:** startup status; xd://lsp status; authoritative LOOP fix-items and end-phase sections.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** mapping shows a shared root cause or write scope.
- **Source:** assumed — autonomous

## Progress
Claimed this iteration's sole item on build/fix-test-apps-mobile-1028. Read authoritative LOOP and recorded triage evidence; source mapping in progress. No source edits or checks run yet.
