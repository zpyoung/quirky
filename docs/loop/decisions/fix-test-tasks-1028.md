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

## D5: Repair executable test boundaries instead of changing correct product behavior
- **Question:** What explains the reached failures after the source trace and canonical gates?
- **Options:** change production rollback/consent/provider policy; increase watchdogs; repair demonstrated DOM, scheduling, and fixture defects
- **Chose:** Keep production unchanged. Import React DOM after DOM registration, attach Project mounts to the document and remove them during teardown, resolve associated labels, wait for the actual selected-view response/readback rather than optimistic tabs, and pump bounded act turns without waiting for downstream effect RPCs inside the act callback. Use native textarea setters. Remove incidental wording/default assertions instead of repinning them.
- **Why:** initial remote gate23files20pass3fail exposes wrong selectors and five30second waits; corrected gate21pass2fail narrows to connected labels, three over-specific error/stale expectations, and async repository input. Diagnostic run proves producer error messages were normalized, failed updates preserved the earlier values, REST search returned fresh data while lagSearch remained1, and the connected Project mount passes all7cases. No timeout or product guard was relaxed.
- **Evidence:** owned scratch tasks-suite/ tasks-suite2/ boundary-diagnostics receipts; remaining-list-issue harness receipts and persisted fixture rows; ProjectsSurface1116; design-system TextField label association; current Projects mount/document lifecycle.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a current public-path regression demonstrates an actual product defect
- **Source:** assumed — autonomous

## D6: Exercise lagging REST search data and compare rendered producer errors
- **Question:** Why did quiet adoption never receive the configured stale result, and why did two failure predicates time out after actual refusal?
- **Options:** weaken stale-read coverage; expose private provider errors; repair the fixture's active transport and observe canonical errors
- **Chose:** Extend the existing list upstream fixture's REST search branch with the same data-page-only lag behavior already present in GraphQL. Preserve count reads. Match visible errors against the actual failed public RPC's message, not private fixture stderr. Use visible/persisted outcomes for Origin switching and remove non-guaranteed adoption call assumptions.
- **Why:** diagnostic receipts show failIssueUpdate and failPRReviewerEdit remained true, actual RPC refusals occurred, prior Closed/first-reviewer values persisted, and UI rendered normalized public errors. The stale fixture existed only in the GraphQL branch while Hosting currently used REST. These are fixture/test contract defects, not a reason to change provider error policy.
- **Evidence:** boundary-diagnostics output and diagnostic-receipts.json; fixtures/list.ts REST search branch; current canonical tasks-suite3 exit0,23/23remote files,no flakes,90.52s; full typecheck3 exit0,57.72s.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the provider changes search transport or normalized error contract
- **Source:** assumed — autonomous

## D7: Bound actual web evidence and preserve every observed limitation
- **Question:** What does the real application smoke establish beyond repaired rendered tests?
- **Options:** infer exhaustive UI/native success; record exactly exercised visible effects and tooling/fixture limits
- **Chose:** Build the actual application (exit0,62.19s), boot two private fixture daemons, and drive the real daemon URLs with pinned likeuser web/unattended. Projects query isolation/restore and Board Todo→Done→No Status pass with personally inspected screenshots. Actual comment posting succeeds; its stable-detail Refresh has no changed tree and is partial, not a refresh-effect pass. New Issue title edit→Escape cancel→reopen preserves the draft. Both browsers close; both daemon services exit0 with root/homeRemoved:true. Native/other-platform effects remain unverified.
- **Why:** report statuses distinguish visible behavior from an idempotent read the visual-only driver cannot certify. Value-only fill signals also report NO_EFFECT despite screenshot-visible typed text; the actual post and reopen actions return OBSERVED. This is not permission to manufacture a dogfood pass.
- **Evidence:** .quirk/using-apps-like-a-user/runs/20261029T005412-d471 report(query/board pass) and screenshots3–9; 20261029T005743-23e6 report(comment partial,draft pass) and screenshots4,10,12,13; tasks-l12-projects-web/tasks-l12-issue-web TASKS_SMOKE_CLEANED.
- **Reversibility:** easy
- **Confidence:** high for named effects only
- **Revisit if:** full UI sweep or native acceptance contradicts the exercised paths
- **Source:** deferred: platform; assumed — autonomous

- **Retained findings:** Project fixture avatar URL fails DNS and its minimal built-in set omits sidebar-extras, causing an unrelated Worktree setting error; issue smoke includes sidebar-extras and eliminates that fixture omission. Issue-only upstream fixture deliberately lacks label/assignee/search responses, and the surface reports those failures. At1280x720 the New Issue footer is clipped; attempted content scrolling has no effect, while Escape cancels correctly. This visibility observation is not fixed or declared passed by this test-harness repair.

## D8: Consume the sole roadmap catch-up and lane8's historical Tasks inventory
- **Question:** Do concurrent lane results require another ownership change or rollback?
- **Options:** undo later repairs; duplicate repair items; retain current owners and distinguish snapshots
- **Chose:** Merge build/roadmap once at090e3a26 before final checks; read incoming fix-test-notifications-1028 D1–D12 and raw Progress completely. Preserve notification/Ask/Heimdall policy, which does not conflict with these test-only changes. Read lane8's exact Tasks failure inventory: all11files are covered by the current successful23file Tasks+scripts gate. Ask remains its existing repair owner's area; no duplicate item/alias or unrelated source change.
- **Why:** lane8's earlier full consumer run reports unknown quirky.worktree/list for9Tasks files, the old composer label failure, and restyle-detail. The earlier Mobile repair supplied the genuine Worktree→CLI fixture prerequisite; this item repairs the reached UI cases. A historical broad red snapshot is not a current full-suite pass or a reason to undo landed fixes.
- **Evidence:** merge090e3a26; docs/loop/decisions/fix-test-notifications-1028.md1–140/raw140; user lane8 heads-up; /Users/zpyoung/orca/workspaces/quirky/build-lane-8/.quirk/build-loop/fix-test-orchestration-1028/full-consumer-failures.json selected Tasks records; tasks-suite3.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the controller's actual merge-result check reports a concrete conflict or new failure
- **Source:** assumed — autonomous

## Progress
All three implementation components and gate-repair components returned, scopes/HEADs audited, merged, and six owned temporary worktrees removed. Production is unchanged; source changes are four UI regression files plus the existing list upstream fixture. The sole roadmap catch-up is integrated and incoming decisions read. Current canonical Tasks+scripts gate23/23remote files/no flakes passes90.52s; full typecheck passes57.72s. Actual build and named web effects/limitations are recorded in D7; both browser runs ended and both daemons cleaned their private homes. One cross-family review and any bounded accepted fix batch remain before final docs/commit/detach/absolute canonical queue.ts land. No second item, human ask, whole-suite completion, native acceptance or clean-output claim.
