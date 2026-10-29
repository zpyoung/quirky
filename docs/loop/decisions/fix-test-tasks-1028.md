# fix-test-tasks-1028 decisions

## D1: Repair the owned Tasks behavior without cross-plugin bypasses
- **Question:** What is the repair scope and acceptance source?
- **Options:** repin stale UI assertions; trace the reported interactions and preserve behavioral coverage; change other plugins opportunistically
- **Chose:** trace all nine queued Projects/list/issue failures plus the workspace-composer and restyle-detail failures assigned by the Mobile repair
- **Why:** the queue and BLOCKERS provide ground-truth failure evidence; selectors, timing and wording are not behavior contracts
- **Evidence:** docs/loop/reports/m7-test-triage.json; docs/loop/BLOCKERS.md under fix-test-mobile-1028; plugins/quirky.tasks/test/projects-ui.test.tsx; plugins/quirky.tasks/test/remaining-list-issue.test.ts
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** current evidence identifies an independently owned plugin defect
- **Source:** locked by docs/loop/LOOP.md

## D2: Use omp implementers and the reachable Gemini cross-family reviewer
- **Question:** Which unattended implementation/review pairing is available?
- **Options:** omp + Opus; omp + Gemini; same-family review
- **Chose:** task subagents on OpenAI implement, google/gemini-3.1-pro-preview reviews through pi-watch
- **Why:** the actual Opus probe exited 5 with no authenticated/shipping model; Gemini probe succeeded at high thinking
- **Evidence:** iteration 17 pi-watch --check opus and --check gemini in private scratch /tmp/quirky-tasks-repair-l12.ZcDnt2
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** review dispatch fails and the fallback ladder is required
- **Source:** assumed — autonomous

## D3: Keep inherited untracked tooling state untouched
- **Question:** How should the preflight handle .serena/?
- **Options:** stash or delete it; preserve and exclude it from the owned patch
- **Chose:** preserve it without staging or modifying it
- **Why:** it was present before claiming this item, with no tracked changes; unrelated user state is not this repair
- **Evidence:** initial git status --short --branch: detached HEAD and only ?? .serena/
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a required tool actually needs a tracked change there
- **Source:** assumed — autonomous

## D4: Split three disjoint repair components without changing public contracts
- **Question:** Which independent scopes can address the reported failures without concurrent shared-file edits?
- **Options:** one broad worker; overlapping surfaces; three vertical repair components
- **Chose:** ProjectsSurface/projects-ui; TasksList/IssueSurface/remaining-list-issue; WorkspaceComposer/NewIssueDialog/workspace-composer/restyle-detail. Each gets its own external worktree, no commits or mid-flight checks. Parent owns tests at barriers, docs, integration, smoke and landing. Cap3, one wave, no semantic edges; cap does not bind.
- **Why:** current public contracts already express the required behavior. Projects tests compare textContent with item-specific aria-labels and always require tbody even in Board mode. List/detail and composer failures require source/harness investigation, not guessed rollback changes. No exported signature changes are planned; LSP status reports no configured language servers.
- **Evidence:** ProjectsSurface.tsx1110–1118; projects-ui.test.tsx61–100,284–298; scout TasksFailureMap; xd://lsp status; baseline4ffce19338d2f6860ebbd1e2a24e14ed01ad8ac9
- **Reversibility:** easy
- **Confidence:** high for partition, medium for remaining causes
- **Revisit if:** a required repair touches shared files; replan before allowing it
- **Source:** assumed — autonomous

## Progress
Claimed lane12; branch build/fix-test-tasks-1028 from source4ffce193. Investigation mapped all nine reported cases and the two additional owned files. Fix items skip new feature specs. Shared API/schema contracts remain unchanged and existing Tasks decisions D3/D8/D9/D10 bind this repair. Three disjoint components are planned in one wave. Canonical suite at barriers: bun scripts/suite.ts plugins/quirky.tasks scripts; full bun run typecheck. Actual web doctor passed with pinned playwright-cli0.1.22. End-phase runtime smoke and one cross-family review remain required. No human asks or checks rerun merely to confirm supplied failures. Queue commands use the absolute canonical integration path. Unrelated .serena/ remains untouched.
