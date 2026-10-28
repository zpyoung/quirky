# Browser graphite restyle

## Status
Autonomously approved against the approved parent design on 2026-10-28. Build-first combined logic/tech spec; no separate tech spec or review campaign.

## Why and conceptual model
Browser remains a center view, including Browser panes hosted by Terminal worktree tabs. Browser Settings remains its registered settings section and command-opened view. No new stripe tool, global launcher, API, storage authority or keyboard shortcut is introduced. The host owns placement; Browser owns controls inside these contributions.

## Scope and behavior
Preserve navigation, address suggestions, native/Watch mode boundaries, profiles, cookie import, settings, Find, downloads, prompts, design picking, annotations, clipboard and frozen-image drawing. Replace local CSS/raw chrome styling with shared design-system controls and semantic tokens. Both approved graphite themes must remain readable without plugin-specific theme detection.

### SC1: Pane navigation and Find
Given an existing pane, show shared controls for Back/Forward/Reload, address/search, Find, mode, design actions, Browser menu and history. Disabled and loading conditions, address keyboard handling, focus refs, Find counters and native/Watch geometry remain unchanged. Example: opening Find retains the selected pane and address and exposes the existing previous/next/close actions.

### SC2: Profile menu, settings and import
Given Browser settings or its menu, group related preferences with shared section/form rows, readable help/error/status messages and compact shared actions. Preserve selected-profile radios, pending admissions, one-use confirmation, importer consent and all unavailable-capability explanations. Example: selecting another profile still calls profileSet; this restyle never changes clear/delete eligibility or initiates native state access.

### SC3: Design and markup
Given an owned page, preserve picking, annotation intent/comment/send targets and annotation identity. Shared buttons, status dots, forms and token surfaces replace custom controls. Highlight/pin/canvas geometry is runtime content, not a fixed UI spacing choice. Frozen screenshot dimensions, user-selected ink colors and exported PNG drawing stay content-owned and do not follow chrome theme changes. Example: undo/redo and Copy Markup retain existing clipboard outcome and cancellation ownership.

### SC4: Errors, empties and themes
Native-unavailable, connecting/ended Watch, no history/targets and failure messages retain actionable existing recovery paths. No silent Native-to-Watch substitution. Dark/light controls inherit canonical UI tokens and use the same component variants. No restyle rule recolors web content or screenshots.

### SC5: Enforcement
Enroll quirky.browser in scripts/ui-lint-plugins.json. Canonical bun run typecheck must pass including UI lint, root/mobile/prepared-desktop typing. Do not weaken the scanner or add exclusions. Existing behavioral tests remain authoritative; update only structural fixtures genuinely broken by shared semantic controls, never pin appearance/source text.

## Decisions locked and alternatives
- Layout/density: keep host slots and existing views; use approved comfortable shared rows. Reject a new Browser tool because Browser is already center content.
- Loading/empty/error: preserve feature state and recovery; use shared presentation rather than new retry logic.
- Interaction: preserve labels, focus, shortcuts, native masks and content geometry. Reject backend rewrites as unrelated.
- Styling: shared controls and token-based inline layout; remove every plugin style block. Reject moving Browser-specific CSS into packages/ui as disguised plugin CSS.
- Rich form popovers may compose shared controls with semantic native details/fieldset/select/range/color/canvas elements where the shared FormRow contract already permits native controls.

## Industry insights
The approved parent design supplies the research and unchanged golden images. No external research swarm under build-first. See ../2026-10-28-ui-redesign/logic.md#industry-insights.

## Non-goals and deferred ideas
No new functionality, mobile restyle, native SDK capability, native screenshot support, Browser partition clear completion, cross-platform certification, custom themes or changed shortcuts. No unbuilt in-scope flow is intentionally deferred.

## Tech decisions and contracts
- Runtime/service/protocol/guest-program behavior is fenced unchanged. Geometry derived from pages or screenshots and content ink values are not UI chrome literals.
- Existing @quirky/ui exports own buttons, badges, fields, sections, rows and dialogs. React 19 input-ref support may be added additively to shared TextField if needed; no incompatible exported signature changes.
- Token-based inline layout stays in the owning UI files; no plugin CSS/style tags or new global Browser selectors. Native fields inside FormRow use shared control classes.
- Three disjoint implementation slices: pane UI; preferences UI; design/markup UI. Parent owns lint enrollment, docs, shared contract additions and integration. Workers use absolute assigned worktree paths, never commit/run checks.
- Verification: current LOOP explicitly selects typecheck-only build-first gates and prohibits suites/formal review/dogfood. Author regression coverage if behavior edges change; do not run suites. Minimum actual built changed-surface smoke is recorded separately and is not a screenshot-model score. Default85 golden review remains an end-phase obligation, not a fabricated pass.

## Glossary
Chrome: Browser controls, not page content. Watch: an explicitly managed page displayed through its existing frame lease. Golden: unchanged approved dark/light combined reference screen.

## Status & amendments
**Amendments:** none.
