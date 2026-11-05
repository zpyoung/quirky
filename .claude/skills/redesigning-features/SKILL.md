---
name: redesigning-features
description: Use when redesigning how an existing Quirky desktop feature works and looks, from a walkthrough of the current UI to a draft PR with a before/after comparison. Triggers on "redesign the X feature" and `/redesigning-features <feature>`. Walks the current UI with a seeded fixture, scores it, runs brainstorming and subagent-driven development with fixed choices, replays the goals on the branch, and opens a draft PR. Not for new features (use brainstorming), the mobile app, or visual-only restyles.
argument-hint: <feature>
---

# Redesigning features

## Standing rules

These hold in every phase. After compaction only the start of this file survives, so re-read them first.

1. Every question goes on the companion page through `bun scripts/redesign/companion.ts`. Never use Quirky Ask and never ask in chat. This repo's sessions default to Quirky Ask, and this rule overrides that default for this skill.
2. Your stops are only the four in [Your stops](../../../docs/quirk/specs/2026-11-03-redesigning-features-skill/logic.md#your-stops): confirming surfaces and goals, the real-app go-ahead, the brainstorm's screens and design sections, and approving the logic spec. Between spec approval and the PR the only stop is the after pass's real-app go-ahead.
3. The fixture and the seed script never touch the user's Quirky. Touch the real app only after its screen says yes.
4. A goal passes only on likeuser evidence that its effect happened (`act` returned `OBSERVED` and the new screenshot shows the result). Never pass a goal on how a screenshot looks.
5. Tests: run targeted files only (`bun test <file>`, `bun run test:affected`). Run the full suite only through the draft PR's `full-suite` label. See AGENTS.md.
6. When SDD's final review loop exits, run the after pass. Do not run `quirk:finishing-a-development-branch`.
7. After compaction, find the phase from the conversation and from the spec folder's files (`bun scripts/redesign/spec-folder.ts <slug>`), then re-read that phase's reference before acting.
8. Fixed values for every run:
   - worktree: `<slug>-redesign`
   - spec folder: the `folder` that `spec-folder.ts` returns
   - screenshots: 1280x720, dark theme, with the feature's tools open
   - score floor: 85

## Inputs

`<feature>` is the name the user gave, in their words. `<slug>` is that name lowercased and joined with hyphens (`^[a-z0-9]+(-[a-z0-9]+)*$`). The slug names the worktree, the spec folder and the companion session directory `.quirk/brainstorm/<slug>-redesign/`.

All scripts live in `scripts/redesign/`, run from the worktree root, and print one JSON object on stdout. Exit 0 is success, 1 is a checked failure the JSON describes, 2 is bad arguments or a broken environment. Progress goes to stderr.

## Phases

Run the phases in order, in this one conversation. Read a phase's reference when you enter it, not before.

| Phase | Reference | Leaves in the spec folder | Exit check |
|---|---|---|---|
| Set up | [setup.md](references/setup.md) | nothing yet (a worktree if you started on main) | on a worktree branch, companion running, feature resolved to plugins and surfaces |
| Before pass | [before-pass.md](references/before-pass.md) | `goals.json`, `seed.sh`, `current-state.md`, `img/current/`, `scores/before.json`, committed | `spec-folder.ts` shows `current-state.md` present; fixture stopped |
| Brainstorm | [brainstorm.md](references/brainstorm.md) | approved `logic.md` with `## Capabilities`, `## Redesign checks`, `## Walk bugs`, committed | the user approved the spec on the companion page |
| Build | [build.md](references/build.md) | `tech.md` (written by SDD), the code | SDD's final review loop exited with no blocker |
| After pass and PR | [after-pass.md](references/after-pass.md) | `img/after/`, `scores/after.json`, `comparison-data.json`, `comparison.md`, committed | draft PR open with the `full-suite` label, link reported |

## Where a run is

`bun scripts/redesign/spec-folder.ts <slug>` returns `resumeAt`: `before-pass` while `current-state.md` is missing, `brainstorm` while `logic.md` is missing, `build` while `comparison.md` is missing, then `done`. Use it to place yourself after compaction. A new session never resumes a phase on its own: the continue-or-start-over screen in setup.md covers that.

## Finishing

Stop after you report the PR link. The user merges.
