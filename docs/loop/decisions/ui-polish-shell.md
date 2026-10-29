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
- **Chose:** One OpenAI source implementer and one disjoint test-migration implementer in a single wave; parent owns evidence/provenance and integration. Two specs because host/plugin boundary and >3 source files. Shared prop contract committed before dispatch; no new public RPC/schema. Reviewer fallback gemini after opus unavailable. No external research swarms; the approved spec and source decisions are design inputs. All questions answered autonomously; no ask. Parent runs checks after worker barrier.
- **Why:** Separate source/test file ownership permits parallel consumer migration against fixed contracts without shared-file races; splitting the three small source corrections would not. Probe `pi-watch --check` reported opus/sonnet unavailable, gemini google/gemini-3.1-pro-preview:high available; task model pin is unsupported except seance, so omit it and use configured OpenAI implementers/reviewer. Queue status is in the end phase, so affected tests and real UI verification are appropriate.
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

## D6: Preserve explicit queued repair ownership while migrating changed UI callers
- **Question:** Initial full affected suite returned27failed of78files; does this authorize unrelated Worktree feature repairs?
- **Options:** change production behavior until every old fixture passes; hide failures; migrate actual moved-control callers and retain the dedicated repair's inventory.
- **Chose:** Treat the observed failures as ground truth, not flakes. One bounded repair wave owns only the three changed consumer test files and moved-control callsites in existing window tests. Keep broad Worktree/Activity/Menu/Tree/ActivityFilters/window-navigation/ui-report repair ownership with m2-sidebar-extras-followup and fix-test-worktree-1028, already queued. No new fix item or feature-flow deferral.
- **Why:** Artifact22 has26Worktree-file failures already named by the dedicated queue item, plus one shared FormData-emulator assertion. Incoming post-restyle repair removes that emulator assertion with actual native-field browser evidence; our new separate-root/frame lifecycle test passed. One real new caller failure occurs when a second Add project action now needs the header popover. Tests for our own presentation cutover must be repaired here; unrelated authority/creation/preference defects must not be silently changed.
- **Evidence:** initial canonical remote affected suite exit1/204.52s,51pass27fail/no flakes; artifact22; queue fix-test-worktree-1028 explicit lane4 coordination; ShellIncoming full failure classification; source-code comparison of WorktreesSection empty versus nonempty Add project paths.
- **Reversibility:** easy
- **Confidence:** high for observed failure/ownership classification, not a root-cause diagnosis of all26files
- **Revisit if:** scoped verification shows an actual new runtime regression or an unowned failure.
- **Source:** locked by docs/loop/queue.json fix-test-worktree-1028

## D7: Compose the sole roadmap catch-up with exact owner and tool identities
- **Question:** How do incoming VM/remote tools, post-restyle test fixes and review visibility compose with this polish?
- **Options:** duplicate the remote Worktrees section; ignore incoming constraints; preserve separate contribution and nearest-frame actions.
- **Chose:** Sole catch-up merge5b5edfd18533fa92bb30e10c690c8e1c75a56808. Read all six incoming decision logs fully, including long lines/Progress: Accounts, packages-cli, post-restyle-boundaries, reviews-tool, native-notification-and-signed-terminal-host, VM-and-owner-bound-host-workspaces. Preserve remote-workspaces' own right-bottom unopened contribution, authenticated owner/generation/instance/window identity, canonical six-slot open semantics and all account/native signing limits. No normative conflict.
- **Why:** Header controls remain inside the existing Worktrees frame, not a new registration, global host-DOM mutation or another sidebar pile. Shared FormData test fix composes with frame lifecycle coverage. Incoming native notification/signing item remains blocked on real SDK/signing prerequisites; this presentation change neither implements nor certifies them.
- **Evidence:** clean merge output; ShellIncoming full six-log read; ui-restyle parent ownership constraints; current ToolPanelActions nearest-frame lookup.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** composed typecheck or current-source UI capture contradicts these identities.
- **Source:** assumed — autonomous

## D8: Report actual guarded UI outcomes and bounded compiler/script proof
- **Question:** Which acceptance claims were exercised rather than inferred?
- **Options:** infer completion from source; claim full suite green; retain precise actual proof and failures.
- **Chose:** Initial full UIlint/root/mobile/prepared-desktop typecheck plus UI build passed exit0/44.29s,11host/vendor files and26plugin modules. `bun test scripts` passed126tests12files1124assertions in84.87s. Actual private daemon/Git fixtures, managed browser and guarded unattended web run20261029T022144-f1fd exercised all four scoped goals: plain list/header/popover/Escape; Week retained on reopen then Clear reset; Add project modal handoff+Cancel; bottom Ledger open, Shift+F10 six destinations/current-disabled, move right-bottom and icon close.4pass, no findings/overrides/gates/cleanup errors,16actions.
- **Why:** Every recorded pass has observed transitions and inspected screenshots. Renderer pixels show neutral Primary and no under-icon chevrons. The helper's one STALE reference attempt made no action and was followed by fresh observation. No full Worktree-suite/native/cross-platform claim is justified. This interaction run used the initial implementation build, before rebuilding incoming VM registrations.
- **Evidence:** .quirk/using-apps-like-a-user/runs/20261029T022144-f1fd/report.md; obs1–21; managed browser errors[]; shell-l12-fixture exited0 and logged homeRemoved:true. Browser closed. Stop endpoint closed its socket during shutdown, but authoritative process cleanup completed.
- **Reversibility:** easy
- **Confidence:** high within the named scenarios
- **Revisit if:** composed-source capture/checks expose a regression.
- **Source:** assumed — autonomous

## D9: Verify the changed contracts without claiming the queued Worktree repair is green
- **Question:** Which composed-source tests pass, and which failures remain with the existing repair?
- **Options:** narrow the reported full gate; change unrelated product behavior; report both scoped closure and full failing evidence.
- **Chose:** After all repair workers returned and both components passed HEAD/scope attribution, integrate c98204e5 and69e1ba0f. Current full typecheck/UI build passed44.08s. Five targeted frame/header/filter/stripe transitions passed across four files (62 assertions,438ms). Both real SC-8 Add project import cases passed (11 assertions,6.24s). Canonical shared UI suite passed32/32 files with no retries in27.08s. The full composed Worktree suite still failed:48files,23passed/25failed, no flakes,160.53s.
- **Why:** The changed header test's original Activity filters copy assertion assumed an unavailable projection provider; activity behavior is instead exercised in the sidebar-specific fixture and real browser. Empty Add project recovery stays visible, while the popup omits its duplicate. Actual moved-control window callers now open both outer options and inner Activity filters/More tools. Existing row-class, confirmation/provider, preferences, creation and harness failures retain their already queued owners; deadlines, production behavior and assertions are not weakened to fabricate a package pass.
- **Evidence:** bg7/bg8/bg10 outputs; composed full-suite artifact63 with suite-result at4762–4763; exact original inventory in BLOCKERS fix-test-repo entry; repair workers' static diagnoses; source HEAD7070a851f0754707809c79c1f04764024d79542b.
- **Reversibility:** easy
- **Confidence:** high for exercised closure and failing inventory; no single-cause claim for the remaining25files
- **Revisit if:** the existing Worktree repair finds a regression caused by the new header or menu boundary.
- **Source:** assumed — autonomous

## D10: Use actual current-renderer captures when the canonical capture selector is obsolete
- **Question:** The requested capture command timed out; can truthful screenshots still be delivered without changing the capture tool or product?
- **Options:** fake capture success; broaden this item into capture-tool repair; capture the actual daemon-served renderer with an external throwaway harness.
- **Chose:** Canonical capture-only exited2 after186.03s waiting for `.app .layout` in capture.ts:416. Current actual page has zero such nodes and one `.tool-shell`; it renders normally. A fresh private daemon/Git fixture and owned managed browser captured the real composed-source dark/light pair at1340×600, DPR1, source7070a851. Use public theme.set, wait for exact body and control computed colors before capture, and preserve unaltered PNG bytes. Update only shell after images, their per-image hashes/source and explicit gallery capture-point text.
- **Why:** The external harness avoids an unrelated product/tool repair or fake fallback. Initial managed viewport retained DPR1.25; explicit page viewport set DPR1 before final captures. The initial light candidate caught control color transitions; exact computed-color settlement produced the published image. Current-source options open/Escape and Ledger right-click/Escape restored focus to Ledger, preserved three rows and reported errors[]. Both browser and private runtime closed; homeRemoved:true.
- **Evidence:** capture-only error/progress artifacts; actual selector counts; final image dimensions/digests; published manifest and gallery; composed browser readback; shell-l12-recapture exited0. The canonical capture command did not pass.
- **Reversibility:** easy
- **Confidence:** high for image authenticity and source attribution
- **Revisit if:** the capture tool's obsolete selector is repaired or the published PNG bytes change.
- **Source:** assumed — autonomous

## D11: Keep scoped code review separate from the failed whole-shell visual score
- **Question:** Do independent review results certify this exact polish, or the entire golden shell?
- **Options:** report all visual approval; repeatedly rescore; preserve both results with their scope.
- **Chose:** One read-only Gemini final review (google/gemini-3.1-pro-preview:high,82.59s,exit0) reported no actionable defect against the literal three corrections and portal/menu/provenance contracts. It inspected current source and manifest/index but only listed screenshot files; it did not independently hash the bytes or inspect all tests. No accepted code findings, so no fix batch. Separately, the canonical screenshot reviewer read both actual images and goldens and failed85-point acceptance: dark50, light69. Record all remaining visual findings rather than claim approval or widen the three-correction item.
- **Why:** The visual reviewer reports existing whole-shell differences: header capitalization, search-button versus input shape, border/icon-button weight, icon sets and native traffic lights. Those are not defects in the three named corrections; native window controls cannot be certified from a daemon-served web renderer. The loop explicitly retains open final-review findings. No threshold, golden, token or screenshot was changed to make scoring pass.
- **Evidence:** actual final review output STATUS:PASS; visual-review/review-report.json and result exit1/52.87s, both imagesRead:true/targetVisible:true; open findings appended to BLOCKERS. Parent independently computed both PNG hashes and checked1340×600 dimensions.
- **Reversibility:** easy
- **Confidence:** high for reported outcomes; review is bounded, not exhaustive or whole-suite/golden certification
- **Revisit if:** a later shell item is authorized to close the remaining golden differences or native review supplies window-frame evidence.
- **Source:** assumed — autonomous

## Progress
Ready to land the single assigned polish. Source capture point7070a851f0754707809c79c1f04764024d79542b includes the sole roadmap catch-up5b5edfd1 and both audited repair components. Current full UI-lint/root/mobile/prepared-desktop typecheck and UI build pass; scripts126tests, all32shared UI files, five scoped transitions and both real SC-8 import cases pass. Guarded UI4/4 goals pass; composed-source options/right-click/Escape readback has errors[] and Ledger focus restored. The published shell after pair is1340×600/DPR1 with computed SHA-256/source attribution; all138other image records are unchanged. One bounded independent code review reports no actionable findings. Whole-shell screenshot scores50/69 fail85 and the broader Worktree gate23pass/25fail remain explicitly recorded in BLOCKERS, not called cleared. Both private services exited0/homeRemoved:true; browser handles closed; all workers/jobs returned; all four component worktrees and branches removed. Raw affected-suite outputs, capture/review evidence, original image bytes, truthful code-review receipt and throwaway harness archive are retained beside lane12 notes. Next commit owned docs/evidence, detach and await canonical queue land. No second item, native/cross-platform certification or whole-loop completion claim.
