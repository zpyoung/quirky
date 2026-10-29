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

## D3: Repair fixture boundaries before changing product contracts
- **Question:** Which current failures require product changes?
- **Options:** Relax search limits or expose fallback methods; restore curated dependencies and wait for the intended asynchronous state.
- **Chose:** Add the real quirky.cli prerequisite to curated vault fixtures; fix scoped UI selectors, actual failure barriers and valid term-limit input. Keep the 512-character public query bound.
- **Why:** The actual private registry marks worktree invalid because quirky.cli is absent, invalidating session/terminal/vault. SC-08 matched preparing-results Retry before the debounced search failed. SC-15 passed 760 characters to an API that rejects more than 512 before engine truncation. Global status/menu-wrapper assertions also drifted after UI restyling.
- **Evidence:** Canonical two-file run exited 1 in 144.71s: flows 0/8, window 3 pass/5 fail/1 skip; detailed traces artifact9. Private registry diagnostic showed dependency errors and completed cleanup. service.ts:365; search/engine.ts:340-342; HistoryPanel.tsx:675.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Corrected fixtures expose a consumer-visible implementation defect.
- **Source:** assumed — autonomous

## Progress
Root causes traced. VaultHostIsolation and VaultWindowAcceptance are implementing disjoint fixture/test repairs in external component worktrees at 121a8de4. Parent added the same missing prerequisite to resume.test.ts. No source contract changed. Next: all-worker barrier/scope audit, integrate, canonical full vault/scripts/typecheck and standalone paired-daemon smoke, one catch-up and final review, authoritative landing. Owned scratch: /tmp/quirky-vault-repair-lane5-RDQalGGE.
