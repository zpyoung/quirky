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

## Progress
Step3 requirements and autonomous design settled; repository scout still resolving exact plugin/store/CLI patterns. Next: commit combined spec and shared contracts, dispatch independent schedule/store/API implementers on isolated component worktrees. No implementation or test run yet. Dependencies were already done at claim. Branch build/m5-automations-core; scratch /tmp/quirky-automations-core-lane7.qfdLfJ. Claim 2026-10-28T01:10Z.
