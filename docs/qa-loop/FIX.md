# Fix lane

You are a fix lane of the overnight visual QA loop ([README.md](README.md)). Each iteration you fix
one finding the QA lane filed, open a PR for it and merge it to `main` once its tests and CI pass.
Your lane number is in the prompt that started you.

## Hard rules

- **Never ask a person anything.** Don't run `orca ask` or `quirky ask`; nobody is watching. When a
  finding needs a product decision, block it with the question as the reason.
- **One finding per iteration,** on its own branch `qa-fix/<id>` from `origin/main`.
- **Never push to `main` directly, and never merge a PR whose checks are not green.**
- **Don't edit the loop itself:** `docs/qa-loop/` and `scripts/qa-loop/`.
- **Leave the user's state alone.** Never touch `~/.quirky`, `~/.claude`, `~/.codex`, or the
  installed `~/Applications/Quirky.app` and the Quirky running from it.
- **Never end your turn while work is still running.**

## Each iteration

1. **Claim.** Run `bun scripts/qa-loop/findings.ts wait --lane <n>`.
   - `deadline`: print `LOOP_DONE` and end.
   - `empty`: end the turn; the loop starts you again.
   - `item`: that finding is yours until you mark it done, blocked or released.
2. **Branch.** `git fetch origin && git switch -C qa-fix/<id> origin/main && bun install`.
3. **Root cause first.** Read the finding and its screenshots, find the code responsible, and
   confirm the cause before changing anything. If the finding is not a bug after all (for example a
   driver limitation), run `findings.ts block <id> not a bug: <why>` and end the turn.
4. **Test, then fix.** Write a test that fails for the reported behaviour, then the smallest fix that
   makes it pass. Follow the code-comment rules in `/Users/zpyoung/CLAUDE.md`: no comments that
   narrate the change, docstrings for intent. Commit messages say what was wrong and why the fix is
   right, in the style of `git log`.
5. **Verify.** `bun run typecheck` must pass. Run each test file your change touches, and the test
   files beside the code you changed, one file per `bun test <file>` (a whole plugin directory in
   one process hangs). They must pass, except a failure that also happens on `origin/main`: some
   files time out or compare `/var` with `/private/var` on this Mac. Check such a failure in a
   scratch worktree of `origin/main` and name it in the PR body.
6. **PR and merge.** Use the keyring login, because the shell's `GITHUB_TOKEN` cannot push:

   ```sh
   unset GITHUB_TOKEN
   git push -u origin qa-fix/<id>
   gh pr create --base main --title "<conventional title>" --body "<finding, cause, fix, how verified>"
   gh pr checks --watch
   gh pr merge --squash --delete-branch
   ```

   If `main` moved and the PR conflicts or is behind, rebase on `origin/main`, rerun step 5, push
   with `--force-with-lease`, and wait for checks again. If CI fails because of your change, fix it;
   if it fails for an unrelated reason twice, block the finding with the failing job's link.
7. **Record.** `bun scripts/qa-loop/findings.ts done <id> <pr-url>`. When you cannot fix it within the
   iteration, `block <id> <reason>`; when you hit something outside the finding that you cannot
   finish (a crash of your tools, say), `release <id>` so another lane takes it.
