# Orchestration tools: shared graphite presentation

**Status:** Autonomous approved-default execution, 2026-10-28. Parent design: `docs/quirk/specs/2026-10-28-ui-redesign/logic.md` (approved). Build-first item.

## Why and conceptual model

Orchestration, Heimdall, handoff and loops retain their existing public APIs, state ownership and commands. Their desktop contributions become coherent shared-component tools/views inside the host's existing six-slot shell. No parallel navigation, workflow engine, persistence layer or theme resolver is introduced.

Data flows remain unchanged: each existing plugin client reads its daemon-owned records, renders them, invokes the existing public action, then reflects the resulting event/readback. A visual restyle must not change identifiers, approval policy, cancellation, launch authority or error outcomes.

## Scope and non-goals

In scope: every desktop renderer contribution of quirky.orchestration, quirky.heimdall, quirky.handoff and quirky.loops, their settings/menus/forms/empty and failure states, and opting all four into canonical UI lint. Retain existing tool IDs and default placement. Use only public shared components and tokens.

Non-goals: new orchestration flows, changed task/loop lifecycle, mobile changes, changed keyboard shortcuts, new daemon APIs, native window controls, account/provider integration, restyling other plugins, screenshot-review implementation changes. Tests and screenshot scoring are not run under this item's explicit build-first policy.

## Behavior and acceptance scenarios

### SC1: Reach the existing contributions

Given a fresh profile and selected fixture worktree, opening Agents, orchestration, handoff and loops through their current registered tools/views shows substantive content in the host-assigned slot or center view, not a new global plugin rail. Before: other host tools and center context exist. Walkthrough: open each registered contribution, then close or replace its tool. After: only the intended host tool/view changes; existing contribution IDs and public commands remain usable.

### SC2: Empty, loading and failure states

Given no tasks, agents, handoffs or loops, each mounted surface shows a concise shared empty state and the existing available creation/navigation action. Pending reads remain distinguishable from empty results; errors stay visible with existing retry/reload behavior. Before: an empty daemon-owned collection. Walkthrough: mount each surface and start its existing form. After: the same operation can be configured without fabricated records or an implicit run.

### SC3: Forms and lifecycle controls preserve intent

Given existing task/agent/handoff/loop records, shared lists, status marks, tabs, fields and buttons retain their original field values, selections and action targets. Before: a known record and a form draft. Walkthrough: edit/select through the shared controls and invoke an existing non-destructive action. After: the correct canonical record changes or the draft remains intact; destructive actions retain existing confirmation semantics. Cancel never creates, launches or approves anything. No style migration may suppress API errors.

### SC4: Both themes and narrow slots

Given app dark or light appearance, every restyled contribution inherits the canonical data-theme/token authority and stays readable without plugin-owned CSS or raw color/pixel styling. Before: a mounted tool with visible controls. Walkthrough: switch theme and exercise its tabs/form in a narrow side slot. After: control labels and actions remain reachable, long text wraps/truncates using shared layout facilities, and no unintended page-wide horizontal overflow occurs.

### SC5: Canonical enforcement

Given all four plugin IDs in scripts/ui-lint-plugins.json, `bun scripts/ui-lint.ts` and `bun run typecheck` pass. No local stylesheet, inline style bypass, violation baseline or lint exemption is added. A needed visual primitive belongs in the shared package, not in a plugin.

## Decisions locked and rationale

- Layout/interaction: retain host registry, contribution IDs/default slots and existing public behavior. Rebuilding workflows is rejected because the parent limits this to appearance/location.
- Density: shared comfortable list rows and section headers; tokenized spacing and typography. Cosmetic substitutions inside legacy local classes are rejected because they retain divergent styling.
- State: shared EmptyState, visible pending/error feedback and existing retry actions; never convert failed reads to empty success.
- Theme: shared semantic working/needs-you/failing/done/idle status vocabulary; use the existing dark/light root authority, no local media-query resolver.
- Coverage: all four plugin renderers, settings and launcher contributions belong to the migration, not just the primary panel.
- Verification: author/migrate useful behavioral coverage where component replacement affects behavior; delete source-text/copy/incidental-style assertions rather than repinning. No permanent tests of mere wiring or CSS names.

## Industry insights

Reuse the approved parent's cited Linear, Zed and extension-contribution findings. No new research swarm: authoritative LOOP build-first says the approved feature/design docs and prior decision logs are the research.

## Deferred ideas

None. No additional product feature is included.

## Glossary

- Tool: host-registered contribution opened in a persisted slot.
- View: host-registered center-tab content.
- Shared component: public @quirky/ui control or layout primitive.
- Canonical record: daemon-owned task, agent, handoff or loop; presentation is never its authority.

## Technical decisions and shared contracts

**Architecture / stack:** existing React desktop plugin entrypoints and public plugin API. Import @quirky/ui and its shared stylesheet only where needed. Keep daemon, manifest contribution IDs and CLI behavior unchanged except an explicit proven integration mismatch.

**Contract:** all implementers reuse existing @quirky/ui props and semantic token names as published at dispatch. No new cross-plugin types, schemas or API signatures are required; this committed boundary is the shared contract. Any missing shared primitive must be coordinated with the parent before changing shared files.

**Coordinated shared additions:** parent owns public `TextArea`/`TextAreaProps` and `SelectField`/`SelectFieldProps`, each with required label, optional help/error and native textarea/select attributes. They preserve native form participation, accessible label and description ownership, disabled behavior and caller state. The canonical shared stylesheet supplies `.ui-readout` for bounded wrapping long output, `.ui-option-list` for composed searchable selection, and `.ui-code-editor` with `.ui-secret-highlight` for CodeMirror editing/secret marks. CodeMirror retains editing authority; plugins no longer inject their own theme CSS. Existing input-only TextField remains unchanged.

`TextArea`, like `TextField`, disables OS autocapitalization, autocorrection and spellchecking by default so technical text retains literal flags and quotes. Callers can explicitly opt into prose-oriented editing through native props.

**Isolation:** at most three disjoint external component worktrees; each worker uses absolute paths within its assigned root, no git commits, tests, lint, formatters, builds or reviews. Parent owns lint opt-in, shared integration changes, one final typecheck and narrow real browser/API proof. The inherited .serena directory remains untouched.

**Acceptance commands (parent only):** `bun scripts/ui-lint.ts`; `bun run typecheck`; `bun packages/ui/build.ts`. Expected exit0. A disposable private HOME/QUIRKY_HOME real daemon and owned Chromium verify changed surfaces and dark/light mounting; persistent evidence excludes credentials. Suites, independent screenshot score, full dogfood and native acceptance remain unclaimed.

**Platforms:** macOS only. No new OS-specific behavior; Linux/Windows visual/focus acceptance remains deferred under the standing platform policy.

## Status & amendments

2026-10-28: self-reviewed against all four named plugins and approved parent. Scope, lifecycle authority, empty/failure behavior and theme ownership are explicit. One combined logic/technical spec follows the authoritative LOOP override; no separate tech.md or review round.

**Amendments:** 2026-10-28 — all three implementers identified missing multiline/select primitives and the handoff editor's private theme. Added the coordinated shared additions above instead of local CSS or replacing functional CodeMirror behavior.

2026-10-28 — real overlay interaction proved the shared dialog inherited the host overlay layer's pointer-events:none. The shared backdrop now owns pointer-events:auto; host-loaded shared CSS remains the sole stylesheet authority. The roadmap catch-up retains incoming TextField ref support alongside the new native multiline/select controls.
