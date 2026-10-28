# m5-automations-core decisions

## D1: Ship the core slice only, with a durable pending dispatch handoff
- **Question:** Which automations.md flows belong to this queue item?
- **Options:** complete dispatch/UI now; definitions/schedules/scheduler/run storage/API/CLI only
- **Chose:** the core slice; accepted manual and scheduled occurrences persist as pending until a later dispatch consumer claims them
- **Why:** The item expressly excludes target resolution, dispatch, UI and OpenClaw. Pending is truthful, not a simulated successful launch. Public claim/result methods provide a complete durable queue seam without importing another plugin's internals.
- **Evidence:** queue item m5-automations-core title; automations.md Data model, The scheduler tick, Run statuses
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** dispatch requires additional atomic queue guarantees
- **Source:** locked by docs/loop/queue.json

## D2: Honor the stored IANA timezone and use strict timestamp ordering across DST
- **Question:** Should scheduling repeat Orca's ignored timezone and fall-back loop defect?
- **Options:** scheduler OS zone; explicit definition timezone
- **Chose:** explicit timezone, defaulting to creating process IANA zone; non-existent wall minutes are skipped and repeated wall minutes occur twice; next is strictly after the supplied instant and latest is at or before it
- **Why:** The feature doc identifies ignored timezone and a repeated-hour next-occurrence defect. Stable stored timezone makes a saved schedule portable across daemon zone changes and prevents the documented DST regression.
- **Evidence:** automations.md Schedules, DST issue #20154, Open questions
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** an earlier binding decision mandates process-local scheduling
- **Source:** assumed — autonomous

## D3: Keep preset and cron semantics explicit and reject impossible new schedules
- **Question:** Which syntax, defaults and validation apply?
- **Options:** unrestricted RFC5545; documented RRULE subset plus five-field cron
- **Chose:** HOURLY/DAILY/WEEKLY RRULE subset; documented cron lists/ranges/steps/names, Sunday0/7 and lexical DOM/DOW OR rule; 2048-byte cron input cap; reject impossible dates and oversized input steps while preserving runnable stored oversized steps
- **Why:** Matches the documented consumer contract without broadening recurrence features.
- **Evidence:** automations.md Schedules and CLI
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a documented preset cannot round-trip
- **Source:** locked by automations.md

## D4: Preserve pause cursor, latest-only catch-up, and elapsed grace plus 120 seconds
- **Question:** What happens after downtime or pause?
- **Options:** replay every missed run; skip all missed runs; latest-only within grace
- **Chose:** latest-only; paused definitions retain nextRunAt; resume may catch up once; grace0 is accepted by API and CLI; lateness strictly greater than grace plus two ticks records skipped_missed
- **Why:** Reproduces the defined scheduler behavior and removes the CLI's inability to select No grace.
- **Evidence:** automations.md The scheduler tick and Edge cases
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** consumers require a different explicit missed-run policy
- **Source:** assumed — autonomous

## D5: Durable row writes, 100 final runs, never prune active runs
- **Question:** How do mutation failures, concurrency, deletion and paging behave?
- **Options:** whole JSON store; plugin-owned SQLite using public store path
- **Chose:** plugin-owned SQLite, transactional run/definition writes; one per-id promise lane for mutations; scheduled occurrence uniqueness separate from manual requests; 100 newest final runs plus all active rows; monotonic run counter; stable timestamp/id cursor with optional legacy numeric offset
- **Why:** Durable pending handoff must survive restart before a dispatch consumer proceeds. Manual run requests in the same millisecond must not dedupe each other. Delete removes definition/history, never workspaces.
- **Evidence:** automations.md Storage and retention, Run statuses, Same occurrence twice
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** public store API cannot support isolated SQLite
- **Source:** assumed — autonomous

## D6: Use OpenAI implementers and verified Gemini cross-family review
- **Question:** Which reachable pair satisfies omp review independence?
- **Options:** task + opus; task + sonnet; task + gemini
- **Chose:** omp task implementers (OpenAI), Gemini high via pi-watch
- **Why:** Actual probes rejected opus and sonnet as no authed/shipping model; Gemini resolves google/gemini-3.1-pro-preview:high. Codex, Terra and Flash also resolve. No human prompts in this unattended loop.
- **Evidence:** iteration6 pi-watch --check outputs
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** dispatch itself fails
- **Source:** assumed — autonomous

## D7: One combined spec, at most three independent implementers, one final review
- **Question:** Which workflow governs this item?
- **Options:** full multi-document workflow; night-mode override
- **Chose:** combined logic.md with final technical section; commit contracts before implementers; one catch-up and final review; own-file TDD then affected suite/scripts/typecheck before land
- **Why:** Authoritative LOOP.md night mode is active. No research swarms or human questions; self-review accepts the recommended choices. API/CLI/Data gray areas include outputs, flags, error recovery, exit codes, pagination, concurrency, idempotency and retention.
- **Evidence:** git show build/roadmap:docs/loop/LOOP.md, Night mode
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the authoritative instructions change
- **Source:** locked by docs/loop/LOOP.md

## D8: macOS validation only, preserve inherited files
- **Question:** Platform and inherited working-tree handling?
- **Options:** validate every platform; macOS now with portable Intl/SQLite primitives
- **Chose:** macOS only; Linux/Windows need validation; inherited untracked .serena/, test-migrated.test.ts and test.ts stay untouched and unstaged; implementers use clean component worktrees
- **Why:** Platform scope is locked; unrelated user work is not ours to stash/delete/commit.
- **Evidence:** LOOP.md Platforms; iteration6 initial git status
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** platform-specific runtime evidence appears
- **Source:** deferred: platform

## D9: Distinguish retention ordering from history paging ordering
- **Question:** Which final row survives when createdAt ties?
- **Options:** ID order for both operations; scheduledFor then ID for retention and ID for paging
- **Chose:** retention uses createdAt descending, scheduledFor descending, ID ascending; paging remains createdAt descending, ID ascending
- **Why:** The feature doc explicitly distinguishes these contracts. Initial AC8 generalized the paging tie-break too broadly. A deterministic persisted-ID regression demonstrated eviction of the newer occurrence before the fix.
- **Evidence:** automations.md Storage and retention, lines365–367; test/store.test.ts retention tie regression; initial failing run artifact84
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the feature's retention policy changes explicitly
- **Source:** locked by automations.md

## D10: Bound occurrence metadata while preserving non-replay after pruning
- **Question:** Parent adjudication of suppressed X1: do compact per-occurrence snapshots still grow without limit?
- **Options:** retain every compact tombstone; retain bounded keys and a durable pruning watermark
- **Chose:** at most100 final occurrence keys plus active keys; remove orphan keys and all snapshot payloads; persist one pruned-scheduled-through watermark per definition
- **Why:** The X refuter rejected a valid citation for an invalid reason. A direct regression observed201 metadata rows for one folded run. Retained duplicate occurrences return their real row; a non-retained timestamp at or before the pruning watermark conflicts, never reconstructs deleted evidence or launches again. Only actual pruning advances the watermark, so out-of-order retained occurrences still fold. The scheduler advances an already-processed pruned cursor without fabricating a run.
- **Evidence:** review X.promote.json X1 and X.refute.json; test/store.test.ts bounded metadata and restart non-replay regressions; initial failing run artifact90; final57test pass artifact97
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** a consumer needs arbitrary historical occurrence lookup after explicit retention
- **Source:** supersedes m5-automations-core D5

## D11: Bound arbitrary JSON metadata separately from output snapshots
- **Question:** Parent adjudication of suppressed X2: should context and result metadata have a byte limit?
- **Options:** rely on transport bounds alone; cap persisted metadata records explicitly
- **Chose:**64KiB serialized UTF-8 JSON each for runContext, sourceContext, launchSettings, precheckResult and usage; invalid-params before mutation above the limit; output keeps its independent256KiB truncation behavior
- **Why:** A public API regression showed a65537-byte object being stored before the fix. Exact65536-byte metadata remains accepted. An initial generic-object placement also restricted output snapshots; the existing output regression caught this, and the limit moved to metadata normalization only.
- **Evidence:** test/api.test.ts exact-limit and rejected mutation regression; initial failing run artifact88; existing output lifecycle regression; final57test pass artifact97
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** legitimate metadata needs a larger documented bound
- **Source:** assumed — autonomous

## D12: Record mechanical review PASS without claiming clean clearance
- **Question:** How much assurance does the final round provide after refuter protocol failures?
- **Options:** treat gate PASS as clean; disclose mechanical results and adjudicate claims directly
- **Chose:** limited assurance; one final round only, direct parent confirmation and one fix batch for X1/X2 plus retention parity
- **Why:** Six real Gemini high dispatches completed under STANDARD C/S/X promote/fresh-refute. C/S raised no findings. X raised two claims, both mechanically suppressed solely for citation ranges whose starts were actually valid. X refute also violated its read-only prompt by writing test-oversized.ts and result.json and executing reproductions. Both reviewer-owned files were preserved then removed; original untracked files stayed untouched. The captured production hashes stayed unchanged. Neither the100% X suppression rate nor the gate PASS proves correctness. No independent closure review is claimed for the final fix delta; focused tests and runtime verification provide its evidence.
- **Evidence:** local audit archive `.orca/loops/omp-until-done-deaecbdd/review-evidence.tar.gz`, SHA256 `76442c560a31dc1cb215b3a8abd46c2b7412b6320fe5177ed9db3cc0f0eed8c0`; member review/integrity-limitations.json, dispatch-audit.json, C/S/X gates/manifests and raw traces; captured artifact SHA256 `15e92dfbdbe9a40ffbb841a116efde7d9522bf1890fd2408f058c2fabefc53c0`
- **Reversibility:** easy
- **Confidence:** high for dispatch/trace facts, limited for review assurance
- **Revisit if:** the review harness enforces read-only execution or this feature is independently reviewed
- **Source:** assumed — autonomous

## D13: Serialize script checks with process-level smokes
- **Question:** Does the initial script timeout represent a waived failure?
- **Options:** waive it; inspect and rerun without concurrent process scopes
- **Chose:** inspect the exact cleanup test, run its file alone, then run all scripts serially
- **Why:** Initial scripts were67pass/1timeout while API tests and a real smoke ran concurrently. The isolated cleanup file passed6/0; the serial full script run passed68/0 with554 assertions. No script, harness deadline or exclusion changed. The helper selects any new guardian globally; concurrent guardian selection or timing is an inference, not a proven root cause because the selected PID was not captured.
- **Evidence:** scripts/process-scope.test.ts:234–269; initial artifact59, isolated bg10, serial artifact69
- **Reversibility:** easy
- **Confidence:** high for observed results; medium for contention hypothesis
- **Revisit if:** the serial command times out
- **Source:** assumed — autonomous

## Progress
Step5 integrated all three audited components: 2fc69e40 schedule, 8a46547b store, 949ffcbb API/CLI. Each component HEAD stayed cbff475d until parent commit; exact path sets matched ownership, excluding inherited .serena/. Parent removed all three component worktrees after merging. Own-file worker results: schedule18pass/60assertions, store15pass/84assertions. API component's acceptance runs awaited integration because it imports both components; no green result inferred. Parent integration review corrected semantic cron labels, pruned-output duplication in occurrence tombstones, and workspace-mode field normalization; corresponding narrow regressions ran red then green. Replaced forwarding/mock-echo CLI tests and an empty tick clock-pin with actual API/CLI flow coverage.

Final verification before landing: `bun test plugins/quirky.automations/test`57pass/0fail/281assertions across5files; `bun test scripts`68pass/0fail/554assertions; `bun run typecheck`exit0 including frozen install557/572 unchanged. Initial affected-suite remote transport was unavailable and fell back to local execution; its two real failures were fixed rather than excluded. The API acceptance tests exercise real CLI CRUD/run/history, public cron semantics, startup/tick isolation, durable result transitions, metadata bounds and retention/paging.

Final actual-daemon/CLI smoke exited0 in61.85seconds on the final storage schema and metadata limits: fresh HOME and QUIRKY_HOME, isolated built-ins, owned ProcessScope children. Proved paused manual queue, claim/result lifecycle, unchanged pause cursor, grace0, public DST inspector, a real60-second timer-created scheduled pending run with advancement/dedupe, restart durability and cascading delete. No agent was launched by this core item; completed status was recorded through the public result API. Daemon stopped and smoke root removed. No UI or native-only scenarios; Linux/Windows validation not claimed.

All implementers, six review dispatches, nested coordinators, process watchers and smoke processes returned. No open confirmed code findings remain after the single fix batch; review integrity limits remain documented in D12, not treated as clean assurance. Specs, README and API descriptions reflect the final contracts. Next: commit final fixes/docs, detach and run authoritative queue land m5-automations-core. Scratch `/tmp/quirky-automations-core-lane7.qfdLfJ` is removable after landing; review evidence archive beside loop notes is retained. One item only this iteration.
