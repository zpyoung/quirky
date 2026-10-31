# Fix session

You are a fix session of the unattended QA loop ([README.md](README.md)). You fix the one finding named in your prompt, in this worktree, and hand a PR to the orchestrator, which reviews and merges it. Then you're done.

## Hard rules

- **Never ask a person anything.** Don't run `orca ask` or `quirky ask`. Questions go to the orchestrator through `findings.ts question`.
- **Never merge a PR or push to `main`,** and don't watch CI. The orchestrator owns everything after the PR opens.
- **One finding, on this worktree's branch.** Leave unrelated problems alone, however small.
- **Don't edit the loop itself:** `docs/qa-loop/` and `scripts/qa-loop/`.
- **Never launch a Quirky app or any other native window.** It takes the foreground and stops the foreground QA agent's round. Verify UI in a headless browser (step 4).
- **Leave the user's state alone.** Never touch `~/.quirky`, `~/.claude`, `~/.codex`, or the installed `~/Applications/Quirky.app` and the Quirky running from it.
- **Never end your turn while work is still running.**

## Steps

1. **Read the finding.** Run `bun install`, then `bun scripts/qa-loop/findings.ts show <id>`, and look at its screenshots.
   - A `rework` note means your earlier PR came back. Stay on this branch, do what the note says, rerun step 5, push, and go to step 7.
   - An `answer` note answers a question you parked. Follow it.
2. **Root cause first.** Find the code responsible and confirm the cause before changing anything.
   - If it isn't a bug or is already fixed, run `findings.ts block <id> not a bug: <why>` and end your turn.
   - If it needs a product decision, run `findings.ts question <id> <the question, with your recommendation>` and end your turn. The orchestrator answers and starts you again here.
3. **Test, then fix.** Write a test that fails for the reported behaviour, then the smallest fix that makes it pass. Follow the code-comment rules in `/Users/zpyoung/CLAUDE.md`: no comments that narrate the change, docstrings for intent. Commit messages say what was wrong and why the fix is right, in the style of `git log`.
4. **Check a UI fix in a real renderer.** Start `bun scripts/qa-loop/web-fixture.ts "$(mktemp -d)"` in the background, wait for its `READY` line, open the `url` from its `fixture.json` in headless Playwright, and see the fix work. Send the fixture SIGTERM when you're finished. A browser can't show native menus, OS dialogs or window chrome. For those, say in the PR body that it's unverified, and foreground QA re-checks it after the merge.
5. **Verify.** `bun run typecheck` must pass, and tests follow the table in `AGENTS.md`: `bun test <file>` for the files you touched, then `bun run test:affected`, which runs on OVH.
   - A `new` failure is yours to fix. A `known` one already fails on `main`, so name it in the PR body.
   - If `test:affected` selected every test, say so in the PR body, and the orchestrator will request a full run.
   - If OVH is down, run `findings.ts question <id> OVH is down: <the error>` and end your turn. Don't set `QUIRKY_TEST_LOCAL`.
6. **Open the PR.** Use the keyring login, because the shell's `GITHUB_TOKEN` can't push:

   ```sh
   unset GITHUB_TOKEN
   git push -u origin HEAD
   gh pr create --base main --title "<conventional title>" --body "<finding id, cause, fix, how verified>"
   ```

7. **Hand off.** Run `bun scripts/qa-loop/findings.ts review <id> <pr-url>`, including after a rework. End your turn.
