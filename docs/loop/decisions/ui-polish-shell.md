# ui-polish-shell decisions

## D1: Apply only the queued three corrections to the approved shell
- **Question:** Brainstorming purpose, consumers, success, constraints, scope and primary behavior; layout/density/interaction/loading/empty/error gray areas.
- **Options:** redesign the sidebar again; permanent expandable toolbar; plain list with one shared header options popover.
- **Chose:** Plain list and header popover containing the existing controls/disclosures; preserve empty-list Add project recovery and existing loading/error behavior. Remove stripe chevrons while preserving context/keyboard/drag tool movement. Primary uses neutral Badge.
- **Why:** The exact queue title and approved goldens require these corrections, not new workspace operations. Current after/shell PNG visibly places options above rows and gives Primary indigo fill.
- **Evidence:** queued ui-polish-shell title; docs/quirk/specs/2026-10-28-ui-redesign/logic.md:23–119,194–227; after/shell/host-shell-dark.png; ui-restyle-worktrees D1–D5/D8–D11; ui-shell-slots D1–D6.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** actual surface cannot reach an existing control.
- **Source:** locked by docs/quirk/specs/2026-10-28-ui-redesign/logic.md

## D2: Use a shared frame-scoped header portal across independent plugin roots
- **Question:** Technical feasibility of a plugin-owned option in the host-owned header.
- **Options:** React context; new protocol/mount contract; shared ToolPanelActions nearest-frame portal.
- **Chose:** Shared public ToolPanelActions and dedicated target inside ToolPanelFrame; no global selector or plugin-specific host branch. Update standalone test mounts to use a real frame. Keep existing frame actions/minimize supported.
- **Why:** PluginSlot mounts into a separate React root, so React context alone cannot carry the host target. Shared encapsulated DOM coordination avoids expanding persisted/RPC contracts or allowing arbitrary plugin DOM access.
- **Evidence:** packages/ui/src/plugins/PluginSlot.tsx:31–42; design-system/panels.tsx:68–83; WorktreesSection.tsx:511–546. Language-server references request returned No language server found; source anchors used instead.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** independent-root/frame lifecycle proof reveals stale or cross-frame controls.
- **Source:** assumed — autonomous

## D3: Replace stripe menu triggers with the existing shared context menu
- **Question:** Preserve moving tools without any tiny secondary stripe buttons.
- **Options:** hide the chevron glyph but retain invisible hit targets; remove movement; contextmenu/Shift+F10 on each real tool icon.
- **Chose:** Shared ContextMenu on existing icon, six destinations, current destination disabled; retain click and drag semantics. Remove obsolete continuous menu-position/portal/trigger CSS machinery.
- **Why:** Hidden hit targets are not an accessible clean cutover. Current separate Menu trigger creates the reported arrows and per-icon position computation. Shared ContextMenu already owns nested geometry and keyboard dismissal.
- **Evidence:** ToolShell.tsx:307–342,372–575; tool-shell.css:171–215; design-system/context-menu-contracts.ts.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** actual keyboard move/dismiss or drag proof fails.
- **Source:** assumed — autonomous

## D4: Use one source implementer and cross-family review with isolated runtime proof
- **Question:** Execution pairing, task shape, specs and verification under the current loop.
- **Options:** independent per-bullet workers with shared frame/test overlap; one source component; omit runtime verification.
- **Chose:** One OpenAI task implementer, parent owns evidence/provenance and integration. Two specs because host/plugin boundary and >3 source files. Shared prop contract committed before dispatch; no new public RPC/schema. Reviewer fallback gemini after opus unavailable. No external research swarms; the approved spec and source decisions are design inputs. All questions answered autonomously; no ask. Parent runs checks after worker barrier.
- **Why:** Small coupled change does not benefit from splitting its shared frame and consumer tests. Probe `pi-watch --check` reported opus/sonnet unavailable, gemini google/gemini-3.1-pro-preview:high available; task model pin is unsupported except seance, so omit it and use configured OpenAI implementers/reviewer. Queue status is in the end phase, so affected tests and real UI verification are appropriate.
- **Evidence:** preflight output exit5, 7/12 aliases; ShellSurvey; docs/loop/LOOP.md end-phase rules; spec-review dispatch model-schema error.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** scoped test, runtime or review evidence contradicts the proposed contract.
- **Source:** assumed — autonomous

## D5: Refresh only the two requested shell after images with truthful provenance
- **Question:** Capture comparability, state safety and platform limits.
- **Options:** reuse stale after PNGs; recapture entire gallery; replace only shell dark/light actual captures and provenance.
- **Chose:** 1340×600 real private daemon/Git fixtures and owned testing Chromium; closed options and visible worktrees. Preserve before images and all other area source labels. Record actual source commit and bytes. Use fresh HOME/QUIRKY_HOME and no real provider credentials. Inherited .serena stays untouched.
- **Why:** The final review manifest records immutable sourceCommit/digest per image; replacing PNGs without provenance would be false attribution. macOS renderer evidence does not certify native OS chrome, Linux or Windows.
- **Evidence:** ui-final-review D2/D4/D6/D7; manifest.json shell entries; using-apps-like-a-user doctor web ready/playwright-cli0.1.22.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** capture mechanism cannot isolate state or fails to render the named panel.
- **Source:** deferred: platform

## Progress
Design/spec authored, awaiting bounded OpenAI spec review. Next commit specs and shared prop contract; dispatch one isolated source implementer; parent builds/tests and exercises actual UI, refreshes screenshots/provenance, cross-family final review, catches up once and lands. No implementation or test-pass claim yet.
