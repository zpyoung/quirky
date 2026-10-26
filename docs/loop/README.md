# Build loop

An unattended Orca loop builds [the roadmap](../roadmap.md) one work item per iteration on the
`build/roadmap` branch. It never touches `main` and never pushes. [LOOP.md](LOOP.md) is what each
iteration follows.

## What to review

- [DECISIONS.md](DECISIONS.md) lists every decision the loop made without you, hardest to reverse
  first. Each row links to the item's full log in `decisions/`.
- [BLOCKERS.md](BLOCKERS.md) lists items the loop couldn't finish, with evidence. The work for each
  is on a `blocked/<id>` branch.
- `reviews/<milestone>.md` is written at each review gate. The only gate is after M0.
- The specs are in `docs/quirk/specs/<date>-<id>/`.

## Running it

- **Progress:**
  - `bun scripts/build-loop/queue.ts status` shows the queue.
  - `orca loop show <loopId>` shows the loop.
  - The loop's tab shows its rail.
- **Approve the M0 review:**
  1. When the loop pauses with "The agent needs a decision", read `reviews/M0.md`.
  2. In the loop's worktree, run `bun scripts/build-loop/queue.ts set gate-m0 done`.
  3. Run `orca loop resume <loopId>`.
- **Unblock an item:**
  1. Fix or decide what its BLOCKERS.md entry asks.
  2. Run `bun scripts/build-loop/queue.ts set <id> todo` and commit.
  3. Resume the loop.
- **Steer:** `orca loop steer <loopId> "<note>"` adds a note to the next iteration's prompt.
- **Change what you'd want decided differently:** edit the decision in `decisions/<id>.md` and
  leave a steer note. The loop treats earlier decisions as binding.
