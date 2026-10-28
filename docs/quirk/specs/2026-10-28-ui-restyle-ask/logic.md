# Ask, Notifications and Structured graphite presentation

**Status:** Approved parent design applied autonomously under the unattended build loop, 2026-10-28. One combined logic/technical spec under build-first rules.

## Goal and conceptual model

Migrate every desktop surface owned by `quirky.ask`, `quirky.notifications` and `quirky.structured` to the existing shared graphite components and semantic tokens. The shell still owns placement, tool frames, center tabs and transient attention. Plugin panels retain their existing IDs, public API, state and actions. Ask remains the right-top tool; Inbox remains host-owned in left-bottom; structured conversations retain their current center-view ownership. Settings remain sections in the global Settings window.

## Scope and non-goals

In scope: question cards and their six input kinds, option/preview/error/loading/history presentation, notification preferences and feedback, structured conversation messages/approvals/status/settings, all plugin UI styles and lint enrollment.

Not in scope: changes to ask admission, validation, defaults/deadlines/FIFO/draft debounce, structured provider transports/account preparation/resume/admission, notification policy/delivery/marker persistence, APIs, CLI, shortcuts, shell slot persistence, phone UI, native banners or new features. No new launcher or parallel Inbox/toast authority.

## Data flow and invariant contracts

Existing hooks and daemon RPCs remain the state authority. Shared controls render the same controlled values and invoke the same handlers. Ask submit still uses validated envelopes and failed submissions retain the question. Notification preferences continue to use canonical settings; test feedback does not bypass delivery policy or create unread markers. Structured approvals still pass through the existing Ask path and cancellation/invalid responses deny. Theme appearance comes from inherited shared dark/light tokens, not plugin theme state.

Formatted Ask previews retain the later sanitized, inert-link behavior in `fix-test-ask-1028` D1/D4/D8–D9, rather than reverting to the earlier plain-text preview proposal in `m2-ask-parity` D17. No navigation-capable URL attributes or unsanitized execution are introduced.

## Behavior and acceptance scenarios

### SC1: Read and answer an Ask

Before: a surfaced pending ask with title, description, required/optional questions and saved draft; later questions remain queued by the daemon.
Walkthrough: open Ask, read formatted preview, edit each supported input, see validation feedback and submit or decline through existing controls.
After: identical canonical answer/draft semantics and option values; controls use shared components, readable tokens and accessible names. Failed submission remains available. Inert preview links cannot navigate. New asks do not steal selected panel or worktree.

### SC2: Empty, loading and error states

Before: a plugin has no visible data, an in-flight request, or an existing error.
Walkthrough: open the tool/view or Settings section.
After: shared EmptyState/status/error presentation preserves existing recovery actions and copy meaning; no fabricated data, success or working status. Long question/option/message text wraps and scrolls without hiding actions.

### SC3: Notification preferences and feedback

Before: canonical notification settings with enable/source/focus/tray/sound/volume values.
Walkthrough: change a preference, choose a supported/custom sound where available, use the test control.
After: existing saved values and visible feedback remain; shared form controls replace local CSS. No new banner delivery path, changed defaults, unread writes or OS side effect is added by rendering.

### SC4: Structured conversation and approvals

Before: a structured conversation in its existing view with messages, status, available controls and optionally an approval.
Walkthrough: read messages, type/send using the existing form, inspect status and approval controls.
After: same message ordering, streaming, errors, cancellation and fail-closed approval authority. Long output remains selectable/readable and controls remain reachable; no provider execution is needed for presentation fixtures.

### SC5: Shared appearance and enforcement

Before: dark or light host appearance and any default tool placement.
Walkthrough: render the three plugin surfaces and switch appearance.
After: all colors, typography, spacing, borders and controls derive from the shared system. No plugin stylesheet, raw color or raw pixel size remains. The three plugin IDs are in `scripts/ui-lint-plugins.json`; `bun run typecheck` enforces them. No duplicate tool frame is added inside a host-owned frame.

## Key decisions and alternatives

1. Recommended: reuse shared controls with token-only structural inline layout, retaining handlers and hooks. Rejected CSS-only recoloring leaves duplicate control styling; rejected feature rewrite risks admission/delivery/provider behavior.
2. Preserve current information hierarchy, comfortable density and scrolling. Do not hide fields, errors, advanced controls or historical content to approximate a golden shell screenshot.
3. Use existing loading/empty/error actions and honest statuses. Do not add retries, telemetry, validation rules or timeouts.
4. Three disjoint plugin presentation components, parent-owned lint/dependency/docs integration. No public signature changes are required; existing exported component props and schemas are the committed contract.

## Decisions locked

- Approved parent `../2026-10-28-ui-redesign/logic.md`: graphite dark/light, semantic tokens/shared components, default slots and unchanged feature behavior.
- Ask durable questions, six types, 500ms saved drafts, FIFO/deadlines and exact-session presentation remain unchanged.
- Notification marker/viewed and delivery gates remain daemon-owned; asks/tests do not create unread markers.
- Structured provider ownership, native account environment and fail-closed approvals/resume remain unchanged.
- Build-first LOOP overrides standalone review/test/dogfood/screenshot-score gates. Do not report unrun gates as passed.

## Industry insights

The approved parent design and existing shared component API are the research for this item; no external research swarm under build-first rules. Source and rationale are linked in the approved parent design's Industry Insights section.

## Deferred ideas

None. No new flows or APIs are proposed.

## Glossary

- Tool: shell-owned slotted panel contribution.
- View: existing center content contribution.
- Inert preview: sanitized formatted content with non-navigating links.
- Build-first: typecheck-only landing gate; authored behavioral tests remain unrun.

## Technical decisions and implementation contract

Use the `@quirky/ui` public exports and `--ui-*` semantic tokens. Reuse Button/IconButton/TextField/TextArea/SelectField/FormRow/Tabs/Badge/StatusDot/SectionHeader/EmptyState/Dialog as appropriate. Native checkboxes/radios remain semantic children of shared form rows when no dedicated shared primitive exists. Structural inline layout may use unitless flex/grid values, percentages and shared tokens, never local CSS strings or raw pixel/color literals.


The actual Structured transcript is owned by `quirky.session/src/window/StructuredView.tsx` and `MessageRow.tsx`. Lane1 already restyled and committed these and their behavioral test in `6c1b22c9`; reuse that committed source through the final roadmap catch-up, rather than dispatching a duplicate writer. The concurrent `ui-restyle-agents` owner retains the remaining Session UI and full Session lint enrollment.

Shared additive contract: `ReadOnlyPreview({ sanitizedHtml: string, title: string })` in `@quirky/ui/read-only-preview` owns the static iframe document stylesheet, inherited dark/light theme, fixed networkless/scriptless CSP and empty sandbox. Ask retains its existing sanitizer and passes only its sanitized HTML. This isolated public subpath keeps the CSS-text import out of the host's stylesheet module graph. No root re-export or compatibility alias remains.
No schema/type/API signature change, store migration or protocol cutover. No new shared abstraction unless an actual missing shared primitive prevents faithful presentation. Parent integrates package dependencies/lock, canonical lint list and plugin README notes. Workers may modify only their assigned UI files and necessary semantic selectors in existing behavioral tests; no source-text/appearance/default-copy tests. Preserve existing behavior tests; do not run them under this phase.

Verification: `bun run typecheck` must exit 0. Build UI assets and perform minimum actual isolated renderer smoke of changed controls and dark/light presentation. Fresh ProcessScope, private HOME/QUIRKY_HOME/Git config, no real provider/account/native notification launch. Browser uses unique owned Playwright Chromium for Testing, not branded Chrome or inherited shared handles. This is not a full dogfood campaign, native acceptance or independent screenshot score.

Self-review: SC1–SC5 cover the three owned UI slices and enforcement; each retains canonical data/control authority and dark/light/overflow requirements. No unbuilt flow is deferred.

### Exercised evidence

Before the required controller-conflict recovery, `bun run typecheck` passed canonical UI lint and root/mobile/prepared-desktop TypeScript (31.79s), and UI build emitted 11 host files and 25 plugin UI modules. That owned private renderer exercised all six Ask input kinds and canonical answered-envelope readback, live dark/light sanitized preview, notification disabled-state independence/custom-path refusal/range commit/test-feedback, and the reused Structured transcript with an explicitly seeded private exited-session/journal fixture. Tool details use the shared mono size with a real monospace family; filtered system events reveal through Show all events; dark/light and 1000x700 rendering were observed. No real structured provider turn or native notification was launched; the notifier was an injected recorder. Page errors were empty.

The first renderer observations exposed duplicated basic-field labels and a host token-stylesheet omission when CSS-text preview code was re-exported from the root UI module. Final composition uses one visible basic-field label; the isolated public preview subpath restores actual host token definitions and styled controls. Early/red captures are retained alongside final captures in `.quirk/build-loop/ui-restyle-ask/`; they are not golden-review approval. Tests, suites, full dogfood, independent scoring, native/provider flows and foreign-platform validation remain unrun under the governing phase policy.

Required recovery merge `61013dd6` preserves incoming Tasks/Worktrees shared contracts, dead-style removal and lint additions. Current canonical typecheck passed again (31.28s); current UI build emitted 11 host files and 25 plugin modules. A new private renderer confirmed actual host tokens, selected Ask option/submission, sandboxed inert preview dark→light, notification off/dependent-disabled/menu-bar-independent controls and no horizontal overflow, with no page errors. The separately named recovery captures are current-source proof; earlier broader six-input/Structured fixture evidence is not relabeled as post-recovery.


## Status & amendments

2026-10-28: combined spec accepted autonomously from the approved design and queue title; no separate tech spec/review under authoritative build-first LOOP. Structured ownership clarified after Lane1 reported its committed implementation. The preview export moved cleanly to its isolated public subpath after actual stylesheet evidence; no root compatibility alias, behavior change or acceptance-scope reduction.
