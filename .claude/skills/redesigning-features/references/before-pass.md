# Before pass

Entry: the feature is resolved to plugins and surfaces (`pluginId` plus `alsoPlugins`), the companion is running, and the spec folder is empty or was cleared.

Leaves behind, all committed on the run's branch: `goals.json`, `seed.sh`, `current-state.md`, `img/current/NN-slug.png`, `scores/before.json`. The fixture is stopped and deleted.

Next phase: brainstorm.md.

## Notation

- `<spec>` is the spec folder from `spec-folder.ts`.
- `<scratch>` is `$TMPDIR/redesign-<slug>`. ui:review's raw output and the fixture's output live here and never go in the repo.
- `likeuser.py` is the quirk plugin's driver. Find it from the companion path: run `bun scripts/redesign/companion.ts locate`, then replace `writing-html-artifacts/scripts/companion.py` in the printed path with `using-apps-like-a-user/scripts/likeuser.py`. Run it with `python3`. Read the likeuser skill (`quirk:using-apps-like-a-user`) if you have not this session.

## Steps

1. Confirm surfaces and goals (SC-5). Draft goals from the surfaces: each is a task a person does with the feature, in plain words ("Stage two files and commit them"). Tag each `fixture` (the headless app can show it) or `real-app` (it needs data or services the fixture lacks, such as an agent reply). Show one screen with the surfaces in `content` and the goals as `multi` options, each labelled with its tag. The user edits, adds or removes goals in the note field and presses Proceed. Rewrite the list until the user confirms it. Walk exactly the confirmed list.

   ```json
   {
     "title": "Surfaces and goals",
     "question": "These are the surfaces I found and the goals I will walk. Edit the goals, then Proceed.",
     "select": "multi",
     "options": [
       { "id": "g1", "label": "Stage two files and commit them (fixture)", "description": "Changes panel, commit box" },
       { "id": "g2", "label": "See the merge-conflict state (fixture)", "description": "Conflict view" },
       { "id": "g3", "label": "Send review notes to an agent and see its reply (real app)", "description": "Review tab" }
     ],
     "content": "<h3>Surfaces</h3><ul><li>Changes panel</li><li>Review tab</li><li>View All Changes command</li></ul>"
   }
   ```

   The companion allows 2 to 4 options. With more goals, put the list in `content` as a table and offer options such as "Looks right" and "I will edit the list in the note".
2. Write `<spec>/goals.json`: `[{"id": "g1", "title": "...", "tag": "fixture"}, ...]`, ids `g1`, `g2` and so on. likeuser reads `id` and `title` and ignores `tag`.
3. Write `<spec>/seed.sh` (SC-6). It is a bash script that gives every fixture goal something to act on. It runs with cwd at the fixture's primary repo and may use `git`, the `REDESIGN_REPO`, `REDESIGN_WORKTREE_<NAME>` and `REDESIGN_PROJECT_<NAME>` variables, and `$REDESIGN_QUIRKY` to call the quirky CLI against the fixture daemon. It only ever runs on a fresh fixture. Stage nothing you want the goal to stage.
4. Start the fixture in the background, with one `--open <contribution-id>` for each of the feature's panels and views (take the ids from `surfaces.ts`):

   ```bash
   bun scripts/redesign/fixture.ts start <scratch>/fixture --theme dark --open panel:quirky.git/source-control
   ```

   Wait for `<scratch>/fixture/fixture.json`. Exit 1 means the start failed after cleanup: read stderr, fix and retry. Then seed it (SC-6):

   ```bash
   bun scripts/redesign/fixture.ts seed <scratch>/fixture <spec>/seed.sh
   ```

   Exit 1 means the seed script failed: fix `seed.sh`, stop the fixture, and start a new one, because a seed never re-runs on the same fixture. Read `url` from `fixture.json`.
5. Walk every fixture goal with likeuser (SC-7):

   ```bash
   likeuser.py begin --target <url> --surface web --owner yours --unattended --goals-file <spec>/goals.json
   ```

   Keep the printed `run_id`. The fixture opens on whatever worktree the UI picks, not the one the seed prepared. Before any goal, select the seeded worktree in the Worktrees tool (`ui-review-ready` unless `seed.sh` works in another one) and prove it with `act`. Then, for each goal, loop `observe`, `act`, `verdict` as the likeuser skill describes. The web viewport is 1280x720 and the fixture is dark with both tool slots open, so the walk matches the rule. Copy each observation that shows a state worth keeping into `<spec>/img/current/NN-slug.png` (`NN` is the walk order, `slug` names the state). Keep empty, error, loading and limit states too. A control that appears only on hover is a design theme, not a capability. Finish with `likeuser.py end --run "$RUN"`.
6. A goal that cannot complete (SC-8): the action has no effect or fails. Record it as a bug with its screenshot, and where you can find it, the `file:line` that handles the action. Verdict the goal `fail` or `blocked` as the likeuser skill says, then continue with the next goal.
7. Real-app goals (SC-9). If no goal is tagged `real-app`, skip this step and show no screen. Otherwise show one screen listing those goals and what you will click in the user's own Quirky:

   ```json
   {
     "title": "Real app goals",
     "question": "May I walk these goals in your real Quirky window?",
     "select": "single",
     "options": [
       { "id": "yes", "label": "Yes, walk them", "description": "I click in your open Quirky window and leave its data unchanged where I can" },
       { "id": "no", "label": "No, skip them", "description": "They are recorded as not walked, reason: declined" }
     ],
     "content": "<ul><li>Send review notes to an agent: click Send in the Review tab</li></ul>"
   }
   ```

   If the user says yes, walk them with a second likeuser run (`--surface native`, `--owner yours`, `--unattended`) and a goals file holding only those goals, and save screenshots to `img/current/`. If no, list them under "Goals not walked" with the reason "declined".
8. Score the current UI (SC-10). Pass every plugin from step 1 (`pluginId` and each of `alsoPlugins`):

   ```bash
   bun scripts/redesign/score.ts run --plugin <id> --plugin <also-id> --out <scratch>/before
   ```

   `--out` must not exist. Exit 0 means a report exists, even with low scores. Exit 2 is an error: read `error`. Copy the result: `mkdir -p <spec>/scores && cp <scratch>/before/scores.json <spec>/scores/before.json`.
9. Write `<spec>/current-state.md` (SC-11) from the template below. Use relative image paths such as `img/current/05-commit.png`.
10. Commit the spec folder: `git add <spec> && git commit -m "docs(redesign): <slug> current state"`.
11. Stop the fixture: `bun scripts/redesign/fixture.ts stop <scratch>/fixture`. It should print `{"stopped": true}`.

## current-state.md template

Write all seven sections, in this order. An empty section says "none".

```markdown
# <Feature>: current state

Walked <date> on the fixture at 1280x720, dark, with <tools> open.

## Where things live

Each surface and where the user finds it (panel, tab, command, context menu).

## The walk

### g1: <goal title>

Result: pass | fail | blocked. What happened, in two or three sentences.

![<state>](img/current/05-commit.png)

(one subsection per goal, with a screenshot for each state reached)

## Capabilities

Every action and state the current UI offers.

| Capability | Where it lives |
|---|---|
| Stage file | row checkbox in the Changes panel |

## Bugs

- <what is wrong>. Screenshot: img/current/NN-slug.png. Cause: `path/file.ts:123` (or "not found").

## Design themes

- <pattern the redesign should address, including hover-only controls>

## Before scores

| Surface | Dark | Light |
|---|---|---|
| Changes panel | 71 | 74 |

Read these from `scores/before.json`.

## Goals not walked

- <goal>: <reason, for example "declined">
```
