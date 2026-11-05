# After pass and PR

Entry: SDD's final review loop has exited on the run's branch, with all work committed. The spec folder holds `goals.json`, `seed.sh`, `scores/before.json`, `current-state.md` and `logic.md`.

Leaves behind: `img/after/`, `scores/after.json`, `comparison-data.json` and `comparison.md`, committed, plus a pushed branch, a draft PR with the `full-suite` label, and a stopped companion.

This is the last phase. Report the PR link and stop.

## Notation

`<spec>`, `<scratch>` and `likeuser.py` are as in before-pass.md. `<plugins>` is every plugin id scored in the before pass.

## Steps

1. Replay the goals (SC-17). Build and start a fresh fixture from the branch with the same options as the before pass:

   ```bash
   bun scripts/redesign/fixture.ts start <scratch>/fixture-after --theme dark --open <contribution-id>
   bun scripts/redesign/fixture.ts seed <scratch>/fixture-after <spec>/seed.sh
   ```

   Use the same `--open` ids as before, or their replacements if `logic.md` moved a tool. Replay with likeuser at the same size and theme:

   ```bash
   likeuser.py begin --target <url> --surface web --owner yours --unattended --goals-file <replay-goals.json>
   ```

   As in the before pass, the first action after `begin` is to select the worktree the seed prepared (`ui-review-ready` unless `seed.sh` works in another one) in the Worktrees tool, proven with `act`, before any goal, so the replay starts where the before walk did. Save screenshots to `<spec>/img/after/NN-slug.png`, reusing each goal's before filename so the pairs line up. A goal passes only when likeuser shows its effect happened (`act` returned `OBSERVED` and the screenshot shows the result), never on how the screenshot looks.
2. Skip cut goals (SC-18). A goal that `logic.md`'s Redesign checks marks as removed is not walked. Leave it out of `<replay-goals.json>` and record it as `cut` with the spec's reason.
3. Stop the fixture: `bun scripts/redesign/fixture.ts stop <scratch>/fixture-after`.
4. Score and gate (SC-19). Names of removed surfaces come from `logic.md` Capabilities and Redesign checks:

   ```bash
   bun scripts/redesign/score.ts run --plugin <id> --plugin <also-id> --out <scratch>/after
   mkdir -p <spec>/scores && cp <scratch>/after/scores.json <spec>/scores/after.json
   bun scripts/redesign/score.ts gate --before <spec>/scores/before.json --after <spec>/scores/after.json --removed <surface-id>
   ```

   Pass one `--removed` per removed surface. `gate` exits 1 when a surface fails: keep its `GateReport` JSON for step 7.
5. Real-app goals (SC-20). If no goal is tagged `real-app`, skip this step. Otherwise show one screen. It lists the goals and warns that running the branch replaces the daemon of the user's Quirky with the branch's until Quirky is restarted from main.

   ```json
   {
     "title": "Real app replay",
     "question": "Replay the real-app goals by running this branch against your real data?",
     "select": "single",
     "options": [
       { "id": "yes", "label": "Yes, run the branch", "description": "bun run dev replaces your Quirky's daemon with the branch's until you quit it and relaunch Quirky" },
       { "id": "no", "label": "No, list them as not replayed", "description": "They go in the PR with the reason: declined" }
     ],
     "content": "<ul><li>Send review notes to an agent and see its reply</li></ul>"
   }
   ```

   - If the user says no, record each goal as `not-replayed` with reason `declined`.
   - If yes, run `which hutch` first. `bun run dev` spawns `hutch electrobun dev` and throws ENOENT without it. If `hutch` is missing, do not try to install it: record each goal as `not-replayed` with reason `hutch executable missing`.
   - If `hutch` exists, run `bun run dev` in the background and replay the goals in that window with a `--surface electron` or `--surface native` likeuser run, as the likeuser skill's router says.
   - If `bun run dev` exits early, or no dev window appears within 5 minutes, stop the dev process and record each real-app goal as `not-replayed` with the launch failure as the reason, quoting the last lines of its output. Tell the user how to get their Quirky back (below) and continue to the PR.
   - Afterwards, tell the user how to get their Quirky back: quit the dev shell, then relaunch `~/Applications/Quirky.app` from main so its own daemon starts again.
6. Fix rounds (SC-21). If the gate or a goal failed, send the failure through the build pairing: follow build.md's brief with the failing rows, goals and reasons as the work, and targeted tests only. Then redo steps 1 to 4, and re-check both gates in full: the score gate, the fixture replay and, when the user agreed to the real-app replay in step 5, the real-app replay too. Do not ask again, because the go-ahead covers the whole pass. If the user declined, the real-app goals stay `not-replayed` with reason `declined`. Do this at most twice. After the second round, move on whatever the result.
7. Write `<spec>/comparison-data.json` (SC-22), shaped as `ComparisonData`:

   ```json
   {
     "feature": "Changes",
     "failures": ["Review tab: light 84 below 85"],
     "goals": [
       { "id": "g1", "title": "Stage two files and commit them", "tag": "fixture",
         "before": "img/current/05-commit.png", "after": "img/after/05-commit.png", "result": "replayed" },
       { "id": "g4", "title": "Change the base ref", "tag": "fixture",
         "before": "img/current/11-base.png", "after": null, "result": "cut", "reason": "always merge base" }
     ],
     "gate": { "passed": false, "floor": 85, "rows": [] },
     "capabilities": [
       { "name": "Stage file", "decision": "kept" },
       { "name": "Discard file", "decision": "moved", "where": "the row context menu" },
       { "name": "Change base ref", "decision": "cut", "reason": "always merge base" }
     ]
   }
   ```

   `gate` is the whole JSON printed by the last `score.ts gate`. `failures` has one line per failed gate row and per failed goal, empty when nothing fails. `result` is `replayed`, `failed`, `cut` or `not-replayed`, and every result but `replayed` needs a `reason`. Then render the page:

   ```bash
   bun scripts/redesign/comparison.ts <spec> <spec>/comparison-data.json
   ```

   Exit 2 names the first bad field: fix and rerun.
8. Commit, push and open the PR (SC-23):

   ```bash
   git add <spec> && git commit -m "docs(redesign): <slug> comparison"
   unset GITHUB_TOKEN
   git push -u origin HEAD
   gh pr create --draft --title "<feature> redesign" --body-file <scratch>/pr-body.md
   gh pr edit <n> --add-label full-suite
   ```

   The label starts the full test suite on GitHub. Do not run the suite yourself.
9. Write the description in `<scratch>/pr-body.md` before `gh pr create`. Link `<spec>/comparison.md` and `<spec>/logic.md` with full GitHub URLs on the branch.
   - If anything still fails, the failures come first, before any summary: one line per failed gate row or goal, then the links.
   - If nothing fails, open with a two-sentence summary, then the links.
10. Stop the companion: `bun scripts/redesign/companion.ts stop .quirk/brainstorm/<slug>-redesign/`.
11. Report the PR link to the user, say whether anything is still failing, and stop. The user merges.
