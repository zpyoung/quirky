# Shared graphite UI system

**Status:** Approved upstream design; autonomous slice decisions under docs/loop/LOOP.md. Implements the `ui-tokens-and-components` row of [the approved redesign](../2026-10-28-ui-redesign/logic.md), including the operator's staged-enforcement update.

## Purpose and scope

Ship a reusable desktop component API, exact dark/light graphite tokens, an interactive gallery showing all fifteen component categories in both themes, and a lint gate in `bun run typecheck`. This is the design-system foundation, not an area restyle. Phone UI, terminal palette/preferences/system appearance wiring, shell slots, attention delivery, persisted layout, screenshot-review automation and feature behavior stay with their existing queue owners.

## Conceptual model and data flow

Shared React components are exported from `@quirky/ui`; CSS is loaded by the host once. Components use semantic design tokens and expose controlled state/callbacks rather than accessing the daemon. Host/plugin behavior remains owned by existing APIs. Dark and light theme scopes inherit the same CSS variable names. The gallery is a separately built `gallery.html` page, uses the actual public component exports and CSS, and needs neither RPC credentials nor daemon state. Existing daemon static serving makes it reachable beside the UI.

The UI linter reads the always-enforced `packages/ui` source and explicitly opted-in plugin source directories. The plugin list starts empty. It never scans unrelated legacy plugins, build output, fixtures, dependency code or phone sources. Diagnostics include relative file, line, column and rule. Invalid enforced-list entries fail rather than silently dropping coverage.

## Key decisions and rationale

- Exact upstream palette and fixed type/spacing/radius steps. Shared components use only this system; namespaced tokens avoid overwriting existing protocol theme vocabulary.
- A separate public React entrypoint avoids importing the application shell when plugins consume components. Existing host components remain internal until their owning restyle.
- A separate gallery document avoids exposing test-only daemon methods or adding a router to the running desktop application.
- All current `packages/ui` style literals are tokenized so enforcement has no historical-baseline escape. Compatibility geometry/syntax tokens preserve current layouts and editor styling until area restyles; new shared components use the approved fixed steps, not those compatibility values.
- Only canonical token-definition declarations may contain raw colors or pixels. The exemption is not file-wide permission for ordinary rules. Dynamic measured dimensions remain valid; literal numeric React style dimensions are pixels and must be replaced by token expressions. Unitless values (opacity, flex, line-height, z-index), zero, percentages, fractions, and runtime measurements are not raw pixels.
- Plugin CSS includes source CSS/SCSS/Less files, private CSS imports, inline style sheets and DOM stylesheet injection; opted-in plugins compose shared components/tokens instead. The canonical `@quirky/ui/styles.css` import is allowed because its source is owned and enforced in the shared UI package. Native rendering engines' semantic configuration (for example CodeMirror style maps) remains covered by color/pixel checking, not prohibited as arbitrary plugin CSS when in `packages/ui`.

## Behavior and acceptance scenarios

### SC1 — Exact theme scopes
Given adjacent dark and light scopes, both render the exact ten color pairs listed in the upstream spec (rail through failing), title/body/label/section/mono sizes 15/12/11/10.5/11.5, spacing 2/4/6/8/12/16/24 and radii 5/7/10. Changing one scope does not recolor the other. Working has a green halo; needs-you amber, failing red, done indigo, idle/queued muted.

### SC2 — Fifteen usable component categories
The gallery renders Button (primary/secondary/destructive and disabled), IconButton (accessible name), TextField (label, disabled, error), ListRow (one/two-line, selected, status/count), SectionHeader, Tabs, Badge/count, StatusDot, Menu, Toast, Dialog/sheet, EmptyState, FormRow, ToolPanelFrame and InlineAgentCard in **both** scopes. Buttons invoke callbacks once; disabled controls do not. Tabs/menu support keyboard navigation, skip disabled options and activate the intended option. Dialog exposes a label, traps focus while open, closes on Escape when allowed, restores opener focus and does not let backdrop/content clicks leak. Menus dismiss on Escape/outside interaction and return focus. Form rows associate help/error text with controls. Toasts offer real dismiss/action callbacks; expiration never fires an action. Empty states have one action. Long text and disabled/error states remain legible.

Menu lists size to their labels and remain at least as wide as their trigger. Icon-only triggers, including the diff toolbar's More actions control, must not squeeze ordinary option labels into letter-by-letter wrapping. Section-header menus align to the trigger's right edge so they open inward; header actions remain right-aligned when the title wraps onto a separate row.

Tabs keep a complete focus-visible ring inside their horizontal scrollport, including the first and last tabs. The ring is inset so it remains visible without changing control sizing or disabling horizontal scrolling.

Scrollable dialog bodies leave inline clearance for outward focus rings, including Settings checkboxes at the content edge. Content stays aligned with the dialog header and actions, and the body keeps vertical scrolling.

### SC3 — Gallery is a working page
After the ordinary UI build, `/gallery.html` loads actual shared components with no daemon connection or token required. Both theme columns show every category; toggling tabs, typing, selecting menu items, showing/closing dialogs, dismissing a toast, and invoking the card action updates visible local demonstration state. The gallery has no private duplicated controls or local CSS; its layout classes are defined with the shared system.

### SC4 — Raw style values fail with actionable locations
An enforced source `color: #ff0000`, CSS `padding: 13px`, TSX `style={{padding: 13}}`, color function/named color, or a non-token literal embedded in a style template fails the CLI and thus typecheck with its file/line/rule. Comments, ordinary prose, URLs/fragments, non-style numbers and token references do not spuriously fail. Canonical primitive definitions remain valid but ordinary forbidden declarations placed alongside them fail.

### SC5 — Staged plugin enforcement
With the enforced plugin list empty, unchanged legacy plugin CSS does not affect lint/typecheck. Adding an existing plugin ID causes its raw colors, raw pixels, CSS file/import, style element and stylesheet injection to fail. Removing the violation by using shared components/tokens passes. An unknown/traversing/duplicate entry fails configuration validation. Only restyle owners add IDs; this item adds none.

### SC6 — Existing desktop behavior preserved
Old UI control, sizing, theme API and plugin mounting callsites continue compiling; no feature behavior or public protocol schema changes. Existing UI CSS/inline literals move to canonical token references without broad restyling. The gallery imports only the public package entrypoint and never starts the shell connection.

## Decisions Locked

Approved redesign controls palette, density and component categories. Operator controls initially empty plugin enforcement. Existing public theme APIs remain valid. Shared components are controlled presentations, not feature-specific daemon clients.

## Industry Insights

Use the existing approved spec's cited design-system and extension-platform findings; no new research swarm under build-first mode.

## Deferred Ideas

No additional feature flows. Shell/terminal/restyle/screenshot flows have named queue owners and are not duplicated here.

## Glossary

Enforced plugin: an explicit plugin ID whose UI source must obey all three rules. Primitive definition: a central CSS custom-property declaration allowed to introduce a raw design value. Compatibility token: centralized existing host geometry or syntax color retained until its owning area restyle.

## Technical decisions and contracts

- Public API: `packages/ui/src/design-system/index.ts` exports components, types from `contracts.ts`, and token names. `@quirky/ui` resolves there; `@quirky/ui/styles.css` resolves the shared stylesheet. No runtime application import.
- `packages/ui/src/design-system/contracts.ts` fixes component prop names/types before implementers. Each implementer must preserve these contracts or request an integration-owner amendment.
- Component owner: design-system directory except compatibility-tokens.css; public package export metadata. Gallery owner: src/gallery.tsx, src/gallery.html, build.ts; imports shared entrypoint. Enforcement owner: scripts/ui-lint.ts, scripts/ui-lint-plugins.json, scripts/ui-lint.test.ts, all existing packages/ui source style literal migrations outside design-system/gallery, compatibility-tokens.css, root package script. Parent owns contracts/spec/decisions/root lockfile integration.
- Lint CLI: `bun scripts/ui-lint.ts`, nonzero on diagnostics/config errors. Pure scanner functions exported for isolated consumer-visible tests. No script/inline suppression or violation baseline. `scripts/ui-lint-plugins.json` is an empty JSON array initially.
- CSS selectors use `.ui-*`; themes scope with `[data-theme="dark"|"light"]` and root dark default, with local scopes overriding inherited color values. Lane4 owns app appearance resolution, the live hook/protocol models and terminal palette adapter; this item owns CSS and component scopes. Primitive source files: `design-system/tokens.css` and `design-system/compatibility-tokens.css`; only custom-property declaration values are exempt.
- Automated acceptance tests authored with the implementation; build-first leaves suites unrun. Parent runs `bun run typecheck`, a focused lint-fixture smoke and built gallery interaction/visual smoke as required by the coding contract. No broad dogfood/review claims.

## Status & amendments

2026-10-28: Self-reviewed against the upstream item row and operator's staged-lint update. SC1–SC6 cover this item's flows; upstream full-window scenarios remain with existing queue owners. Separate tech/spec review omitted under build-first mode.

2026-10-28: Clarified canonical shared CSS import admission; private plugin CSS stays prohibited. Lane4's landed public terminal-theme export composes with the shared root/CSS exports; no new preference or terminal owner introduced.
