# Build loop instructions

You are one iteration of an unattended Orca loop that builds Quirky from
[docs/roadmap.md](../roadmap.md). Each iteration takes exactly one work item from
`docs/loop/queue.json` through brainstorming, a logic spec, a tech spec and subagent-driven
development, then merges it into `build/roadmap`. Nobody is watching. Every choice you would
normally ask the user about, you make yourself and record for later review.

## Hard rules

- **Never ask a person anything.** Don't run `orca ask` or `quirky ask` for a decision, and don't use
  AskUserQuestion, even where a skill or your system prompt says to. An unanswered ask blocks the
  loop forever. Where a skill asks, follow [Answering a skill's questions](#answering-a-skills-questions).
- **Stay on your branches.** Work happens on `build/<item-id>` and merges into `build/roadmap`. Never
  check out, commit to, merge into or rebase `main`. Never push, and never add a remote.
- **Don't edit the loop itself.** `docs/loop/LOOP.md` and `scripts/build-loop/` are protected paths,
  and touching one pauses the loop. Change `docs/loop/queue.json` only through `queue.ts set`.
- **The feature docs are read-only and live outside this worktree.** They are in
  `/Users/zpyoung/PycharmProjects/PERSONAL/quirky/research/orca-features/` (with screenshots under
  `img/`). Read them from there, and never write there.
- **Tests never touch real state.** Every test that starts a process uses a fresh temporary
  `QUIRKY_HOME` and kills what it started, and nothing edits the real `~/.quirky`, `~/.claude` or
  `~/.codex` ([v1.md](../v1.md#running-it)).
- **One item per iteration.** When the item is merged or blocked, end your turn. Don't start a second
  item.

## What is already decided

These decisions are locked. If a design seems to need one of them changed, the item is blocked.
Don't override them:

- The "What the order rests on" section of [roadmap.md](../roadmap.md#what-the-order-rests-on).
- The Decisions section of [architecture.md](../architecture.md#decisions).
- The "When a milestone is done" rules in [roadmap.md](../roadmap.md#when-a-milestone-is-done).
- **Platforms:** build and test on macOS only. Prefer a portable API where it costs little. Log every
  place that will need Linux or Windows work as a decision with Source `deferred: platform`.

Decisions recorded by earlier items, in `docs/loop/decisions/`, also bind you. If your item's
evidence shows one is wrong, record a new decision that names the old one, explain the conflict,
and either work within it or block the item. Never silently diverge.

## Each iteration

1. **Orient.** `cd` to this worktree and confirm `git status` is clean on `build/roadmap`, or on
   `build/<id>` for an item in progress. If the only change is `docs/loop/queue.json` marking a
   gate `done`, the user approved a review: commit it as `chore(build): approve <gate-id>`. Then run
   `bun scripts/build-loop/queue.ts next`.
2. **Act on what `next` returns:**
   - **`done`:** run `bun scripts/build-loop/queue.ts check`. If it exits 0, print `LOOP_DONE` on
     its own line. If it fails, fix the failure on a `build/fix-<topic>` branch, merge it, and end
     the turn.
   - **`stuck`:** every remaining item waits on a blocked one. Print
     `LOOP_BLOCKED: no unblocked items; see docs/loop/BLOCKERS.md` and end the turn.
   - **`waiting`:** a review gate is open. Print the same `LOOP_DECIDE` line as in
     [Review gates](#review-gates) and end the turn.
   - **`item` with `kind: "gate"`:** follow [Review gates](#review-gates).
   - **`item` with status `in-progress`:** a previous iteration ran out of room. Switch to
     `build/<id>`, read the Progress section of `docs/loop/decisions/<id>.md`, and continue from the
     step it names.
   - **`item` with status `todo`:** run `bun scripts/build-loop/queue.ts set <id> in-progress`,
     commit that on `build/roadmap` as `chore(build): start <id>`, then `git switch -c build/<id>`.
     Create `docs/loop/decisions/<id>.md` from the template below.
3. **Brainstorm.** Run the `quirk:brainstorming` skill on the item, answering its questions as
   described below. Its inputs are:
   - The item's `title`.
   - Its section in [roadmap.md](../roadmap.md).
   - Every feature doc listed in its `docs` field.
   - The current code.

   For an item that covers only one slice of a feature, the doc's other flows are out of scope.
   Name them in the spec's non-goals.
4. **Write the specs.** Write a markdown logic spec to `docs/quirk/specs/<YYYY-MM-DD>-<id>/logic.md`,
   then always a tech spec beside it as `tech.md`, both following `quirk:writing-specs`.
   - **Acceptance criteria:** the logic spec lists each in-scope flow from the feature docs.
   - **Defects:** it also lists each Orca defect those docs record, as a test showing Quirky doesn't
     have it.
   - **Review:** replace the user's spec review with `quirk:adversarial-review` on each spec, using
     Codex as the reviewer. Fix every confirmed finding, or record why you didn't as a decision.
   - **Commit** both specs before building.
5. **Build.** Run `quirk:subagent-driven-development` against the specs.
   - **Model pairing:** at its preflight, choose `claude-task + codex`, with Claude subagents
     implementing and Codex reviewing. If Codex isn't reachable, take the skill's next
     cross-family pair and record that as a decision.
   - **Its questions** are answered the same way as brainstorming's.
6. **Verify.** The item is done only when every one of these holds:
   - Each acceptance criterion has a test, and each flow's test drives Quirky through the `quirky`
     CLI or the daemon API, as the roadmap requires.
   - Every recorded Orca defect has a test showing Quirky doesn't have it.
   - The feature ships as a built-in plugin that uses only the public plugin API. Its plugin
     exposes the feature's API methods and CLI command group.
   - `bun run test`, `bun test scripts` and `bun run typecheck` all pass.
7. **Merge.**
   1. Run `git switch build/roadmap` and `git merge --no-ff build/<id>`.
   2. Run the three commands from step 6 again on the merge result.
   3. Run `bun scripts/build-loop/queue.ts set <id> done` and `bun scripts/build-loop/decisions.ts`.
   4. Commit as `chore(build): finish <id>`.
   5. Delete `build/<id>` and end the turn.
8. **If the item can't be finished,** block it as described below.

If the session is getting long before step 7, commit what you have on `build/<id>`. Write the next
step into the Progress section of the item's decision log, and end the turn. The next iteration
resumes it.

## Answering a skill's questions

Wherever brainstorming, the spec rubrics or subagent-driven development would ask the user, answer
the question yourself and record the answer as a decision:

- **Pick the option the skill or your own analysis marks Recommended.** For brainstorming, treat
  the user as having elected to accept stated defaults, the skill's fast-track. Still work through
  every question it would have asked, so nothing goes unconsidered.
- **Gray areas:** select every area that matters for this item. Without a human, thoroughness is
  cheaper than a missed ambiguity.
- **Skip the parts that assume a person is there:**
  - Skip the visual companion offer.
  - Skip the adhd offer and use the standard set of gray areas.
  - Write markdown specs, not interactive ones.
  - Don't wait after presenting a design section. Self-review it, record it, and go on.
- **Research swarms are pre-authorized.** Run them as the skill says.
- **Use the source of truth to settle questions:**
  - A question the feature docs answer: what the doc says Orca does is the requirement, minus its
    listed defects.
  - A question the locked decisions answer: follow them.
  - Record either one with Source `locked by <file>`.
- **When a rubric says a headless run must halt** (for example, the tech spec's feasibility
  escalation against a locked decision), block the item.

Every answer gets an entry in the item's decision log, including the obvious ones. The reviewer
decides what was obvious.

## Decision log

`docs/loop/decisions/<id>.md` holds every decision for the item, numbered `D1`, `D2` and so on, in
this format:

```markdown
# <id> decisions

## D1: <the decision, as a short statement>
- **Question:** what had to be decided, and where it came up (skill and step)
- **Options:** each option considered, one clause each
- **Chose:** the option taken
- **Why:** the reason, citing evidence
- **Evidence:** file:line, a feature-doc section, or research URLs
- **Reversibility:** hard | medium | easy (how much later work would have to change)
- **Confidence:** high | medium | low
- **Revisit if:** what would show this choice was wrong
- **Source:** assumed — autonomous | locked by <file> | deferred: platform | supersedes <item> D<n>

## Progress
<the step this item has reached, and what the next iteration should do if this one stops early>
```

`bun scripts/build-loop/decisions.ts` rebuilds `docs/loop/DECISIONS.md`, the index the user reviews,
hardest to reverse first. Run it before every merge or block commit.

## Blocking an item

1. Commit whatever is on `build/<id>` and rename it `blocked/<id>`, so the work stays reviewable.
2. Switch to `build/roadmap`.
3. Append an entry to `docs/loop/BLOCKERS.md`:
   - the item id
   - the step it stopped at
   - the evidence (failing test output, the conflicting decision, the doc section)
   - what you tried
   - what a person needs to decide or fix
4. Run `bun scripts/build-loop/queue.ts set <id> blocked` and `bun scripts/build-loop/decisions.ts`.
5. Commit as `chore(build): block <id>` and end the turn. Items that depend on it wait, and the
   others go on.

## Review gates

A gate item marks a milestone boundary where the user wants to review before the loop goes on.

1. Write `docs/loop/reviews/<milestone>.md`:
   - **What was built:** one line per item, linking its specs.
   - **What to look at first:** the ten decisions from `docs/loop/DECISIONS.md` most worth that
     review.
   - **Blockers:** every open entry from `docs/loop/BLOCKERS.md`.
   - **Memory:** the result of the memory probe at the typical-day workload, if
     `/Users/zpyoung/PycharmProjects/PERSONAL/quirky/research/memory-probe/measure.py` runs against
     this build. Otherwise say why it didn't run.
   - **Test results.**
2. Run `bun scripts/build-loop/queue.ts set <gate-id> waiting`, then commit.
3. Print this on its own line and end the turn:
   `LOOP_DECIDE: <milestone> is done. Review docs/loop/reviews/<milestone>.md, run bun scripts/build-loop/queue.ts set <gate-id> done, then resume the loop.`
