# Agent instructions

## Where tests run

These rules beat any spec, plan or older doc that says otherwise. Many specs under `docs/quirk/specs/` still say `bun run test`, so don't follow them on this point.

Pick the row that matches what you need:

| You need | Run | Where it runs |
| --- | --- | --- |
| The full suite | Open a PR (a draft is fine), then `gh pr edit <number> --add-label full-suite` | GitHub Actions |
| The tests your change affects | `bun run test:affected` | OVH |
| One or more directories | `bun scripts/suite.ts <dir> <dir> ...` | OVH |
| One file while you edit | `bun test <file>` | This Mac |

Files in `scripts/test-on-macos.txt` always run on this Mac alongside an OVH run.

- Never run the full suite here or on OVH. That rules out `bun run test`, `bun test` with no path, and `bun scripts/suite.ts packages apps plugins`. The one exception is the build loop's final `queue.ts check`.
- Read the result from the PR's Tests comment, or wait with `gh pr checks <number> --watch`. A full run takes about 10-30 minutes and compares against the baseline from main, so only `new` failures count against you.
- The label stays on, so every later push also runs in full. Remove it with `gh pr edit <number> --remove-label full-suite` once you have your answer.
- Run `unset GITHUB_TOKEN` before you push or label, because the shell's token can't push.
- If `test:affected` says it selected every test, nothing ran. Your change touches something the whole suite depends on, so get the full run through a PR.
- If OVH is down, stop and report it. Don't set `QUIRKY_TEST_LOCAL=1`, which moves the run onto this Mac.
