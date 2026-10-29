# Overnight visual QA loop

Four Orca loops run until a set deadline. One QA lane (Claude Code) builds the latest `main`, drives
the real app window through one area of [areas.md](areas.md) per round and files findings. Three fix
lanes (omp) each take one finding, fix it with a test, and merge a PR per fix to `main` once its
tests and CI pass. The lanes' instructions are [QA.md](QA.md) and [FIX.md](FIX.md).

The findings queue is `scripts/qa-loop/findings.ts`. Its state lives in
`<git common dir>/qa-loop/`, shared by every worktree and never committed:

- `findings.json`: every finding with its status, lane and outcome (the PR, or why it is blocked).
- `config.json`: `{"deadline": "<ISO time>"}`. Every loop's done-check is `findings.ts deadline`.
- `evidence/`: screenshots the QA lane cites. `qa-log.md`: one entry per QA round.

## Operating it

- `bun scripts/qa-loop/findings.ts status` shows counts and who holds what.
- Blocked findings carry the question or reason in `outcome`; they wait for a person.
- To stop early, move the deadline into the past or stop the loops with `orca loop stop <id>`.
