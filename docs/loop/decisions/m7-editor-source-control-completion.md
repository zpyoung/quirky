# m7-editor-source-control-completion decisions

## D1: Complete existing owners without changing the locked platform or exclusions
- **Question:** What scope and authority govern this completion item?
- **Options:** replace the editor/Git/sidebar stack; extend each canonical built-in owner.
- **Chose:** extend canonical editor, Git, hosting and sidebar APIs and UI. Preserve CodeMirror 6, public cross-plugin calls, disk/content CAS and exact note settlement. Exclude non-GitHub forges, Objective runner and PR sitter. Keep Finder source-path support in its separately blocked item.
- **Why:** the queue names concrete unfinished flows, not a new replacement stack or permission to fabricate native capabilities.
- **Evidence:** queue title; docs/roadmap.md:13–53,259–287; docs/architecture.md:290–324; m7-sweep-editor-source-control D1/D3/D5/D10.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** a supported public capability conflicts with an earlier binding decision.
- **Source:** locked by docs/roadmap.md and docs/architecture.md

## D2: Resolve gray areas autonomously with source-grounded defaults
- **Question:** How should design questions be resolved in this unattended iteration?
- **Options:** ask a person or run external research swarms; decide from feature docs, locked decisions and current owners.
- **Chose:** no asks, companion offers, divergent ideation, external research swarms or spec review. Domains are Visual/API/CLI/Data/Integration. Preserve compact existing layouts and schema-generated CLI. Choose explicit loading/empty/error states; fail closed on stale ownership, permission denial and ambiguous links; preserve drafts and notes on failure; keep state in its current canonical store. Inspect all material interaction, error, persistence, grouping, response and conflict-resolution gray areas. One combined logic spec with a technical final section, self-reviewed against the named flows.
- **Why:** authoritative build-first LOOP instructions replace interactive gates and separate tech/spec reviews. Purpose, consumers, success, constraints, scope and primary behavior come from the queue and three feature docs.
- **Evidence:** authoritative git show build/roadmap:docs/loop/LOOP.md; external editor.md, sidebar-extras.md and source-control.md.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** source documents leave an observable behavior unresolved.
- **Source:** locked by docs/loop/LOOP.md

## D3: Author acceptance now and defer execution to the end phase
- **Question:** Which verification cadence applies before m7-test-triage?
- **Options:** run suites/dogfood/review now; author tests and native handoffs, run the typecheck-only landing gate.
- **Chose:** write behavior/defect regressions without running them; do not run suites, UI dogfood or review campaigns. Typecheck is the landing gate. Use at most three disjoint implementers after committing shared contracts. Runtime smoke required by engineering policy will be narrowly scoped and isolated, not a test-suite or dogfood campaign.
- **Why:** current LOOP explicitly moved testing/debugging to the end phase; typecheck or authored tests must never be described as behavioral acceptance.
- **Evidence:** authoritative LOOP Build first, test at the end section; queue status has feature items in progress.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** end phase is claimed or an operator changes the policy.
- **Source:** locked by docs/loop/LOOP.md

## D4: Preserve unrelated diagnostic metadata
- **Question:** How should inherited untracked .serena/ be handled?
- **Options:** stage/stash/delete it; leave it untouched and explicitly stage only owned paths.
- **Chose:** preserve it unchanged and uncommitted. Implementers use separate temporary worktrees and absolute file-tool paths.
- **Why:** it was restored from a previous iteration and is not this item's work.
- **Evidence:** initial git status --short --branch; loop notes iteration4 completion and iteration6 receipt.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** metadata interferes with a required command.
- **Source:** assumed — autonomous

## D5: Preserve the nonoverlapping earlier editor handoff
- **Question:** Does this completion absorb another queued editor implementation?
- **Options:** duplicate every historical title; follow the latest explicit ownership ruling.
- **Chose:** this item owns details/document-link/permission plus Changes integration; m2-editor-build-unbuilt-flows owns the other unbuilt Explorer/notebook/CSV/media interactions. Preserve all SC-3–22 acceptance goals and original native findings for the end phase without claiming they passed or creating a testing-only follow-up.
- **Why:** predecessor D20 explicitly resolved overlapping historical queue titles after the sweep landed its own implementation.
- **Evidence:** docs/loop/decisions/m2-editor-complete-remaining-flows.md:212–221; docs/loop/BLOCKERS.md:43–49,513–515.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** the owning item publishes a conflicting contract.
- **Source:** locked by docs/loop/decisions/m2-editor-complete-remaining-flows.md D20

## D6: Commit shared public contracts before three disjoint components
- **Question:** How are cross-owner interfaces and parallel scopes stabilized?
- **Options:** overlapping workers on one tree; contracts first and three owner-scoped worktrees.
- **Chose:** commit e5acf4bc defines rich format enum, advisory diskWritable, Git compareAgainstHead, diff placement fields and pushTarget/purpose schemas. Three components fork that exact clean HEAD: editor; Git/hosting; sidebar/worktree presentation. No semantic successor wave; cap3 does not bind. Parent owns spec/native/decision integration; no worker source writes in parent or commits/checks mid-flight.
- **Why:** editor Changes consumes the committed Git API while the Git owner implements it; other components have no shared files. Existing public hosted tabs provide preview/replacement/move-to-split with close checks.
- **Evidence:** external journal /tmp/quirky-editor-completion.VXzR1M/journal.json; MapCompletionOwners; terminal layout/service.ts:517–651,662–723,880–893.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** a required capability cannot be supplied without changing another owner's files.
- **Source:** assumed — autonomous

## D7: Retain source-loss and destination-safety guards
- **Question:** Which observable design defaults resolve data/permission/integration ambiguity?
- **Options:** widen parsing/remote defaults optimistically; represent supported rich nodes and validate effective authority.
- **Chose:** preserve original bytes on no-op and untouched blocks during edits; Source fallback for unsupported HTML. Link completion uses exact path then unambiguous basename and cannot mutate during IME. OS-effective write access is advisory, separate from readOnly; annotations/drafts remain available and denied save retains state. PR push requires fresh exact head identity matched to configured push URLs, with no guessed fallback/remote creation; revalidate before mutation. Keep existing confirmation, lease and hook policy.
- **Why:** removing validation exposes corruption or wrong-repository pushes; conflating permission and format denies readable-file annotation without preventing TOCTOU.
- **Evidence:** feature editor.md sections322–359,369–400; source-control.md sections114–139,196–225,318–340; predecessor editor D5/D7 and sweep D10.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** a supported source construct or provider identity cannot meet these invariants.
- **Source:** assumed — autonomous

## D8: Keep native evidence separate from web/API acceptance
- **Question:** How are native-only completion behaviors tracked without foreground automation?
- **Options:** infer native effects from API state; mark genuinely native scenarios pending.
- **Chose:** new native handoff covers IME/clipboard, effective macOS ACL denial and focused split/Changes keyboard behavior. Existing editor native reports, including Copy Path failure, print/default-app limitations and Finder source-path block, remain unchanged.
- **Why:** API or rendered source presence cannot establish OS clipboard, ACL, focus or dialog outcomes.
- **Evidence:** docs/loop/native/m7-editor-source-control-completion.json; docs/loop/native/m2-editor.json; docs/loop/NATIVE.md:60–82.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the nightly native runner records a result.
- **Source:** locked by docs/loop/LOOP.md

## D9: Extend the canonical Git primitive for exact-target mutation
- **Question:** Can validation be followed by a push that silently re-resolves Git configuration?
- **Options:** plugin-local validation with config-derived mutation; extend the existing Git primitive with exact target options.
- **Chose:** extend the canonical primitive additively and migrate the validated-purpose caller. Explicitly expand CompleteGitHosting's exclusive scope to required packages/git source and tests; no other component owns that package. Preserve ordinary existing callers and explicit force-with-lease behavior. Enumerate references and record exact changed paths before acceptance.
- **Why:** worker source inspection found push accepts only a lease and re-resolves configuration internally; that cannot guarantee the destination just validated.
- **Evidence:** CompleteGitHosting message; packages/git canonical push/pushTarget owner; committed public pushTarget and purpose schemas.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** the existing primitive already supports an exact target without config re-resolution.
- **Source:** assumed — autonomous

## D10: Keep selection reachable while adding split-open
- **Question:** Should all Orca split modifiers replace selection?
- **Options:** Cmd/Shift/Alt split as upstream reads; Alt split with Cmd/Shift selection preserved.
- **Chose:** Alt/Option split; retain Cmd toggle and Shift range selection. Amend C5 and tell its implementer before the row-opening change.
- **Why:** the earlier core explicitly fixes the unreachable-selection defect, and parity excludes Orca defects.
- **Evidence:** docs/loop/decisions/m2-source-control-core.md D33; source-control.md:78,568; completion spec amendment.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** explicit user keybinding policy changes.
- **Source:** locked by docs/loop/decisions/m2-source-control-core.md D33

## D11: Reuse a bounded public renderer for detached diff text
- **Question:** How can Git render modified Markdown without importing editor internals?
- **Options:** duplicate parser dependencies; import private renderer; public text-only editor action.
- **Chose:** public markdown action renderPreview with required bounded text returns sanitized html using the canonical pipeline, without opening/mutating buffers or supplying filesystem authority. Detached local images are omitted and the Git UI explains the limitation; source-bound editor preview retains its existing authorized image support.
- **Why:** renderer internals are not the public plugin API, and detached text does not establish a file-resource lifetime or authorize local reads.
- **Evidence:** editor markdown/preview.tsx:18–66 and service.ts:400–406; CompleteEditor and CompleteGitHosting contract messages; combined spec amendment.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a public owner-bound detached resource lease supports local images.
- **Source:** deferred: detached diff local-image rendering

## D12: Recover the attributed cross-worktree test write before resuming
- **Question:** How should the editor worker's accidental relative edit be handled?
- **Options:** accept contaminated parent state; reset unrelated work; invert the exact attributed delta and capture a new snapshot.
- **Chose:** pause editor writes, inspect the exact sole parent-file diff, surgically invert it, and prove its blob equals HEAD. Preserve the intended private-tree test patch and record its content hash plus unchanged component HEAD before explicit resume. Other components continue in disjoint scopes. No broad reset or metadata deletion.
- **Why:** file-tool relative paths resolve against the parent tool root despite the worker's Bash cwd; prompt-only isolation is not a sandbox.
- **Evidence:** editor-boundary-recovery.json and journal editorRestart in /tmp/quirky-editor-completion.VXzR1M; worker's exact patch/self-report; parent restored test hash equals committed blob.
- **Reversibility:** easy
- **Confidence:** high for the attributed test recovery; no attribution claimed for unrelated .serena changes
- **Revisit if:** the final scope audit finds another outside-scope write.
- **Source:** assumed — autonomous

## D13: Correct the sidebar presentation scope to its current paths
- **Question:** Does the historical src/window path fence exclude current canonical UI files?
- **Options:** leave required presentation behavior unbuilt; explicitly correct the component scope before editing.
- **Chose:** authorize worktree src/Tree.tsx, report.ts, useSidebarActivity.ts and ActivityFilters.tsx, plus parent-approved directly required sidebar-only helpers. Keep every other owner unchanged and record the scope amendment in the journal.
- **Why:** the current worktree plugin stores these files at src root and has no src/window directory; the intended boundary is presentation ownership, not a stale layout.
- **Evidence:** CompleteSidebar source report; journal.scopeAmendments.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** additional required paths intersect another component.
- **Source:** assumed — autonomous

## D14: Derive the destination from fresh PR identity and freeze the URL snapshot
- **Question:** Is validating the configured default equivalent to a PR-derived push target?
- **Options:** validate default remote/ref only; select from fresh PR head identity and bind the configured URL through push.
- **Chose:** provider-head-first matching across configured safe remotes, with trusted saved WorktreePushTarget only as validated disambiguation. Allow a remote PR ref differing from its local branch name while checking actual local identity. Carry private URL snapshot/fingerprint into the canonical exact-target primitive, recheck configuration and push the validated snapshot without public caller URL parameters.
- **Why:** origin may be the base while a different configured fork remote owns the head. Re-resolving config by remote name after provider validation can redirect a push if its URL changes.
- **Evidence:** initial worker push-target.ts:140–181 and packages/git remote.ts:74–85; parent corrective contract messages; committed component3706a37b; updated C6.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** Git's configured URL rewriting makes the snapshot differ from the actual transport destination.
- **Source:** assumed — autonomous

## D15: Treat the first integrated checks as failures, not acceptance
- **Question:** What did the first actual compiler and runtime checks establish?
- **Options:** infer correctness from worker reports/UI bundle success; retain exact failures and repair their roots.
- **Chose:** source-only component checkpoints are unverified. Initial typecheck failed58diagnostics across13files; route editor, Git/hosting and sidebar typing repairs to disjoint owners. The narrow isolated real-daemon insert smoke read diskWritable:true but observed no details after successful insert and exited1; investigate its exact API/content boundary. No suite, dogfood campaign or review round ran. UI bundle succeeded, which does not supersede either failure.
- **Why:** successful bundling ignores type/behavior errors; a no-op insertion cannot be called delivered from source presence.
- **Evidence:** bg1 raw artifact://24; bg2 actual smoke exit1 with both cleanup markers; bg3 built25plugin UI modules.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** corrected source-bound smoke and typecheck pass.
- **Source:** assumed — autonomous

## D16: Register details as a block tokenizer and repair concrete compiler roots
- **Question:** Why did successful insertion fail the actual read boundary?
- **Options:** weaken the smoke assertion or accept escaped markup; fix the serialization root.
- **Chose:** register MarkdownToggle's tokenizer at block level. The pure diagnostic traced raw inserted details into escaped canonical text because the extension defaulted to inline; existing reconciliation accepted that escaped output. Add the exact API insert/read regression without running it. Also repair the document-link base scope, nullable buffer/viewer predicate, concrete target discriminants, Review repository provenance and test fixture/timer typings. No type suppression or test exclusions.
- **Why:** this preserves actual rich structure rather than changing expected output to match loss. The second compiler run's9diagnostics were narrowed to two files and fixed; the next full root/mobile typecheck exited0.
- **Evidence:** TraceRichInsert pure diagnostic and receipt; bg4/artifact31; bg7 typecheck exit0 in40.80s; repair-audit.json.
- **Reversibility:** easy
- **Confidence:** high for diagnosed conversion and compiler output; final daemon smoke result remains separate
- **Revisit if:** the actual inserted/read/saved source does not retain real details.
- **Source:** assumed — autonomous

## D17: Bound actual surface proof without claiming the deferred acceptance campaign
- **Question:** What visible evidence covers the changed surface under build-first policy?
- **Options:** infer UI behavior from bundling; a bounded owned rendered-surface check; full dogfood campaign.
- **Chose:** rebuild25UI modules, open an owned hidden browser against a private-home actual daemon and use the real Changes and Markdown-preview controls on README. Observe the same tab, distinct HEAD Original paragraph and Modified paragraph, then modified-only rendered text with the explicit local-image limitation; return to source. No console errors were reported. Close the managed tab; stop the daemon/harness and explicitly stop the remaining wrapper after its cleanup marker.
- **Why:** actual surface proof is required by engineering policy, but this is not exhaustive SC-3–22 acceptance, native focus, a full build or a dogfood/review campaign. Initial selectors guessed title/notice text and timed out; subsequent actual text/screenshots established the result rather than re-pinning incidental wording.
- **Evidence:** surface-smoke.json, surface-preview-smoke.json and three owned screenshots in external scratch; bg6 bundle output; EditorCompletionSurface SURFACE_STOPPED and proc stop receipt.
- **Reversibility:** easy
- **Confidence:** high for these visible paths only
- **Revisit if:** end-phase interaction or native acceptance finds a broader issue.
- **Source:** assumed — autonomous

## D18: Return the consumed raw token as required by the block parser
- **Question:** Why did the post-block-registration daemon smoke hang?
- **Options:** extend deadlines or waive the smoke; restore the parser's consumed-token contract.
- **Chose:** return the already-computed raw span from MarkdownToggle.tokenize. The component had removed raw from its result while retaining its local computation; the original implementation returned raw. With block tokenization active, omitting the consumed span prevents parser progress. Preserve the exact insert/read regression and rerun the bounded actual smoke after this source correction, not the unchanged failed command.
- **Why:** block classification alone corrected escaping but was insufficient for the lexer contract; a timeout is not proof of completion.
- **Evidence:** bg5 interrupted after300s following BUFFER_ACCESS with no insertion/cleanup markers; Toggle.ts:151,161; parent one-line return correction.
- **Reversibility:** easy
- **Confidence:** high for missing consumed span; corrected daemon outcome recorded separately
- **Revisit if:** corrected insert/read still fails or hangs.
- **Source:** assumed — autonomous

## D19: Match the installed serializer callback contract
- **Question:** Why did the consumed-token repair then fail safe parsing?
- **Options:** relax parse validation; use the installed Tiptap positional node/helpers callback.
- **Chose:** custom Toggle and DocumentLink renderMarkdown now accept positional node/helpers, not a destructured wrapper. Render toggle children from node.content or an empty array, avoiding self-recursion for empty details. Preserve rich validation.
- **Why:** the pure diagnostic built the correct ProseMirror toggle but getMarkdown threw on undefined node.attrs. Installed Tiptap calls handler.renderMarkdown(node, helpers, context); both custom nodes used the wrong callback shape. These are one adapter-contract correction, not a new renderer or fallback.
- **Evidence:** actual pure diagnostic stack; installed @tiptap/markdown3.31.3 dist/index.js:1040–1072; bg9 safe parse refusal; final bg11 insert/read/save success.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the installed Markdown callback API changes.
- **Source:** assumed — autonomous

## D20: Queue only the one unbuilt detached-image flow
- **Question:** What feature remainder is eligible for a follow-up?
- **Options:** claim image rendering from sanitized text; duplicate testing/GUI work; one implementation-only resource-authorization flow.
- **Chose:** canonical queue add created m7-diff-markdown-local-images depending on this item. It owns source-authorized detached images and exact per-mounted-diff resource lifetime without private imports or editor-tab mutation. No verification/review/debug-only item. Existing editor unbuilt-flow and Finder blockers are unchanged.
- **Why:** text-only detached rendering deliberately has no filesystem authority; adding safe local images needs a real public owner contract, not unsafe URL output or a claimed pass.
- **Evidence:** canonical absolute queue add exited0 using external followup.json; D11; append-only BLOCKERS remainder entry.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the dependent item implements the owner-bound capability.
- **Source:** deferred: detached diff local-image rendering

## D21: Record exercised checks without upgrading them to full acceptance
- **Question:** Which checks actually passed on this item's source?
- **Options:** report authored tests as passing; record only completed commands and observed paths.
- **Chose:** final root/mobile typecheck bg12 exited0 in23.48s. Narrow actual daemon/API and generated CLI smoke bg11 exited0 in4.00s: advisory write fact, real details and document-link insert/read/save, HEAD-versus-index distinction, no-origin target refusal and sidebar projection; both cleanup markers observed. Exact-target real-Git smoke bg8 exited0 in3.52s, fork/remote-feature received exact OID, base unchanged and changed URL refused. D17 retains bounded surface evidence. Suites, reviews, full packaged build and exhaustive/native GUI acceptance were not run.
- **Why:** each result has a different scope; none substitutes for the end-phase acceptance matrix.
- **Evidence:** bg8/bg11/bg12 actual outputs; external smoke scripts/journal/screenshots; native pending handoff.
- **Reversibility:** easy
- **Confidence:** high for exercised paths only
- **Revisit if:** merged typecheck or the end-phase acceptance campaign finds a failure.
- **Source:** assumed — autonomous

## D22: Retain the macOS-only support evidence boundary
- **Question:** Do these checks establish Linux or Windows permissions, keyboard and resource behavior?
- **Options:** infer portability from API types; retain unverified platform work explicitly.
- **Chose:** use portable OS open probes and Git APIs where available, but claim only macOS checks. Linux/Windows ACL/effective-write behavior, platform modifier/IME/clipboard/focus routing and configured Git transport/upstream semantics need their own platform execution.
- **Why:** no Linux/Windows process or UI was exercised, and native permission/clipboard behavior cannot be inferred from types.
- **Evidence:** workstation macOS; actual check outputs; docs/roadmap.md:282–287; pending native completion file.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** supported-platform runs provide evidence.
- **Source:** deferred: platform

## D23: Preserve both additive sidebar test blocks in the single catch-up
- **Question:** How should the one roadmap catch-up conflict and new preference field be composed?
- **Options:** drop our edge tests or incoming automation test; keep both with correct closures and target only corrupted fields.
- **Chose:** merge3a6fd20b keeps quiet-aging/first/sticky separator tests plus incoming durable automation-attribution filtering. The merged compiler found the corrupt-preference assertion pinned the entire old preferences shape; retain its six corrupted-field recovery assertions as a partial object match rather than add a new incidental automation default. No production policy, deadline or consumer assertion was removed.
- **Why:** new independent preferences must not invalidate an older corruption-recovery contract or make it assert unrelated defaults.
- **Evidence:** sole conflict sidebar-extras-ui.test.ts:1283–1376; bg13/artifact55; final merged root/mobile typecheck bg15 exited0 in23.23s. Caught-up actual API/CLI smoke bg14 exited0 in3.54s with both cleanup markers.
- **Reversibility:** easy
- **Confidence:** high for the composed compiler/runtime paths; suites remain unrun
- **Revisit if:** end-phase acceptance identifies a real interaction.
- **Source:** assumed — autonomous

## D24: Preserve the complete immutable incoming decision inventory
- **Question:** Did newly landed decisions alter this item's implementation contract?
- **Options:** trust the initial partial MERGE_HEAD read; enumerate the committed merge's immutable second parent and finish all missing reads.
- **Chose:** enumerate1f03ec3f...3a6fd20b^2 and read all14incoming logs in full. Preserve editor unbuilt-flow ownership, notebook restart trust revocation and exact viewer-resource leases; automation durable attribution/client preferences; local native structured-option authority; blocked remote host generation/filesystem boundaries; Browser native/profile/import owners and unavailable controls; Mobile method ceilings and phone authority. No incoming contract requires another source change.
- **Why:** committing the merge removed MERGE_HEAD before the scout finished; an immutable ref supplies an auditable complete set instead of substituting an advancing roadmap tip.
- **Evidence:** exact immutable diff inventory and IncomingCompletionLocks completed receipts: m2-editor-build-unbuilt-flows; m4-hosting-ui-review-browser-routing; m5-automations-dispatch-remote-and-args; m5-loops-ui-visible-stop-close-review; m6-heimdall-host-power; m6-orchestration-idle-pointer-shutdown; m7-ledger-remote-host-flows; m7-sweep-automation-completion; sa-browser-agent-extras; sa-browser-pane-native-host-controls; sa-browser-pane-workspace-preview; sa-browser-profile-import-ui; sb-mobile-app-panels; sb-mobile-app-panels-unbuilt-flows.
- **Reversibility:** easy
- **Confidence:** high for the complete inventory and stated ownership boundaries
- **Revisit if:** canonical landing imports a conflicting contract or type failure.
- **Source:** locked by the incoming decision logs listed above

## Progress
Ready for canonical landing. Single roadmap catch-up3a6fd20b and all14incoming decision logs are integrated/read(D24). Final merged root/mobile typecheck bg15 and actual API/CLI smoke bg14 passed; exact-target Git and bounded surface evidence remain scoped in D17/D21. All workers/checks/services returned/stopped, component worktrees removed, no suite/review/dogfood campaign or native pass claimed. Commit the corruption assertion/evidence, detach and submit canonical queue land. After its actual receipt, retain evidence and update loop notes; end exactly this item, not the global queue.
