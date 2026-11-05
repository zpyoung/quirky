# Set up

Entry: the user ran `/redesigning-features <feature>` in a Claude Code session in a quirky checkout.

Leaves behind: a session on a `<slug>-redesign` worktree branch, a running companion server, the feature resolved to plugins and surfaces, and a decision about any files already in the spec folder. Nothing is committed yet.

Next phase: before-pass.md.

## Steps

1. Derive `<slug>` from the feature name. Run `bun scripts/redesign/spec-folder.ts <slug>`. It prints `checkout`, `branch`, `folder`, `exists`, `files` and `resumeAt`. Exit 2 means the slug is invalid: fix it and run again.
2. If `checkout` is `main` (SC-2), do not work here. Create the worktree and hand the run to a new session there:

   ```bash
   quirky worktree create <slug>-redesign --agent claude --prompt "/redesigning-features <feature>" --submit-prompt --activate
   ```

   Tell the user the worktree name and that the run continues there, then stop. Do nothing else in main.
3. If `checkout` is `worktree` (SC-1), the run's spec folder is the `folder` from step 1, on this branch. Continue.
4. Start the companion with session directory `.quirk/brainstorm/<slug>-redesign/`:

   ```bash
   bun scripts/redesign/companion.ts start .quirk/brainstorm/<slug>-redesign/
   ```

   Give the user the printed `url`. Exit 2 with `companion-not-found` means the quirk plugin is not installed: report that and stop.
5. Resolve the feature: `bun scripts/redesign/surfaces.ts <feature words>`.
   - `status: "one"` means `candidates[0]` is the feature. Its `pluginId` plus `alsoPlugins` are the plugins to score. Go to step 7.
   - `status: "many"` or `"none"` (SC-3): show a candidates screen and wait for the answer. Nothing is walked until the user picks.
6. Candidates screen. List each candidate's `pluginName` as an option (2 to 4; take the top four by score). In the `description`, name its main surfaces. Use `"select": "single"`.

   ```json
   {
     "title": "Which feature",
     "question": "\"changes\" matched more than one feature. Which one do you want to redesign?",
     "select": "single",
     "options": [
       { "id": "quirky-git", "label": "Git", "description": "Changes panel, Review tab, View All Changes command" },
       { "id": "quirky-sidebar-extras", "label": "Sidebar extras", "description": "Source control activity item, pinned items" }
     ]
   }
   ```

   Write it to `.quirk/brainstorm/<slug>-redesign/screens/candidates.json`, then:

   ```bash
   bun scripts/redesign/companion.ts show .quirk/brainstorm/<slug>-redesign/ .quirk/brainstorm/<slug>-redesign/screens/candidates.json
   bun scripts/redesign/companion.ts wait .quirk/brainstorm/<slug>-redesign/
   ```

   `wait` exits 1 on timeout: run it again. The `proceed` event's `selected` holds the choice. Use that candidate's `pluginId` and `alsoPlugins`.
7. Check the spec folder (SC-4). If `exists` is true and any of `files` is true, show the continue-or-start-over screen. List the files present in `content`, one per line.

   ```json
   {
     "title": "Existing run",
     "question": "This spec folder already holds files from an earlier session. What now?",
     "select": "single",
     "options": [
       { "id": "continue", "label": "Continue", "description": "Pick up at the first missing file and reuse everything before it" },
       { "id": "start-over", "label": "Start over", "description": "Delete the folder and begin at the before pass" }
     ],
     "content": "<ul><li>current-state.md</li><li>goals.json</li><li>seed.sh</li></ul>"
   }
   ```

   - Continue: enter the phase named by `resumeAt`, reading its reference first. Reuse the goals and seed the folder already holds.
   - Start over: run `git rm -r <folder>` and commit it with `git commit -m "chore(redesign): clear <slug> spec folder"`. Delete any untracked leftovers in the folder too. Then go to before-pass.md.
8. If the folder is empty or absent, go to before-pass.md.
