# m2-editor-complete-remaining-flows decisions

## D1: Complete the exact transferred remainder, not a second core-only landing
- **Question:** Which flows does this follow-up own?
- **Options:** only missing implementations; every implementation and GUI acceptance gap transferred by m2-editor
- **Chose:** every named remaining flow, original SC-3–6/7–11/13–15/17–22 variants, and the observed UI defects
- **Why:** the claimed title and m2-editor D25–D26 transfer them explicitly; prior API proofs are not full GUI evidence.
- **Evidence:** canonical queue wait --lane 6; docs/loop/BLOCKERS.md:27–49; original editor logic delivery amendment
- **Reversibility:** medium (completion boundary)
- **Confidence:** high
- **Revisit if:** an explicit later scope ruling changes the target
- **Source:** locked by docs/loop/decisions/m2-editor.md D25–D26

## D2: Resolve unattended choices autonomously and use full specs after the night deadline
- **Question:** How to answer workflow questions and which spec workflow applies?
- **Options:** ask humans; unattended recommended defaults; continue expired night-mode shortcuts
- **Chose:** no human prompts, standard gray areas and recorded recommended defaults; logic plus tech specs and one combined Codex review
- **Why:** LOOP forbids questions; observed time is 2026-10-28 06:20 CDT, after night mode's 4am target.
- **Evidence:** git show build/roadmap:docs/loop/LOOP.md; date command
- **Reversibility:** easy (record only)
- **Confidence:** high
- **Revisit if:** canonical loop instructions change
- **Source:** locked by docs/loop/LOOP.md

## D3: Retain existing daemon buffers, hosted tabs and focused services
- **Question:** Which design approach fits the completion?
- **Options:** existing service extensions; replace editor library; parallel virtual document subsystem
- **Chose:** existing services, CodeMirror/TipTap and terminal-hosted tabs
- **Why:** alternatives split ownership or violate locked library/plugin choices without solving missing behavior.
- **Evidence:** docs/architecture.md:205–220,290–324; m2-editor D4/D8; original tech Composition and ownership
- **Reversibility:** hard (ownership and persistence)
- **Confidence:** high
- **Revisit if:** implementation demonstrates a locked architectural contradiction
- **Source:** locked by docs/architecture.md

## D4: Preserve the operator's import-all and native handoff boundaries
- **Question:** Are Finder open-in-place and native OS evidence part of this web completion?
- **Options:** implement unsupported native hooks; retain approved copy policy and native runner handoff
- **Chose:** Finder/OS files still import copies; open-in-place excluded; real clipboard/default-app/focus/pickers/sheets go to pending native scenarios
- **Why:** m2-editor D19 names the operator-owned follow-up; web verification cannot prove native effects.
- **Evidence:** original editor logic SC-9; docs/loop/NATIVE.md:60–82; current claimed title exclusion
- **Reversibility:** easy (later supported native seam)
- **Confidence:** high
- **Revisit if:** supported native API and explicit follow-up ruling land
- **Source:** locked by docs/loop/decisions/m2-editor.md D19

## D5: Keep lossless rich semantics rather than remove safety gates
- **Question:** How to enable details/toggle/document-link forms?
- **Options:** remove rejection; represent nodes and prove round trips before enabling
- **Chose:** real custom-node parse/serialize/edit behavior, empty/nested/label cases and no-op/untouched-byte tests; retain Source fallback for unsupported forms
- **Why:** the current rejection prevents corruption; merely widening the enum would not supply the missing feature.
- **Evidence:** MapRichEditor source map; plugins/quirky.editor/src/markdown/{Toggle.ts,DocumentLink.ts,source.ts,service.ts}; m2-editor D8
- **Reversibility:** medium (format representation)
- **Confidence:** high
- **Revisit if:** a supported construct cannot round trip safely
- **Source:** locked by docs/loop/decisions/m2-editor.md D8

## D6: Use explicit owned untitled placeholders and destination-safe retarget
- **Question:** Virtual in-memory files or the feature doc's placeholder lifecycle?
- **Options:** new virtual filesystem; collision-safe placeholder with provenance; continue named-file creation
- **Chose:** placeholder flagged untitled; exclusive creation; blank/template distinction; explicit Save As; same buffer/tab identity; no-overwrite destination and failure-preserved source/draft
- **Why:** the feature doc creates an on-disk placeholder; current named creation lacks its lifetime/destination semantics. Provenance prevents deleting user files named untitled.md or replaced placeholders.
- **Evidence:** editor.md section5 and Templates; original SC-14; MapDraftFiles; current service new/retarget bodies
- **Reversibility:** medium (durable provenance)
- **Confidence:** high
- **Revisit if:** save/close/restart proof shows a provenance gap
- **Source:** locked by editor.md

## D7: Separate disk write permission from format read-only capability
- **Question:** What do mode bits/ACL denial mean for drafts and review notes?
- **Options:** treat chmod bits as policy; forbid all edits/notes; advisory effective OS access with authoritative save checks
- **Chose:** optional diskWritable metadata, OS access including ACLs, visible restriction/error, allow editable-format drafts and notes, preserve draft on denied save and refresh permissions on retry
- **Why:** access can change between read and write; a readable file's review notes do not require writing the Markdown. Existing readOnly describes unsupported editing formats, not disk permissions.
- **Evidence:** plugins/quirky.editor/src/daemon/files.ts:11–18,47–82; original logic SC-3–5/15 and locked visible permission states
- **Reversibility:** easy (additive metadata)
- **Confidence:** medium
- **Revisit if:** actual effective-access and write results disagree or annotation requires private state
- **Source:** assumed — autonomous

## D8: Distinguish local acknowledgments without weakening concurrent-writer guards
- **Question:** How to remove observed false newer-shared-draft warnings?
- **Options:** suppress all revision warnings; correlate local submission/result revisions and pending events
- **Chose:** revision-aware acknowledgment handling including event-before-response, repeated text and undo-to-baseline; real stale peer writes still warn and preserve unsent text
- **Why:** text equality alone is not writer identity; removing CAS would lose concurrent edits.
- **Evidence:** DocumentSurface.tsx:216–287,301–322; SourceEditor synchronization; BLOCKERS own-draft report
- **Reversibility:** medium (renderer sync)
- **Confidence:** high
- **Revisit if:** deterministic held-ack/two-writer regression contradicts the model
- **Source:** locked by docs/quirk/specs/2026-10-27-m2-editor/logic.md SC-2

## D9: Return separate Preview controls to the real edit tab
- **Question:** Should Rich/Source mutate Preview identity or activate the edit tab?
- **Options:** mutate preview buffer-global mode; open/reuse focused edit tab in requested mode
- **Chose:** public open/reuse with matching group, retain Preview and draft
- **Why:** Preview has an independent read-only tab mode; updating only shared view state cannot change it into an edit surface.
- **Evidence:** DocumentSurface openMode/header; original tech separate-preview contract; recorded F35/obs65–67
- **Reversibility:** easy (routing)
- **Confidence:** high
- **Revisit if:** hosted-tab identity reuse fails the actual renderer scenario
- **Source:** assumed — autonomous

## D10: Finish existing controls without unrelated UI redesign
- **Question:** Loading/density/empty/error/interaction and keyboard preferences?
- **Options:** redesign editor shell; preserve current layout and complete exact missing controls
- **Chose:** existing shell density and accessible controls; expose dead-kernel recovery and CSV row/column/range clipboard; effective rebound bindings own shortcut dispatch
- **Why:** mapping finds actual missing controls and static-default suppression; unrelated layout changes do not address the completion target.
- **Evidence:** MapNotebookMedia; NotebookSurface ready-only restart; ViewerSurface CSV controls; SourceEditor HOST_MANAGED_EDITOR_CHORDS
- **Reversibility:** easy (controls/keymap composition)
- **Confidence:** high
- **Revisit if:** guarded GUI reveals inaccessible controls or duplicate command dispatch
- **Source:** locked by editor.md

## D11: Scope visible viewer resources by explicit leases
- **Question:** How to release hidden viewer resources without breaking split views/API callers?
- **Options:** release all resources for a buffer; keep until close; exact per-mounted-view lease
- **Chose:** optional media leaseId and idempotent release action; exact lease ownership; unmount and late-acquisition cleanup; anonymous API resources remain close/dispose owned
- **Why:** releasing all by buffer breaks another visible split; never releasing contradicts hidden-view disposal. Existing ranged public resources remain unchanged.
- **Evidence:** viewers/service.ts:createResource/createViewerMethods; ViewerSurface refresh effect; m2-editor D10/D16
- **Reversibility:** medium (public lifecycle contract)
- **Confidence:** high
- **Revisit if:** split/unmount/dispose API proof shows invalidation or leaked capabilities
- **Source:** assumed — autonomous

## D12: Exercise actual setup only in disposable owned Python environments
- **Question:** How to prove consented install/ensurepip/PEP668 without global changes?
- **Options:** mocked success; install into system Python; disposable real environments and controlled prerequisites
- **Chose:** real packages/venvs and owned caches; retain trust and central confirmation; label controlled-branch fixtures separately from actual installation evidence
- **Why:** setup and kernels execute arbitrary local code; there is no authorization to modify user's Python.
- **Evidence:** editor.md notebook setup; m2-editor D9/D22; notebook/python.ts and service conditional confirmation
- **Reversibility:** easy (verification environment)
- **Confidence:** high
- **Revisit if:** required package source is unavailable after attempted reachable alternatives
- **Source:** locked by docs/loop/decisions/m2-editor.md D9

## D13: Use OpenAI task implementers and the reachable Gemini final reviewer
- **Question:** Which cross-family pair is available?
- **Options:** omp+opus; omp+sonnet; omp+gemini
- **Chose:** IMPLEMENTER=omp task, AUTHOR_FAMILY=openai, REVIEWER_ALIAS=gemini; Codex same-family combined spec review as LOOP requires
- **Why:** actual pi-watch --check found opus0/8 and sonnet0/6 unavailable; gemini resolves google/gemini-3.1-pro-preview:high. Codex resolves openai-codex/gpt-6.1-sol:medium. Spec review has reduced family independence; final review full if actual dispatch succeeds.
- **Evidence:** preflight command output in this iteration; Bun1.4.0; RUN_BASE fe06aaeb7f34cb6d0c654e15987776e89f4c1c5e
- **Reversibility:** easy (immutable per-run binding with documented failure ladder)
- **Confidence:** high
- **Revisit if:** actual dispatch fails under the skill's retry/fallback policy
- **Source:** assumed — autonomous

## D14: Use four disjoint components with contracts committed first
- **Question:** How to implement without shared-file collisions?
- **Options:** one serialized editor rewrite; overlapping worker edits; four vertical components with one shared-contract owner
- **Chose:** rich Markdown, core/window/manifest, notebook, viewers. Core owns types/manifest; parent commits service signatures and schemas before dispatch. Components have separate tests/worktrees and no semantic successor wave; final integration checks all together.
- **Why:** shared interfaces can be fixed first; overlap in Markdown new/retarget resolves through core-owned createUntitled/saveAs rather than parallel service edits. Width4; cap6 does not bind.
- **Evidence:** all three completed scout maps; tech.md ownership/contracts; language-server references attempt returned No language server found
- **Reversibility:** easy (scope audit)
- **Confidence:** medium
- **Revisit if:** scope audit or actual dependency shows a shared implementation hub
- **Source:** assumed — autonomous

## D15: Preserve inherited state and isolate all verification children
- **Question:** What to do with untracked .serena and historical real-home risk?
- **Options:** delete inherited files; commit them; preserve separately and isolate children
- **Chose:** stash `.serena/` as lane6-inherited-serena-iteration6; scratch /tmp/quirky-lane6-editor-Tz5Hnw; fresh HOME/QUIRKY_HOME, hooks disabled, exact owned process cleanup
- **Why:** inherited state is not this item. D22 shows QUIRKY_HOME alone cannot isolate hook installers; no trustworthy old config baseline exists.
- **Evidence:** initial git status/stash output; m2-editor D22/D29; current core-acceptance boot fixture
- **Reversibility:** easy (stash) | hard (historical preimages unavailable)
- **Confidence:** high
- **Revisit if:** a trustworthy historical baseline becomes available
- **Source:** locked by docs/loop/decisions/m2-editor.md D22/D29

## D16: Land the design checkpoint immediately under the new build-first ruling
- **Question:** What happens to this in-progress item after the operator's priority instruction?
- **Options:** continue the previous implementation/review/test plan; commit the current checkpoint, typecheck and land now
- **Chose:** stop review and acceptance preparation, consolidate the retained design into one logic spec with proposed technical decisions, run typecheck only and land. No implementation or acceptance completion is claimed.
- **Why:** the user explicitly moved all testing/debugging to the end phase and directed existing items to land at their next step. No product source, tests, shared types or schemas had been changed when that instruction arrived.
- **Evidence:** operator interjection in iteration 6; canonical `git show build/roadmap:docs/loop/LOOP.md` Build first, test at the end; new logic Status and technical section
- **Reversibility:** easy (design checkpoint)
- **Confidence:** high
- **Revisit if:** the queued unbuilt flows are implemented or the end phase is claimed
- **Source:** supersedes m2-editor-complete-remaining-flows D2/D13/D14

## D17: Queue one implementation-only follow-up; leave verification and debugging to the end phase
- **Question:** Which remaining work is eligible for a follow-up under the new rule?
- **Options:** requeue the whole verification matrix and known bugs; queue only missing feature behavior
- **Chose:** one dependent item for lossless details/toggle/document-link insertion and completion, real untitled/Save As/provenance, permission-aware UX, missing Explorer keyboard interactions, notebook idle-death/restart controls, CSV row/column/range clipboard and mounted-view resource release. Existing-implementation bugs and all API/GUI/native verification, reviews and test failures stay with the end phase, not another feature item.
- **Why:** the current landing is a design checkpoint; those feature flows are unbuilt. The operator expressly forbids follow-ups whose purpose is testing, verification, review or debugging.
- **Evidence:** initial API smoke before the policy change observed new.untitled=false, retarget/three rich formats schema-rejected and details richEligible=false; three source-mapping scout reports; completion logic C1–C9
- **Reversibility:** easy (queue decomposition)
- **Confidence:** high
- **Revisit if:** the single follow-up builds the listed behaviors
- **Source:** locked by docs/loop/LOOP.md Build first, test at the end

## D18: Retain native and source findings as end-phase evidence, not completed repairs
- **Question:** What did investigation establish beyond missing feature flows?
- **Options:** infer failures from static code; retain actual reports and label unproven hypotheses
- **Chose:** preserve the native Copy Path/Relative Path failure and empty-query Search routing report; note corresponding Explorer path-composition/intent source. Preserve existing Preview return and own-ack warning reports. Rebound duplicate dispatch remains unproven because effective host capture already stops propagation.
- **Why:** these are debugging/verification targets for the end phase. No test-failure or reported-bug repair was started after the priority instruction.
- **Evidence:** docs/loop/native/m2-editor.json; native report 20261028T061952-27c6:20–22; ExplorerPanel.tsx:317–322,397–400; ui.tsx:363–367; packages/ui/src/components/useShortcuts.ts:9–15
- **Reversibility:** easy (evidence classification)
- **Confidence:** high
- **Revisit if:** end-phase execution proves the effective behavior
- **Source:** assumed — autonomous

## D19: Preserve the interrupted review without inventing a verdict
- **Question:** What can be claimed from the review already in flight when the user stopped reviews?
- **Options:** call promote output a completed review; retain the actual partial stages and stop
- **Chose:** preserve Codex promote exit 0 and its two unrefuted candidates: allocation-aware template filename substitution (HIGH/HIGH), and explicit old-placeholder cleanup after successful Save As (MEDIUM/MEDIUM). No refute, gate or manifest ran; there is no verdict, no accepted-finding adjudication and no claimed fix.
- **Why:** the operator ordered review work to stop; restarting or completing stages would violate that instruction. Candidate claims are design inputs, not confirmed product defects.
- **Evidence:** ignored iteration evidence `spec-review/promote.{stdout,stderr,exit}` and `promote.prompt.md`; ReviewEditorSpecs returned with its exact subprocess finished
- **Reversibility:** easy (evidence record)
- **Confidence:** high
- **Revisit if:** implementation chooses a final contract or end-phase review evaluates it
- **Source:** assumed — autonomous

## Progress
Immediate landing under D16. Only retained logic/design, this decision log and an append-only BLOCKERS receipt changed; no product source/test/type/schema changed. Canonical queue add exited 0 and direct queue read confirms the single `m2-editor-build-unbuilt-flows` item is todo, depending on this item. It names feature implementations only; all testing/review/GUI/known-bug debugging remains in the end phase. Both workers returned partial/incomplete with no processes running; no review verdict or GUI pass is claimed. Next: commit checkpoint, catch up once, run only typecheck, detach and canonical queue land. The separate tech draft and partial review artifacts are retained with ignored iteration evidence.
