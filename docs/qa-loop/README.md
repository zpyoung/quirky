# Unattended QA loop

QA agents use the real app and file what's broken, omp agents fix it in their own worktrees, and an orchestrator keeps it all moving until a set deadline. Nobody needs to be watching. Decisions the orchestrator made, and anything it left unmerged, are in the final report.

| Piece | Runs as | Instructions |
| --- | --- | --- |
| Orchestrator (Claude Code) | Orca loop, 5 minutes after each tick ends | [ORCHESTRATOR.md](ORCHESTRATOR.md) |
| Foreground QA (Claude Code), one | Orca loop, drives the real app window | [QA.md](QA.md), [areas.md](areas.md) |
| Background QA (Claude Code), one or two | Orca loop, headless browser | [QA.md](QA.md), [areas.md](areas.md) |
| Fix sessions (omp), up to 12 | One Orca worktree per finding, started by the orchestrator | [FIX.md](FIX.md) |

A finding moves through these states, in `scripts/qa-loop/findings.ts`:

1. QA files it as `todo`, and it waits in the queue.
2. The orchestrator assigns it to a new worktree when fewer than 12 are open (`in-progress`).
3. The fix session opens a PR (`in-review`), or parks the finding with a question (`needs-answer`).
4. The orchestrator merges the PR (`done`), sends it back (`in-progress`), or closes the finding with a reason (`blocked`), then removes the worktree.

The queue's state lives in `<git common dir>/qa-loop/`, shared by every worktree and never committed:

- `findings.json`: every finding with its status, worktree, PR, notes and outcome.
- `config.json`: `{"deadline": "<ISO time with offset>"}`. Every QA loop's done check is `findings.ts deadline`.
- `evidence/`: screenshots QA cites.
- `qa-log.md`: one entry per QA round.
- `orchestrator-log.md`: what each tick did and every decision it made.
- `report.md`: the final report, whose existence ends the orchestrator's loop.

## Operating it

- `bun scripts/qa-loop/findings.ts status` shows counts, and `open` shows which worktree holds what.
- To stop early, move the deadline into the past. The orchestrator drains what's in flight and writes the report. To stop right away, run `orca loop stop <id>` on each loop.
- Keep the Mac awake and unlocked. A locked screen stops foreground QA.
