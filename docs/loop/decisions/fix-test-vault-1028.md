# fix-test-vault-1028 decisions

## D1: Repair the three recorded vault acceptance failures without repinning incidental assertions
- **Question:** Which failures and contracts govern this unattended fix item?
- **Options:** Repin presentation wording and defaults; trace and repair consumer-visible behavior while deleting incidental assertions.
- **Chose:** Trace the recorded SC-08, SC-15/16 and real-host acceptance failures; preserve meaningful identity, redaction, availability and recovery checks.
- **Why:** The queue explicitly requires consumer-visible repairs and deletion of incidental wording/source/default/inventory mirrors.
- **Evidence:** docs/loop/reports/m7-test-triage.json, groups plugins/quirky.vault; plugins/quirky.vault/test/window-parity.test.ts; plugins/quirky.vault/test/flows.test.ts.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Current evidence identifies an additional defect at the same contract seam.
- **Source:** locked by docs/loop/LOOP.md

## D2: Isolate implementation and use a reachable cross-family reviewer
- **Question:** How should implementation, review and private state be isolated?
- **Options:** Modify inherited metadata; preserve it and scope all owned work explicitly. Use unavailable Opus; use reachable Gemini.
- **Chose:** Preserve inherited untracked .serena unchanged; use explicitly scoped omp task implementers and Gemini review after green verification. No person is asked anything.
- **Why:** Opus probe returned no authenticated shipping model; Gemini probe resolved google/gemini-3.1-pro-preview:high. No language servers are configured, so code navigation uses repository search.
- **Evidence:** pi-watch --check opus exited 5; pi-watch --check gemini exited 0; xd://lsp status reported no configured servers.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** The reviewer fails at dispatch.
- **Source:** assumed — autonomous

## Progress
Claimed on lane 5; branch created from current build/roadmap. Reading exact triage evidence and current source. Read-only VaultFailureMap investigation running. No implementation or checks claimed yet. Owned scratch: /tmp/quirky-vault-repair-lane5-RDQalGGE.
