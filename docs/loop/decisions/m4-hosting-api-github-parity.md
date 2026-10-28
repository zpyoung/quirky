# m4-hosting-api-github-parity decisions

## D1: Finish exactly the predecessor's two deferred flows and their existing consumer
- **Question:** what is in scope after claiming this follow-up?
- **Options:** API-only with the temporary UI block retained; both API gaps plus the affected existing Tasks caller; broader hosting audit.
- **Chose:** both gaps and remove the existing Tasks Project-owner restrictions, with one UI scenario. No new UI or other providers.
- **Why:** parent D38 names these exact gaps; retaining the consumer restriction would leave a dead temporary boundary after cutover.
- **Evidence:** docs/loop/decisions/m4-hosting-api-github.md D38; plugins/quirky.tasks/src/projects/ProjectsSurface.tsx:627-675; hosting-api.md:301-322.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** authenticated GitHub capabilities differ from the content-owner model.
- **Source:** locked by docs/loop/decisions/m4-hosting-api-github.md

## D2: Resolve all design questions autonomously and use one combined spec
- **Question:** how to run brainstorming/spec gates with nobody watching?
- **Options:** ask a person; skip decisions; self-answer standard API/CLI/integration gray areas and record them.
- **Chose:** self-answer authentication, response/error format, pagination, rate limiting, CLI flags/output/exit codes, data mapping and retry policy below; skip visual/adhd offers and research swarms; combined logic.md with technical decisions and self-review.
- **Why:** canonical LOOP explicitly overrides interactive gates and night-mode asks for one spec/contracts first.
- **Evidence:** canonical docs/loop/LOOP.md read by git show build/roadmap:docs/loop/LOOP.md, Night mode and Answering a skill's questions.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the operator changes the unattended workflow.
- **Source:** locked by docs/loop/LOOP.md

## D3: Content repository ownership determines issue-type capability
- **Question:** whose types apply to a user-owned Project, personal repositories and missing capabilities (data-mapping/auth-method)?
- **Options:** keep the Project-owner guard; blindly query organization by login; authenticate the content repository's owner type and use its organization catalog.
- **Chose:** authenticated repository owner metadata determines Organization versus User; organization catalog regardless of Project owner, proven personal owner yields no choices and not_found for requested type. Errors/malformed data remain errors.
- **Why:** Projects can contain foreign organization issues; personal repositories cannot supply organization issue types. Empty results must not hide failed discovery.
- **Evidence:** parent D17/D38; plugins/quirky.hosting/src/project-mutations.ts:39-49,248-286; hosting-api.md:314-322.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** GitHub adds issue types for personal repositories.
- **Source:** locked by docs/loop/decisions/m4-hosting-api-github.md

## D4: Preserve all existing public contracts and safety checks
- **Question:** change methods/versioning/flags, discovery output, mutation consent or identity rules?
- **Options:** new issue-type endpoints/batch flags; existing schemas and generated commands.
- **Chose:** existing projectItemMutation/updateIssueType, Tasks projectEdit/issueType and listWorkItems/countWorkItems signatures. Omitted type selector is no-write discovery; enabled type by ID or case-insensitive name updates once. Keep public API ownership, ambient Projects auth, trusted host/item association and bound ordinary search. Safe classified data.reason, existing JSON/exit codes, no new confirmation for reversible type edits.
- **Why:** every required input/result is already declared; no new protocol or storage migration is needed.
- **Evidence:** quirky.hosting/quirky-plugin.json projectItemMutation; parent D6/D7/D17/D18; docs/architecture.md:312-324.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** API consumers need a distinct read-only discovery contribution.
- **Source:** locked by docs/quirk/specs/2026-10-27-m4-hosting-api-github/tech.md

## D5: Use one hosting-local coordinator over the existing runner
- **Question:** what architecture and rate/retry semantics implement batching?
- **Options:** independent queries; global daemon batching; per-HostingEnv search coordinator.
- **Chose:** per-env aliased search/count batches, scoped via env.cacheKey; only env.graphql spawns and accounts reported batch cost. Max10 aliases/12000 serialized query characters, individually oversized valid query isolated under existing runner limits. Preserve four slots and idempotent read fallback/retry policy; no mutation replay.
- **Why:** independent queries miss the deferred behavior; global infrastructure adds needless API and account-boundary risk.
- **Evidence:** hosting-api.md:304; env.ts HostingEnv; runtime-runner.ts existing GraphQL cost policy; parent D37.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a second plugin requires the same batching contract.
- **Source:** assumed — autonomous

## D6: Bounded page/cursor reuse preserves freshness and failure isolation
- **Question:** pagination, cache mode, errors, rate limits and empties?
- **Options:** persist cursors; unbounded process maps; bounded short-lived generation-scoped memory.
- **Chose:** response <=120s/512entries/16MiB; cursors <=120s/1024entries/1MiB. Exact duplicates coalesce, noCache bypasses settled data, mutation/disposal clears data and late generations cannot publish. Preserve <=8192-byte query and <=1000 results. Alias-local errors affect only that alias; global failures preserve existing per-source fallback/errors. Reject malformed/nonadvancing cursors rather than report duplicate complete rows.
- **Why:** memory bounds and identity/freshness are load-bearing while changing pagination. workItemPage numbered REST, empty recent issues and PR list transport remain unchanged.
- **Evidence:** hosting-api.md:303-305,418-424; env.ts:99-114,236-288; parent GH08/GH11.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** measured provider behavior requires different safe cursor lifetime.
- **Source:** locked by hosting-api.md

## D7: Use native omp implementers with Gemini review because Opus is unavailable
- **Question:** cross-family model pairing and environment readiness at execution preflight?
- **Options:** native omp tasks plus Opus; native omp tasks plus available Gemini; reduced-independence OpenAI reviewer.
- **Chose:** IMPLEMENTER=omp-task; AUTHOR_FAMILY=openai; REVIEWER_ALIAS=gemini. pi-watch --check resolved google/gemini-3.1-pro-preview:high; Opus and Sonnet had no authed/shipping model. Bun1.4.0 is available. LSP references for listWorkItems returned no language server, so scoped text/symbol inspection is the fallback.
- **Why:** canonical omp pairing says use next cross-family pair when Opus is unreachable. No auth/environment changes are authorized.
- **Evidence:** actual preflight pi-watch --check output (7/12 ready, exit5); bun --version1.4.0; xd://lsp references response.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** actual Gemini dispatch fails; follow the recorded fallback ladder rather than invent a review.
- **Source:** assumed — autonomous

## D8: Run one wave of three disjoint vertical components
- **Question:** execution decomposition, inherited dirty state and contract ownership?
- **Options:** shared-tree concurrent edits; serialized everything; separate worktrees with disjoint source/tests.
- **Chose:** search coordinator+new dedicated test; issue-type backend+work-items test; Tasks guard cutover+projects tests/fixture. No semantic edges; one wave width3, cap3 not binding, native task async barrier. Existing public signatures and internal env contracts are committed in the combined spec before implementers. Main owns documentation and smokes. No worker commits or mid-flight checks; parent observes regression then final passes after edits.
- **Why:** scopes do not intersect and no new shared API is necessary. Parent maintains integration ownership. Inherited .serena untracked directory is preserved via path-limited stash lane6-inherited-serena-iteration5; no user content deleted.
- **Evidence:** HostingParityMap scout; spec Technical decisions and contracts; initial git status; successful path-limited stash.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** implementation reveals an unavoidable shared source change; replan before editing outside scope.
- **Source:** assumed — autonomous

## D9: Verify public API, actual CLI and one web user scenario
- **Question:** required acceptance and check commands, native coverage and test-state isolation?
- **Options:** unit-only proof; public daemon+CLI regression and guarded web flow.
- **Chose:** all P/S/C/U acceptance rows in the combined spec. Parent runs owning files then affected suite, scripts and typecheck; queue land owns whole suite. U01 uses build and fresh-home web-only yours/unattended dogfood. No new native scenario. Every spawned process uses temporary QUIRKY_HOME and is terminated; never shared gh state.
- **Why:** milestone rules require scriptable flows, and consumer cutover must work on the actual surface.
- **Evidence:** docs/roadmap.md:43-53; LOOP Verify; package.json:10-15; combined spec acceptance table.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** external tooling blocks a scenario; preserve report and distinguish tool limit from app failure.
- **Source:** locked by docs/loop/LOOP.md

## D10: Retain the macOS-only support boundary
- **Question:** does this item claim Linux or Windows subprocess verification?
- **Options:** claim portable behavior from types; retain existing platform deferral.
- **Chose:** no new platform-specific primitives; macOS runtime verification only. Linux/Windows gh process-tree, runtime path and execution environment checks remain pending under predecessor D12.
- **Why:** portable TypeScript maps do not prove OS process behavior.
- **Evidence:** docs/roadmap.md Platforms; parent D12; docs/loop/LOOP.md Platforms.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Linux/Windows becomes a supported build target.
- **Source:** deferred: platform

## D11: Consume coordinated committed implementations instead of duplicate rewriting
- **Question:** lane8 reports its m7-sweep-hosting branch already implements both exact API gaps and the Tasks guards; which tree owns implementation?
- **Options:** continue independent production rewrites; copy foreign uncommitted changes; consume isolated committed changes and add only missing verification.
- **Chose:** cherry-picked -x9cc24e68 andeafde4d7 as aae21422/98a52de5. Local agents remain tests-only on separate scopes; parent reconciles canonical fixture updates when lane8 commits them. No production rewrite started locally.
- **Why:** user coordination explicitly prioritizes reuse and avoiding colliding source. Incoming code authenticates repository.owner and removes all three UI owner guards, with8 search and3 type regressions reported passed by lane8. Those reports are not relabeled parent-observed checks.
- **Evidence:** user coordination interjection; git show stats/source for both exact commits; cherry-pick output; /tmp/quirky-lane8-hosting-parity-reply.md.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** independent acceptance reveals a gap or canonical lane8 changes conflict.
- **Source:** supersedes m4-hosting-api-github-parity D8 (local production implementation ownership)

## D12: Keep source query-document limits rather than add a speculative variable ceiling
- **Question:** should the new spec count serialized variables against the12000-character batching bound?
- **Options:** a new combined body ceiling; source document ceiling plus the existing runner body bound.
- **Chose:** document <=12000 characters and runner <=8192 UTF-8 document bytes, with existing request-body limits unchanged. Amend the logic source before any corrective implementation.
- **Why:** hosting-api.md names query characters, while the consumed implementation uses variables and honors the stricter current runner document ceiling. Lowering the variable-body limit would invent a new constraint rather than deliver parity.
- **Evidence:** item-search.ts MAX_BATCH_QUERY_CHARACTERS/MAX_EXECUTABLE_QUERY_BYTES and splitBatches; runtime-runner.ts:481-484; hosting-api.md:304.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** GitHub or the public API defines a combined request-size requirement.
- **Source:** supersedes m4-hosting-api-github-parity D5 (batch-size interpretation only)

## D13: Preserve independent regression evidence and repair provider fixtures, not assertions
- **Question:** how to interpret the first integrated5-file run (52pass11fail), and which fixes are justified?
- **Options:** weaken assertions or increase timeouts; repeat the whole run unchanged; fix the demonstrated cursor defect and protocol-fixture mismatches.
- **Chose:** keep the assertions and original bounds. A repeated cursor returned100 rows with50 unique identities; reject previously seen continuation cursors before appending a block, then use the existing REST fallback. Repair alias-aware rule routing, authenticated nested repository.owner, mixed-owner Project view/item fixture lookup and issue-store readback. The isolated account test must return real --user capability help and always await its released pending request.
- **Why:** old-source GH34 was independently red (0pass4fail) and the Tasks user-project regression was red on unsupported_operation. Consumed source clears that boundary, but fixtures still described the old wire shape. Missing fixtures are not grounds to change the provider contract. The Tasks selection20s timeout remains disclosed; no product/test deadline is raised.
- **Evidence:** old-source test outputs; integrated run artifact://39 (435.84s); parity-search-regressions.test.ts:168-171; current fetchGraphqlSearch previously appended repeated results; committed6867676f compatibility diff; ConsumerFixtureRepair root-cause report.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** owning-file checks still fail after the scoped repairs.
- **Source:** assumed — autonomous

## D14: Accept lane8's observed selector regression as ground truth
- **Question:** lane8 reports a successful Bug write becomes a blank select after Board→Table; reproduce it here or consume its committed fix?
- **Options:** repeat the known broken scenario; rewrite the same UI fix; await the isolated committed correction and verify closure once.
- **Chose:** do not rerun to confirm the reported failure. Lane8 owns the tiny selector patch; consume its committed SHA when supplied, then exercise U01 including Board→Table and retained visible Bug.
- **Why:** user-reported observation is ground truth and duplicate source rewrites risk conflicts. Unloaded choices must not hide the saved current value.
- **Evidence:** lane8 user interjection (screenshot observation11, red); coordination reply /tmp/quirky-lane8-hosting-parity-reply.md.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the committed fix does not close the actual U01 scenario.
- **Source:** assumed — autonomous

## D15: Consume the saved-selector fix and retain the guarded UI partial verdict
- **Question:** does the actual corrected web surface satisfy U01, and can the automation verdict be labeled pass?
- **Options:** manufacture a trailing OBSERVED action; silently call visual evidence a pass; preserve the guard's tool-limited partial with exact evidence.
- **Chose:** consumed539aa1c9 as008f2722 and rebuilt. Run20261028T100152-a007 used web/yours/unattended with no overrides. It visibly loaded pat/4, showed saved Task before choices loaded, discovered Bug/Task without disabled Archived, changed to Bug, retained Bug after Board→Table with unloaded choices, and retained Bug after closing/reopening Tasks. Final reopen was UNSETTLED; stable observation18 did not change the guard's last-act requirement, so pass_without_effect refused pass. Recorded partial under LOOP's explicit tool-limit rule, not an app failure or formal UI pass.
- **Why:** screenshot evidence establishes the visible saved-value correction, but cannot override the deterministic guard. Refresh on unchanged data returned NO_EFFECT, not proof of a network reload. No extra mutation/unrelated trailing action was used to game status.
- **Evidence:** .quirk/using-apps-like-a-user/runs/20261028T100152-a007/report.json; observations7/8/12/14/18; actual pass_without_effect output. End closed the browser with no kept-open windows; frontmost restore to baseline com.apple.SecurityAgent failed desktop_command_failed. Owned daemon97798 exited0 and its temporary root was confirmed absent.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a future guard supports settling an UNSETTLED act through observation, or the real UI fails the saved-value scenario.
- **Source:** locked by docs/loop/LOOP.md

## D16: Route the unchanged numbered-page completeness finding to its active sweep owner
- **Question:** plugin-validator flags workItemPage incomplete status lost by Tasks; is that introduced by these changes?
- **Options:** expand this item into numbered-REST list work; suppress the finding; preserve it and route to m7-sweep-hosting.
- **Chose:** static source evidence confirms the producer can return partial:true/truncated:true without errors and the consumer currently reads only errors/count. Both paths are unchanged here and explicitly excluded from this item's cursor-search cutover. Recorded MEDIUM in BLOCKERS and sent the exact evidence to active lane8; do not claim its resolution or turn it into a local source rewrite.
- **Why:** the request names the two deferred API flows; inventing a third flow would collide with the sweep owner. This is not a false-positive dismissal: the bounded plugin validation reports FAIL for that wider consumer issue while reporting matching54hosting/28Tasks public method/CLI declarations and correct type discovery/owner semantics.
- **Evidence:** ParityPluginValidation report; plugins/quirky.tasks/src/list/methods.ts:279-301; plugins/quirky.hosting/src/task-page.ts:91-103,171-180; combined spec Scope and non-goals; /tmp/quirky-lane8-hosting-parity-reply.md.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** lane8 supplies its committed correction or these changes are shown to introduce the issue.
- **Source:** assumed — autonomous

## D17: Keep lane8's fresh U01 PASS distinct from lane6's tool-limited run
- **Question:** lane8 reports guarded U01 closure passing on the same committed selector fix; repeat it or retain both evidence records?
- **Options:** repeat UI work; relabel lane6 partial as pass; accept the reported closure separately while keeping local evidence exact.
- **Chose:** user coordination reports rebuilt guarded run20261028T095840-a759 PASS: saved Bug cold, choose Task, Board→Table visibly Task before focus. It uses539aa1c9 already consumed here. Preserve that as lane8-reported acceptance and retain lane6's independent visible persistence/partial verdict unchanged. No third dogfood run.
- **Why:** reported observations are ground truth; repeating a passed cross-lane scenario is unnecessary and risks conflicting source ownership. Both prove the same saved-current-value path, with different tool verdicts transparently named.
- **Evidence:** lane8 user interjection naming539aa1c9 and closure20261028T095840-a759; lane6 report20261028T100152-a007 and observations14/18; second local build output.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the reported closure is contradicted by the actual integrated surface.
- **Source:** assumed — autonomous

## D18: Accept the exercised affected gate without relabeling earlier failures
- **Question:** what verification establishes this candidate's API/CLI/build acceptance?
- **Options:** use lane8's reports alone; rerun the whole repository suite locally; run the required affected packages and leave whole-suite integration to queue land.
- **Chose:** the parent affected gate exited0:125remote files125passed0failed, suite ok:true/flaky:[], scripts68pass0fail576assertions, typecheck0 after596frozen installs across610packages unchanged. Included hosting, Tasks and consumer reviews/worktree/git directories. Keep the earlier52/11 local run and Tasks20s timeout as historical failures, not hidden passes.
- **Why:** the repaired owning regressions and actual CLI exercise changed behavior; broader consumer files ensure integration compatibility without competing whole-suite runs on this Mac. Script-suite red output is its intentional flaky/broken fixture scenarios; outer scripts68/0 and command0 are the result.
- **Evidence:** bg12 output artifact://83 (1229.56s); /tmp/quirky-lane6-parity-tekogA/verification.json; actual CLI smoke and post-selector build output; scoped post-fix test outputs.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** normal queue land's merge-result checks fail.
- **Source:** locked by docs/loop/LOOP.md

## D19: Reject C1 after the exact pending-overlap API experiment disproves its premise
- **Question:** final cross-family correctness lens claims new reads can join an old generation's pending promise; add an extra generation check?
- **Options:** blindly add redundant source logic; accept only static reasoning; exercise the exact disputed overlap and adjudicate against the complete key.
- **Chose:** no source change. Full-independence Gemini standard-depth promote/refute Round1 returned C NEEDS_FIXES (C1 HIGH/LOW), S PASS and X PASS, zero limitations/questions/exclusions. Reject C1: pageKey contains env.cacheKey, which includes scope-generation advanced synchronously by env.invalidate. The actual public API smoke held OLD_HELD, mutated the issue, and completed FRESH_WHILE_OLD_PENDING while the old promise was still held; releasing it then returned OLD_HELD only to the original caller.
- **Why:** refute explicitly asserted pageKey lacks generation, but missed env.ts's composed generation field. Both source and runtime contradict that premise. A redundant check would not fix a demonstrated bug. Raw GateResults remain unchanged; this is parent adjudication, not three machine PASS verdicts.
- **Evidence:** review/C.gate.json, C.refute.json and C.manifest.json; S/X gate/manifest records; item-search.ts:389-397 and env.ts:99-114,236-247; review-C1-smoke.ts actual exit0/3.52s output; review/adjudication.json under /tmp/quirky-lane6-parity-tekogA. Reviewed11source/test files; artifact hash445a1e90024db976c8a71e949053d0cdde7561fd586f95ce13bd7ff12c575e87.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a public API reproduction returns an old held result to a post-invalidation caller.
- **Source:** assumed — autonomous

## D20: Reconcile only the advancing canonical fixture conflicts and retain all incoming authority rules
- **Question:** normal queue land refused the candidate because build/roadmap advanced; how to reconcile its actual changes without duplicate source rewriting?
- **Options:** choose whole-file ours/theirs; modify shared integration state; follow the normal item-branch merge and preserve the fixture union.
- **Chose:** land635bfd82 stopped before tests after131.23s. Switched back to the item branch and merged build/roadmap; product source merged cleanly, only hosting work-items and Tasks projects fixtures conflict. A scoped resolver preserves canonical alias/per-expression/global-error and mixed-owner/readback behavior plus independent GH34/U01 positive-owner tests. Read all incoming decision logs via the read-only scout: m5-loops-ui D1–D25, m6-heimdall-control D1–D15, m6-heimdall-owner D1–D43, m7-sweep-hosting D1–D12, m7-sweep-terminal D1–D20.
- **Why:** canonical m7-sweep-hosting is now done (candidate de8a3517); our queue item remains in progress and owns independent edge acceptance. Incoming rules preserve Hosting-local bounded search, content-repository type authority, public plugin/CLI routing, exact local worker identity and no fabricated readiness/stop evidence. No binding conflict requires a local source change. Keep sweep's C1 source-context finding distinct from our C1 pending-overlap claim; neither justifies a fallback. Numbered-page incomplete status remains unresolved, not silently cleared.
- **Evidence:** canonical queue land failure and merge conflict output; canonical queue state read; ParityIncomingDecisions complete read report; incoming five decision logs; lane8 authoritative landing interjection reporting706remote+6Mac and scoped retry/scripts/typecheck receipts.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** resolved merged candidate fails owning/affected checks or canonical land rejects its next merge.
- **Source:** locked by docs/loop/LOOP.md

## D21: Remove the duplicate fixture binding and prove the corrected consumer path remotely
- **Question:** post-merge gate reported124/126 files passing, a deterministic Projects fixture failure and a sidebar setting timeout; what actually needs changing?
- **Options:** weaken assertions/deadlines; repeat the same full gate without diagnosis; repair the demonstrated fixture syntax and isolate the consumer files.
- **Chose:** Bun.Transpiler identified `repositoryOwnerType has already been declared` in the merged disposable gh source. Removed the obsolete earlier declaration, retaining the later metadata→canonical issue-owner fallback. No production change. The remote Tasks/worktree gate then passed36/36 files with ok:true/flaky:[], including both previously failing files. Scripts68pass0fail580assertions and typecheck0 subsequently passed. Post-merge actual generated CLI and pending-overlap smokes passed; packaged build passed25UI modules29plugins.
- **Why:** the duplicate binding prevented every provider operation in that fixture from parsing; it was a merge-reconciliation defect, not a provider-policy failure. The prior126-file run stopped before scripts/types. Two local isolation runs timed out and cascaded into connection/window cleanup errors; those remain failed receipts, not relabeled successes. Static sidebar event-path investigation found no concrete defect, and the36-file remote run passed unchanged assertions and deadlines. No cause is attributed to hosting or to load without proof.
- **Evidence:** bg20 output124pass2fail/590.65s; actual Bun.Transpiler diagnostic; one-line fixture deletion; local bg22/bg23 failure artifacts127/126; SidebarGateDiagnosis evidence; bg24 remote36pass0fail/126.86s; bg25 scripts68/0/580 and typecheck0/294.27s (artifact://130); post-merge smoke19.97s and build99.53s outputs.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** normal land's current merge-result checks fail or the setting transition fails under controlled isolation.
- **Source:** assumed — autonomous

## Progress

Ready to retry normal queue land after committing the final one-line disposable-fixture parser repair and this receipt. Canonical merge2564ff4e is complete; incoming rules reconciled. Prior affected run covered124passing files, and the corrected Tasks/worktree gate passedall36files/noflaky, closing both failed file paths without assertion/deadline changes. Scripts68/0/580, typecheck0, current actual CLI/pending-overlap smokes and25UI-module/29plugin packaged build passed. Earlier local failures, raw model C NEEDS_FIXES→parent rejection, U01 local partial and lane8-reported PASS remain explicitly qualified. All agents/jobs/services returned; commit/detach and canonical queue.ts land next, then archive evidence/clean owned scratch and end exactly this item.
