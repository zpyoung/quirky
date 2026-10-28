# m2-editor-build-unbuilt-flows decisions

## D1: Preserve the prior ownership cutover
- **Question:** Does the historical title authorize rebuilding overlapping editor flows?
- **Options:** rebuild the title verbatim; honor delivered code and existing completion owner
- **Chose:** implement only Explorer navigation/selection, notebook idle-death recovery controls, CSV clipboard controls and mounted viewer lifetime. Preserve delivered untitled/Save As/provenance and leave rich details/document links/permissions with m7-editor-source-control-completion.
- **Why:** predecessor D20 explicitly narrows this follow-up after incoming delivery; canonical queue confirms the other completion is held by lane3.
- **Evidence:** docs/loop/decisions/m2-editor-complete-remaining-flows.md D20; canonical queue items m7-sweep-editor-source-control done and m7-editor-source-control-completion in-progress lane3; MapEditorFlows source map
- **Reversibility:** medium (work ownership)
- **Confidence:** high
- **Revisit if:** a later explicit scope ruling transfers the other owner
- **Source:** locked by docs/loop/decisions/m2-editor-complete-remaining-flows.md D20

## D2: Apply unattended build-first workflow
- **Question:** Which skill gates and human choices apply?
- **Options:** human prompts/full research/review campaigns; recorded recommended defaults and one spec
- **Chose:** standard gray areas, no prompts/research swarm, single logic spec with technical section; tests authored but no suites/reviews/dogfood run. Typecheck is the user landing gate. Developer-required minimal runtime smoke remains narrow, isolated and distinct from acceptance campaigns.
- **Why:** current canonical LOOP build-first section supersedes its earlier general workflow; higher-priority runtime evidence requirement remains binding.
- **Evidence:** git show build/roadmap:docs/loop/LOOP.md; runtime verification developer instruction
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** m7-test-triage starts or instructions change
- **Source:** locked by docs/loop/LOOP.md

## D3: Extend the canonical services, not a second editor state model
- **Question:** Architecture approach and consumer outcome?
- **Options:** focused service extensions; renderer-only features; replacement editor/store
- **Chose:** existing public namespaced methods and flat manifest schemas, daemon-owned interaction state, existing CodeMirror/TipTap buffers
- **Why:** every visible action must be scriptable and visible state readable; replacements split durable-draft ownership.
- **Evidence:** docs/roadmap.md What the order rests on; docs/architecture.md UI and Decisions
- **Reversibility:** hard
- **Confidence:** high
- **Revisit if:** public API cannot represent required behavior
- **Source:** locked by docs/architecture.md

## D4: Separate Explorer focus, anchor and selected membership
- **Question:** Keyboard/range semantics and persistence?
- **Options:** last selected member as focus; explicit focus and stable anchor in daemon
- **Chose:** navigate/select actions compute authorized visible rows; exact Home/End/Page/Left/Right and Shift contraction; Cmd/Ctrl toggles; Enter renames and Space activates. Expansion/selection survive remount as ephemeral daemon state, not a DB migration.
- **Why:** last member fails backward range contraction and renderer-only selection cannot be driven/read by agents. Page step is max(1,floor(rows/10)). Invalid hidden/stale targets never select unrelated files.
- **Evidence:** editor.md section8 keyboard/selection; ExplorerPanel.tsx:424–463; ExplorerService current inventory/preferences API
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** end-phase tree interaction evidence shows mismatch
- **Source:** locked by editor.md

## D5: Preserve restart trust revocation and publish genuine idle death
- **Question:** Does exposing restart from dead redefine restart?
- **Options:** silently restart and retain trust; expose existing stop/revoke/retrust lifecycle
- **Chose:** retain existing restart API status stopped/trusted false/outputsKept true, preserve selected Python; show restart when dead and publish actual current-session death. Next explicit Run requests fresh trust and starts a new session.
- **Why:** the public service and existing tests deliberately revoke trust on restart; missing UI controls/events do not authorize weakening this gate.
- **Evidence:** notebook/service.ts:751–759; notebook/kernel.ts:127–145; NotebookSurface.tsx:118–126,397; notebook/kernel-bridge.py:118–124 already observes real kernel death
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** locked notebook trust policy changes
- **Source:** locked by existing notebook public restart contract

## D6: Clipboard ranges use source coordinates and quoted TSV
- **Question:** What do row/column/range copies mean after filter/sort and with embedded separators?
- **Options:** display indices/unescaped joins; source indices and lossless quoted TSV
- **Chose:** existing row/column/cell/all copy meanings plus inclusive endRow/endColumn rectangle requiring all coordinates; source indices remain stable. Quoted TSV round trips through existing paste parser. Invalid bounds preserve the draft.
- **Why:** displayed CSV rows already carry source index; unescaped tabs/newlines would change cell boundaries on paste. Paged CSV stays read-only/bounded.
- **Evidence:** viewers/service.ts:491–503,525–534; ViewerSurface.tsx CsvRow.index; predecessor C9
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** consumer-visible roundtrip evidence contradicts the format
- **Source:** assumed — autonomous

## D7: Resource capabilities belong to exact mounted leases
- **Question:** How to free an unmounted view without breaking another split?
- **Options:** revoke per buffer; retain until close; optional exact lease and idempotent release
- **Chose:** unique per-acquisition leaseId (nonempty, at most128 chars), release only that lease, late-acquisition cleanup, stale close/dispose guard. Anonymous API callers keep close/dispose ownership.
- **Why:** a buffer is shared by visible split viewers; its lifetime cannot identify one mounted consumer. No lease token is persisted in view state.
- **Evidence:** predecessor D11; viewers/service.ts:367–386,428–434; ViewerSurface.tsx media acquisition
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** split/late-close capability evidence fails
- **Source:** locked by docs/loop/decisions/m2-editor-complete-remaining-flows.md D11

## D8: Three disjoint vertical components share committed contracts
- **Question:** How to dispatch without overlapping hub edits?
- **Options:** parallel CSV/lifetime workers sharing files; three disjoint component worktrees
- **Chose:** Explorer daemon/window/tests; notebook kernel/service/surface/tests; viewer clipboard+lifetime service/surface/tests. Parent commits types/manifest before dispatch. One wave, width3/cap3, no successor or component dependency. Workers do not commit; parent audits scoped changes and commits after all return.
- **Why:** CSV and leases share service/surface hubs; combining them avoids untested auto-merges. New focused test files have single owners. No language server is configured (xd://lsp status returned that fact); known-symbol grep used for references instead.
- **Evidence:** MapEditorFlows completed source map; shared types ExplorerNavigationKey/ExplorerInteraction/ExplorerParams/CsvCopyRange/ViewerResourceParams; flat manifest schema
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a worker needs a cross-scope file
- **Source:** assumed — autonomous

## D9: Defer cross-family review under build-first, not as a passing review
- **Question:** Should preflight probe reviewer backends when all review rounds are forbidden?
- **Options:** probe/start a review; retain omp OpenAI implementers and postpone review
- **Chose:** IMPLEMENTER=omp task, AUTHOR_FAMILY=openai; no review backend dispatch/probe. Preferred eventual reviewer is cross-family Opus if reachable; no reviewer is claimed available or passing this run.
- **Why:** user expressly stopped reviews until the end phase; probing unused aliases adds no implementation evidence.
- **Evidence:** canonical LOOP Build first, test at the end; previous pairing receipts are historical, not current probes
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** end-phase item is claimed
- **Source:** locked by docs/loop/LOOP.md

## D10: Preserve compact accessible controls and platform boundaries
- **Question:** Layout, loading/error patterns, native interactions and platform scope?
- **Options:** redesign shell; extend current controls and errors without changing native contracts
- **Chose:** current density/loading/errors, input-safe keyboard handlers, visible clipboard and kernel errors, no false success. macOS only; Linux/Windows keyboard/clipboard/process behavior requires later platform work. Existing native editor scenarios remain unchanged; the new CSV row/column/range OS clipboard path gets its own pending C1-native-clipboard handoff.
- **Why:** missing interactions do not require shell redesign or unsupported native APIs.
- **Evidence:** editor.md sections7–8; docs/architecture.md UI; docs/loop/native/m2-editor.json; docs/loop/native/m2-editor-build-unbuilt-flows.json
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a platform/native implementation item changes those contracts
- **Source:** deferred: platform

## D11: Isolate all smoke dependencies and retain exact component ownership
- **Question:** Where can runtime evidence and worker edits safely live?
- **Options:** real homes/global Python; isolated scratch and owned venv; allow workers to edit parent
- **Chose:** scratch /tmp/quirky-lane6-editor-flows-1lss1N with fresh HOME/QUIRKY_HOME, hooks disabled and owned Python3.12 venv. uv installed ipykernel7.4 plus30 dependencies only there (cache also scratch). Three worktrees start at3ca50907. Explorer scope additionally owns window/editorState.ts type adaptation; parent retains manifest/types. Worker-reported mistaken relative-path viewer test edit in parent is being reverted only for that exact worker-authored block before absolute-path reapplication.
- **Why:** notebook lifecycle needs a real disposable interpreter; unrelated real agent homes and parent edits must remain untouched. Parent audits component paths and initial-HEAD invariants after every worker returns.
- **Evidence:** actual uv venv/pip output (31 packages installed); MapEditorFlows source map; BuildViewerFlows cross-worktree notification
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** scope audit finds unresolved contamination or any non-owned process/state
- **Source:** assumed — autonomous

## Progress
Scope resolved and logic spec self-reviewed against retained feature flows. Shared types/schemas and spec are ready for the pre-implementer contract commit. Next: create three isolated /tmp worktrees from that commit, dispatch at most three implementers with disjoint scopes, integrate, narrow runtime smoke and typecheck, catch up build/roadmap once/read incoming decisions, commit/detach/canonical land. No acceptance, review or UI/native pass claimed.
