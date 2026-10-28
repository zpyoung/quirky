# m7-diff-markdown-local-images decisions

## D1: Preserve canonical owners and add one source-authorized lease
- **Question:** How can detached modified-side Markdown show local images without gaining editor-buffer ownership?
- **Options:** widen text-only renderPreview; open hidden buffers; duplicate Git parser/resource ownership; separate public editor lease.
- **Chose:** separate quirky.editor/markdownPreview render/release contract, explicit registered worktree and relative source path, per-render UUID lease. Reuse canonical safe Markdown and image/file-resource owners. Git hosted tab identity stays unchanged; editor Changes consumes the same contract.
- **Why:** text-only text carries no filesystem authority; buffer/path-wide release can invalidate another mounted split. Source location and per-effect lifetime are independent facts.
- **Evidence:** parent m7-editor-source-control-completion D11,D20; editor markdown/service.ts:366–376,415–434; markdown/files.ts:237–281; Git FileDiff.tsx:119–148; editor ChangesSurface.tsx:125–140; external source-control.md:223 and editor.md:366.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** public authorized resources cannot bind detached source authority without buffer mutation.
- **Source:** supersedes m7-editor-source-control-completion D11

## D2: Resolve standard gray areas without a human or research swarm
- **Question:** Which observable design defaults apply to this unattended Visual/API/Integration/Data item?
- **Options:** interactive choices/external research; source-grounded autonomous defaults.
- **Chose:** unchanged layout/density and modified-only notice; loading/concrete errors with Source escape; safe alt fallback for unavailable images; strict explicit authority and schema; no remote images or historical Git blobs; ephemeral bounded exact leases; preserve all shared drafts/tabs/source previews. Source locations may be absent for historical/staged diffs but must authorize through canonical create-path resolution without file creation. Inspect auth/response/error/lifetime/conflict/persistence/interaction gray areas. Purpose, consumers, success, constraints, scope and primary behavior are fully specified by queue and read-only feature docs. No open questions.
- **Why:** authoritative LOOP replaces interactive gates and swarms and requires one combined spec, self-reviewed against actual feature flows.
- **Evidence:** git show build/roadmap:docs/loop/LOOP.md Build first/Answering a skill's questions; combined logic.md; docs/roadmap.md:13–56; docs/architecture.md:290–324.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** feature source or locked decisions contradict these defaults.
- **Source:** locked by docs/loop/LOOP.md

## D3: Stabilize contracts before disjoint implementers
- **Question:** What implementation decomposition minimizes coupled file writes?
- **Options:** one long cross-owner implementation; committed shared types/schema followed by two disjoint owner slices.
- **Chose:** parent commits public params/result types, schema and combined spec first. Backend owns editor Markdown service/resolver/detached module and backend/API tests; consumer owns Git FileDiff and editor ChangesSurface plus respective UI tests. Both use isolated temporary worktrees from that commit, absolute file-tool paths and no worker commits/checks. Parent integrates after barrier and removes trees immediately after merge. Preserve inherited untracked .serena/ unchanged.
- **Why:** two natural nonoverlapping scopes consume the same precommitted API. No extra layers, reviews or speculative replacement APIs.
- **Evidence:** PreviewResourceMap completed survey; current types.ts,manifest,service,FileDiff,ChangesSurface owning files.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a required source change crosses the declared scope.
- **Source:** assumed — autonomous

## D4: Author tests now and retain bounded runtime evidence separately
- **Question:** Which verification applies before the end-phase triage item?
- **Options:** run suites/dogfood/review campaigns; write acceptance now and use typecheck-only landing gate.
- **Chose:** write real isolated API/resource acceptance and deterministic late-acquisition/UI lifetime coverage; do not run suites, full build, semantic review or dogfood campaign. Root/mobile bun run typecheck is the landing gate. Engineering-required narrow runtime/API and actual owned rendered-surface smoke have isolated homes/teardown and are recorded without claiming exhaustive acceptance. IMPLEMENTER=omp task OpenAI; REVIEWER_ALIAS=opus cross-family reserved but review/probes skipped under current LOOP. One wave/two components, width cap3 does not bind. No successor/checkpoint review.
- **Why:** build-first LOOP explicitly shifts campaigns to the end phase. Typecheck cannot prove behavior; authored tests are not passing tests.
- **Evidence:** authoritative LOOP; parent D3,D17,D21.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** end phase starts or policy changes.
- **Source:** locked by docs/loop/LOOP.md

## D5: Keep platform evidence bounded to macOS
- **Question:** What does portable path/resource code establish on other platforms?
- **Options:** infer Windows/Linux parity; preserve explicit platform limit.
- **Chose:** reuse portable path and opaque-resource APIs but record Linux/Windows symlink/path/case and split/browser resource cancellation as requiring platform execution. No new native-only OS scenario for this web-only flow.
- **Why:** no Windows/Linux runtime is available or exercised; URL/path normalization semantics differ.
- **Evidence:** roadmap.md:282–287; WorktreePaths; workstation macOS.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** platform execution provides evidence.
- **Source:** deferred: platform

## D6: Align the resource contract at the actual supported boundary
- **Question:** What did integrated source inspection, typecheck and the first daemon smoke establish?
- **Options:** trust worker/structural PASS reports; keep one canonical contract and diagnose observed failures.
- **Chose:** backend d5202297 and consumer feb161a6 integrated after both initial HEADs/scopes were checked; both trees removed immediately. Authorized backend scope addition preview.tsx exports the existing bounds validator, removing a duplicate policy. Shared params/results replace private duplicates; lease alphabet matches the schema; explicit id:<id> only, lexical normalized source identity, new generated CLI markdown-preview-resource. Keep all source-buffer behavior independent.
- **Why:** duplicate bound policies drift; source authority is a resolved id, while a symlink target is not Git's diff path identity. A UUID lease is never shared by a buffer or split.
- **Evidence:** committed contract d0a50944; scope audit output; detachedPreview.ts; two component handoffs; logic spec dated amendment.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** an actual authorized source cannot preserve public diff identity.
- **Source:** assumed — autonomous

## D7: Repair declaration rejection and fixture typing without weakening service guards
- **Question:** Why did the actual daemon expose no editor methods, and why did typecheck fail?
- **Options:** waive smoke/typecheck or relax validation; remove unsupported declaration syntax and repair exact fixture types.
- **Chose:** remove minLength/maxLength/pattern from the flat manifest schema while retaining service checks and documenting their limits. The protocol checkSchemaDeclaration diagnostic returned five unsupported-keyword errors. Add the omitted pendingLeaseIds fixture signature and explicit shared Release result types to four expectations. No consumer assertion or runtime guard was removed.
- **Why:** daemon smoke bg8 failed unknown quirky.editor/state before reaching the new API; the invalid declaration prevented plugin availability. Structural validator PASS did not inspect the schema parser and was insufficient. Typecheck bg7 found7diagnostics in these two test files; these were generic expectation inference and fixture-interface errors.
- **Evidence:** bg8 actual failure and DIFF_IMAGE_SMOKE_CLEANED; packages/protocol/src/schema.ts:20–31,53–55; actual checkSchemaDeclaration output; bg7/artifact19; corrected manifest and fixtures.
- **Reversibility:** easy
- **Confidence:** high for observed roots; corrected runtime/typecheck evidence is recorded separately
- **Revisit if:** corrected runtime still cannot activate the editor or typecheck reports more diagnostics.
- **Source:** assumed — autonomous

## D8: Keep exercised API and component evidence distinct from deferred acceptance
- **Question:** What has actually passed, and what remains deliberately unrun?
- **Options:** treat authored tests/typecheck as full parity; report only observed isolated paths.
- **Chose:** corrected root/mobile typecheck bg9 passed24.08s. Actual daemon/API+generated CLI bg10 passed2.67s:68-byte local PNG, two independent URLs, exact release404 while sibling/source-buffer remain200, idempotent release, four unsafe-source refusals, text-only boundary, absent historical source, no detached buffer/disk mutation. Production FileDiff browser mount showed two modified-only sanitized previews with real1px image decode; unmounting one yielded404/200. Production ChangesSurface with a controlled shared-draft boundary and real daemon APIs showed the shared draft/image; Source returned that draft, released its URL404 and retained both Git URLs200.
- **Why:** actual mounted components plus resource GETs establish changed paths but not packaged-app/native/full acceptance. The scratch harness is not the shell/tab owner. Same-tab hosted behavior, deferred-acquisition races and bounds have authored permanent coverage, not a reported passing suite.
- **Evidence:** bg9/bg10; component service r9b and r9c readiness/exit0/DIFF_IMAGE_SMOKE_CLEANED; managed browser DOM/screenshots and resource statuses. Scratch JSX initially lacked react/jsx-dev-runtime resolution; fixing only its resolver allowed real component mounts. First browser worker timed out/was killed; reopened owned tab supplied the actual evidence. Resource cancellation logged expected net::ERR_ABORTED on revoked image fetches; no observed page exception. Browser tabs released, both owned services exited0; shutdown response socket close occurred while awaited teardown completed.
- **Reversibility:** easy
- **Confidence:** high for exercised paths only
- **Revisit if:** end-phase acceptance or native/platform execution contradicts these observations.
- **Source:** assumed — autonomous

## D9: Preserve the single incoming terminal completion's ownership
- **Question:** Did the one integration catch-up alter this source/resource contract?
- **Options:** duplicate terminal rendering/authority; preserve the incoming owners and source authorization.
- **Chose:** single conflict-free merge754cab76; immutable HEAD^1...HEAD^2 inventory contained only m7-sweep-terminal-completion.md, read in full including its truncated evidence/Progress. Preserve Ask's separate inert preview pipeline, Dashboard/Fork ownership, panel-only Sleep, worktree provenance, exact scoped cleanup and remote/native capability limits. No source/image contract conflict and no extra in-scope flow remains unbuilt; no follow-up item.
- **Why:** Ask output is not a file-authorized diff source, and terminal Sleep/cleanup must retain its own resource/lifecycle authority. Incoming new hooks wrote only the smoke's isolated provider homes; cleanup removed them.
- **Evidence:** git merge output754cab76 and exact incoming log inventory; complete incoming D1–D14; merged actual daemon/API/CLI bg12 passed2.69s with DIFF_IMAGE_SMOKE_CLEANED; merged root/mobile typecheck bg11 passed24.04s.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** canonical landing introduces a conflicting owner or compiler failure.
- **Source:** locked by docs/loop/decisions/m7-sweep-terminal-completion.md

## Progress
Ready for canonical landing: implementation, authored acceptance and bounded runtime/component evidence complete; merged root/mobile typecheck bg11 passed24.04s and actual merged API/CLI bg12 passed2.69s. No suites/reviews/full dogfood/native clearance claimed. Both component worktrees removed immediately after merge. Single roadmap catch-up754cab76 and its only incoming decision log reconciled. All workers/checks returned and owned browser/services stopped. Commit final evidence, detach and canonical queue land. After its receipt remove only owned scratch/component branches, update loop notes and end this one item.
