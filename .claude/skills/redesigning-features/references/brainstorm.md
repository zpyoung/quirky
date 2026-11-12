# Brainstorm

Entry: `current-state.md`, `goals.json` and `scores/before.json` are committed in the spec folder.

Leaves behind: an approved, committed `logic.md` in the spec folder that carries the three added sections below.

Next phase: build.md.

## Steps

1. Invoke the `quirk:brainstorming` skill (SC-12). Pass it this brief as the opening context, with `<spec>`, `<slug>` and `<feature>` filled in:

   ```text
   Redesign of the existing Quirky feature "<feature>". Write the logic spec to
   <spec>/logic.md. Read <spec>/current-state.md and the screenshots in
   <spec>/img/current/ first. They are the input.

   Choices already made. Do not ask about them.
   - Every question goes on the companion page, session directory
     .quirk/brainstorm/<slug>-redesign/, through
     `bun scripts/redesign/companion.ts` (start, show, wait, stop). Never use
     Quirky Ask and never ask in chat. Do not offer the companion; it is running.
   - A design question shows a crop of the current screenshot beside a wireframe
     for each option. Put the crop in the screen with a placeholder such as
     {{img:img/current/05-commit.png@0,0,640,360}} in an option's html or in content;
     companion.ts show inlines it.
   - A question whose answer changes other answers gets its own screen. Everything
     with a safe default goes on one defaults screen, each item marked "Looks right"
     or changed.
   - Approve the design one section per screen.
   - The spec format is markdown. Do not ask.
   - Stage and commit logic.md in the spec folder when approved.

   logic.md must gain three sections (see below).
   ```

   Append the three sections from step 2 to the brief.
2. The three sections `logic.md` must gain.

   `## Capabilities` (SC-13). Every capability in `current-state.md`'s capability list, each marked `kept`, `moved to <where>` or `cut: <reason>`. No capability may be missing from the list. Check it item by item against `current-state.md` before asking for approval.

   ```markdown
   ## Capabilities

   | Capability | Decision |
   |---|---|
   | Stage file | kept |
   | Discard file | moved to the row context menu |
   | Change base ref | cut: the Review tab always compares against the merge base |
   ```

   `## Redesign checks` (SC-14). In this order:
   - the confirmed goals from `goals.json`, marking any the design removes with the reason
   - the before scores from `scores/before.json`
   - the two gates: every surface scores at least 85 and at least its before score in dark and light (a new surface needs only 85, a removed surface is listed and not scored); every confirmed goal the design did not cut replays successfully on the new UI
   - the goals tagged real-app

   SDD plans from `logic.md`, so write this section so that the after pass reads as part of the build.

   `## Walk bugs` (SC-15). Each bug from `current-state.md` marked `fixed by this redesign` or `filed`, and a filed bug carries its issue link. File a bug with `gh issue create` when the user chooses to defer it.
3. During the dialogue, the user may remove a goal. Record it in Redesign checks as removed, with the reason. The after pass uses that reason.
4. When the user approves the spec on the companion page, confirm `logic.md` is committed. Brainstorming normally hands off to SDD here. Go to build.md.
