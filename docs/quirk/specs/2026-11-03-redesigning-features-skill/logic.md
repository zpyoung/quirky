# Redesigning features: one command from walkthrough to draft PR

## Why

The Changes redesign (session `s_f7e2dce318f6`, spec `docs/quirk/specs/2026-11-02-changes-redesign/`) worked, but every piece of it was improvised: the fixture was started by hand from a harness outside the repo, git state was seeded with ad hoc shell, companion screens were built with a one-off script, and the checks that prove the redesign worked lived only in that spec. Doing the next feature the same way means rediscovering all of it, and nothing guarantees the before and after are comparable.

This skill makes the process repeatable. You name a feature, and one run walks the current UI, brainstorms the redesign with you, builds it through the existing chain, proves it against the same walk, and opens a draft PR.

## What this builds on

- `quirk:using-apps-like-a-user` (likeuser) drives the app and proves each action changed something.
- `quirk:brainstorming` and its companion page run the design dialogue and write the logic spec.
- `quirk:subagent-driven-development` (SDD) writes the tech spec, plans and builds.
- `bun run ui:review` scores screenshots with a reviewer from a different model family.
- `scripts/ui-review/fixtures.ts` already seeds the fixture daemon the headless app runs against.

The skill wraps that chain. It adds the quirky-specific ends (the before pass and the after pass) and fixes the choices the Changes run had to ask about. It does not replace or fork brainstorming or SDD.

## Conceptual model

### A run

One invocation, `/redesigning-features <feature>`, in a Claude Code session inside quirky. A run has five phases, in order, in one conversation:

1. Set up: resolve the feature to its plugins and surfaces, make sure the run is in its own worktree, start the companion page.
2. Before pass: walk the current UI, score it, write `current-state.md`.
3. Brainstorm: brainstorming with the run's fixed choices, ending at an approved `logic.md`.
4. Build: SDD as it runs today, with the model pairing preset.
5. After pass and PR: replay the goals on the branch, score again, write `comparison.md`, open a draft PR.

No file tracks which phase a run is in. The conversation is the run, and compaction is survived by keeping the rules that must always hold at the top of the skill.

### The spec folder

Everything a run produces lands in one folder on the run's branch, `docs/quirk/specs/<date>-<feature>-redesign/`:

| File | Written in | Holds |
|---|---|---|
| `current-state.md` and `img/current/` | Before pass | The walk, capability list, bugs, design themes, before scores |
| Seed script | Before pass | The fixture setup both passes run |
| `logic.md` | Brainstorm | The approved design, with the three redesign additions |
| `tech.md` | Build | Written by SDD when its gate fires |
| `img/after/` and `comparison.md` | After pass | The replay, after scores and the before/after comparison |

### Goals, capabilities and checks

- A goal is a task a person does with the feature ("stage two files and commit them"). Goals are drafted by the skill, confirmed by you, walked in the before pass and replayed in the after pass. Each goal is tagged *fixture* or *real app*.
- The capability list is every action and state the current UI offers, found during the walk. The design must account for each one as kept, moved or cut. It shapes the design; it is not re-verified as its own gate.
- The two gates every redesign must clear before its PR opens:
  1. ui:review scores every surface of the feature at 85 or more, and no lower than its before score, in dark and in light.
  2. Every confirmed goal the spec didn't cut replays successfully on the new UI.

### Your stops

You're asked to act at these points and no others:

1. Confirming the surfaces and goals (one screen).
2. The go-ahead to drive your real Quirky, once per pass, and only if some goals are tagged *real app*.
3. The brainstorm's screens and its design sections.
4. Approving the logic spec.

Between spec approval and the draft PR, the only stop is the after pass's real-app go-ahead. Every question goes on the companion page.

### Data flow

The set-up phase turns the feature name into a list of plugins and surfaces, which drafts the goals. The confirmed goals and the seed script drive the before walk, which produces screenshots, the capability list, bugs and themes; ui:review adds the before scores. All of that becomes `current-state.md`, which is the brainstorm's main input alongside the screenshots. The brainstorm turns it into `logic.md`, whose Redesign checks section carries the goals, before scores and gates forward. SDD builds against `logic.md`. The after pass reads the same goals, seed script and before scores, produces after screenshots and scores, and folds both passes into `comparison.md`, which the draft PR links.

## Behavior and scenarios

### Setting up

1. **SC-1 Started in a feature worktree**
   - **Given** you're in a Claude Code session in a quirky worktree that isn't main
   - **When** you run `/redesigning-features changes`
   - **Then** the skill resolves "changes" to its plugins and surfaces, starts the companion page and shows the surfaces-and-goals screen (SC-5); the run's spec folder is `docs/quirk/specs/<today>-changes-redesign/` on this worktree's branch

2. **SC-2 Started on main**
   - **Given** you're in a session on the main checkout
   - **When** you run `/redesigning-features changes`
   - **Then** the skill creates the quirky worktree `changes-redesign`, starts a Claude session there running the same command, tells you where it went, and does nothing else in main
   - **Data before:** **Worktrees**: main
   - **Walkthrough:**
     1. You run the command on main.
     2. The skill creates **changes-redesign** from main with a Claude session whose first prompt is `/redesigning-features changes`.
     3. The main session reports the new worktree and stops.
   - **Data after:** **Worktrees**: main; ✓ **changes-redesign** with a running Claude session at SC-1

3. **SC-3 A name that matches nothing or several things**
   - **Given** the name you gave matches no plugin or surface, or matches more than one feature
   - **When** set-up resolves it
   - **Then** the companion shows the candidates it found (or the closest ones) and asks which you meant; nothing is walked until you pick

4. **SC-4 The spec folder already has files**
   - **Given** `docs/quirk/specs/<date>-<feature>-redesign/` already holds files from an earlier session (for example `current-state.md` but no `logic.md`)
   - **When** a new session runs the skill for the same feature
   - **Then** it starts a new run that reuses the files already there [ASK: should it show one screen offering to continue from the first missing file or start the folder over, or always continue from the first missing file without asking?]

### The before pass

5. **SC-5 Confirming surfaces and goals**
   - **Given** set-up resolved the feature
   - **When** the surfaces-and-goals screen is shown
   - **Then** it lists every surface found in the feature's plugin manifests and the drafted goals, each tagged *fixture* or *real app*; you confirm, edit, add or remove goals on that one screen, and the walk uses exactly the confirmed list
   - **Surfaces and goals screen:**

     | Section | Example content |
     |---|---|
     | Surfaces | Changes panel; Review tab; "View All Changes" command; Source Control AI settings; file row context menu* |
     | Goals | 1. Stage two files and commit them (fixture)*; 2. See the merge-conflict state (fixture)*; 3. Send review notes to an agent and see its reply (real app)* |
     | Your edits | change, add or remove any goal, then Proceed |

6. **SC-6 Seeding the fixture**
   - **Given** goals are confirmed
   - **When** the before pass prepares the fixture
   - **Then** the skill writes a seed script into the spec folder that gives every fixture goal something to act on, starts a fresh fixture and runs the script against it; the same script is what the after pass runs

7. **SC-7 Walking the fixture goals**
   - **Given** a seeded fixture
   - **When** the skill walks each fixture goal with likeuser
   - **Then** each goal is walked in the headless app at 1280×720 in dark with both tool slots open; every state the walk reaches (empty, error, loading, limit) is screenshotted into `img/current/`; a control that only appears on hover is recorded as a design-theme observation; your Quirky is never touched

8. **SC-8 A goal the current UI can't complete**
   - **Given** a fixture goal whose action has no effect or fails in the current UI
   - **When** the walk reaches it
   - **Then** it's recorded as a bug with its screenshot and, where the skill can find it, the `file:line` responsible, and the walk continues with the next goal

9. **SC-9 Real-app goals in the before pass**
   - **Given** at least one confirmed goal is tagged *real app*
   - **When** the fixture walk is done
   - **Then** one companion screen lists those goals and what the skill will click in your Quirky; (a) if you agree, it walks them in your real window; (b) if you decline, they're recorded as not walked with "declined" as the reason
   - **Given** no goal is tagged *real app*, no such screen appears

10. **SC-10 The before score**
    - **Given** the walk is done
    - **When** the skill scores the current UI
    - **Then** `ui:review` runs on the feature's plugins only, in dark and light, and each surface's two scores go into `current-state.md`

11. **SC-11 current-state.md**
    - **Given** the walk and scoring are done
    - **When** the before pass ends
    - **Then** `current-state.md` is written with these sections: where things live; the walk, goal by goal, with screenshots; the capability list with where each item lives; bugs; design themes; before scores; goals not walked and why. It's committed on the run's branch with the screenshots and seed script, and the fixture is stopped and deleted

### Brainstorm

12. **SC-12 Handing off to brainstorming**
    - **Given** `current-state.md` is committed
    - **When** the skill hands off to `quirk:brainstorming`
    - **Then** brainstorming runs its usual steps with these choices already made: every question goes on the companion page (no Quirky Ask, nothing asked in chat, no companion offer); a design question shows a crop of the current screenshot beside a wireframe for each option; a question whose answer changes other answers gets its own screen and everything with a safe default goes on one defaults screen marked "Looks right" or changed per item; the design is approved one section per screen; the spec is markdown, unasked

13. **SC-13 Accounting for every capability**
    - **Given** the capability list in `current-state.md`
    - **When** brainstorming writes `logic.md`
    - **Then** `logic.md` lists every capability as kept, moved (saying where) or cut (with a reason), and no capability is missing from that list
    - **Data before:** **Capability list**: Stage file; Discard file; Fetch; Change base ref; Generate commit message*
    - **Walkthrough:**
      1. The design keeps Stage file and Generate commit message.
      2. The design moves Discard file into the row's context menu and Fetch into the ship button's menu.
      3. The design cuts Change base ref because the Review tab always compares against the merge base*.
    - **Data after:** **logic.md Capabilities**: ✓ Stage file kept; ✓ Generate commit message kept; ✓ Discard file moved to the row context menu; ✓ Fetch moved to the ship menu; ✓ Change base ref cut, reason given

14. **SC-14 The Redesign checks section**
    - **Given** the design is approved
    - **When** `logic.md` is written
    - **Then** it has a Redesign checks section listing the confirmed goals (marking any the design removes), the before scores, the two gates and the real-app goals; SDD plans from , so the after pass is planned as part of the build

15. **SC-15 Bugs from the walk**
    - **Given** `current-state.md` lists bugs
    - **When** `logic.md` is written
    - **Then** each bug is marked either fixed by this redesign or filed, and filed ones carry their issue link

### Build

16. **SC-16 Building with no stops**
    - **Given** `logic.md` is approved
    - **When** brainstorming hands off to SDD
    - **Then** SDD runs with the preset pairing (Sonnet subagents implement, Codex reviews), doesn't ask about spec format or pairing, runs only targeted test files between waves and never the full suite outside the PR label, and doesn't stop for you unless something blocks it

### The after pass and the PR

17. **SC-17 Replaying the goals**
    - **Given** SDD's final review loop has finished on the run's branch
    - **When** the after pass starts
    - **Then** the skill builds the branch, starts a fresh fixture from it, runs the same seed script, and replays every confirmed fixture goal with likeuser at the same size and theme; screenshots go to `img/after/`; a goal counts as passing only when likeuser shows its effect happened, never on how the screenshot looks

18. **SC-18 A goal the design cut**
    - **Given** `logic.md` marks a goal as removed by the design
    - **When** the replay reaches it
    - **Then** it isn't walked, and `comparison.md` lists it as cut with the spec's reason

19. **SC-19 The score gate**
    - **Given** before scores and a replayed branch
    - **When** ui:review runs on the same plugins in dark and light
    - **Then** each surface clears only if both its scores are at least 85 and at least its before score; a surface that didn't exist before needs only 85; a surface the design removed is listed as removed and not scored
    - **Score gate:**

      | Surface | Before (dark / light) | After (dark / light) | Result |
      |---|---|---|---|
      | Changes panel* | 71 / 74 | 88 / 90 | ✓ clears |
      | Review tab* | none, new | 86 / 84 | ✗ light below 85 |
      | Conflict view* | 89 / 91 | 87 / 92 | ✗ dark below its before score |

20. **SC-20 Real-app goals in the after pass**
    - **Given** at least one confirmed goal is tagged *real app*
    - **When** the fixture replay is done
    - **Then** one companion screen lists those goals and warns that running the branch replaces your Quirky's daemon with the branch's until you restart Quirky from main; (a) if you agree and `bun run dev` launches, the goals are replayed in that window; (b) if you decline or the dev build can't launch, they're listed in the PR as not replayed, with the reason (for example, the `hutch` executable missing)

21. **SC-21 Fix rounds**
    - **Given** a gate fails
    - **When** the after pass handles it
    - **Then** the failure is fixed by the build pairing with targeted tests only and both gates are re-checked; this repeats at most twice, and after the second round the run moves on to the PR whatever the result

22. **SC-22 comparison.md**
    - **Given** the after pass has finished, with or without failures
    - **When** the skill writes `comparison.md` in the spec folder
    - **Then** it shows each goal's before and after screenshots side by side with its result, the before and after scores per surface in dark and light, and the capability list marked kept, moved or cut; it's markdown so GitHub renders it in the PR
    - **Comparison page:**

      | Goal | Before | After | Result |
      |---|---|---|---|
      | Stage two files and commit them* | img/current/05-commit.png* | img/after/05-commit.png* | ✓ replayed |
      | See the merge-conflict state* | img/current/08-conflict.png* | img/after/08-conflict.png* | ✓ replayed |
      | Change the base ref* | img/current/11-base.png* | none | cut: always merge base* |

23. **SC-23 The draft PR**
    - **Given** `comparison.md` is committed
    - **When** the run finishes
    - **Then** the skill opens a draft PR for the branch, adds the `full-suite` label, and links `comparison.md` and `logic.md` in the description; (a) if anything still fails, the failures are the first thing in the description; (b) if nothing fails, the description opens with the summary. It then stops the companion server, reports the PR link and stops. You merge

## How we know it's done

The skill is done when its first real run on a feature you choose reaches a draft PR whose spec folder holds `current-state.md` with screenshots, the seed script, an approved `logic.md` with its Capabilities and Redesign checks sections, and `comparison.md`, and the run keeps following its standing rules after any compaction along the way. Whatever that run gets wrong is fixed in the skill afterwards.

## Scope and non-goals

In scope: redesigning how an existing Quirky desktop feature works and looks, from walkthrough to draft PR, run from Claude Code.

Not in scope:

- New features, which go to brainstorming.
- The mobile app.
- Visual-only restyles (tokens, spacing, components with no behavior change).
- Codex or other agents running the skill.
- Merging the PR.
- Tracking a run's phase in a file or resuming a run's phase in a new session.

## Decisions Locked

### Where it lives and who runs it

- The skill lives in the quirky repo as a project skill, `.claude/skills/redesigning-features/`.
- It's called `redesigning-features` and runs in Claude Code sessions only.
- A redesign is how an existing desktop feature works and looks. New features, mobile and visual-only restyles are out.
- It's built as a short orchestrator with standing rules at the top, one reference per phase, and helper scripts for the steps that must run the same way every time.

### Where a run starts and stops

- The skill wraps the existing brainstorming → SDD chain rather than owning every phase.
- A run survives compaction through the conversation only, with no run file. This was the user's choice; the recommendation was a run file in the spec folder.
- One run redesigns one feature, named however you'd call it.
- A run works in its own worktree, `<feature>-redesign`.
- A run ends at a draft PR with the full-suite label; you merge.

### Capturing the before

- The walk uses the headless fixture first, then your real Quirky (after asking) for goals the fixture can't show. This was the user's choice; the recommendation was the fixture only.
- Fixture state comes from a seed script saved in the spec folder and replayed by the after pass.
- The skill drafts the goals and you confirm them on the same screen as the surfaces.
- `current-state.md` has a capability list the design must account for.
- Problems are recorded as bugs and design themes, without severity scores.
- Screenshots are 1280×720 in dark with both tool slots open, covering every state the goals reach.

### How and when it asks you

- Every question goes on the companion page.
- A design question shows today's screenshot beside a wireframe for each option.
- Forking questions get their own screen; everything else goes on one defaults screen.
- The design is approved one section per screen.
- Spec format (markdown) and the build pairing are preset, so nothing stops between spec approval and the after pass.

### What done means

- The fixed gates are the ui:review score and the goal replay. The capability check and the spec's own done criteria are not fixed gates. This was the user's choice; the recommendation was all four.
- The before pass scores the current UI, and the after score can't be lower than it.
- The before/after comparison is a page in the spec folder linked from the draft PR, with no extra stop.
- A failing gate gets up to two fix rounds, then the PR opens with failures first.
- Real-app goals are replayed in the after pass by running the branch build against your real data, after asking. This was the user's choice; the recommendation was listing them for a hand check.
- The skill itself is tested by its first real run.

### Assumed while writing the spec

- A surface new in the redesign needs only 85; a removed surface is listed and not scored (SC-19).
- A name that matches nothing or several features is resolved on a companion screen (SC-3).
- A goal the current UI can't complete is recorded as a bug and the walk continues (SC-8).
- Each walk bug is fixed by the redesign or filed with its link (SC-15).

## Industry Insights

Research ran on 2026-11-02 and 2026-11-03. Brave Search was unavailable on the plan, so findings rest on WebSearch, Anthropic's docs and a few community threads.

### Patterns that shaped the design

- Ground the audit in task walkthroughs so the same tasks replay as acceptance later. This is why goals are walked before and replayed after on the same seed. ([Otther](https://otther.co/blog/nielsen-heuristics))
- Measure a baseline before changing anything, then re-measure. This is the before score and its "no lower" gate. ([NN/g](https://www.nngroup.com/articles/product-ux-benchmarks/))
- Use fixed-viewport screenshots as before/after evidence, and remember one screenshot says nothing about empty, loading or error states. ([tenten](https://developer.tenten.co/claude-design-skills-interface-workflow))
- Scripts suit deterministic steps: they're repeatable and only their output costs context. Prose suits judgment-heavy phases like exploration and brainstorming. ([Anthropic best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices), [Anthropic engineering](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills))
- Keep SKILL.md under 500 lines with references one level deep. After compaction only the first 5,000 tokens of each invoked skill survive, so the standing rules go first. ([Claude Code skills](https://code.claude.com/docs/en/skills))

### Anti-patterns the design avoids

- Dropping features users relied on. Sonos's 2024 redesign did, and spent months restoring them. This is the capability list. ([Tom's Guide](https://www.tomsguide.com/audio/speakers/sonos-is-returning-the-features-its-courageous-app-redesign-left-behind))
- Treating a visual score as acceptance. Scores find gaps; the replay decides whether goals work. ([Browserbase ui-test](https://mcpservers.org/agent-skills/browserbase/ui-test), snippet only)
- Self-grading. ui:review uses a reviewer from another model family, and SDD's review uses Codex. ([Medium](https://medium.com/data-science-collective/reward-hacking-why-ai-agents-cant-grade-their-own-work-c31ecdee8486))
- Skipped phases in long skills, and lost rationale after compaction. Hand-offs go through files in the spec folder, and the standing rules sit at the top. ([claude-code #54049](https://github.com/anthropics/claude-code/issues/54049), [DEV](https://dev.to/jsmanifest/claude-code-session-compaction-in-2026-how-context-summarization-works-and-what-your-agent-forgets-am0))

### Approaches considered

- Instructions only was rejected: prose drifts on fragile steps, so before and after stop lining up.
- A scripted workflow for the walk and replay was rejected: workflows can't stop to ask mid-run, cost far more tokens, and resume only in the same session. ([Claude cookbook](https://platform.claude.com/cookbook/claude-agent-sdk-08-dynamic-workflows))

## Deferred Ideas

- `[tech-spec]` The fixture launcher lives in `.git/qa-loop/harness/web-fixture.ts`, outside the repo; the skill needs its own copy in the repo that wraps `scripts/ui-review/fixtures.ts`.
- `[tech-spec]` How the skill finds `companion.py` from the installed quirk plugin, and how it embeds screenshots in screens.
- `[tech-spec]` How the after pass runs after SDD's final review and before its finishing step.
- `[tech-spec]` The seed script's language and how it receives the fixture's repo path.
- `[tech-spec]` How `bun run dev` reaches your real data, and installing `hutch` on this Mac.
- Using this skill's after pass to finish the Changes run, which hasn't reached its screenshot score or goal replay yet.
- Quirky Ask rejected a question containing the word "pass" as credential-shaped. Worth filing as a bug.

## Glossary

| Term | Meaning |
|---|---|
| Run | One invocation of the skill for one feature, from set-up to the draft PR |
| Before pass, after pass | The walk and scoring of the current UI, and the replay and scoring of the redesigned UI |
| Goal | A task a person does with the feature, walked before and replayed after |
| Fixture | A private Quirky daemon with seeded git repos, served to a headless browser and isolated from your Quirky |
| Seed script | The setup that puts the fixture's repos into the state the goals need |
| Capability list | Every action and state the current UI offers, which the design must keep, move or cut |
| Gate | A check every redesign must clear before its PR opens: the score gate and the goal replay |
| Companion page | Brainstorming's local web page that shows one question per screen |
| likeuser | The driver behind  |

## Status & amendments

Status: Draft
