# Test runs use OVH first and overflow to gcloud

A test run should never silently spend two hours on this Mac because a host is down. On 2026-10-30 the configured gcloud box stopped answering, so `bun run test` ran 886 files one at a time here while its log still said they were on the host. Each run now picks a host on purpose and says which one, and if no host can be reached it stops straight away.

## How a run picks its host

A run picks one host when it starts and stays on it. It tries OVH first and looks at gcloud only when OVH is down or full. The choice and the reason appear at the top of the log, and the macOS-only files start after the choice is made.

## Behavior

1. **SC-1: OVH has room**
   - **Given** OVH is reachable and no other run is using all its slots
   - **When** a run starts
   - **Then** it runs on OVH, and gcloud isn't contacted
   - **Data before:** **OVH**: reachable, 0 other runs; **gcloud**: down
   - **Walkthrough:**
     1. The developer runs `bun run test`
     2. The run checks OVH and finds room
   - **Data after:** **Log**: ✓ running on OVH; **gcloud**: not contacted

2. **SC-2: OVH is full and gcloud is up**
   - **Given** another run is using all of OVH's slots and gcloud is reachable
   - **When** a run starts
   - **Then** it runs on gcloud, and the log says OVH was full
   - **Data before:** **OVH**: reachable, 1 other run on 4 of 4 slots; **gcloud**: reachable
   - **Walkthrough:**
     1. The developer runs `bun run test`
     2. The run finds OVH full and checks gcloud
   - **Data after:** **Log**: ✓ running on gcloud because OVH is full

3. **SC-3: OVH is full and gcloud is down**
   - **Given** another run is using all of OVH's slots and gcloud can't be reached
   - **When** a run starts
   - **Then** it queues on OVH, and the log says overflow is unavailable because gcloud is down
   - **Data before:** **OVH**: reachable, 1 other run on 4 of 4 slots; **gcloud**: down
   - **Walkthrough:**
     1. The developer runs `bun run test`
     2. The run finds OVH full and gcloud unreachable
   - **Data after:** **Log**: ✓ queued on OVH; ✓ overflow unavailable because gcloud is down

4. **SC-4: OVH is down and gcloud is up**
   - **Given** OVH can't be reached and gcloud can
   - **When** a run starts
   - **Then** it runs on gcloud, and the log says OVH is down

5. **SC-5: Both hosts are down**
   - **Given** neither host can be reached
   - **When** a run starts
   - **Then** it exits with a failure within about 30 seconds, no tests run (including the macOS-only files), and the error names both hosts and `QUIRKY_TEST_LOCAL=1`
   - **Data before:** **OVH**: down; **gcloud**: down
   - **Walkthrough:**
     1. The developer runs `bun run test`
     2. Both checks time out
   - **Data after:** **Run**: ✗ no tests started; exit code 1*; **Log**: ✓ both hosts named; ✓ says `QUIRKY_TEST_LOCAL=1` runs everything on this Mac

6. **SC-6: A land while OVH is full**
   - **Given** a land starts while another run is using all of OVH's slots
   - **When** the land picks its host
   - **Then** it stays on OVH, because lands already take priority over other runs there; if OVH is down, it follows SC-4 or SC-5

7. **SC-7: A run while a land holds OVH**
   - **Given** a land is running on OVH
   - **When** another run starts
   - **Then** OVH counts as full, so the run follows SC-2 or SC-3

8. **SC-8: The host is lost mid-run**
   - **Given** a run is under way on a host
   - **When** that host stops responding or the copy to it fails
   - **Then** the run stops with an error naming the host, with no retry on the other host and no fallback to this Mac

9. **SC-9: Running here on purpose**
   - **Given** `QUIRKY_TEST_LOCAL=1` is set or no host config exists
   - **When** a run starts
   - **Then** everything runs on this Mac, as it does today, and no host is contacted

10. **SC-10: Only one host configured**
    - **Given** the config names OVH and no overflow host
    - **When** OVH is full or down
    - **Then** a full OVH queues the run and a down OVH follows SC-5, naming the one host

11. **SC-11: An older branch reads the new config**
    - **Given** a worktree whose `scripts/suite.ts` predates this change
    - **When** it reads the host config
    - **Then** it uses OVH and ignores the overflow entry, keeping its old Mac fallback

## Decisions Locked

**Choosing a host**

- A run picks one host at the start and never splits across hosts.
- Full means other runs on the box already use all its slots. With 4 jobs and 4 slots, that's any one other run. Runs are counted because a slot lock is briefly free between files, which would make a busy box look free.
- A land stays on OVH when OVH is up.

**When hosts are down**

- A stopped gcloud VM stays stopped. The run stays on OVH and says so, so nothing spends cloud money without the developer choosing it.
- The automatic Mac fallback is removed. It took about 2 hours and failed anyway, so a fast, clear error is more useful.
- A host lost mid-run ends the run with an error, because a retry could add another full run's time unasked.

**Config**

- `<git common dir>/build-loop/remote-tests.json` keeps its current fields for OVH and gains `"overflow": {"host", "jobs", "slots"}`. Older branches read the same file, so the existing fields can't change.
- The gcloud entry moves from 2 jobs to 8, because at 2 an overflow run would take about as long as the wait it avoids. This number is provisional until the VM's core count can be checked.

## Scope & non-goals

This covers host choice in `scripts/suite.ts`, its tests in `scripts/suite.test.ts`, and the "Where the tests run" section of `docs/loop/README.md`. It doesn't change which tests run, how slots are shared within a host, or the macOS-only list.

## Industry Insights

Skipped: this is a choice inside a local test runner, and outside patterns wouldn't change the decisions above. No research agents ran.

## Deferred Ideas

- Start the gcloud VM automatically when overflow needs it.
- Split one run across both hosts, sharing a file queue.

## Glossary

- **Land:** the build loop's merge-and-verify run, started from the `integration` or `verify` worktree.
- **Slot:** one of a host's machine-wide locks. Each test file holds one while it runs.
- **Jobs:** how many files one run tries to execute at once.
- **Overflow host:** the host used only when the first host is down or full.
- **macOS-only files:** tests listed in `scripts/test-on-macos.txt`, which always run on this Mac.

## Status & amendments

**Status:** Approved. Tech spec: not needed.

**Amendments:** None.
