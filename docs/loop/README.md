# Build loop

Ten unattended Orca loops, called lanes, all running omp, build [the roadmap](../roadmap.md) in parallel, one work
item per iteration each. Their work lands on the `build/roadmap` branch. They never touch `main` and
never push. [LOOP.md](LOOP.md) is what each iteration follows, and [NATIVE.md](NATIVE.md) is what
the nightly native run follows.

## What to review

- [DECISIONS.md](DECISIONS.md) lists every decision the loop made without you, hardest to reverse
  first. Each row links to the item's full log in `decisions/`.
- [BLOCKERS.md](BLOCKERS.md) lists items the loop couldn't finish, with evidence, and review
  findings an item finished without closing. The work for a blocked item is on a `blocked/<id>`
  branch.
- `reviews/<milestone>.md` is written at each review gate. The only gate was after M0.
- [native/RUNS.md](native/RUNS.md) has one line per nightly native run, and `native/<item>.json`
  holds each native-only scenario's last result.
- The specs are in `docs/quirk/specs/<date>-<id>/`.

## How the lanes share work

`build/roadmap` stays checked out in an integration worktree at
`<git common dir>/build-loop/integration`. Nobody works in it: `scripts/build-loop/queue.ts`
changes the queue there, under a lock, so two lanes never claim the same item or land at once. Each
lane claims an item, builds it on `build/<id>` in its own worktree, and runs `queue.ts land`, which
merges it, reruns the tests on the result and marks it done. A merge that conflicts or fails the
tests leaves `build/roadmap` unchanged.

| Worktree | Runs |
| --- | --- |
| `~/orca/workspaces/quirky/build-roadmap` | lane 1 |
| `~/orca/workspaces/quirky/build-lane-<n>` | lane n, for lanes 2 to 10 |
| `~/orca/workspaces/quirky/native-qa` | the nightly native run, 23:30 America/Chicago |

## Where the tests run

`bun run test` runs the suite on a Linux host instead of this Mac, so the lanes' test runs don't
compete for its CPU. `<git common dir>/build-loop/remote-tests.json` names the host and how many
test files run there at once, with an optional `overflow` host in the same shape; it's local to
this machine and never committed. Without that file, or with `QUIRKY_TEST_LOCAL=1`, everything runs
here.

- **Which host:** a run picks one host when it starts and says so in its log. It uses the OVH box,
  or the gcloud box when OVH is down or another run already takes all of OVH's slots. A land stays
  on OVH unless OVH is down. When OVH is full and gcloud is down, the run queues on OVH; nothing
  starts the gcloud VM for you. When neither host answers, the run stops within about 30 seconds
  before any test starts. A host lost during a run stops that run.
- **The hosts** are used as the unprivileged user `quirkyci`. Every run copies the working
  tree to a fresh folder there and deletes it afterwards. Only files git doesn't ignore are copied,
  so `research/` never leaves this machine.
- **The host's setup** is bun 1.4.0 and zsh, a git identity, and stub `claude` and `codex`
  commands in `~/.local/bin` (also on the zsh login PATH through `~/.zprofile`). Some tests look
  for those commands on the PATH. The stubs never reach a real account.
- **macOS-only tests** are listed in `scripts/test-on-macos.txt` and run on this Mac alongside.
- **Order and sharing:** test files start slowest first, by the times logged on the host in
  `~/test-slots/durations.log`. A land's run gets every slot, and other runs share one while it
  goes, because the land holds the queue lock. One land also takes in up to three other items
  whose lanes are waiting to land, so a single run verifies them all.
- **Flaky files:** a failing test file is rerun once on its own. One that then passes is logged to
  `<git common dir>/build-loop/flakes.log`; fix the ones that keep showing up.
- **Per-file costs:** `QUIRKY_TEST_PROFILE=1 bun run test` prints `suite-file` JSON rows with
  `file`, `wallMs`, `userCpuMs`, `systemCpuMs` and `exitCode` for each attempt, including isolated
  retries. Without a remote host, profiling runs each discovered file serially; ordinary runs keep
  their existing scheduling. `QUIRKY_TEST_LOCAL=1` also forces that local profiling path.
  CPU is OS resource accounting for the test command and waited-for descendants, not total host
  or independent guardian CPU. Wall time includes execution and cleanup, but not initial guardian
  creation, slot contention, transfer or install. Compare the same files and runner configuration;
  suite elapsed time also depends on other lanes and slot contention.

## Running it

Run `queue.ts` from any lane worktree.

- **Progress:**
  - `bun scripts/build-loop/queue.ts status` shows the counts, and which lane holds what.
  - `orca loop list` shows the loops, named "quirky build lane <n>". Each loop's tab shows its rail.
- **Unblock an item:**
  1. Fix or decide what its BLOCKERS.md entry asks.
  2. Run `bun scripts/build-loop/queue.ts set <id> todo`.
  3. Resume any paused lane.
- **Steer:** `orca loop steer <loopId> "<note>"` adds a note to that lane's next iteration.
- **Change what you'd want decided differently:** edit the decision in `decisions/<id>.md` on
  `build/roadmap`, and leave a steer note on each lane. The loop treats earlier decisions as
  binding.
- **The nightly native run** needs the Mac awake and unlocked. It skips the night when the screen
  is locked. Every failure it finds becomes a `fix-native-*` item that a lane picks up.
