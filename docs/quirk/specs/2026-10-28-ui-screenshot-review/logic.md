# Fixture-backed desktop screenshot review

**Status:** Autonomous implementation approval under LOOP.md; derives from the approved [desktop redesign](../2026-10-28-ui-redesign/logic.md).

## Why and conceptual model

Restyle lanes need a repeatable visual gate, not another source of screenshots to inspect manually. A run starts the real Quirky daemon and desktop renderer against disposable Git worktrees. It discovers the live contribution registry, opens each requested surface, and captures its full viewport in both themes. A separate vision-model process compares each image to the approved same-theme golden and returns a structured, evidence-linked score.

The command is repository developer tooling, not a shipped plugin feature. It does not introduce plugin UI or public daemon APIs. Existing public contribution, layout, theme and workspace APIs drive the real app. It is intentionally separate from the native-window/nightly harness: OS chrome, focus and native browser embedding are not inferred from renderer screenshots.

## Key decisions and rationale

- Use browser automation of the actual daemon-served desktop renderer, not mocked components or foreground native automation. This is the URL the desktop window loads.
- Discover surfaces from `ui.contributions`; do not maintain a plugin allowlist. Existing panels/sidebar/activity contributions are today's tools. Include views, overlays, settings sections and host shell/settings/palette. Future shell-slot registrations must preserve discovery or extend this adapter when the public model changes.
- Use real local Git fixtures with several worktrees, an edited source file and sample editor assets. Fixtures are inert: no provider login, hook installation, remote network repository, or automation execution.
- A complete run means every discovered target has both dark and light images. A selected area run is explicitly filtered and reports its exact inventory; it never certifies the whole app.
- Use independent vision review rather than pixel diffs because the approved goldens depict a combined screen and plugin content legitimately varies.

Rejected alternatives: screenshot mock stories omit actual mounting/state; pixel equality against the combined golden rejects legitimate content; native foreground automation conflicts with unattended web-surface policy and requires permissions unrelated to styling.

## Command behavior

`bun run ui:review -- --author-family openai --output /absolute/new/report-directory`

- Default mode builds the actual UI bundle, seeds a fresh isolated app, captures all surfaces in both themes, reviews every capture, writes JSON and prints an evidence summary.
- `--only` is repeatable and matches an exact contribution ID or exact plugin ID (host targets have IDs `host:shell`, `host:settings`, `host:palette`). Unknown/empty selection is an error. Filters never suppress a failure within the selected inventory.
- `--threshold` accepts a finite number from 0 to 100, default 85. Every image must meet it, not just the aggregate.
- `--reviewer` chooses a pi-watch alias, default `gemini`; `--author-family` declares the implementer's family and is required. The resolved reviewer family must differ. No silent model fallback chosen by this command; pi-watch resolves only within the explicit alias ladder and the resolved identity is recorded.
- `--skip-build` uses existing UI assets only if present. `--browser` can point to an installed Chromium-family executable; otherwise the installed Playwright Chromium is used. Missing browser/assets/reviewer produce actionable errors.
- `--capture-only` produces capture evidence without model review and reports `not-reviewed`; it never emits a visual-pass claim. A separate `--manifest` review-only mode reviews an existing capture manifest without launching the app, after validating image digests and coverage.
- `--help` describes prerequisites, flags and exit codes without starting anything.
- Exit 0: requested capture-only inventory captured successfully, or every requested image reviewed and passed. Exit 1: coverage/capture/mount/visual-score failure. Exit 2: invalid arguments, missing prerequisites, malformed/tampered evidence, failed reviewer or unexpected runtime failure. Capture-only output is distinctly not-reviewed even though successful capture exits 0.
- Review-only validation failures are returned in `review-report.json` with status `error` and no accepted captures; `ui-review-result.json` records exit 2 and the diagnostic. `ui-review-error.json` is reserved for thrown runtime failures or interruption. Reviewer subprocesses explicitly inherit the current process environment, including runtime configuration changes.

## Scenarios and acceptance criteria

1. **Full capture:** Given an installed browser and built/in-buildable app, run the command without filters. All discovered code-backed UI surfaces and host targets appear in the manifest; every one has exactly one dark and one light capture. New plugin contributions are discovered without editing a hand-maintained list.
2. **Scoped restyle:** Given `--only quirky.tasks`, only matching targets are reviewed, in both themes. The output says filtered and lists exact target IDs. Unknown selectors fail rather than yielding an empty success.
3. **Real fixture state:** The Worktrees UI shows the disposable repository and multiple real Git worktrees; the file/changes surfaces can show actual fixture content. No real project/home/provider configuration is read or written by the app. A source/editor view receives valid fixture input; input-requiring views without support are explicit failures, never pictures of the wrong view.
4. **Dark/light:** Capture dark then light through the real theme API; verify the active theme/appearance before each capture. Same-theme golden paths/digests accompany each image. No CSS override that paints a fake theme.
5. **Mount failure:** A contribution that errors, never mounts, is hidden/zero-sized, or requires unavailable native functionality is named in failures. Its diagnostic image may be retained, but it cannot count as a successful coverage row or passing visual score. Genuine empty states are valid rendered UI and are reviewed; a missing required view input is not an empty-state substitute. Wait until visible loading content settles before capturing.
6. **Independent scoring:** For each image, the reviewer reads both the actual image and matching golden. It scores palette, typography, spacing/density, shared-component consistency and visual hierarchy independently on 0–100 and supplies concrete reasons. Content differences are allowed; structural/style drift and missing target UI are not. The computed mean is the image score.
7. **Threshold:** With threshold 85, an image scoring 84 fails even if every sibling scores 100. Exactly 85 passes. Missing dimensions, non-finite/out-of-range scores, absent image confirmation or malformed JSON fail as reviewer errors.
8. **Evidence integrity:** Report paths link captures and references by SHA-256. Review-only refuses replaced/missing images, duplicate target/theme rows, missing theme pairs or mismatched golden references. Partial/failed capture runs cannot become passing reports.
9. **Isolation and cleanup:** Success, setup failure, screenshot failure, model failure and SIGINT/SIGTERM clean up the owned daemon/PTY/browser and temporary fixture/config homes. Preserve only the explicit output directory; never store runtime tokens there. Existing output directories are not overwritten. Unrelated processes remain untouched.
10. **Current unre-styled app:** Low scores are expected evidence of present styling, not a reason to alter goldens, lower thresholds automatically or restyle this item's dependencies.

Example: `quirky.tasks/panel` yields dark=91 and light=82. Threshold85 produces report status failed and exit1. Both screenshots, image/reference digests, reviewer identity and light-theme reasons remain available; no daemon or fixture home survives.

## Scope and non-goals

In scope: command, disposable real fixtures, dynamic capture inventory, strict scoring/coverage gates, machine-readable evidence, safe cleanup, authored behavioral tests, usage documentation.

Non-goals: restyling any plugin/shell, changing public plugin APIs, changing approved goldens, native OS chrome/notifications/focus validation, phone app, running automation/provider processes, pixel-diff baselines, approving current app styling. A native-only contribution unavailable in renderer capture is explicitly failed, not silently certified.

## Decisions Locked

- Approved golden PNGs are read-only references.
- Default threshold85 applies per image; configurable explicit threshold is recorded.
- Real daemon/public APIs and fixture Git worktrees; no mocked app.
- Fail closed on missing targets, missing themes, malformed scores and unavailable reviewers.
- Separate model family and explicit identity; no same-session visual score.
- Short disposable application home, isolated ambient config/Git state, owned-process cleanup.
- No new UI styling; shared components/tokens remain the only UI building blocks.

## Industry Insights

Research swarms omitted under LOOP.md's build-first override. Sources are the approved redesign's Industry Insights, the live contribution registry, existing desktop daemon URL, and existing owned-process isolation helper. This item adds no independently researched visual language.

## Deferred Ideas

None. Native-window evidence remains owned by the existing native harness and is not represented as a renderer pass.

## Glossary

- Target: one registered code-backed UI surface or one explicit host surface.
- Capture: full renderer-viewport PNG with target, theme, readiness and digest.
- Golden: approved combined dark/light screen, not an app screenshot baseline.
- Coverage: exact selected targets crossed with both themes, with no skipped/duplicate cells.
- Independent reviewer: separate vision-model process from a different author family.

## Tech decisions and shared contracts

Use Bun/TypeScript developer scripts under `scripts/ui-review/`, Playwright Chromium as a development dependency, `connectDaemon` from `@quirky/protocol/node` for authenticated public RPC with explicit isolated home and autostart disabled, and `createProcessScope` for owned child cleanup. The renderer is built by `packages/ui/build.ts`; do not alter application/plugin UI solely to expose screenshots. Use the existing public layout/theme APIs and observable DOM slot/readiness state. Bound browser/RPC/model operations; stop and clean up in `finally`, including signal-triggered cancellation.

Shared type-only contract lives at `scripts/ui-review/contracts.ts` and is committed before implementers. `captureApplication(options)` returns a complete or explicitly failed `CaptureManifest` after cleanup; it writes evidence beneath a caller-created output directory. `reviewManifest(manifest, options)` validates immutable evidence and returns a `ReviewReport`. The CLI owns parsing, fresh output allocation, capture/review selection, JSON/report output and exit-code mapping. No module executes a run merely when imported.

Implementation partitions: capture/fixture lifecycle; independent reviewer/coverage validation; CLI parsing/orchestration/tests. They share only the committed contracts. Parent owns package/lock integration, item docs and final verification. Behavioral tests cover real score boundaries, evidence tampering, duplicate/missing coverage, family mismatch, unknown selection and failure cleanup; no source-text or incidental-wording tests.

## Status & amendments

Autonomously approved 2026-10-28 under LOOP.md. Self-review: every parent-spec rollout criterion has an explicit scenario above; no questions remain. Build-first uses this combined spec instead of a sibling tech document or review pass.

**Amendments:** 2026-10-28: corrected the tech-only client import to the repository's existing `connectDaemon` helper; no `@quirky/client` package exists. Clarified that genuine empty states are captureable UI, as the parent spec requires, while missing required inputs and loading placeholders are not valid final captures.
