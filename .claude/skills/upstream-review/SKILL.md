---
name: upstream-review
description: Use when asked to review upstream, find out what's new upstream, or run an upstream review of stablyai/orca. Lists upstream releases newer than the last reviewed one, sorts their changes into port, maybe and skip, and opens the proposal as a draft PR on zpyoung/quirky. Triggers on "review upstream", "what's new upstream", "upstream review".
---

# Upstream review

Quirky is a hard fork of `stablyai/orca`. This skill proposes which upstream changes the owner
should port. It writes a proposal and opens a draft PR. It never ports code and never pushes to
`main`.

## 1. Find the last reviewed version

Read `docs/upstream-review/last-review.md`. The version in it is the last release already reviewed.

## 2. List newer releases

```sh
gh release list -R stablyai/orca --exclude-drafts --limit 100
gh release view <tag> -R stablyai/orca
```

Keep only tags newer than the last reviewed version, oldest first. Read the notes of each. If there
are none, report "nothing new upstream" and stop.

## 3. Collect candidate changes

For each release, list every change with:

- what it fixes or adds, in one line
- its upstream PR link
- whether it touches code Quirky removed: Stably services, Windows/Linux/WSL, the hosted relay,
  Bitbucket, Gitea, Azure DevOps

A change that touches removed code is skipped, and the reason names what was removed.

## 4. Write the proposal

Create one file, `docs/upstream-review/<YYYY-MM-DD>.md`, with the range reviewed at the top and
three lists: port, maybe, skip. Each entry is one line: the change, a one-line reason, and the
upstream PR link.

Finish by setting `docs/upstream-review/last-review.md` to the newest release reviewed.

## 5. Open a draft PR

Work on a branch, never `main`. Commit the two files and open a draft PR on `zpyoung/quirky`:

```sh
gh pr create --draft -R zpyoung/quirky --title "docs(upstream-review): <first tag> to <last tag>" --body "<one paragraph: range, counts of port / maybe / skip>"
```

Merging the PR is the owner's decision. The merge is what records the new last-review version, so
do not merge it and do not edit `last-review.md` anywhere else.

## Schedule

The owner creates the weekly automation once. It is created disabled:

```sh
quirky automations create --name "Upstream review" --trigger weekly --prompt "Run the upstream-review skill" --provider claude --repo <quirky repo selector> --disabled
```

Enable it with `quirky automations edit <id> --enabled`.
