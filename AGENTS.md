# Agent instructions

## Where tests run

These rules beat any spec, plan or older doc that says otherwise. Many specs under `docs/quirk/specs/` still say `bun run test`, so don't follow them on this point.

Tests run on GitHub Actions. Push to a draft PR as often as you like: each push runs the tests your change affects and updates the PR's Tests comment, and a new push cancels the previous run.

Pick the row that matches what you need:

| You need | Run | Where it runs |
| --- | --- | --- |
| The full suite | Open a PR (a draft is fine), then `gh pr edit <number> --add-label full-suite` | GitHub Actions |
| The tests your change affects | Push to your draft PR. `bun run test:affected` lists what the push would run and why, and runs nothing | GitHub Actions |
| One file while you edit | `bun test <file>` | This Mac |

Files in `scripts/test-on-macos.txt` run in the Tests workflow's macOS job.

- Never run `bun run test`, `bun test` with no path, or `bun scripts/suite.ts <dirs>` here, because they run on this Mac. The one exception is the build loop's final `queue.ts check`.
- Read the result from the PR's Tests comment, or wait with `gh pr checks <number> --watch`. A full run takes about 10-30 minutes and compares against the baseline from main, so only `new` failures count against you.
- The label stays on, so every later push also runs in full. Remove it with `gh pr edit <number> --remove-label full-suite` once you have your answer.
- Run `unset GITHUB_TOKEN` before you push or label, because the shell's token can't push.
- If `test:affected` says the next push runs the whole suite, that's expected for changes to shared test tooling, such as `scripts/suite.ts`.
- Draft PRs skip the macOS app build (`Build and release`) until you mark them ready.
- If GitHub Actions isn't running jobs, stop and report it. Don't fall back to running suites on this Mac.
