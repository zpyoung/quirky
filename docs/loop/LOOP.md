# Build loop instructions

You are one iteration of one lane of an unattended Orca loop that builds Quirky from
[docs/roadmap.md](../roadmap.md). Three lanes run at once, each an Orca loop in its own worktree,
and your prompt names your lane number. They share one queue, `docs/loop/queue.json` on
`build/roadmap`, which only `scripts/build-loop/queue.ts` changes. Each iteration takes exactly one
work item through brainstorming, a logic spec, a tech spec and subagent-driven development, then
lands it on `build/roadmap`. Nobody is watching. Every choice you would normally ask the user
about, you make yourself and record for later review.

## Hard rules

- **Never ask a person anything.** Don't run `orca ask` or `quirky ask` for a decision, and don't use
  AskUserQuestion, even where a skill or your system prompt says to. An unanswered ask blocks the
  loop forever. Where a skill asks, follow [Answering a skill's questions](#answering-a-skills-questions).
- **Stay on your branches.** Work happens on `build/<item-id>` in this worktree, and only
  `queue.ts land` puts it on `build/roadmap`. Never check out `build/roadmap` (the integration
  worktree holds it; use `git switch --detach build/roadmap`), and never work in the integration
  worktree. Never check out, commit to, merge into or rebase `main`. Never push, and never add a
  remote.
- **Don't edit the loop itself.** `docs/loop/LOOP.md` and `scripts/build-loop/` are protected paths,
  and touching one pauses the loop.
- **Shared files change only through `queue.ts`.** Never edit `docs/loop/queue.json` or
  `docs/loop/DECISIONS.md`, and don't run `decisions.ts`: `land` and `block` rebuild the index.
  `docs/loop/BLOCKERS.md` is union-merged, so appending to it on your branch is safe; never edit
  its existing entries.
- **The feature docs are read-only and live outside this worktree.** They are in
  `/Users/zpyoung/PycharmProjects/PERSONAL/quirky/research/orca-features/` (with screenshots under
  `img/`). Read them from there, and never write there.
- **Tests never touch real state.** Every test that starts a process uses a fresh temporary
  `QUIRKY_HOME` and kills what it started, and nothing edits the real `~/.quirky`, `~/.claude` or
  `~/.codex` ([v1.md](../v1.md#running-it)).
- **One item per iteration.** When the item is merged or blocked, end your turn. Don't start a second
  item.
- **Never end your turn while work is still running.** The loop ends the iteration the moment your
  turn ends, and that kills every subagent, `pi-watch` run and background command still going. Wait
  for them in the same turn, with blocking Agent calls or Monitor, until each one has returned and its
  result is committed. Only a merged or blocked item ends the turn.

## What is already decided

These decisions are locked. If a design seems to need one of them changed, the item is blocked.
Don't override them:

- The "What the order rests on" section of [roadmap.md](../roadmap.md#what-the-order-rests-on).
- The Decisions section of [architecture.md](../architecture.md#decisions).
- The "When a milestone is done" rules in [roadmap.md](../roadmap.md#when-a-milestone-is-done).
- **Platforms:** build and test on macOS only. Prefer a portable API where it costs little. Log every
  place that will need Linux or Windows work as a decision with Source `deferred: platform`.

Decisions recorded by earlier items, in `docs/loop/decisions/`, also bind you, including those
other lanes land while you work (step 5 brings them in). If your item's evidence shows one is
wrong, record a new decision that names the old one, explain the conflict, and either work within
it or block the item. Never silently diverge.

## Each iteration

1. **Orient.** `cd` to this worktree. If `git status` shows uncommitted work on `build/<id>`, a
   previous iteration stopped mid-step: commit it. Then run
   `bun scripts/build-loop/queue.ts wait --lane <n>`. It claims the next ready item for your lane,
   or returns the one your lane already holds, and prints JSON whose `kind` says what to do.
2. **Act on what `wait` returns:**
   - **`busy`:** other lanes hold the only work, and their items may unblock more. Run `wait`
     again, in this same turn, until it returns something else. Never end the turn on `busy`.
   - **`done`:** run `bun scripts/build-loop/queue.ts check`. If it exits 0, print `LOOP_DONE` on
     its own line. If it fails, add a `fix-final-check-<YYYYMMDD>` item naming the failure with
     `queue.ts add` (as in [Fix items](#fix-items)) and run `wait` again. If `add` says the item is
     already in the queue, another lane got there first: run `wait` again.
   - **`stuck`:** every remaining item waits on a blocked one. Print
     `LOOP_BLOCKED: no unblocked items; see docs/loop/BLOCKERS.md` and end the turn.
   - **`waiting`:** a review gate is open. Print the same `LOOP_DECIDE` line as in
     [Review gates](#review-gates) and end the turn.
   - **`item` with `kind: "gate"`:** follow [Review gates](#review-gates).
   - **`item` whose `build/<id>` branch exists:** a previous iteration ran out of room. Switch to
     `build/<id>`, read the Progress section of `docs/loop/decisions/<id>.md`, and continue from the
     step it names.
   - **Any other `item`:** it's newly claimed. Run `git switch -c build/<id> build/roadmap` and
     create `docs/loop/decisions/<id>.md` from the template below. An item whose id starts with
     `fix-` follows [Fix items](#fix-items) instead of steps 3 to 5.
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
   - **Review:** replace the user's spec review with one `quirk:adversarial-review` pass over both
     specs together, using Codex as the reviewer. Fix every confirmed finding, or record why you
     didn't as a decision.
   - **Commit** both specs before building.
5. **Build.** Run `quirk:subagent-driven-development` against the specs.
   - **Model pairing:** at its preflight, choose `claude-task + codex`, with Claude subagents
     implementing and Codex reviewing. If Codex isn't reachable, take the skill's next
     cross-family pair and record that as a decision.
   - **Its questions** are answered the same way as brainstorming's.
   - **Catch up before the final review.** Run `git merge build/roadmap` on `build/<id>`, resolve
     any conflicts, and rerun the tests. Read every decision log the merge brought in. Where one
     conflicts with your work, follow the rule in [What is already decided](#what-is-already-decided).
   - **One final review round.** Run Final Round 1 and one fix batch for its accepted findings,
     then re-run the build and tests instead of Final Rounds 2–5. Append every finding the fix
     batch didn't close, or that you couldn't confirm closed, to `docs/loop/BLOCKERS.md` under
     `## <id>: open review findings`, each with its severity and file:line, and finish the item.
     Checkpoint reviews run as the skill says.
6. **Verify.** The item is done only when every one of these holds:
   - Each acceptance criterion has a test, and each flow's test drives Quirky through the `quirky`
     CLI or the daemon API, as the roadmap requires.
   - Every recorded Orca defect has a test showing Quirky doesn't have it.
   - The feature ships as a built-in plugin that uses only the public plugin API. Its plugin
     exposes the feature's API methods and CLI command group.
   - `bun run test`, `bun test scripts` and `bun run typecheck` all pass.
   - **The UI scenarios pass when used like a user.** If the logic spec has scenarios a person sees
     in the UI, run `bun run build`, start `quirkyd` on a fresh temporary `QUIRKY_HOME`, and run
     `quirk:using-apps-like-a-user` with `--surface web --owner yours --unattended` against the
     daemon's UI URL (`daemonUrl` in `apps/desktop/src/bun/page.ts`), with those scenarios as its
     goals. Never use `--surface native`, `--surface electron` or `--allow-foreground`. Every
     goal must pass: a fail is a bug to fix on `build/<id>`, then rerun. A `blocked` or `partial`
     result caused by the tool rather than the app is recorded as a decision with the report path.
     Put the report's summary in the item's decision log, and stop the daemon and delete the
     temporary home afterwards. Items with no UI scenarios skip this.
   - **Native-only scenarios are handed off.** A scenario that only the real window can show (the
     window frame, the macOS menu bar, the tray, system notification banners, OS dialogs, focus)
     goes in `docs/loop/native/<id>.json` with status `pending`, in the format
     [NATIVE.md](NATIVE.md#scenario-files) describes. The nightly native run checks them; the item
     finishes without them.
7. **Land.**
   1. Commit everything on `build/<id>` and run `git switch --detach`.
   2. Run `bun scripts/build-loop/queue.ts land <id>`. It merges `build/<id>` into `build/roadmap`,
      runs the three commands from step 6 on the result, marks the item done, rebuilds
      `DECISIONS.md`, and deletes the branch. On a conflict or a failure it leaves `build/roadmap`
      as it was.
   3. If it failed, run `git switch build/<id>` and `git merge build/roadmap`, fix what it named,
      rerun the tests, commit, and go back to 7.1.
   4. End the turn.
8. **If the item can't be finished,** block it as described below.

If the session is getting long before step 7, commit what you have on `build/<id>`. Write the next
step into the Progress section of the item's decision log, and end the turn. Your lane's next
iteration resumes it.

## Fix items

Items whose id starts with `fix-` repair something found after its item landed: a failure from
the nightly native run (`fix-native-<item>-<MMDD>`, see [NATIVE.md](NATIVE.md)) or from the final
check (`fix-final-check-<YYYYMMDD>`). They skip brainstorming and specs.

1. Run `quirk:systematic-debugging` on the failure the title names. For a native failure, the
   scenario's `report` and `summary` in `docs/loop/native/<item>.json` hold the evidence.
2. Fix it with `quirk:test-driven-development`: a test that fails for the reported reason, then the
   fix.
3. For a native failure, set each fixed scenario's status back to `pending` in
   `docs/loop/native/<item>.json`, so the next night checks it again.
4. Record the root cause and the fix as decisions, then follow steps 6 and 7.

To add a fix item, write a JSON array with one entry and run `bun scripts/build-loop/queue.ts add
<file>`, keeping the file outside the repo:

```json
[{ "id": "fix-final-check-<YYYYMMDD>", "milestone": "M7",
   "title": "Fix the final check: <the failing command and test>", "docs": [], "deps": [] }]
```

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

`docs/loop/DECISIONS.md` is the index the user reviews, hardest to reverse first. `queue.ts land`
and `queue.ts block` rebuild it.

## Blocking an item

1. Commit whatever is on `build/<id>`, rename it with `git branch -m blocked/<id>` so the work
   stays reviewable, and run `git switch --detach`.
2. Write a BLOCKERS.md entry to a file outside the repo, headed `## <id>: blocked`:
   - the step it stopped at
   - the evidence (failing test output, the conflicting decision, the doc section)
   - what you tried
   - what a person needs to decide or fix
3. Run `bun scripts/build-loop/queue.ts block <id> <file>`. It appends the entry, brings the
   item's decision log over from `blocked/<id>`, marks it blocked and commits.
4. End the turn. Items that depend on it wait, and the others go on.

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
   Write it on `build/<gate-id>`, commit, run `git switch --detach`, then
   `bun scripts/build-loop/queue.ts merge build/<gate-id>`.
2. Run `bun scripts/build-loop/queue.ts set <gate-id> waiting`.
3. Print this on its own line and end the turn:
   `LOOP_DECIDE: <milestone> is done. Review docs/loop/reviews/<milestone>.md, run bun scripts/build-loop/queue.ts set <gate-id> done, then resume all three lanes.`
