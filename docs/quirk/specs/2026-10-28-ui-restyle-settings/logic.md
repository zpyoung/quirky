# Settings and utility contributions: shared graphite restyle

**Status:** Approved parent design; autonomous slice decisions 2026-10-28. Build-first combined logic/technical spec.

## Purpose and conceptual model

Restyle the desktop Mobile page/settings, CLI settings, command palette, Source Control activity contribution and host Settings window using the approved shared design system. The host owns Settings and command discovery; each plugin keeps its current public methods, contribution IDs, state authority and lifecycle. Mobile remains a left-bottom tool. CLI remains a dedicated settings view. Palette remains command-only; no new tool or preference is invented.

## Key decisions & rationale

Use shared React controls, tokens and existing layout utilities, not locally injected CSS or a second toolkit. Preserve current controls and outcomes, including unavailable native/distribution affordances. A full behavior rewrite risks pairing and launcher ownership; CSS-only renaming retains inconsistent controls. The chosen presentation cutover keeps feature methods intact. Convert the imperative CLI view to the existing compiled React plugin convention so it can consume actual shared controls; remove its obsolete source entry and migrate every import.

## Behavior and acceptance scenarios

### SC1: One Settings host
Before: user opens Settings with existing declared values and application appearance. Walkthrough: inspect categorized sections, change a boolean/text/number/enum, cancel; reopen, change and Save. After: cancel writes nothing, Save uses existing validation/error reporting and persists only edits. Appearance remains default/system, dark/light or a registered theme through existing theme.set. Plugin navigation keeps current IDs, unavailable-module disabling and truthful errors. Shared dialog supports keyboard Escape/focus and scrolls long content without horizontal overflow.

### SC2: Mobile setup and settings
Before: no paired phones. Walkthrough: open Mobile in its current slot; inspect intro/install/pair/paired stages and settings link, machine name, sidebar visibility, network choices/custom address and automatic restore. After: controls retain daemon readback and existing unavailability messaging; loading/error/empty states are readable. Settings only generates a QR on explicit action; the pairing stage retains automatic issuance. No phone-app code changes.

### SC3: Pairing and device lifecycle
Before: a pending offer. Walkthrough: copy offer, enlarge QR, close enlarged dialog, regenerate; inspect devices and revoke. After: existing copy/rotation/reuse/revoke authority remains unchanged; no offer/token enters public view reports/logs/events. The intentionally displayed offer remains copyable. Device refresh failures after successful revoke stay truthful. QR artwork remains scannable in both themes and its dialog is keyboard operable.

### SC4: CLI settings
Before: missing/managed/foreign launcher state and no saved runtimes. Walkthrough: inspect target/path/profile; install/update, reveal or uninstall where valid; create/remove profile launcher; enter saved-runtime name and pairing offer; save/remove runtime. After: unavailable target disables installation, foreign replacement still confirms, managed-only removal remains guarded, offer is a password field and is cleared only after successful add. Listings expose safe endpoint/device metadata, never credentials. Errors are visible, stale completion cannot mutate an unmounted view, forms remain labeled.

### SC5: Palette and Source Control
Before: effective commands/tools/views/worktrees are registered. Walkthrough: open search, filter, keyboard navigate and execute; search unmatched text and close. After: shared controls/rows/empty state preserve exact-window navigation and existing shortcuts. Source Control activation still routes through its canonical owner, with the active-worktree-only dirty label/count and stale-result guard unchanged; no parallel toolbar appears.

### SC6: Consistent themes and enforcement
Before: each scoped surface is mounted. Walkthrough: pin dark then light through the existing API. After: shared tokens repaint all scoped controls without losing drafts, no plugin-owned stylesheet/style-tag remains, and canonical UI lint admits all four plugin IDs. Actual typecheck and bundle build must pass. Existing behavioral coverage is migrated/authored for uncertain lifecycle/secret/validation boundaries, not incidental class or wording assertions.

## Scope and non-goals

Desktop presentation only. No transport/security/RPC/schema/shortcut changes, phone app restyle, new relay/install distribution, real launcher writes outside disposable homes, new settings store, native-window changes or new feature flows. Native-only OS dialogs retain existing native handoffs; this item adds none. Suites, full dogfood, screenshot scores and formal reviews are not run under the queue item's explicit build-first instruction.

## Decisions Locked

- Parent approved graphite palette, density, shared components, host slots and default Mobile placement.
- Existing daemon preference, theme, pairing/revocation, launcher and exact-window owners remain authoritative.
- Use recommended compact shared forms, wrapped safe readouts, one-action empties, existing error/retry actions; never hide unavailable capabilities.
- Existing component contracts suffice: Button/IconButton, TextField/TextArea/SelectField, FormRow, SectionHeader, ListRow, Badge/StatusDot, Dialog, EmptyState and ToolPanelFrame.

## Industry Insights

Reuse the approved parent spec's sourced host contribution/design-system findings; no research swarm under LOOP build-first. Binding decisions: ui-tokens-and-components D2/D4/D10; ui-shell-slots D2/D3/D5/D6; ui-terminal-theme D2–D4; sb-mobile-daemon D5–D9/D15; m2-sidebar-extras D9/D10/D12 (old rail placement superseded by approved shell).

## Deferred Ideas

None. No new product flows requested or deferred.

## Glossary

Settings host: single application dialog for declarative settings, contributed sections and links. Dedicated view: plugin-owned settings opened via an existing view/command. Offer: sensitive pending mobile pairing credential, intentionally displayed only in its pairing surface. Shared system: public @quirky/ui controls and canonical centrally-owned styles/tokens.

## Technical decisions and implementation contracts

Three independent components from a committed contract base, one wave, cap three (not binding):

1. Mobile owns plugins/quirky.mobile/src/ui.tsx and src/window/** plus plugin-local behavioral tests. Remove MobileStyles after all its consumers migrate. No daemon/phone/protocol changes.
2. CLI owns plugins/quirky.cli/** except package.json already committed as shared dependency contract. Migrate ui.js to src/ui.tsx + manifest module dist/ui.js and all old imports/tests. Preserve public activate(context) mount/dispose semantics. No method/CLI contract changes.
3. Host/utilities owns packages/ui/src/components/SettingsDialog.tsx, packages/ui/src/plugins/CommandPalette.tsx, their existing behavioral tests, plugins/quirky.sidebar-extras/src/ui.tsx and local tests, plugins/quirky.palette/src/ui.tsx. Keep settingsGroups/settingsDraft semantic owners unchanged.

Parent owns docs, lint plugin list, lockfile, any genuinely needed shared presentation extension and removal of dead shared legacy CSS after workers return. Public dependencies @quirky/ui/react/react-dom are committed first; no shared exported signature changes planned. Workers use absolute paths rooted in assigned isolated worktrees, no commits or checks, and report exact changed paths. Parent performs barrier attribution, integrates, runs bun run typecheck and bun packages/ui/build.ts, and minimally mounts/exercises actual daemon-served changed surfaces with fresh HOME/QUIRKY_HOME and an explicitly owned CDP browser. No test/suite/review or visual-score pass is claimed. Single git merge build/roadmap just before land; incoming decision logs read. Only canonical absolute queue.ts land may integrate the item.

## Status & amendments

2026-10-28 self-review: SC1–SC6 cover every named slice; pairing/launcher safety, unavailable controls, errors, owner/lifecycle and theme drafts explicit. No unresolved questions. **Amendments:** none.
