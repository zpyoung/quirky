# Build loop

Three unattended Orca loops, called lanes, build [the roadmap](../roadmap.md) in parallel, one work
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
| `~/orca/workspaces/quirky/build-roadmap` | lane 1 (the loop "quirky build") |
| `~/orca/workspaces/quirky/build-lane-2` | lane 2 |
| `~/orca/workspaces/quirky/build-lane-3` | lane 3 |
| `~/orca/workspaces/quirky/native-qa` | the nightly native run, 23:30 America/Chicago |

## Running it

Run `queue.ts` from any lane worktree.

- **Progress:**
  - `bun scripts/build-loop/queue.ts status` shows the counts, and which lane holds what.
  - `orca loop list` shows the three loops. Each loop's tab shows its rail.
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
