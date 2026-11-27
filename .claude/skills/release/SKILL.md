---
name: release
description: Use when cutting a release of zpyoung/quirky, when a release failed or is stuck as a draft, or when asked to update CHANGELOG.md. Writes the changelog entry, picks the next semver version, dispatches release-cut.yml, and watches the build until the release is published, recovering the failures it can. Triggers on "cut a release", "release failed", "get the release out", "update the changelog", "ship a build".
---

# Releasing Quirky

Releases publish to `zpyoung/quirky`. This skill writes the changelog, dispatches the release
pipeline, and stays with the build until the GitHub release is published. A dispatched cut is not a
release: the tag and changelog land minutes in, while signing, notarization, and publishing take
over an hour and can fail on their own, leaving a draft no client ever sees. It does **not** run
typecheck, lint or tests, because CI owns verification.

Arguments: `--yes` skips the confirmation prompt and every other question (for unattended
automation runs). Where an unattended run would need a person, it stops and reports "needs
attention" instead.

## Versions

Versions are plain semver starting at `2.0.0`. Prereleases are `X.Y.Z-rc.N`, counting up from
`rc.0`, and the stable release drops the suffix: `2.0.0-rc.0`, `2.0.0-rc.1`, `2.0.0`, then
`2.0.1-rc.0`. The tag is `v` plus the version.

## 1. Check preconditions

Stop and report if any fail. Do not write anything until every one of them passes.

```sh
git status --porcelain                 # must be empty
git fetch origin main
git rev-list --count origin/main..HEAD # must be: 0  (nothing unpushed)
git rev-list --count HEAD..origin/main # must be: 0  (nothing unpulled)
```

**Both** counts are required. `origin/main..HEAD` alone is also `0` when local `HEAD` is _behind_
`origin/main`, which would let the skill commit against stale state and then fail the push as
non-fast-forward.

What this skill needs is a clean checkout whose content **is** `origin/main`. The two counts prove
exactly that, and they hold on a detached `HEAD` as readily as on the branch, so do not additionally
require `HEAD` to be the branch `main`.

## 2. Find the previous release and the commits since

```sh
LAST_PUBLISHED_TAG=$(gh release list --repo zpyoung/quirky --exclude-drafts --limit 1 --json tagName --jq '.[0].tagName')
git log --no-merges --format='%H%x09%an%x09%s' "$LAST_PUBLISHED_TAG"..HEAD
```

No release yet means this is the first cut: use every commit on `main` and version `2.0.0-rc.0`.

Exclude two classes from the range:

- **Bot-authored commits**: any author containing `[bot]`. Drops the recurring
  `Update README downloads badge` commit and release-cut's own version-bump commit.
- **The skill's own changelog commits**: subject starting `docs(changelog): release`.

What remains is the set of commits needing changelog entries.

## 3. Decide whether there is anything to release

### First, check that the previous release actually shipped

A cut whose build failed looks released to the range check, and every later run would report
"nothing to release" while the newest release sits as a draft with no assets. Check the newest
changelog section's tag before anything else:

```sh
PREV_TAG=v$(grep -m1 -oE '^## \[[^]]+\]' CHANGELOG.md | sed -E 's/^## \[(.*)\]$/\1/')
PREV_SHA=$(git log -1 --format=%H -F --grep="docs(changelog): release ${PREV_TAG}" HEAD)
gh release view "$PREV_TAG" --repo zpyoung/quirky --json isDraft,assets \
  --jq '{isDraft, assets: [.assets[].name]}'
gh run list --repo zpyoung/quirky --workflow=release-cut.yml --commit "$PREV_SHA" \
  --json databaseId,status,conclusion,createdAt,url --limit 1
```

A release-cut run's head SHA is the changelog commit it was dispatched on, which is why `--commit`
finds it.

- **Published** (`isDraft` false, assets present): carry on below.
- **Run still in progress**: do not cut. Go to Step 7 and watch that run instead.
- **No run, and no tag**: "changelog pushed, dispatch never ran" (see _Recovering from a partial
  failure_). Re-dispatch the same version, then go to Step 7.
- **Run failed**: classify its failure with Step 7's table, then:
  - If the range check below finds something new to release, cut normally. The new cut supersedes
    the draft, and Step 5 carries the draft's entries forward.
  - Otherwise, for a **transient** or **account-side** cause, re-run the failed jobs
    (`gh run rerun "$RUN_ID" --repo zpyoung/quirky --failed`) and go to Step 7. GitHub refuses
    re-runs of runs older than 30 days; recut instead.
  - Otherwise, for a **repo defect**, apply Step 7's fix flow if `origin/main` doesn't already
    carry a fix, then recut with the next rc number. A re-run would replay the broken workflow,
    because re-runs use the run's original commit.

Only the newest section matters. Older drafts are already superseded; leave them alone.

### Then, check for new content

Release if there is at least one non-bot commit in the range. Otherwise, with the previous release
published, report "nothing to release" and stop.

## 4. Compute the version

`VERSION` is the next semver after the newest published release (`LAST_PUBLISHED_TAG` without its `v`):

- Previous is `X.Y.Z-rc.N` and you are cutting another candidate: `X.Y.Z-rc.(N+1)`.
- Previous is `X.Y.Z-rc.N` and the candidate is good: `X.Y.Z`.
- Previous is stable `X.Y.Z`: `X.Y.(Z+1)-rc.0`, or `X.(Y+1).0-rc.0` / `(X+1).0.0-rc.0` when the
  changes warrant a minor or major bump.
- First release: `2.0.0-rc.0`.

Unless `--yes` was passed or this is an approved recut (Step 6), ask which of the applicable
versions to cut. `TAG` is `v${VERSION}`.
Sanity-check it: it must sort above every published version.

## 5. Write the changelog

Prepend a new section under `# Changelog`, newest first:

```markdown
## [2.0.0-rc.0] - 2026-12-01

### Changed

- Release builds are signed, notarized, macOS-only, and auto-update from this repo.
```

- Use [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) groupings: `Added`, `Changed`,
  `Fixed`, `Removed`, `Deprecated`, `Security`.
- **Reword each commit into reader-facing prose.** Read the full commit body, because squash-merged
  PRs carry detail the subject line throws away. Do not paste subjects verbatim.
- The heading must be exactly `$VERSION`; `create-draft-release.mjs` matches on it to build the
  release body. A mismatch silently drops the section and the release ships with generated notes
  only.
- When this cut supersedes an unpublished draft (Step 3), copy the draft section's entries into the
  new one, because no client ever received them. Then add one line under the draft's own heading:
  `Not published: the build failed. Superseded by <new version>.` Leave the rest of that section as
  it was.

## 6. Confirm, commit, dispatch

Unless `--yes` was passed, show `$TAG`, the changelog diff, and the commits included, then ask for
confirmation.

**An approved recut skips this prompt.** That covers a recut after this invocation's own fix PR
merged (Step 7), when the user confirmed the original cut in this invocation and the only non-bot
commits since that cut are the fix PR. Its version is the next rc, and its changelog only carries
the draft's entries forward, so the user has already approved everything it ships. Say in the
report that you recut and why. If anything else landed on `main` in between, the recut would ship
content nobody approved, so ask as usual.

```sh
git add CHANGELOG.md
git commit -m "docs(changelog): release ${TAG}"
git push origin HEAD:refs/heads/main

gh workflow run release-cut.yml \
  --repo zpyoung/quirky \
  -f kind=rc \
  -f ref=main \
  -f version="${VERSION}"
```

Push `HEAD`, not the branch name: the refspec form is correct whether the run is on `main` or
detached at it, and it still fast-forwards `origin/main` either way. A rejected push means
`origin/main` moved mid-run, so report it and never force.

Pass `version` without the leading `v`. `kind` is a required input; it is ignored when `version` is
set, but must still be passed. Put `--repo` on every `gh` call, so a stray default repo can never
receive the dispatch.

Capture the run by the changelog commit it was dispatched on. It can take a few seconds to appear:

```sh
RELEASE_SHA=$(git rev-parse HEAD)
gh run list --repo zpyoung/quirky --workflow=release-cut.yml --commit "$RELEASE_SHA" \
  --event workflow_dispatch --json databaseId,url,status --limit 1
```

Do not take `--limit 1` without `--commit`, because another dispatch can be newer.

**`dry_run=true` cannot validate any of this.** Its `if:` condition also skips release-cut's
"Compute next version" step, so a dry run never evaluates the version gate or the tag it would cut.
There is no way to rehearse a cut; verify by reading the gate, then dispatch for real.

## 7. Watch the build until the release is published

Stay with the run. Mac signing and notarization alone take over an hour, so watch in the background
and expect to wait up to 3 hours:

```sh
gh run watch "$RUN_ID" --repo zpyoung/quirky --exit-status --compact --interval 300 \
  > "${TMPDIR:-/tmp}/release-watch-$RUN_ID.log" 2>&1; echo "exit=$?"
```

Write the output to a file and read its tail, because `gh run watch` redraws on every interval.
In Claude Code, run the command with `run_in_background` and wait for the completion notification.
Don't poll it yourself.

**On success, confirm the release is really out:**

```sh
gh release view "$TAG" --repo zpyoung/quirky --json isDraft,isPrerelease,assets \
  --jq '{isDraft, isPrerelease, assets: [.assets[].name]}'
```

It must be `isDraft: false`, with `latest-mac.yml`, an `-arm64-mac.zip`, and a macOS `.dmg` among
the assets, and `isPrerelease: true` for an `-rc.N` version. Auto-update reads `latest-mac.yml`, so
a release without it has not shipped, even when every job is green.

**On failure, find what broke:**

```sh
gh run view "$RUN_ID" --repo zpyoung/quirky --json jobs --jq '.jobs[] | select(.conclusion=="failure")
  | "\(.databaseId) \(.name) \([.steps[] | select(.conclusion=="failure") | .name] | join(","))"'
gh api "repos/zpyoung/quirky/actions/jobs/$JOB_ID/logs" | sed 's/\x1b\[[0-9;]*m//g' \
  | grep -nE '##\[error\]|Error|⨯' | head -40
```

Read the first real error, not the last. A failed job skips everything after it, so the jobs that
show as skipped never ran and say nothing about the cause. Then classify it:

| Cause            | Looks like                                                                                                                                                                                   | Action                                                                                                                                                                                                                                                           |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Transient**    | runner lost or shut down, network timeouts, 5xx from GitHub or Apple, notarytool timing out                                                                                                  | `gh run rerun "$RUN_ID" --repo zpyoung/quirky --failed`, then watch again                                                                                                                                                                                        |
| **Account-side** | notarytool `HTTP status code: 403. A required agreement is missing or has expired`, a 401 or rejected Apple ID, an expired signing certificate, a credential secret that is missing or empty | Stop with "needs attention". Name the error and what the owner must do, such as "sign the updated agreement at developer.apple.com/account". Leave the draft as it is. The next run's Step 3 re-runs it, so no recut is needed once the owner fixes the account. |
| **Repo defect**  | the same step fails the same way on a re-run: a workflow or script change that broke the build, a missing workflow input                                                                     | Fix it on `main` (below), then recut with the next rc number                                                                                                                                                                                                     |

A re-run replays the run's original commit and workflow file, so it can only clear transient or
account-side causes. If the rerun fails the same way, treat the cause as a repo defect.

**Fixing a repo defect.** The fix goes through a PR, never a direct push:

1. Branch from `origin/main` as `release-fix/<tag>` and make the smallest change that makes the
   failing step pass. The cause is almost always in the release workflows or
   `config/scripts/release-*`.
2. Never weaken a gate to get through: no skipped signing, notarization, or verification step, no
   loosened version gate, no `continue-on-error`. Never put a real credential in a file.
3. Open the PR with `env -u GITHUB_TOKEN gh pr create --repo zpyoung/quirky` and a body following
   `.github/pull_request_template.md`. Wait for its checks in the background, then merge with
   `env -u GITHUB_TOKEN gh pr merge <n> --repo zpyoung/quirky --squash`. PR CI never runs the
   release workflows, so green checks prove only that nothing else broke, and the recut is the real
   test.
4. Detach onto the new `origin/main`, then go back to Step 2 and recut. Step 3 finds the failed
   draft, and Step 5 carries its entries forward. When only the fix PR landed since the original
   cut, this is an approved recut: dispatch it without asking (Step 6).

If the fix needs a judgement call, or a change outside the release pipeline, or if its PR doesn't
go green within 2 hours, leave the PR open and report "needs attention".

**Limits per invocation:** at most one re-run per cut, one fix PR, and two cuts in total, the
original and one recut. When a limit is hit, stop and report "needs attention" with the run URL
and the classified cause. Never loop on recuts.

## 8. Report

State the outcome first: `published <TAG>` with the release URL, or `needs attention` with the
cause, its classification, and what a person must do. Then list the version cut, the commits
included, every run URL, any re-run or recut and its reason, and any fix PR.

## Recovering from a partial failure

The changelog commit lands before the dispatch, so the two can disagree. Diagnose by comparing
`CHANGELOG.md`'s newest section against the tags that actually exist.

**Changelog pushed, dispatch never ran** (`gh workflow run` failed, or you declined at the prompt).
Re-dispatch the _same_ `VERSION` by hand. The changelog section is still correct and `$TAG` does not
exist yet. Do not write a second changelog section.

**Tag created, build failed with an incomplete draft.** Step 3 finds it and Step 7 decides between a
re-run of the failed jobs and a recut. Never reuse the tag for a fresh dispatch. A recut advances
the rc number (`2.0.0-rc.0` to `2.0.0-rc.1`) and adds a new changelog section for the new tag.

**Never delete a published tag or release to retry.** Clients may already have installed it.

## Notes

- A release with no signed macOS artifacts is useless for auto-update, which is why this skill
  dispatches `release-cut.yml` rather than calling `gh release create` directly.
- Never rewrite `main`'s history; the changelog commits and tags depend on it staying put.
