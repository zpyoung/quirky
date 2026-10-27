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

## Progress
Step 4 complete: full logic and technical specs authored, self-reviewed and Codex promote/refute reviewed; accepted F1–F3 fixed, lexical planned-reference findings adjudicated in D15. Native scenarios written. Step 5 next: commit specs/log, record RUN_BASE and create six disjoint component worktrees, then dispatch omp implementers under contracts in tech.md. Pair fixed: OpenAI implementers + Gemini final reviewer (Opus unavailable). No implementation yet.
