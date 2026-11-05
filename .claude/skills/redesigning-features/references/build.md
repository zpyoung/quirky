# Build

Entry: `logic.md` is approved and committed, with `## Capabilities`, `## Redesign checks` and `## Walk bugs`.

Leaves behind: the implementation on the run's branch, `tech.md` in the spec folder if SDD's gate wrote one, and SDD's final review loop exited with no blocker. The user is not asked anything in this phase unless SDD is blocked.

Next phase: after-pass.md.

## Steps

1. Invoke `quirk:subagent-driven-development` on `<spec>/logic.md` (SC-16). Pass this brief and fill in `<spec>` and `<slug>`:

   ```text
   Build the redesign specified in <spec>/logic.md on the current branch.

   Choices already made. Do not ask about them.
   - Preflight: the model pairing is claude-task + codex (Sonnet subagents
     implement, Codex reviews). Do not show the pairing card.
   - The spec format is markdown and logic.md already is. Do not ask.
   - Tests: run targeted test files only between waves (`bun test <file>` or
     `bun run test:affected`). Never run the full suite. Only the draft PR's
     full-suite label runs it (AGENTS.md).
   - Paste the "Redesign checks" section of logic.md into the spec lens's
     acceptance criteria, so the review checks the goals and the score gates.
   - Plan the after pass as part of the build: it replays goals.json with
     seed.sh and checks scores against scores/before.json.
   - Do not stop for the user unless something blocks you.
   - When the final review loop exits, stop. Do not run
     quirk:finishing-a-development-branch. The caller runs the after pass next.
   ```
2. Let SDD run its tech-spec gate, plan, waves and review loop as it does today. Do not stop to report between waves.
3. If SDD blocks and needs the user, put the question on the companion page like any other, then continue.
4. When the final loop exits, do not run `quirk:finishing-a-development-branch`. Make sure all work is committed (`git status` is clean), then go to after-pass.md.
