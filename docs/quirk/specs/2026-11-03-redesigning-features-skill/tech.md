# Redesigning features: tech spec

Status: Reviewed 2026-11-05. Logic spec: [logic.md](logic.md) (approved 2026-11-05).

## Architecture

The skill is prose plus six small Bun scripts.

- `.claude/skills/redesigning-features/` holds `SKILL.md` and one reference per phase. It holds no code, so nothing in it needs typechecking or tests.
- `scripts/redesign/` holds the helper scripts and their tests. `tsconfig.json` already typechecks `scripts`, and `scripts/test-baseline/select.ts:38` already groups `scripts/<dir>` tests for CI, so the scripts get typechecking and CI coverage without new config.
- Every script prints one JSON object on stdout and nothing else there; progress and diagnostics go to stderr. Exit 0 means success, 1 means a checked failure the JSON describes (a gate failed, no match), 2 means bad arguments or a broken environment.
- Shared shapes live in `scripts/redesign/contracts.ts`. Every script imports its input and output types from there.

Technologies: Bun 1.4, TypeScript, `node:child_process`/`Bun.spawn`, the existing daemon and protocol packages, `python3` for the quirk companion server, macOS `sips` for crops.

| File | Logic anchor | Job |
|---|---|---|
| `.claude/skills/redesigning-features/SKILL.md` | [A run](logic.md#a-run), [Your stops](logic.md#your-stops) | Standing rules, then the phase table |
| `.claude/skills/redesigning-features/references/setup.md` | [Setting up](logic.md#setting-up) | SC-1 to SC-4 |
| `.claude/skills/redesigning-features/references/before-pass.md` | [The before pass](logic.md#the-before-pass) | SC-5 to SC-11, with the `current-state.md` template |
| `.claude/skills/redesigning-features/references/brainstorm.md` | [Brainstorm](logic.md#brainstorm) | SC-12 to SC-15: the brief handed to brainstorming |
| `.claude/skills/redesigning-features/references/build.md` | [Build](logic.md#build) | SC-16: the brief handed to SDD |
| `.claude/skills/redesigning-features/references/after-pass.md` | [The after pass and the PR](logic.md#the-after-pass-and-the-pr) | SC-17 to SC-23 |
| `scripts/redesign/contracts.ts` | [Data flow](logic.md#data-flow) | Shared types |
| `scripts/redesign/spec-folder.ts` | SC-1, SC-2, SC-4 | Where the run is, and what the spec folder already holds |
| `scripts/redesign/surfaces.ts` | SC-3, SC-5 | Feature name to plugins and surfaces |
| `scripts/redesign/fixture.ts` | SC-6, SC-7, SC-17 | Start, seed and stop the headless fixture |
| `scripts/redesign/companion.ts` | SC-3, SC-4, SC-5, SC-9, SC-12, SC-20 | Find the companion server and show screens with embedded screenshots |
| `scripts/redesign/score.ts` | SC-10, SC-19 | Run ui:review for the feature's plugins and apply the score gate |
| `scripts/redesign/comparison.ts` | SC-22 | Write `comparison.md` |

## Code references

Existing code the scripts build on. Paths are repo-relative.

- `scripts/ui-review/fixtures.ts`
  - `createIsolatedRuntimeEnvironment(home, {repoRoot?, uiDir?})` (:103) returns the stripped env: `HOME`, `QUIRKY_HOME`, `TMPDIR`, `XDG_*` under the home, `GIT_CONFIG_GLOBAL=/dev/null`, a fixed `PATH`, and with `repoRoot` also `QUIRKY_BUILTIN_PLUGINS_DIR`, `QUIRKY_UI_DIR`, `QUIRKY_CLI_ENTRY`.
  - `prepareCaptureFixtureHome(home, {timeoutMs, env})` (:239) creates `<home>/projects/{ui-review-fixture,harbor-api,ledger-web}` and returns `repoPath` and `projects[]`.
  - `registerCaptureFixtures(client, prepared, {timeoutMs})` (:332) registers the projects and creates the worktrees `ui-review-ready` and `ui-review-notes`; the result carries `primaryWorktree.path` and `worktrees[].path`.
- `/Users/zpyoung/PycharmProjects/PERSONAL/quirky/.git/qa-loop/harness/web-fixture.ts` (local-only, not in git) is the launcher `fixture.ts` replaces. Read it before writing `fixture.ts`; its start sequence (build UI into `<out>/ui-dist`, prepare home, spawn `packages/daemon/src/main.ts` under `createProcessScope`, wait for `runtime.json`, check `status.get` home, register fixtures, write `fixture.json`, print `READY`) is the one to keep. Its test sits beside it as `web-fixture.test.ts`.
- `scripts/test-support/process-scope.ts`: `createProcessScope()` (:461) makes the temp home; `scope.spawn`, `scope.cleanup()`.
- `packages/protocol/src/node/index.ts`: `readRuntime(home)` (:117), `isDaemonAlive` (:139), `connectDaemon`.
- Daemon RPCs used after registration: `theme.set {id}` (`packages/protocol/src/rpc.ts:215`), `ui.tool.open {id}` (`rpc.ts:135`), `quirky.worktree/navigate {worktree: 'id:<id>'}` (as in `scripts/ui-review/shell-scenes.ts:127-146`).
- `scripts/ui-review.ts` with `scripts/ui-review/arguments.ts:37-70`: `--author-family` (required), `--output <absolute, must not exist>`, `--only <id-or-plugin>` (repeatable), `--threshold` (default 85), `--reviewer` (default `gemini`), `--capture-only`. Exit 0 pass, 1 below threshold or capture failure, 2 error.
- `scripts/ui-review/contracts.ts:74-84` and `review.ts:690-725`: `review-report.json` has `captures[]`, each with `targetId`, `theme` (`dark`|`light`), `score`, `passed`, `assessment.targetVisible`.
- `scripts/ui-review/capture.ts:136-175`: scoreable kinds are views, panels, sidebarSections, activityItems, statusBars, overlays, settingsSections; `--only` matches `target.id` or `target.plugin`.
- `packages/daemon/src/plugins/discover.ts:63` `discoverPlugins({builtin, installed})` reads every `plugins/<id>/quirky-plugin.json` without running plugin code.
- `packages/daemon/src/plugins/tool-layout.ts:53-80` `RULES` gives host titles that differ from manifests (`panel:quirky.git/source-control` is titled "Changes", with alias `activity-item:quirky.sidebar-extras/source-control`). It is module-private today.
- `packages/protocol/src/plugins.ts:465` `PluginManifest`, `:522` `parseContributionId`. UI kinds: `packages/protocol/src/ui.ts:6`. Contribution ids are `<kind>:<pluginId>/<name>`.
- Companion server: `<quirk>/skills/writing-html-artifacts/scripts/companion.py` with `start SESSION_DIR`, `show SESSION_DIR SCREEN.json`, `wait SESSION_DIR [--timeout N]`, `stop SESSION_DIR` (`references/companion.md:22-28`). Screens allow only `title`, `question`, `select`, `options` (2-4, each `id`, `label`, optional `description`, `html`), `content`, `diagram`, `layout` (`companion.py:64`, `:666-710`). Only the current screen's HTML is served, so images must be data URIs (`htmlkit/checks.py:31-32` warns at 2 MB, fails at 10 MB).
- likeuser: `<quirk>/skills/using-apps-like-a-user/scripts/likeuser.py`. `--goals-file` reads `[{id, title}]` and ignores other keys (`likeuser.py:909-921`). The web driver's default viewport is 1280×720 (`scripts/_web.py:30`).
- `quirky worktree create <name> --agent claude --prompt <text> --submit-prompt --activate` (`plugins/quirky.worktree/cli.ts:384-456`).
- `bun run dev`: root `package.json:12` → `apps/desktop/package.json:7` → `apps/desktop/scripts/with-electrobun-devkit.ts:77-86`, which spawns `hutch electrobun dev` and throws ENOENT when `hutch` isn't on `PATH`. With `QUIRKY_HOME` unset it uses `~/.quirky` and replaces the running daemon (`packages/protocol/src/node/index.ts:256-265`).

## Contracts & interfaces

All commands run from the worktree root.

### spec-folder.ts

`COMMAND:` `bun scripts/redesign/spec-folder.ts <feature-slug> [--date YYYY-MM-DD]`

`SCHEMA:` stdout is `SpecFolderStatus` (contracts.ts).

- `checkout`: `"main"` when `git rev-parse --git-dir` equals `--git-common-dir` (the main checkout), else `"worktree"`. `branch` is the current branch.
- `folder`: the existing `docs/quirk/specs/*-<slug>-redesign/` with the newest date prefix, or, when none exists, `docs/quirk/specs/<date>-<slug>-redesign/` with `--date` defaulting to today (local time). `exists` says which.
- `files`: which of `current-state.md`, `goals.json`, `seed.sh`, `logic.md`, `tech.md`, `comparison.md` are present.
- `resumeAt`: the phase the first missing required file belongs to. Order: `current-state.md` → `before-pass`; `logic.md` → `brainstorm`; `comparison.md` → `build`; all present → `done`. `tech.md` is never required. An empty or missing folder gives `before-pass`.
- Exit 0 always on a valid slug. Exit 2 when the slug doesn't match `REGEX:` `^[a-z0-9]+(-[a-z0-9]+)*$`.

### surfaces.ts

`COMMAND:` `bun scripts/redesign/surfaces.ts <feature name words...>`

`SCHEMA:` stdout is `SurfaceResolution`.

- Reads built-in manifests with `discoverPlugins({builtin: '<repo>/plugins', installed: <a path that does not exist>})` and the host titles from `tool-layout.ts`. Make `RULES` reachable by adding `export` to its declaration; nothing else in that file changes.
- Matching is case-insensitive on whole words of the query against: the plugin id's last segment (`quirky.git` → `git`), the plugin `name`, each UI contribution's `title`, and each host tool title from `RULES` (mapped to its contribution id and aliases' plugins). A plugin's match score is the best field hit: id segment or plugin name exact = 3, host tool title exact = 3, contribution title containing every query word = 2, partial word overlap = 1.
- `status`: `"one"` when exactly one plugin has the top score and that score is ≥ 2; `"many"` when two or more plugins share a top score ≥ 2; `"none"` otherwise. For `"none"`, `candidates` holds the five plugins with the highest score (ties by id) so the skill can offer the closest. For `"one"` and `"many"`, `candidates` holds every plugin with score ≥ 1.
- `surfaces` for each candidate lists UI contributions of kinds `panel`, `view`, `sidebar-section`, `activity-item`, `status-bar`, `overlay`, `settings-section`, `setting`, `command`, `menu-item`, each `{id, kind, title, scoreable}`. `scoreable` is true for the seven kinds ui:review captures (Code references).
- A host tool title hit credits the plugin that owns the tool's `id`. The tool's `aliases` are the same tool contributed by another plugin, so they're appended to that candidate's `surfaces` and that candidate's `alsoPlugins`; the aliased plugin is never scored as a rival. "changes" therefore gives one candidate, `quirky.git`, whose surfaces include `activity-item:quirky.sidebar-extras/source-control` and whose `alsoPlugins` is `["quirky.sidebar-extras"]`. The skill scores `pluginId` plus `alsoPlugins`.
- Exit 0 for `one`, 1 for `many` or `none`, 2 for no query.

### fixture.ts

`COMMAND:` `bun scripts/redesign/fixture.ts start <out-dir> [--theme dark|light] [--open <contribution-id>]...`
`COMMAND:` `bun scripts/redesign/fixture.ts seed <out-dir> <script-path>`
`COMMAND:` `bun scripts/redesign/fixture.ts stop <out-dir>`

- `start` runs in the foreground until SIGTERM/SIGINT; callers run it in the background and wait for `<out-dir>/fixture.json`. It keeps web-fixture.ts's sequence, then sets the theme (default `dark`), navigates to the `ui-review-ready` worktree and opens each `--open` tool with `ui.tool.open`. It writes `fixture.json` (`FixtureInfo`) and prints `READY <path>` on stderr, and the single stdout JSON line `{"ready": "<path>"}`. On SIGTERM/SIGINT it closes the client and runs `scope.cleanup()`, which stops the daemon and removes the home; it then deletes `fixture.json`. A start failure exits 1 after cleanup.
- `seed` reads `<out-dir>/fixture.json`, runs `bash <script-path>` with cwd `repos.primary`, and the env from `seedEnvironment(info)`: the fixture's isolated env (`createIsolatedRuntimeEnvironment(info.home, {repoRoot})`) plus the `REDESIGN_*` variables in Config below. No variable from the caller's environment reaches the script, so a seed can never touch your `~/.quirky` or this session's Quirky ids. Stdout is `{"seeded": true, "exitCode": 0}`; the script's own output goes to stderr. Exit 1 when the script fails, 2 when `fixture.json` is missing.
- `stop` reads `pid` and `home` from `fixture.json`, sends SIGTERM, waits up to 30 s for the process to exit and the home to disappear, and prints `{"stopped": true}`. A missing `fixture.json` or a pid that is no longer running prints `{"stopped": false}` and exits 0. Exit 1 when the home still exists after 30 s.
- `CONTRACT:` exported for tests: `parseFixtureArgs(argv: string[]): FixtureCommand` (throws `UsageError` with a message on bad input) and `seedEnvironment(info: FixtureInfo, repoRoot: string): Record<string, string>`.

### companion.ts

`COMMAND:` `bun scripts/redesign/companion.ts locate`
`COMMAND:` `bun scripts/redesign/companion.ts start <session-dir>`
`COMMAND:` `bun scripts/redesign/companion.ts show <session-dir> <screen.json>`
`COMMAND:` `bun scripts/redesign/companion.ts wait <session-dir> [--timeout <seconds>]`
`COMMAND:` `bun scripts/redesign/companion.ts stop <session-dir>`

- `locate` prints `{"companion": "<absolute path>"}`. Search order, first existing file wins:
  1. `$CLAUDE_PLUGIN_ROOT/skills/writing-html-artifacts/scripts/companion.py`
  2. the newest version directory (by `semver`-like numeric compare of dot-separated parts) matching `~/.claude/plugins/cache/*/quirk/*/skills/writing-html-artifacts/scripts/companion.py`
  3. each entry of `~/.claude/plugins/known_marketplaces.json` (an object keyed by marketplace name) whose `source.source` is `"directory"`, at `<source.path>/skills/writing-html-artifacts/scripts/companion.py`. A missing or malformed file skips this step rather than failing.
  Exit 2 with `{"error": "companion-not-found", "searched": [...]}` when none exists.
- `start`, `wait` and `stop` run `python3 <companion> <cmd> <session-dir> ...` and pass its stdout and exit code through unchanged.
- `show` reads the screen JSON, replaces every placeholder in string values, writes the result to `<session-dir>/built/<screen basename>`, then runs `python3 <companion> show <session-dir> <built path>` and passes its stdout and exit code through.
  - `REGEX:` placeholder `\{\{img:([^}@]+)(?:@(\d+),(\d+),(\d+),(\d+))?\}\}`. Group 1 is a path relative to the screen file's directory, or absolute. Groups 2-5 are an optional crop `x,y,w,h` in image pixels, done with `sips --cropOffset <y> <x> -c <h> <w>` into a temp file.
  - The replacement is `data:<mime>;base64,<...>` with the MIME from the extension (`png`, `jpg`/`jpeg`, `webp`, `svg`).
  - A missing image, a crop on a non-macOS host, or a built screen over 8 MB exits 2 with `{"error": "...", "path": "..."}` before calling the companion.
- `CONTRACT:` exported for tests: `locateCompanion(env: {CLAUDE_PLUGIN_ROOT?: string, HOME: string}): string | null` and `inlineImages(screen: unknown, screenDir: string, crop?: CropFn): unknown` (returns a new value; `CropFn` defaults to the `sips` crop).

### score.ts

`COMMAND:` `bun scripts/redesign/score.ts run --plugin <id>... --out <dir> [--author-family anthropic]`
`COMMAND:` `bun scripts/redesign/score.ts gate --before <scores.json> --after <scores.json> [--removed <surface-id>]...`

- `run` creates `<dir>` (it must not exist), runs `bun scripts/ui-review.ts --author-family <family> --output <dir>/ui-review --threshold 85` plus one `--only <id>` per `--plugin`, then reads `<dir>/ui-review/review-report.json` and writes `<dir>/scores.json` (`Scores`). ui:review's exit 1 (below threshold) is not a failure here, because a before pass expects low scores; `run` exits 0 when `review-report.json` exists with `status` `passed` or `failed`, and 2 otherwise (ui:review exit 2, missing report, or `status: "error"`), copying ui:review's last stderr lines into `{"error": ...}`. `--author-family` defaults to `anthropic`, since redesigns are built by Sonnet.
- A surface whose capture has `assessment.targetVisible: false` gets `null` for that theme.
- `gate` compares two `Scores` and prints `GateReport`. Per surface id in either file:
  - in before and after: `clears` when both after themes are ≥ 85 and each is ≥ the same theme's before score; else `fails` with one reason per broken rule (for example `light 84 below 85`, `dark 87 below before 89`). A `null` after score fails with `dark not captured`.
  - only in after: `new`, clears when both themes are ≥ 85.
  - only in before and listed in `--removed`: `removed`, never scored.
  - only in before and not listed: `fails` with `missing after`.
  - `passed` is true when no surface `fails`. Exit 0 when passed, 1 when not.
- `CONTRACT:` exported for tests: `scoresFromReport(report: unknown, plugins: string[]): Scores` and `applyGate(before: Scores, after: Scores, removed: string[]): GateReport`. Threshold is the constant `SCORE_FLOOR = 85`.

### comparison.ts

`COMMAND:` `bun scripts/redesign/comparison.ts <spec-folder> <comparison-data.json>`

- Reads `ComparisonData`, writes `<spec-folder>/comparison.md`, prints `{"written": "<path>"}`. Exit 2 on invalid data (the message names the first bad field).
- Page order:
  1. `# <feature>: before and after`
  2. When `failures` is non-empty, `## Still failing` listing each failure. This section is first so the PR's first link opens on it (SC-23a).
  3. `## Goals`: a table `Goal | Before | After | Result`. Image cells are `<img src="<relative path>" width="420">` so GitHub renders them side by side; an absent screenshot is `none`. Result text: `✓ replayed`, `✗ failed: <reason>`, `cut: <reason>`, `not replayed: <reason>`.
  4. `## Scores`: `Surface | Before (dark / light) | After (dark / light) | Result`, from the embedded `GateReport`; `none, new` for a surface with no before; `removed` for removed.
  5. `## Capabilities`: `Capability | Decision`, with `kept`, `moved to <where>`, or `cut: <reason>`.
- `CONTRACT:` exported for tests: `renderComparison(data: ComparisonData): string`.

## Data models / schemas

`SCHEMA:` all in `scripts/redesign/contracts.ts`; scripts and tests import from there.

```
SCHEMA:
type Theme = 'dark' | 'light'
type GoalTag = 'fixture' | 'real-app'
type Goal = { id: string; title: string; tag: GoalTag }            // goals.json is Goal[]; ids g1, g2, ...
type SpecFolderStatus = {
  checkout: 'main' | 'worktree'; branch: string
  folder: string; exists: boolean
  files: Record<'current-state.md' | 'goals.json' | 'seed.sh' | 'logic.md' | 'tech.md' | 'comparison.md', boolean>
  resumeAt: 'before-pass' | 'brainstorm' | 'build' | 'done'
}
type Surface = { id: string; kind: string; title: string; scoreable: boolean }
type SurfaceCandidate = { pluginId: string; pluginName: string; score: number; alsoPlugins: string[]; surfaces: Surface[] }
type SurfaceResolution = { query: string; status: 'one' | 'many' | 'none'; candidates: SurfaceCandidate[] }
type FixtureInfo = {
  url: string; port: number; home: string; pid: number
  repos: { primary: string; worktrees: Record<string, string>; projects: Record<string, string> }
}
type SurfaceScore = { id: string; plugin: string; dark: number | null; light: number | null }
type Scores = { createdAt: string; plugins: string[]; reportPath: string; surfaces: SurfaceScore[] }
type GateRow = {
  id: string; before: { dark: number | null; light: number | null } | null
  after: { dark: number | null; light: number | null } | null
  result: 'clears' | 'fails' | 'new' | 'removed'; reasons: string[]
}
type GateReport = { passed: boolean; floor: number; rows: GateRow[] }
type GoalOutcome = {
  id: string; title: string; tag: GoalTag
  before: string | null; after: string | null                     // screenshot paths relative to the spec folder
  result: 'replayed' | 'failed' | 'cut' | 'not-replayed'; reason?: string   // reason required unless replayed
}
type Capability = { name: string; decision: 'kept' | 'moved' | 'cut'; where?: string; reason?: string }
type ComparisonData = { feature: string; failures: string[]; goals: GoalOutcome[]; gate: GateReport; capabilities: Capability[] }
```

`FixtureInfo.repos.worktrees` maps worktree name (`ui-review-ready`, `ui-review-notes`) to path; `projects` maps project name (`ui-review-fixture`, `harbor-api`, `ledger-web`) to path; `primary` is the primary worktree path (web-fixture.ts's `repo`).

Spec-folder files written by the skill (not by scripts) and their shapes:

- `goals.json`: `Goal[]`, passed straight to likeuser's `--goals-file`.
- `seed.sh`: a bash script run by `fixture.ts seed`. It may use `git` and `$REDESIGN_QUIRKY`, and must be idempotent against a fresh fixture only (it is never re-run on the same fixture).
- `scores/before.json` and `scores/after.json`: `Scores` copied out of `score.ts run`'s output dir (ui:review's raw output stays in the scratchpad, not the repo).
- `comparison-data.json`: `ComparisonData`, committed beside `comparison.md` so the page can be rebuilt.

`CONFIG:` variables `fixture.ts seed` sets for the seed script:

| Variable | Value |
|---|---|
| `REDESIGN_FIXTURE_JSON` | absolute path of `fixture.json` |
| `REDESIGN_REPO` | `repos.primary` |
| `REDESIGN_WORKTREE_<NAME>` | each `repos.worktrees` path, name upper-cased with `-` → `_` (`REDESIGN_WORKTREE_UI_REVIEW_READY`) |
| `REDESIGN_PROJECT_<NAME>` | each `repos.projects` path, same naming |
| `REDESIGN_QUIRKY` | `<process.execPath> <repoRoot>/packages/cli/src/main.ts`, for `$REDESIGN_QUIRKY worktree create ...` against the fixture daemon |
| `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, `GIT_COMMITTER_EMAIL` | `Redesign Fixture`, `redesign-fixture@localhost` |

## DO-NOT-CHANGE fences

- `scripts/ui-review/**`: the score gate depends on ui:review's report shape and 85 default, and other plans use it. Call it; don't edit it.
- `packages/daemon/src/plugins/tool-layout.ts`: only the `export` keyword on `RULES` may change. The table drives every user's tool layout.
- `scripts/test-support/process-scope.ts` and `packages/protocol/**`: shared by every test in the repo.
- `/Users/zpyoung/PycharmProjects/PERSONAL/quirky/.git/qa-loop/harness/*`: the QA loop still uses it. Copy from it; never edit or move it.
- The quirk plugin's files (companion.py, likeuser.py): they're another repo. Wrap them; never patch them.

## Always / Ask / Never

Always:
- Keep stdout to one JSON object per invocation, so the skill can parse every script the same way.
- Run every subprocess with an argument array, never a shell string built from input.
- Clean up a fixture's home on every exit path of `start`, including a failed start.
- Put the standing rules at the top of `SKILL.md`, inside its first 5,000 tokens, since that's all compaction keeps.

Ask (Tier 2, with the stated default):
- A script needs a flag or field not pinned here. Default: add it, and note it in the task report so the docs task can mirror it.

Never:
- Let `fixture.ts seed` pass the caller's environment to the seed script.
- Run the full test suite, locally or on OVH (AGENTS.md).
- Write ui:review's raw output into the repo.

## Cross-cutting

- Isolation is the one security property that matters: the fixture and the seed script must never reach `~/.quirky` or your running daemon. `seedEnvironment` and `createIsolatedRuntimeEnvironment` are the guard, and the fixture test checks it.
- Real-app steps (SC-9, SC-20) are prose in the references, not scripts, and each is behind a companion screen.
- No migration or rollback: the scripts are new and nothing else imports them.

## The skill files

`SKILL.md` (aim under 200 lines; hard cap 500):

- Frontmatter: `name: redesigning-features`; `description` starting "Use when redesigning how an existing Quirky desktop feature works and looks..." naming the triggers ("redesign the X feature", `/redesigning-features <feature>`) and the exclusions (new features, mobile, visual-only restyles); `argument-hint: <feature>`.
- `## Standing rules` comes first, before anything else. It must hold:
  1. Every question goes on the companion page via `scripts/redesign/companion.ts`; never Quirky Ask, never chat. (This repo's sessions otherwise default to Quirky Ask, so state it explicitly as the override for this skill.)
  2. Your stops are only the four in [Your stops](logic.md#your-stops); between spec approval and the PR the only stop is the after pass's real-app go-ahead.
  3. The fixture and seed never touch your Quirky; real-app steps only after their screen says yes.
  4. Goals pass only on likeuser evidence that their effect happened, never on a screenshot's look.
  5. Tests: targeted files only; the full suite only through the draft PR's `full-suite` label (AGENTS.md).
  6. When SDD's final loop exits, run the after pass instead of `quirk:finishing-a-development-branch`.
  7. After compaction, find the phase from the conversation and the spec folder's files (`spec-folder.ts`), then re-read that phase's reference before acting.
  8. The run's fixed values: worktree `<slug>-redesign`, spec folder from `spec-folder.ts`, screenshots 1280×720 dark with the feature's tools open, score floor 85.
- Then a phase table: phase, reference file, the files it must leave in the spec folder, and its exit check.

References: each opens with what the phase needs on entry and what it must leave behind, then numbered steps citing the exact commands above. Specific content each must carry:

- `setup.md`: run `spec-folder.ts`; on `main`, create the worktree with `quirky worktree create <slug>-redesign --agent claude --prompt "/redesigning-features <feature>" --submit-prompt --activate`, report, stop (SC-2). Start the companion with session dir `.quirk/brainstorm/<slug>-redesign/`. Resolve with `surfaces.ts`; `many`/`none` → candidates screen (SC-3). `exists` with files → the continue-or-start-over screen listing them (SC-4); start over runs `git rm -r` on the folder and commits.
- `before-pass.md`: the surfaces-and-goals screen (SC-5) with goals tagged; write `goals.json`; write `seed.sh`, start the fixture with the feature's panels `--open`, seed, walk with likeuser (`begin --target <url> --surface web --owner yours --unattended --goals-file goals.json`); screenshots to `img/current/NN-slug.png`; a failing goal is a bug with `file:line` (SC-8); real-app screen (SC-9); `score.ts run` into scratch then copy `scores.json` to `scores/before.json` (SC-10); the `current-state.md` template with the seven sections of SC-11; commit; `fixture.ts stop`.
- `brainstorm.md`: the exact brief to pass when invoking `quirk:brainstorming`, carrying the SC-12 presets, and the three sections `logic.md` must gain: `## Capabilities` (every item from current-state.md, kept/moved/cut), `## Redesign checks` (goals with any removed, before scores, the two gates, real-app goals), `## Walk bugs` (fixed or filed with link) (SC-13 to SC-15).
- `build.md`: the brief for `quirk:subagent-driven-development`: preflight answers preset (`claude-task + codex`, no card), spec format already markdown, targeted tests only, full suite only via the PR, Redesign checks pasted into the spec lens's criteria, and the rule that the final loop's exit hands back to the after pass (SC-16).
- `after-pass.md`: build and start a fresh fixture from the branch, same seed, replay with likeuser into `img/after/`; cut goals skipped with the spec's reason (SC-18); `score.ts run` then `score.ts gate --removed ...` (SC-19); real-app screen with the daemon warning, the `which hutch` check before `bun run dev`, and how to get your Quirky back (quit the dev shell, relaunch `~/Applications/Quirky.app`) (SC-20); up to two fix rounds through the build pairing (SC-21); write `comparison-data.json`, run `comparison.ts` (SC-22); commit, push, `unset GITHUB_TOKEN`, `gh pr create --draft`, `gh pr edit <n> --add-label full-suite`, description failures-first, `companion.ts stop`, report the link (SC-23).

## Testing strategy

One test file per script, beside it, run with `bun test <file>` on this Mac:

| Test file | Must cover |
|---|---|
| `scripts/redesign/spec-folder.test.ts` | main vs worktree in temp git repos; newest dated folder wins; `resumeAt` for empty, current-state only, current-state + logic, all; bad slug exits 2 |
| `scripts/redesign/surfaces.test.ts` | against the real `plugins/`: "changes" → `status: "one"`, top candidate `quirky.git` with `alsoPlugins` `["quirky.sidebar-extras"]`, and the Changes panel, `View All Changes` command and AI settings view among its surfaces; "source control" → `status: "one"`, top candidate `quirky.git`; a nonsense word → `none` with 5 candidates; a word shared by two plugins → `many` |
| `scripts/redesign/fixture.test.ts` | `parseFixtureArgs` cases; `seedEnvironment` contains no `QUIRKY_SESSION_ID`, `QUIRKY_WORKTREE_ID` or `QUIRKY_HOOK_*` and has `HOME`/`QUIRKY_HOME` under the fixture home; one integration case (timeout 300 s): `start` writes `fixture.json` with every `repos` path existing, `seed` runs a script that commits in `$REDESIGN_REPO`, `stop` removes the home |
| `scripts/redesign/companion.test.ts` | `locateCompanion` order with fake directory trees for each of the three sources and none; `inlineImages` replaces nested placeholders, leaves other strings, errors on a missing file; crop case skipped unless `process.platform === 'darwin'` |
| `scripts/redesign/score.test.ts` | `scoresFromReport` from a fixture report (both themes, an invisible target → null); `applyGate` for every row result in SC-19's example table plus `removed`, `missing after` and a `null` after |
| `scripts/redesign/comparison.test.ts` | failures-first ordering; no "Still failing" section when empty; every result kind's cell text; image cells; invalid data exits 2 naming the field |

The skill files have no automated test. Per the logic spec, the skill itself is tested by its first real run.

Typecheck: `bunx tsc --noEmit -p tsconfig.json` must pass.

## Non-goals

- No changes to ui:review, likeuser, the companion server or brainstorming/SDD themselves.
- No viewport change for ui:review: it keeps 1400×880 against its goldens. The 1280×720 rule applies to the walk screenshots only.
- No real-app automation script; real-app steps stay as instructions behind a confirmation screen.
- No `hutch` install. The after pass detects its absence and reports it (SC-20b).
- No run-state file. `spec-folder.ts` reads deliverables the logic spec already requires, and never records a phase.
