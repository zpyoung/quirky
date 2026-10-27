# m2-editor decisions

## D1: Preserve the full queued editor scope
- **Question:** Which editor slices belong to this item?
- **Options:** only the first roadmap slice; all three slices in the queued title
- **Chose:** all three slices, with feature-owned handoffs explicitly documented
- **Why:** the queue item names explorer, tabs, CodeMirror, disk preconditions, watching, quick open/search, rich Markdown, notebooks and all viewers; parity cannot be silently narrowed.
- **Evidence:** docs/roadmap.md:157-161; queue wait --lane 4 returned m2-editor
- **Reversibility:** medium (contracts span plugin and UI)
- **Confidence:** high
- **Revisit if:** queue scope changes explicitly
- **Source:** locked by docs/roadmap.md

## D2: Resolve questions without human gates
- **Question:** How should brainstorming, spec review and execution questions be answered?
- **Options:** unattended defaults; ask a human
- **Chose:** recommended defaults after checking feature docs and locked decisions; markdown specs; no visual companion or adhd offer; adversarial review replaces human approval
- **Why:** this loop is unattended and forbids human questions.
- **Evidence:** docs/loop/LOOP.md:175-200
- **Reversibility:** easy (decision record remains reviewable)
- **Confidence:** high
- **Revisit if:** this becomes attended work
- **Source:** locked by docs/loop/LOOP.md

## D3: Use omp implementers and a reachable cross-family reviewer
- **Question:** Which execution/review pairing is reachable at preflight?
- **Options:** omp + opus; omp + gemini; same-family fallback
- **Chose:** omp task implementers (OpenAI), gemini reviewer (Google) through pi-watch
- **Why:** pi-watch --check resolved codex, terra, gemini and flash; opus and sonnet had no authed/shipping model. Gemini is the next reachable cross-family pair. Spec review still uses Codex as required.
- **Evidence:** pi-watch --check (2026-10-27): opus 0/8, sonnet 0/6; gemini google/gemini-3.1-pro-preview:high; codex openai-codex/gpt-6.1-sol:medium
- **Reversibility:** easy (selection fixed for this run)
- **Confidence:** high
- **Revisit if:** dispatch fails and the documented fallback ladder applies
- **Source:** assumed — autonomous

## D4: Extend terminal workspace tabs with hosted editor content
- **Question:** Where do editor tabs live, and which of three implementation approaches fits?
- **Options:** independent editor view/tabs; extend terminal layout with hosted views; embed a complete IDE
- **Chose:** focused editor services/components, with declared editor view content mounted in terminal workspace tabs
- **Why:** D39 of m1-term-ui names this extension; independent tabs would not sit beside terminals; an IDE embed violates the chosen lightweight CodeMirror architecture.
- **Evidence:** docs/loop/decisions/m1-term-ui.md:390-398; packages/protocol/src/ui.ts:225-231; EditorMap and EditorPatterns research
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** hosted tab extension conflicts with a newer binding decision
- **Source:** locked by docs/loop/decisions/m1-term-ui.md D39

## D5: Reuse preview and dirty-close semantics
- **Question:** Interaction style: preview reuse, pin/edit promotion, reopening, and dirty close?
- **Options:** permanent tabs only; feature-doc preview/permanent lifecycle
- **Chose:** preview replacement until edit/pin/double-click; reuse same worktree/path/mode; Cancel/Don't Save/Save dirty close; 10-entry ephemeral reopen stack
- **Why:** preserves documented browsing and prevents draft loss.
- **Evidence:** editor.md sections 1 and 4; logic.md SC-1 through SC-6
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** parity evidence contradicts the specified lifecycle
- **Source:** locked by editor.md

## D6: Keep every default-able gray area observable and scriptable
- **Question:** Loading/empty/error states, density/layout, focus, settings persistence and API shapes?
- **Options:** renderer-only shortcuts/state; daemon-owned actions/state with existing shell density
- **Chose:** existing shell density and controls; bounded loading/empty/error/conflict states; explicit focus/selection/view state; schema-declared methods and generated CLI for every operation; declared settings
- **Why:** the roadmap requires agents to drive everything people can and read what they see.
- **Evidence:** docs/roadmap.md:31-41; packages/protocol/src/plugins.ts:48-78; packages/protocol/src/ui.ts:192-232
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** a control cannot be expressed through the declared public API
- **Source:** locked by docs/roadmap.md

## D7: Guard saves by content and preserve both conflict versions
- **Question:** Conflict resolution, missing baselines, autosave gates and deleted-file explicit saves?
- **Options:** last-writer-wins; content baseline with explicit conflict actions
- **Chose:** content hash baseline; serialize writes; fail closed on absent/stale baseline; Compare/Reload/Overwrite/Keep; pause autosave on uncertainty; explicit save can recreate a clean deleted buffer
- **Why:** avoids silent data loss and fixes the observed Orca deleted-file save no-op. Filesystem APIs cannot offer cross-process atomic compare-and-swap; no such guarantee is claimed.
- **Evidence:** editor.md:115-133,256-272; https://nodejs.org/api/fs.html
- **Reversibility:** hard (durable draft safety contract)
- **Confidence:** high
- **Revisit if:** an OS-level transaction primitive becomes available
- **Source:** assumed — autonomous

## D8: Preserve untouched Markdown or refuse rich editing
- **Question:** Rich-mode round trips, unsupported syntax, size limits, front matter and fallbacks?
- **Options:** canonical serialize entire document; original-source reconcile with safe fallback to source
- **Chose:** preserve untouched bytes/EOL/front matter, no-op is exact; unsupported or unprovable round-trip uses source with explanation; documented 600 KiB/1 MiB/8 MiB gates
- **Why:** TipTap supplies structural conversion, not byte preservation; unsafe canonical fallback would violate the feature's defining invariant.
- **Evidence:** editor.md:322-368; https://tiptap.dev/docs/editor/markdown/getting-started/basic-usage; accessible Orca source reconciliation utility
- **Reversibility:** medium
- **Confidence:** medium
- **Revisit if:** source preservation cannot be verified for an enabled syntax
- **Source:** locked by editor.md

## D9: Treat notebooks as local arbitrary code execution
- **Question:** Trust, interpreter selection, missing dependencies, execution lifetime and outputs?
- **Options:** run automatically; trust per open notebook with explicit setup confirmations
- **Chose:** tab-lifetime trust before kernel start/run; local Python only; workspace/PATH discovery; explicit arbitrary interpreter probe/install/venv; sequential queue, interrupt/restart/close cleanup; sanitize/sandbox outputs, never widgets/JS
- **Why:** notebook cells and interpreter executables run arbitrary code; no silent global modification is safe.
- **Evidence:** editor.md:171-185,389-400; https://jupyter-server.readthedocs.io/en/latest/operators/security.html
- **Reversibility:** hard (security contract)
- **Confidence:** high
- **Revisit if:** execution-host capability changes in a later milestone
- **Source:** locked by editor.md

## D10: Bound file inventory, search and specialized viewer memory
- **Question:** Pagination/truncation, file limits, binary handling, search cancellation and viewer modes?
- **Options:** materialize every file/result; documented caps and paged/range transport
- **Chose:** documented inventory/query/result limits, visible truncation and cancellation, read-only paged CSV >=1 MiB, bounded media/PDF/image data, unsupported binary/error surfaces; lazy viewers dispose when hidden
- **Why:** preserves responsiveness and the locked memory model.
- **Evidence:** editor.md:297-320,402-444; docs/architecture.md:205-220; https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Range_requests
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** real workloads show limits are too tight
- **Source:** locked by editor.md

## D11: Classify observations separately from defects
- **Question:** Which feature-doc observations require regression tests or decisions?
- **Options:** label every unexercised behavior broken; classify actual discrepancies and preserve stated behavior
- **Chose:** fix deleted-clean-save no-op and shortcut double-dispatch; preserve slash Escape leaving `/`; support `.markdown` explicitly; inserted images retain supplied alt text; persist activity position; test unexercised paths rather than claim Orca defects
- **Why:** the feature has no numbered defect register; unverified questions are not evidence of failure.
- **Evidence:** editor.md:132,464,482,497-505; logic.md Defect regression requirements
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** new parity evidence resolves an open question differently
- **Source:** assumed — autonomous

## D12: Keep feature-owned handoffs on public contributions
- **Question:** Changes/conflicts, browser HTML preview, artifacts, remote owners and native chat?
- **Options:** duplicate neighboring feature implementations; call existing declared public contributions
- **Chose:** editor entry points call available public APIs/commands and expose precise unavailable errors for features not yet installed; no private cross-plugin imports; native chat excluded by architecture
- **Why:** the feature doc explicitly names these as dependencies/handoffs, not editor implementation internals; roadmap schedules remote/browser capabilities separately.
- **Evidence:** editor.md:7,447-457; docs/architecture.md:175-178; plugins/test/imports.test.ts:50-70
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a later plugin supplies the named handoff
- **Source:** locked by docs/architecture.md

## D13: Record macOS-only integration and native verification
- **Question:** What platform/native behavior can this lane verify?
- **Options:** simulate desktop dialogs in web; verify web flows and hand off real OS interactions
- **Chose:** macOS Trash/reveal/open and cmd bindings now; Linux/Windows counterparts need later verification; native pickers, clipboard/drag, save sheet and OS default-app focus go in nightly scenarios
- **Why:** LOOP.md permits headless web only and requires native handoff.
- **Evidence:** docs/loop/LOOP.md:124-137; docs/loop/NATIVE.md:60-82
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** cross-platform test hosts become available
- **Source:** deferred: platform

## D14: Self-review the design and author both markdown specs
- **Question:** Is the purpose/consumer/behavior/success/constraints/scope coverage sufficient, and can design approval proceed unattended?
- **Options:** wait for a person; self-review then Codex adversarial review
- **Chose:** self-reviewed the conceptual model, data flow, scenarios, non-goals and glossary against full editor.md; markdown logic spec plus required code-anchored tech spec, then combined Codex review before implementation
- **Why:** essentials are grounded in locked docs; LOOP.md replaces human approval with recorded autonomous decisions.
- **Evidence:** docs/loop/LOOP.md:80-105,175-200; docs/quirk/specs/2026-10-27-m2-editor/logic.md
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** spec review identifies an unmet requirement or locked conflict
- **Source:** locked by docs/loop/LOOP.md

## D15: Accept three Codex spec findings and dismiss lexical planned-reference alarms
- **Question:** How should the combined spec review's 46 findings be adjudicated?
- **Options:** apply every lexical alarm as a missing implementation; distinguish confirmed contract gaps from examples/planned deliverables
- **Chose:** accept F1 close identity, F2 concurrent drafts and F3 Keep/autosave; fix with actual tabId routing, contentRevision compare-and-set, and a persisted autosave hold until explicit save/reload. Correct F8's shorthand source pointer. Dismiss F4–F7 and F9–F46 as examples, explicitly new APIs/files/tests, guarded real-user paths, or a skill invocation rather than existing executable.
- **Why:** Codex promote and fresh refute upheld F1–F3. The deterministic lexical prepass treats planned file names and schema identifiers as missing live references; those are intended deliverables, not stale anchors. It cannot infer the spec's create/SCHEMA/CONTRACT context. No implementation claim was made for them.
- **Evidence:** /tmp/m2-editor-review.CRnYWV/gate.json; manifest.json; review-report.json. Gate: NEEDS_FIXES, 46 blockers, no suppressed/contested/advisory; reviewer codex OpenAI gpt-6.1-sol, reduced family independence, standard depth. Logic SC-2/3/5 and tech Contracts amended.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** implementation or review demonstrates a cited existing anchor is genuinely stale
- **Source:** assumed — autonomous

## D16: Add a public scoped file resource capability for real viewer streaming
- **Question:** How can media/PDF/image viewing use bounded ranged transport without private daemon access?
- **Options:** full base64/data URLs; private route import; grow PluginContext with scoped file resource registration
- **Chose:** createFileResource({path,contentType,disposition?}) returning capability URL/revoke, with GET/HEAD/single-range, fixed canonical identity, no-follow request recheck and activation-scoped revocation; daemon/protocol owner isolated from plugin workers
- **Why:** capability scout found no public file HTTP or native media transport. The roadmap requires API growth for feature needs. A narrowly scoped bearer URL avoids exposing filesystem paths or global daemon token.
- **Evidence:** packages/protocol/src/plugins.ts:48-78; packages/daemon/src/server.ts:73-112; packages/daemon/src/plugins/host.ts:20-36,511-565; EditorResourceSeam research
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** media/PDF integration reveals a missing range/lifecycle contract
- **Source:** assumed — autonomous

## D17: Export PDFs through a real isolated Chrome renderer
- **Question:** Which actual print renderer can satisfy Markdown export when the desktop has no public PDF API?
- **Options:** fake/basic PDF bytes; external unavailable command only; installed Chrome with disposable profile and bounded headless print/CDP
- **Chose:** installed Chrome, real rendered HTML, 60-second timeout, isolated profile/temporary assets and process cleanup; actionable error if no renderer is installed
- **Why:** scout verified the Chrome executable; no existing desktop PDF or Quirky browser print API exists. This is on-demand export, not a persistent browser/helper or an import of future browser-plugin internals.
- **Evidence:** /Applications/Google Chrome.app/Contents/MacOS/Google Chrome; packages/protocol/src/ui.ts:192-232; EditorResourceSeam research
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** real export smoke fails or a later public browser print API replaces it
- **Source:** assumed — autonomous

## D18: Use one six-component implementation wave with explicit disjoint scopes
- **Question:** How should the reviewed feature be decomposed and checked?
- **Options:** horizontal dependent waves; one contract-first wave of six independent components
- **Chose:** six components: public resources (protocol/daemon), hosted tabs (terminal), editor core/manifest/types/package, base UI/build packaging, Markdown, notebooks/viewers. All interfaces fixed in tech.md; one worktree per component; width cap 6, no cap binding and no successor/checkpoint. Parent audits each scope/HEAD, runs task acceptance after all workers return, commits/merges, then full gate and one final three-lens review/fix batch.
- **Why:** components write disjoint files and can use fixed contracts before implementations land; shared hubs have one owner. All named acceptance flows remain assigned. No worker runs build/lint/tests/formatters mid-flight or commits; tests are written before implementation, and parent runs them after the wave as required by tool delegation policy.
- **Evidence:** docs/quirk/specs/2026-10-27-m2-editor/tech.md; package.json:10-15. Bun 1.4.0 is available. xd://lsp references on PluginContext reported no language server, permitting symbol-search fallback.
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** scope audit finds a true dependency or conflict
- **Source:** assumed — autonomous

## D19: Import every Finder drop for this item
- **Question:** How should SC-9 behave while Electrobun does not expose native dropped-file source paths?
- **Options:** block m2-editor; add an unsupported native hook; import every Finder/OS file drop for now
- **Chose:** every Finder/OS file drop into the editor/explorer imports a collision-safe copy, including files already inside the worktree. App-defined internal drags and terminal path insertion keep their existing semantics. Keep native SC-9 pending and land after all other gates pass.
- **Why:** the user explicitly selected this policy through the operator. Native open-in-place belongs to the operator-queued `m4-editor-drop-open-in-place`; this lane must not add another item or block m2-editor over it.
- **Evidence:** operator/user ruling in this conversation, 2026-10-27; docs/loop/native/m2-editor.json SC-9-native
- **Reversibility:** easy (drop routing can use native source paths when the runtime supplies them)
- **Confidence:** high
- **Revisit if:** the operator's follow-up implements supported native drop-path events
- **Source:** user ruling 2026-10-27 (via operator)

## D20: Keep public file resources and panel geometry generic
- **Question:** Which missing kernel capabilities does the editor need?
- **Options:** private daemon/DOM access; full binary JSON payloads; public scoped resources and panel configuration
- **Chose:** activation-scoped file capabilities with GET/HEAD/single-range; `ui.panel.configure` with per-panel width and global Top/Side preferences; existing public calls and generated CLI routes
- **Why:** the changed paths were exercised through real daemon API, CLI and browser surfaces without coupling the shell to editor setting IDs.
- **Evidence:** file-resources.test.ts: 11 pass/101 assertions; panel-geometry.test.ts: 3 pass/48 assertions; resource-tree typecheck and UI build pass; geometry browser reports 20261027T143038-f445 and 20261027T144225-3856 under the resource worktree's ignored .quirk directory
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** a consumer needs another passive MIME type, layout constraint or resource lifecycle
- **Source:** assumed — autonomous

## D21: Bound text transport instead of raising the RPC frame limit
- **Question:** How can 50 MiB local files and 16 MiB pastes fit the existing 16 MiB JSON transports?
- **Options:** reduce editor limits; raise global frame limits; metadata snapshots and bounded editor transfers
- **Chose:** public buffer metadata with lazy text reads and staged 64 KiB byte uploads; internal buffers stay complete; compare-disk text uses its own signature; drafts commit only against the original content revision
- **Why:** JSON escaping/envelopes make whole-string requests exceed the current socket cap. Chunking preserves the feature limits and stops incomplete uploads from autosaving.
- **Evidence:** packages/daemon/src/socket-server.ts MAX_LINE_BYTES; packages/protocol/src/client.ts; plugins/quirky.editor/src/types.ts and src/daemon/service.ts
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** the public transport gains a generic bounded transfer primitive
- **Source:** assumed — autonomous

## D22: Stop unsafe smoke setup and preserve uncertain user configuration
- **Question:** How should verification recover from the discovered hook-installer side effect?
- **Options:** blindly uninstall every Quirky marker; restore unrelated old backups; preserve files without a trustworthy before-image and isolate subsequent runs
- **Chose:** stop the unsafe smoke, inspect ownership read-only, leave the six real-home paths intact because their exact previous bytes are unknown, and preseed `setting:quirky.agent-status/hooks=false` before fixture startup. Child app runs also use a temporary HOME and an environment whitelist.
- **Why:** a temporary QUIRKY_HOME does not change the installer HOME. Generic markers identify Quirky, not this run; uninstall could remove user-desired entries. No installer journal or suitable local Time Machine snapshot was available.
- **Evidence:** the direct CLI smoke logged writes to ~/.codex/hooks.json, ~/.gemini/settings.json, ~/.cursor/hooks.json, ~/.config/opencode/plugins/quirky-opencode-status.js, ~/.pi/agent/extensions/quirky-agent-status.ts and ~/.omp/agent/extensions/quirky-agent-status.ts. Read-only installer audit found no preimage backup; `tmutil listlocalsnapshots /` returned no snapshots. The corrected CLI smoke exited 0 and all six before/after SHA-256 values matched.
- **Reversibility:** hard (exact earlier configuration requires an independent baseline)
- **Confidence:** high
- **Revisit if:** a trustworthy pre-smoke snapshot becomes available
- **Source:** assumed — autonomous

## D23: Keep editor declarations within the binding flat schema subset
- **Question:** How should integration repair the editor manifest's unsupported union and constraint keywords?
- **Options:** expand the shared schema language; remove constraints without documenting them; project declarations faithfully into the supported subset and retain explicit service guards
- **Chose:** honor m0-scripting D4. Use supported scalar/object/array schemas and enums where representable; describe nullable/heterogeneous variants and conditional requirements precisely where the subset needs `{}`. Keep action-specific requirements, lengths and bounds enforced by editor services. Do not add shared schema keywords.
- **Why:** the combined source typechecks, but all 22 core API tests fail because registration rejects the manifest before invocation. This is a declaration incompatibility, not 22 independent missing methods. D4 explicitly permits descriptive schemas for unions.
- **Evidence:** packages/protocol/src/schema.ts; docs/loop/decisions/m0-scripting.md D4-D6; combined core.test.ts run: 0 pass, 22 fail; diagnostic harness reports quirky.editor invalid with unsupported keyword/type diagnostics
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** an approved later item changes the shared schema language
- **Source:** locked by docs/loop/decisions/m0-scripting.md D4-D6

## D24: Preserve integration checkpoints and isolate repair ownership
- **Question:** How should the implementation wave recover from incomplete handoffs and integration failures?
- **Options:** discard the implementation; hide missing flows; retain explicit checkpoints and assign bounded completion/repair slices
- **Chose:** finish original component handoffs with replacement owners, audit scopes, assemble the complete source, and checkpoint compiler repairs before two disjoint manifest/command repair tasks. The main item branch now contains the assembled source. No checkpoint claims runtime completion.
- **Why:** the initial assembly exposed parser defects and 100 semantic diagnostics; five isolated repair slices returned, their changes were scope-audited, and combined typecheck passed. The subsequent core runtime run exposed D23. Earlier accidental relative-path/root-file writes were restored or relocated before assembly; generated Serena scaffolds were removed.
- **Evidence:** assembly checkpoint fccb94a; typed repair checkpoint 20cd578; /tmp/m2-editor-sdd.bnKf9F/type-fix-journal.json; main merge of build/m2-editor-wavecheck-i2
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a scope audit finds an unowned change
- **Source:** supersedes m2-editor D18

## D25: Prioritize blocking core flows and land under the operator deadline
- **Question:** Which remaining work gates this landing after the operator's latest user decision?
- **Options:** finish the original exhaustive acceptance plan first; land without checks; fix core-flow blockers, record remaining findings and queue a dependent completion item
- **Chose:** fix only blocking findings, verify the affected package suites plus scripts tests and typecheck, run core browser smoke, catch up with build/roadmap once and land. The land operation runs the whole suite. Before landing, add a dependent follow-up naming every unfinished flow and its reason; append open findings to BLOCKERS.md. Do not duplicate the operator-owned SC-9 open-in-place item.
- **Why:** the user explicitly prioritized landing this item within the next hour so the build can land by 4am, and authorized unfinished flows to move to a named follow-up.
- **Evidence:** latest operator note in this conversation; schema/command integration checkpoint f684af5; integrated typecheck passes; runtime suites identify concrete blockers now assigned to four disjoint owners
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a core data-safety flow cannot pass its affected tests
- **Source:** user ruling 2026-10-27 (via operator)

## D26: Publish the supported core contract and queue exact completion work
- **Question:** Which incomplete flows remain after the deadline-authorized core cutover?
- **Options:** claim the original matrix passed; leave known unsupported actions advertised; publish the supported boundary and queue the exact remaining work
- **Chose:** queue `m2-editor-complete-remaining-flows` in M2, depending on `m2-editor`, with the implementation gaps, observed UI defects and unfinished acceptance variants listed in BLOCKERS.md. Keep named Markdown creation; do not publish retarget/Save As or details/collapsible-heading/custom-document-link formats until their rich round trips exist. Keep safe Source fallback/rejection and unchanged drafts.
- **Why:** the public creation path does not create untitled buffers, and the unsupported rich constructs fail serialization or cannot preserve their semantics. The user explicitly authorized these named flows and the exhaustive GUI matrix to move to a dependent item. Core formatting, tables, math, ordinary links, note delivery and viewer primitives remain implemented.
- **Evidence:** Markdown RPC stage trace; source capability checks; current manifest; `docs/loop/BLOCKERS.md` m2-editor section; successful `queue.ts add` of the dependent item
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the dependent item supplies the missing real paths and end-to-end proof
- **Source:** user ruling 2026-10-27 (via operator)

## D27: Use actual runtime evidence to close core integration failures
- **Question:** Which evidence, rather than compilation or declarations, gates the core implementation?
- **Options:** rely on typecheck and model review; exercise APIs, real kernels, CLI and browser surfaces
- **Chose:** real daemon/CLI acceptance, disposable Python kernels, and like-a-user web runs. Fix observed cursor/TOC presentation schema mismatch, canonical viewer/notebook RPC names, deferred React event reads and passive image source-mode gating. Preserve failed reports and collect fresh post-fix visual proof instead of rewriting their verdicts.
- **Why:** API-only tests did not execute the renderer callback boundary. Browser evidence exposed failures that the compiled source and method schemas alone could not prove.
- **Evidence:** runs `20261027T195525-588b`, `20261027T204701-c6c5` and `20261027T210143-c4f5` under the wavecheck ignored .quirk directory; source save/reopen, dirty-close choices, commands, rich/source/preview, CSV persistence, image zoom and PDF rendering were observed. Real-kernel edge and selective-note-delivery API files passed.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** final integration or native evidence contradicts a core result
- **Source:** assumed — autonomous

## D28: Record the single cross-family review and its fix batch precisely
- **Question:** What did the final review establish, and what did runtime verification add?
- **Options:** treat a model PASS as full acceptance; retain exact snapshot, stage results and later fix evidence
- **Chose:** one C/S/X round at explicit standard depth with Gemini, full family independence against OpenAI implementers, then one combined runtime/finding fix batch and rechecks. No extra review rounds. Formal gates passed for snapshot 6fa3ebd; they do not certify later fixes or the entire acceptance matrix.
- **Why:** Opus/Sonnet were unavailable at preflight. X's external-import claim was independently refuted against the authenticated caller-selected import contract. S's cleanup-race claim was gate-suppressed for an inexact quote, but independent source investigation confirmed a rescan release race; activation is now blocked during stale teardown, with a real store-counter/subscription regression.
- **Evidence:** /tmp/m2-editor-final-review-slL2EP/{report,resolve,prepass,model,gate-C,gate-S,gate-X}.json; all gates PASS, suppressed counts C=0/S=1/X=1; artifact aee21f5709ed1ad7955b6c69bdabc395b7858a176ba4b665da40454e780f68b6; repaired lifecycle/core/UI/hosted-tab failed-file rerun passed
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the final land check exposes a remaining integration defect
- **Source:** assumed — autonomous

## D29: Isolate every actual test child without changing transport or parent state
- **Question:** How can remote/local acceptance avoid real HOME writes and verify delete recovery safely?
- **Options:** mutate process.env; add feature-specific test shims; isolate each bun test child and retain real filesystem behavior
- **Chose:** the suite runner creates temporary HOME/QUIRKY_HOME values, seeds hooks off and cleans up in finally for local and slotted test processes. SSH transport and machine-wide slot locks retain their existing environment. Delete undo/redo uses the same no-overwrite cross-device move primitive as trash moves.
- **Why:** a temporary harness home alone does not change homedir-based integration writes; the earlier remote undo failure also exposed an EXDEV path. No global environment mutation or real-trash cleanup by guessed ownership is used.
- **Evidence:** scripts/suite.ts and its real-child isolation regression; core delete/history acceptance; D22 and the earlier affected-package failure log
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** another test subprocess bypasses this runner or a recovered path fails identity checks
- **Source:** assumed — autonomous

## D30: Own renderer completion rather than depend on Chrome teardown status
- **Question:** What marks successful Markdown PDF export when Chrome finishes the file but its macOS shutdown watchdog exits abnormally?
- **Options:** accept partial files; depend only on child exit zero; validate complete output before explicitly stopping the owned renderer
- **Chose:** bounded header/tail validation observes a real `%PDF-` artifact ending in `%%EOF`, then requests shutdown of that exact child and awaits close. Spawn failures, timeouts and incomplete output still fail. Revalidate before staging/copying to the authorized destination. A handled shutdown may translate its exit status; it is not the render-completion signal.
- **Why:** the real renderer wrote approximately 70 KiB of valid PDF before the teardown watchdog failed. Waiting solely for exit zero reported a failed export after rendering had completed. No fabricated bytes or fallback renderer is used.
- **Evidence:** remaining-gates.log and pdf-ready.log; `plugins/quirky.editor/src/markdown/pdf.ts`; the consumer test reads the selected destination and returned canonical path and checks PDF signature/EOF without requiring a particular `/var` versus `/private/var` spelling
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** validated output is incomplete or owned renderer cleanup exceeds its bound
- **Source:** assumed — autonomous

## D31: Combine the single catch-up's additive APIs and cleanup contracts
- **Question:** How should the pinned roadmap catch-up be integrated without dropping either lane's behavior?
- **Options:** choose one side; add compatibility shims; combine the actual additive changes and retain both cleanup boundaries
- **Chose:** one catch-up at d3f4b74eb6964c133ffc46c9cce1fc13b4c1e77c. Read all twelve incoming decision logs; no binding design conflict was found. Resolve the nine code conflicts by retaining resource capabilities, geometry and hosted tabs together with optional stored settings, badge titles/unread state, shared fixture helpers, sound assets, and incoming process-scope cleanup. Per-test HOME isolation remains inside the owned process boundary; SSH environment and machine-wide slots remain unchanged.
- **Why:** incoming fixes explicitly require awaited disposable-process ownership and preserve production PTY persistence. Sidebar additions retain the existing default controls and one-panel layout. Blocked terminal-dock design prose is not treated as an approved new implementation contract.
- **Evidence:** incoming logs for fix-ask-regex-budget-20261027, fix-sc31-first-shell-race, fix-test-process-leaks, m1-agent-status-scripting, m1-notifications, m2-sidebar-extras, m2-source-control-core, m2-source-control-notes-ai, m3-terminal-dock, m5-ledger, m5-structured-runner and sa-browser-agent; full-read reports CatchupDecisionsA/B; scoped merge handoffs KernelMerge/ShellMerge/RunnerMerge
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** post-merge typecheck or the land verification exposes a concrete integration defect
- **Source:** locked by docs/loop/LOOP.md and the incoming decision logs

## D32: Apply the retained isolated-retry policy to loaded loop tests
- **Question:** How should three default-five-second batch-land test timeouts be classified after catch-up?
- **Options:** edit protected tests or raise their limits; ignore the failures; run the failed file alone under the retained retry policy
- **Chose:** keep the protected loop/tests and their timeout unchanged; rerun only `scripts/build-loop/lanes.test.ts` in isolation. It passed. Preserve the full-run failure and isolated result as load-sensitive evidence, not a source fix.
- **Why:** the full scripts run had 60 passes and three timeouts in the same file; all isolated cases completed successfully with the original bound. Incoming decisions explicitly retain isolated retries for contention.
- **Evidence:** catchup-scripts.log; catchup-loop-isolated.log, exit 0; post-catch-up typecheck and the five-file resource/geometry/lifecycle/hosted-tab/link boundary suite also passed
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the same case fails in isolation or land verification reports a reproducible defect
- **Source:** locked by docs/loop/decisions/fix-test-process-leaks.md

## D33: Bootstrap candidate dependencies at the local test boundary
- **Question:** Why did controller verification miss declared editor packages while the current checkout and remote tests resolved them?
- **Options:** duplicate dependencies at the root; install by hand in the controller worktree; alter protected loop code; bootstrap the current checkout before local test execution
- **Chose:** use the same unfiltered frozen root install at the suite CLI's local boundary that the remote-copy path already uses. Keep generic `runSuite`/`runFiles` fixture helpers independent of a package manifest. Do not edit protected prepareVerify or work manually in its tree.
- **Why:** the controller installs before merging the candidate, then tests the merged source without a dependency refresh. React and Sanity are already runtime dependencies in the editor package and lockfile; the local failure was not an undeclared-package excuse.
- **Evidence:** failed land bg_70; VerifyDependencyScout; protected lanes.ts install/merge order at 158-166 and 264-285; remote suite copy/install order
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a clean candidate test process still cannot resolve a declared workspace dependency
- **Source:** assumed — autonomous

## D34: Reject stale fetched UI snapshots after a newer layout event
- **Question:** Can an older in-flight UI snapshot overwrite a newer layout event during cross-feature navigation?
- **Options:** raise view-test timeouts; disable editor startup; retain the newer event instead of applying an older in-flight snapshot
- **Chose:** track UI-state event freshness in WindowPluginHost and ignore a fetched snapshot superseded while its request was in flight. Add a deterministic held-response/newer-event regression; keep daemon layout semantics and all plugin surfaces.
- **Why:** the held-response regression establishes that ordering invariant independently. The two remaining Git waits did not mean their views never opened: one expected an unavailable host agent, and the other clicked the editor's global Collapse All instead of the combined-diff control. Those fixture corrections are separate from this host guard.
- **Evidence:** LandLayoutRegressions; packages/ui/src/plugins/host.ts and its held-snapshot regression; exact controller wait predicates in ai.test.ts:190 and view-combined.test.ts:59
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a newer event is lost or initial snapshot loading cannot complete
- **Source:** assumed — autonomous

## D35: Make environment and import-fence fixtures test their actual boundaries
- **Question:** Which full-suite failures were invalid host/parser assumptions rather than missing feature implementations?
- **Options:** restore real HOME; require installed/authenticated Claude; edit production text to evade a regex; use owned prerequisites and syntax-aware inspection
- **Chose:** preserve HOME isolation; use a real temporary agent contribution for Create More, select the agent supplied by the AI-settings fixture, and remove the structured fake-runner test's unrelated host-Claude assertion. Scope combined-diff Collapse/Expand controls to their toolbar. Replace the import fence's raw-source regex with TypeScript syntax traversal, preserving type/runtime path and package rules.
- **Why:** a quoted `import` string is not an import; isolated HOME must not depend on personal agent installations; multiple feature surfaces may legitimately expose the same button label. Keep actual ask, prompt, reset, recipe, collapse and public-boundary assertions rather than renaming production controls or restoring host state.
- **Evidence:** exact controller wait predicates and fixture prerequisites; deterministic provider fixture; syntax-import-fence.log exit 0; bootstrap-suite-fixed.log exit 0
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a real forbidden import escapes or a UI prerequisite still depends on host state
- **Source:** assumed — autonomous

## D36: Budget process-integration fixtures for awaited ownership cleanup
- **Question:** How should the suite-runner tests account for several real Bun children and guardian teardown in one case?
- **Options:** return before cleanup; remove isolation; use an outer integration-case bound while preserving functional cleanup assertions
- **Chose:** 30-second bounds only on the unprotected suite-runner child-process integration cases. Keep the detached-process test's internal five-second cleanup assertion, production deadlines and protected loop-test bounds unchanged.
- **Why:** default five-second case expiry deleted fixture directories while owned async children were still settling, producing collateral ENOENT errors. The fixtures must await their real child lifecycles rather than hide cleanup or depend on contention-free timing.
- **Evidence:** bootstrap-suite-test.log; corrected recursive local-workspace fixture; bootstrap-suite-fixed.log exit 0 and repair-scripts.log exit 0
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a functional cleanup assertion fails or a case exhausts its integration bound
- **Source:** assumed — autonomous

## D37: Repair the controller-reported moving-tip conflict on the item branch
- **Question:** What can finish landing after the roadmap advances and the controller rejects an actual merge conflict?
- **Options:** discard either feature set; force or edit the controller worktree; resolve the reported conflict on the item branch
- **Chose:** after the single planned catch-up, repair only the concrete concurrent-tip rejection by merging pinned 1c73fb19ceffd0ae6a0cd5b16b7a4a5cf23ec4ce on build/m2-editor. Read all six newly landed/updated logs and preserve account status-bar, terminal-accessory, session/hosting, guardian and editor contracts. No protected or foreign integration state is edited.
- **Why:** the second land attempt stopped before verification because of conflicts, not an editor failure. A conflict repair is required to preserve both branches and complete the authorized land; it is not an optional repeated catch-up or a reason to drop hosted views.
- **Evidence:** bg_79; pinned conflict-repair record; full reads of fix-flaky-quirky-git-files-scenarios, fix-flaky-quirky-worktree-window-projects, m3-accounts, m3-session-info, m4-hosting-api-github and updated m5-structured-runner; five reported source/test conflicts
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** the controller reports another concrete conflict or verification defect
- **Source:** locked by docs/loop/LOOP.md step 7 conflict recovery

## D38: Preserve handoff's terminal IDs and background focus alongside hosted views
- **Question:** How should the next reported moving-tip conflict incorporate the newly landed handoff contract?
- **Options:** drop hosted views; strip handoff IDs/focus; combine the terminal-only append contract with the Tab union
- **Chose:** repair the concrete rejection against pinned 1df36ca1c71e3f18951ccc093de23da53b1d243f. Read the complete m3-handoff D1–D84 log. Keep `activate:false` append behavior and `{workspace,session,tab,pane}` new-terminal IDs; keep view open/rekey and synchronous editor close guards. Narrow terminal-only expanded-pane/test accesses rather than invent sessions for views.
- **Why:** handoff's incoming caller appends via newTab and does not replace/remove hosted views. The existing destructive tab/group paths remain guarded, so no new bypass or queue cycle is introduced. Obsolete copied contribution/count tests stay removed.
- **Evidence:** bg_81 rejection; merge ba9718c; HandoffHostedMerge audit; newtab-activate test Tab-union narrowing
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** a handoff append steals focus or an unguarded destructive view mutation is introduced
- **Source:** locked by docs/loop/decisions/m3-handoff.md

## D39: Select one optional editor fixture and await published autosave completion
- **Question:** What remained after the full controller run reached 506/509 passing files?
- **Options:** skip handoff coverage; alter the real editor to satisfy a fake; select one fixture implementation and synchronize actual completion
- **Chose:** the handoff rig excludes the optional real editor when constructing its controlled built-ins, then installs exactly the requested fake editor for that boundary case. The editor autosave test waits for both disk bytes and the published clean buffer before asserting completion; its five-second bound is unchanged.
- **Why:** the new real editor collided with the old fixture's symlink at the same ID. Separately, an autosave may publish disk bytes before acknowledging the clean buffer snapshot; observing that intermediate state is not evidence the save failed. The host timeout case passed the existing isolated retry and its production/test deadlines stay unchanged.
- **Evidence:** bg_85 full verification; plugins/quirky.handoff/test/support.ts; core-acceptance autosave condition
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the optional real integration is incompatible or disk and published buffer do not converge
- **Source:** assumed — autonomous

## D40: Migrate handoff's optional editor consumer to real tab/buffer metadata
- **Question:** Does fixing the optional fixture collision also prove that handoff reads the new editor correctly?
- **Options:** keep the fake-only documents response; add a legacy shim to the editor; migrate the consumer and prove the real public integration
- **Chose:** consume `quirky.editor/state` through its actual `buffers` and `tabs`, joining tab buffer IDs, deduplicating live documents and retaining the existing root/path caps. Change the controlled fixture to that shape and add a real-editor daemon case; do not add a nonexistent legacy documents response to the producer.
- **Why:** the audit found the RPC name/request matched but handoff required a top-level documents array, which the real metadata-only editor never returns. A passing fake-only case would conceal a missing live document listing.
- **Evidence:** HandoffEditorContract; handoff source.ts readEditorTabs; editor state metadata contract and fakeEditor response
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a tabless retained draft is listed as open or content hydration is required for a paths-only block
- **Source:** assumed — autonomous

## D41: Preserve declared private assets and pinned graphs in the reported browser/ledger conflict
- **Question:** How should the next concrete moving-tip conflict retain editor and browser packaging without losing dependency pins?
- **Options:** choose one package set; accept an unconstrained lock regeneration; combine package/workspace records and the existing syntax fence
- **Chose:** resolve the reported rejection at pinned cfaab6ab219f9feba003d1643f18efedc2560290. Read both updated ledger/browser logs. Keep editor UI/KaTeX/PDF/Python assets, sounds/notices and the incoming declared private binary/LICENSE assets. Preserve both Mac-only reasons. Consolidate the equivalent TypeScript fences using the broader import-equals-aware traversal and retain both regression sets.
- **Why:** both workspace additions are required. The initial partial lock resolution could not name the missing browser workspace; restore the exact three-way workspace/package records from the two valid parent locks and their common base, rather than silently upgrading unrelated pins. The semantic record merge has no conflicting values.
- **Evidence:** bg_89 conflict rejection; LastPackagingMerge full log reads and asset audit; parent-lock semantic merge against c183153/cfaab6ab/1df36ca; no protected or controller-tree edits
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** frozen installation or packaging cannot resolve a declared private asset
- **Source:** locked by docs/loop/decisions/sa-browser-agent.md and docs/loop/decisions/m5-ledger.md

## Progress
Step 7 resubmission ready: the reported browser/ledger conflict is resolved in e394b9a plus the pin-preserving lock correction. Both updated logs were fully read. Frozen install, typecheck, full packaged-app build and the combined import fence pass; editor/real-handoff/core and earlier full-controller repair proofs remain intact. Commit/detach and resubmit without optional scope changes. The controller still decides complete merge acceptance; do not claim landed or alter protected/foreign integration state.

Last SC-9 point: Finder drops import copies under D19, including in-worktree sources. Native SC-9 stays pending for the nightly run. Open-in-place is owned by the operator's `m4-editor-drop-open-in-place`, not an m2-editor blocker.
