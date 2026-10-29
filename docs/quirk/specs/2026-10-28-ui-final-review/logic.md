# UI final review: one visual comparison page

Status: Approved autonomously under the unattended LOOP protocol, 2026-10-28. Parent authority: [approved desktop redesign](../2026-10-28-ui-redesign/logic.md), rollout row ui-final-review.

## Purpose and conceptual model

The user gets one durable, repository-local review page containing genuine before/after renderer screenshots for every redesign rollout area, in dark and light. This is an evidence/documentation item, not another restyle, test campaign, independent model score or sign-off on behalf of the user.

An area is one rollout group: shell, terminal/terminal-dock, editor, git/reviews/checks, browser, worktree/repo, agents/agent-status/session/session-info, orchestration/heimdall/handoff/loops, tasks/automations, ledger, accounts/vault, and mobile/cli/palette/sidebar-extras/Settings, plus ask/notifications/structured. Captions identify individual contributions, fixture state, theme, source revision and limitations. Existing approved goldens are linked separately.

## Decisions locked

- Structure: one Markdown review page with local PNG/WebP assets, before/after columns, dark and light subsections, and a source manifest. Markdown uses the viewer's standard components; no custom CSS, alternate token set, product UI or runtime controls are introduced.
- Density: images retain readable native resolution through links to the originals. Each area is navigable from a compact linked index.
- Evidence: use existing genuine capture evidence when provenance is available; historical recaptures are explicitly labeled as recaptures, never original contemporaneous evidence. Do not recolor, synthesize or reuse a golden as an actual app screenshot.
- Versioning: identify exact historical and after commits; nonidentical fixtures must be disclosed, not presented as pixel-diff baselines. No assertion that a capture from an earlier area branch represents the final merged renderer.
- Errors/empty states: real settled empty states are acceptable and named. A loading screen, failed mount or native-only blank is not evidence of the intended area. Missing evidence remains explicit and prevents a claim of complete coverage.
- Interactions: the page has only navigation and original-image links. This item changes no application behavior, plugin registrations, shortcuts or styling.
- Safety: capture only disposable local fixture state with owned processes/browser profiles and isolated provider/Keychain boundaries. No real credentials or history are captured.

## Scenarios and acceptance

1. Opening the page shows what is compared, source revisions, the area index and explicit evidence limits. Example: Terminal → dark before and after → light before and after, each original accessible from its thumbnail.
2. Every rollout area has actual before and after screenshots in both themes. Multi-plugin groups identify all named contributions either in separate captures or visibly combined surfaces. Example: Accounts settings and Vault history are not represented by an unrelated shell image.
3. Before/after attribution is inspectable in a manifest containing image path, SHA-256, theme, area/contribution and source revision or recorded source qualification. Historical source and current source use real renderer output without CSS overrides.
4. The complete review page and assets are committed and portable: no absolute workstation paths are required to view its images. Golden references remain clearly marked as design references, not runtime evidence.
5. UI lint and full repository typecheck pass. No suite, formal review, scoring campaign or broad dogfood is run under build-first; capturing the requested artifact is not a pass claim for product behavior.

No Orca defect is repaired by this documentation-only item. Inherited native/GPU/fixture limitations are retained in captions and decisions.

## Scope and non-goals

Includes the final comparison artifact, local evidence assets, this spec and the item decision log. Excludes product/script source edits, UI fixes, new feature flows, phone app restyling, native OS-window chrome certification, independent golden scoring, suite execution and approval on the user's behalf.

## Industry insights

No external research swarm under LOOP build-first. Repository authority: parent approved spec rollout and scope; ui-screenshot-review D2/D3/D5/D8/D10; prior area decision logs. Real fixtures and explicit image provenance avoid conflating mockup quality with shipped pixels.

## Deferred ideas

None. If a source limitation makes a required comparison unreachable, record exact evidence and use the LOOP block/defer protocol rather than substitute fabricated screenshots.

## Glossary

Before: historical renderer evidence preceding the relevant restyle. After: renderer evidence with all restyles integrated, unless explicitly qualified. Golden: approved design reference, not an app capture. Review page: the single Markdown document and its linked image files.

## Technical decisions and contracts

- Artifact root: `docs/loop/reviews/ui-final-review/`; entry page `index.md`; local images under `images/`; provenance `manifest.json`.
- Manifest schemaVersion 1; sources identify git revisions and capture mechanism; each image records relative path, sha256, area, surface, theme and phase (`before`/`after`). No runtime tokens, private home files or credential metadata are retained.
- Shared public UI signatures are unchanged; no schema/API contracts need edits. This spec is committed before delegated artifact/capture work.
- Parent owns integration, decisions and landing. Up to three workers own disjoint evidence/artifact slices; throwaway harnesses stay outside tracked source. No worker runs tests/lint/typecheck/formatters, commits or edits protected loop paths.
- Verification: existing capture commands or disposable public-API fixture drivers produce actual renderer images; then local image/link/provenance checks and `bun run ui:lint` / `bun run typecheck`. Sole planned catch-up is `git merge build/roadmap` immediately before land; recovery only after canonical controller refusal.

## Status & amendments

2026-10-28: Initial self-review: all parent rollout areas enumerated; no missing evidence may be called complete; Markdown intentionally avoids introducing another UI implementation. One combined logic/tech spec as required by LOOP build-first.
