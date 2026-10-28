# m4-hosting-ui-reviews decisions

## D1: Build the composite review scope, not only the sidebar
- **Question:** what does the queue's three-part title include?
- **Options:** sidebar only; all three parts; all hosting UI.
- **Chose:** right-sidebar Checks, full PR detail, and review creation/hosting settings together. Tasks/issue/Projects are the neighboring dependency; PR sitter and provider APIs remain their owners.
- **Why:** the composite title expressly unions all three parts and excludes only flows absent from every part.
- **Evidence:** queue wait lane5 m4-hosting-ui-reviews; hosting-ui.md sections5,10,11 and non-task12; docs/roadmap.md M4.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** the queue explicitly reallocates a flow.
- **Source:** locked by docs/roadmap.md

## D2: Resolve design questions unattended with one self-reviewed logic spec
- **Question:** how to run brainstorming and specifications without a person?
- **Options:** ask and wait; use recommended defaults under the autonomous night protocol.
- **Chose:** no asks, no visual/adhd offer, no research swarm; one markdown logic spec with final technical contracts. Select Visual layout/density/loading/errors/interaction, API errors/auth/response, CLI flags/output/errors, Integration conflict/data mapping, Data persistence/ownership. Resolve every selected question against feature docs and existing public conventions.
- **Why:** canonical LOOP night mode overrides the interactive gates and separate tech/spec-review stages.
- **Evidence:** git show build/roadmap:docs/loop/LOOP.md; sections Night mode and Answering a skill's questions.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** operation becomes attended.
- **Source:** locked by docs/loop/LOOP.md

## D3: Keep the review feature independently replaceable and share hosting policy
- **Question:** where do the PR page, Checks and creation/settings live?
- **Options:** expand the shell; concurrently modify the Tasks plugin; separate quirky.reviews plugin over public hosting/worktree/git/UI APIs.
- **Chose:** separate quirky.reviews plugin, no private sibling imports or renderer gh invocation. Public open method takes worktree, number and optional conversation/checks/files tab; view ID view:quirky.reviews/review. Tasks keeps its navigation state and routes PR detail to this method. A public close method restores prior view.
- **Why:** separate ownership avoids concurrent writes with the pending Tasks item while preserving one canonical provider, merge, auth and confirmation seam.
- **Evidence:** m4-hosting-ui-tasks D1/D3; committed plugins/quirky.tasks/src/contracts.ts; accepted coordination receipt5828f059-4097-45e7-9918-72b39662c3a2.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** public registry routing cannot express a documented flow; grow it rather than import private implementations.
- **Source:** assumed — autonomous

## D4: Use OpenAI task implementers and Gemini cross-family review
- **Question:** which reachable pairing satisfies an omp lane?
- **Options:** task+Opus; task+Gemini; same-family fallback.
- **Chose:** IMPLEMENTER=task, AUTHOR_FAMILY=openai, REVIEWER_ALIAS=gemini, high thinking. At most three implementation components; one final review round and blocking fix batch.
- **Why:** actual pi-watch --check found Opus/Sonnet unavailable and Gemini google/gemini-3.1-pro-preview:high available. Bun1.4.0 available. Build bun run build; affected directories bun scripts/suite.ts; scripts bun test scripts; typecheck bun run typecheck. Whole suite belongs to queue land.
- **Evidence:** preflight exit5 with7/12 aliases ready; separate bun --version1.4.0; LSP status no language servers configured.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** actual selected reviewer dispatch fails; use the documented fallback ladder.
- **Source:** locked by docs/loop/LOOP.md

## D5: Preserve data ownership and show failures rather than false success
- **Question:** how do missing metadata, stale reads, optimistic writes and provider failures appear?
- **Options:** reproduce Orca's silent/no-check defaults; distinguish loading, unavailable, empty and authoritative state.
- **Chose:** preserve stale data plus visible refresh error, generation/context ownership, optimistic reversible updates with rollback, confirmed comments retained over lagging reads, and explicit unsupported status-only rerun error. Never interpret unknown checks or missing merge metadata as permission to merge; destructive merge uses fresh expectedHead and kernel confirmation.
- **Why:** these are consumer-visible correctness requirements and fix recorded source defects without inventing another provider policy.
- **Evidence:** hosting-ui.md sections5,10, Edge cases, Verified in the app; m4-hosting-api-github D9/D17/D19/D38/D42.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** an acceptance flow contradicts the source or canonical API.
- **Source:** locked by hosting-ui.md

## D6: Verify isolated macOS workflows and hand off OS effects
- **Question:** how to test hosting writes and native links/clipboard unattended?
- **Options:** real user forge/auth state; disposable daemon/home/repo and stateful gh fixture.
- **Chose:** fresh HOME/QUIRKY_HOME and owned process scope for API/CLI and web proof; never real hosting mutations or credentials. Native clipboard, external-browser routing, modifier behavior and focus go to pending native scenarios. Linux/Windows keyboard, shell/auth and link routing need their platform verification.
- **Why:** headless web proof does not establish OS effects and the loop forbids real-state tests.
- **Evidence:** LOOP Hard rules/Verify; hosting-ui.md sections5,10–12.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** those platforms or real native verification become available.
- **Source:** deferred: platform

## D7: Grow canonical PR conversation and assignee APIs rather than use Project routes
- **Question:** how to implement PR conversation add/edit/delete and assignees when hosting lacks their public primitives?
- **Options:** misroute through issue/Project methods; omit the flows; add focused canonical hosting methods.
- **Chose:** parent owns src/review-conversation.ts, registration from src/pr.ts, manifest additions and real-daemon regressions. reviewConversation accepts number/action(add/edit/delete), optional commentId/body and prRepo; reviewAssignees accepts number/action(add/remove/set), logins and optional prRepo. Fresh shared lookup validates source; exact comment issue_url validates host/repo/PR membership. Delete-only conditional confirmation; add/edit and assignments stay ask-free. No provider mutation retry; uncertain completion invalidates and requires refresh.
- **Why:** issueComment asserts issue kind and Project mutation requires Project membership; neither is a valid arbitrary PR conversation seam. Lane6 explicitly ceded these focused files and retains its read projections.
- **Evidence:** hosting manifest reviewComment/updateReview/issueComment; src/pr.ts; user coordination ruling; observed reds unknown method -32601, then five real-daemon tests green with19 assertions.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** provider wire shapes or membership guarantees change.
- **Source:** assumed — autonomous; locked by operator source-ownership ruling

## D8: Execute three disjoint vertical components against committed contracts
- **Question:** which decomposition allows parallel work without shared-file edits?
- **Options:** horizontal backend/frontend waves; one broad implementer; three vertical slices and parent-owned assembly.
- **Chose:** Detail, Checks, Create/hosting-settings in three external component worktrees at6ef0a6c; parent owns env/main/UI entry/manifest/package/harness and canonical missing hosting mutations. Detail owns shared review controls; Checks imports their committed export contracts. Create alone can edit the Source Control WorktreePanel integration. HEAD/content/mode baselines captured before dispatch; workers cannot commit or run checks mid-flight; parent runs the barrier audit and checks.
- **Why:** each slice has a test owner and disjoint union scope. Contract imports are a fixed interface, not shared mutations. One wave width3, cap3 does not bind; no overlap-only dependency demotions or sequential successor/checkpoint.
- **Evidence:** scratch journal /tmp/quirky-reviews-lane5-run/journal.json; three dispatch scopes and committed contracts.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** required changes cross a declared scope; explicitly amend ownership before editing.
- **Source:** assumed — autonomous

## D9: Defer only provider-dependent and human-browser routing flows with named prerequisites
- **Question:** can unavailable other-provider APIs or the not-yet-built human browser be treated as successful review functionality?
- **Options:** invent forge routes or browser view; block the entire GitHub feature; ship verified GitHub/system routing and queue exact missing integrations.
- **Chose:** m4-hosting-ui-review-provider-parity depends on this item and both blocked provider API items; m4-hosting-ui-review-browser-routing depends on this item, sa-browser-pane and sa-browser-profiles-settings. Other providers display truthful unavailable guidance. Current system links use the public terminal opener; requested in-app destination explicitly refuses without silently rerouting. Native handoff covers shipped system delivery, not an unimplemented browser capability.
- **Why:** there is no canonical provider implementation or human browser view to invoke; faking those would violate public API and scope. The rest of GitHub review behavior works independently.
- **Evidence:** authoritative integration queue shows other-provider APIs blocked; public seam map found only quirky.terminal/openExternal and no human browser view; both follow-ups added through queue.ts add successfully.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the named dependencies land, then complete their exact flows.
- **Source:** deferred: other-provider reviews/creation/settings and in-app review-link routing

## D10: Expose non-checkout conflict inspection through the canonical Git owner
- **Question:** how can Checks show real conflict paths when provider metadata only says conflicting and changed files are not conflicts?
- **Options:** mislabel changed paths; run a mutating checkout merge; add a read-only merge-tree preview on existing commit objects.
- **Chose:** public quirky.git/mergePreview with complete base/head SHAs, registered worktree resolution, bounded deadlines, no fetch and no checkout/index/ref mutation. Configured external merge drivers make the preview explicitly unavailable; missing commit objects and unsupported/failed preview likewise return reasons. Git may create immutable merge-tree objects only.
- **Why:** provider conflict metadata has no path API; local current-operation conflicts are insufficient for an otherwise clean PR branch. The canonical Git library/owner is the reusable public seam.
- **Evidence:** observed API red -32601; actual daemon conflict preview then passed1 test/7 assertions including exact README conflict, unchanged HEAD/index/status/content, clean result, missing objects, invalid SHA and custom-driver refusal. Owned-run real generated CLI mergePreview also returned clean exact-SHA result.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** Git versions lack required merge-tree flags or a provider flow needs missing remote commit objects; report unavailable, never merge the checkout.
- **Source:** assumed — autonomous

## D11: Verify new canonical mutations through generated CLI, not only tests
- **Question:** do command discovery, array flags and confirmation reach real handlers?
- **Options:** infer from manifests/tests; exercise source CLI against the isolated daemon and stateful gh fixture.
- **Chose:** actual add Unicode comment, refused unconfirmed delete, set two assignees, confirmed delete and state readback. Corrected the smoke's initial JSON-array flag mistake to repeated --logins jo --logins pat, following the existing CLI parser rather than changing it. Explicit-origin regression with upstream and unconfigured-source refusal also passed.
- **Why:** tests alone do not prove the shipped generated client contract. No real forge/auth state was touched; owned process runner and harness cleaned every created scope.
- **Evidence:** /tmp/quirky-reviews-lane5-run/hosting-smoke.ts successful output; separate source-selection regression1pass/0fail/4assertions; first five mutation regressions5pass/0fail/19assertions.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** CLI flag generation or hosting source selection changes.
- **Source:** assumed — autonomous

## D12: Make custom plugin settings pages discoverable without shell feature imports
- **Question:** how do provider cards, budgets and account controls appear from the existing Settings entry point, which only rendered scalar fields?
- **Options:** feature-specific shell imports; command-palette-only settings; generic opt-in view metadata and Settings navigation.
- **Chose:** optional boolean view.settings declaration, public UiSlotEntry.settings projection and links in SettingsDialog. Only effective opted-in views appear; absent UI module disables its link. Await ui.view.open before closing; navigation failures stay visible. Parent owns view sections only and preserves lane6's separate optional boolean-setting menu field.
- **Why:** public plugin views express rich settings without coupling the shell to Tasks/Reviews. Ordinary feature pages must not accidentally appear in Settings.
- **Evidence:** focused commit71f73d6; actual daemon+React shell regression failed first with no preferences link, then passed1 test/4 assertions proving exact view navigation and removal after plugin disable. User ceded exact generic sections for a shareable commit; lane6 will mark its own settings view.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** a later plugin needs grouped or parameterized settings navigation beyond a view; extend public metadata, not private feature imports.
- **Source:** assumed — autonomous; locked by operator source-ownership ruling

## D13: Hydrate real stack members instead of turning a stack ID into a PR link
- **Question:** how does the stack map obtain member identities when canonical Review.stack contains only a summary?
- **Options:** invent root/member PR numbers from the stack ID; omit the map; add the original provider's bounded membership read.
- **Chose:** focused hosting/reviewStack in src/review-stack.ts, registered from parent-owned pr.ts. Resolve current PR and trusted source fresh; query PR.stack.entries(first:100), check summary/graph stack IDs, validate members and source URLs, sort by actual position and report truncation/unavailability. Stack resource number, selected PR number and member PR numbers remain separate.
- **Why:** the summary's number is not a PR number. Original source hydrates entries through GraphQL rather than a guessed REST stack resource. Stack merge still uses the same canonical merge direct/queue method; only the confirmation list is hydrated.
- **Evidence:** original read-only github-pr-stack.ts26–56,127–228 and StackMapWire report; API red -32601 then1pass3assertions; owned-run real generated CLI returned stack42 with real PR7/8, not a fabricated PR42.
- **Reversibility:** medium
- **Confidence:** high for the source-supported protocol; provider capability errors remain explicit unavailable.
- **Revisit if:** the provider removes stack GraphQL support or returns a changed membership shape.
- **Source:** locked by hosting-ui.md stack map; assumed — autonomous (public method shape)

## D14: Finish incomplete component handoffs with focused same-scope retries
- **Question:** may an incomplete worker report be treated as ready because substantial source exists?
- **Options:** accept the report; cut untested flows; audit and retry the same component with exact failure packets.
- **Chose:** Checks returned and froze with a clean five-path/unchanged-HEAD audit. Creation and Detail each returned incomplete; their seven/nine-path audits passed, and fresh focused retries continue those same components without broad rewrites or extra concurrent ownership. Shared contracts add session settings observations, exact-target agent dialogs and file-tree visibility so semantic UI state remains daemon-readable.
- **Why:** a report is not verification, and neither interrupted source nor missing uncertain-edge tests satisfies the acceptance flows. An intentionally older worker contracts snapshot is not an external blocker; parent owns integration.
- **Evidence:** scratch journal return audits; create-recovery.md and detail-recovery.md failure packets; original worker reports explicitly claim no checks and unfinished work.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a same-scope retry fails or identifies an actual unavailable prerequisite; route that concrete failure rather than accepting a scaffold.
- **Source:** assumed — autonomous

## D15: Preserve real comment destinations and provider bot identity
- **Question:** how does Go to comment work for existing comments when normalization dropped the selected provider URL?
- **Options:** synthesize URL fragments; hide existing-comment navigation; preserve validated human-facing provider URLs.
- **Chose:** nullable url from GraphQL url or REST html_url (never REST API url), rejecting unsafe schemes/credentials; nullable isBot from actual Graph actor typename/REST user type. Add typename to existing Graph selections with no new process. Unknown author type remains null for UI heuristics/overrides.
- **Why:** source-generated member/comment identities cannot be guessed, and a plain-name bot must not be forced into Humans because its provider flag was discarded.
- **Evidence:** Detail's concrete missing-field report and comment-details.ts mapper/type inspection; one actual daemon boundary test passed4 assertions across Graph/REST fallback, plain-name bot, explicit user, javascript URL and credential URL. No failing-before rerun is claimed for the reported omission.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** provider comment URL/actor types change; retain unavailable rather than unsafe link guesses.
- **Source:** locked by hosting-ui.md comments/navigation/bot detection

## D16: Use the public flat Schema contract and repair actual integration failures
- **Question:** may richer JSON Schema keywords or source-only component reports stand in for a loadable plugin?
- **Options:** widen the protocol to arbitrary JSON Schema; normalize silently at runtime; align descriptors and validate the integrated source.
- **Chose:** MethodSpec params/result use public Schema; unsupported nullable unions/length/pattern/format keywords become the established flat nullable/description forms, with existing runtime/canonical guards retained. Fixed a malformed schema expression, JSX closer and fixture template nesting. Read-only plugin validation found one command-argument blocker and two contract inconsistencies; window commands now declare workspace args, argument-free Create derives its active view workspace, required draftVersion is declared, and obsolete duplicate recovery with unsupported active:true is removed.
- **Why:** the loader rejects unsupported descriptors; a second schema dialect or fallback would hide a broken public contract. Input bounds and target/confirmation guards remain real server behavior.
- **Evidence:** manifest assembly failure; scoped ReviewSchemaAlignment audit; plugin-validator report67 methods/67 aliases and one blocking command contract; type-gate commits0b056214/c1e26455. No full-item green is inferred from those reports.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** protocol Schema explicitly grows a reviewed nullable/constraint feature.
- **Source:** locked by packages/protocol/src/schema.ts

## D17: Preserve and relocate a misdirected fixer patch before normal integration
- **Question:** how to handle a fixer that used relative paths in the parent instead of its assigned worktree?
- **Options:** silently accept parent edits; discard the useful patch; preserve and reattribute exact source before merge.
- **Chose:** stopped the task, confirmed the assigned tree initially had zero changes, and traced its actual four parent-file edits in history. Git's dirty-path list contained exactly those four files. Preserved the patch, verified baseline/fixed hashes, copied it to the declared component tree and restored only its same-run parent edits. The relocated four-path/unchanged-HEAD/exact-hash audit passed before normal commit and merge.
- **Why:** an advisory report cannot override the worktree boundary. No user change or unrelated file was discarded; the parent remained the integration owner.
- **Evidence:** scratch journal typeGateFixes.mislocation and relocatedAudit; exact four files detail/{methods,data}.ts and create/{methods,CreateReview}.ts(x); resulting component commitc1e26455. Parent-only Tasks dependency merge did not touch those files.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** another attribution gap appears; stop and establish provenance rather than widen scope silently.
- **Source:** assumed — autonomous

## D18: Keep transport fixtures isolated and real readiness proof on a real PTY
- **Question:** why did process workflows time out, use incompatible web globals, or fail to exercise an agent at all?
- **Options:** relax product deadlines/confirmation; keep a fake-PTY no-op and claim success; repair the test boundary and exercise real processes.
- **Chose:** finite native20-second bounds on the multi-RPC cases (no global or production timeout change), preserving callback formatting and every semantic assertion. DOM tests retain Bun transport/stream/timer/Abort primitives and flush React effects before awaiting effect-owned promises. Generation fakes use the exact Bun interpreter, exclusive fixture search directories and the real stdin prompt contract; cleanup precedes restoration of test env. Hosting fixtures default agent discovery to their owned fakebin. Duplicate recovery uses an explicitly controlled existing resource, not an incidental fixture default.
- **Why:** the observed five-second teardown interrupted legitimate workflows; Happy DOM replaced native I/O and Abort classes; an argv-only fake could not read Claude's stdin prompt. A fake PTY never executed the fake agent, so its supposed ready transition was not evidence.
- **Evidence:** create test failures and transport traces; canonical Claude oneShot.prompt=stdin; focused generation2pass/0fail; replacement agent-delivery.test.ts uses the existing owned real-daemon/real-PTY E2E harness and passed1test/8assertions, including no resolution on failure, exactly one real bracketed paste, and resolution only after successful delivery. The invalid fake-PTY delivery case was removed, not weakened.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the public agent prompt/delivery protocol or native test harness changes.
- **Source:** locked by LOOP.md isolated-state and behavioral-verification rules

## D19: Retain confirmed comment overlays until a provider read adopts them
- **Question:** why did a confirmed new comment disappear after a lagging refresh?
- **Options:** hide refresh failures; retry the mutation; acknowledge overlays only from provider reads.
- **Chose:** local rendering/optimistic merges no longer acknowledge their own confirmed overlay. Only a real provider result with the confirmed body can retire that entry; edit/delete overlays continue to reconcile the lagging list.
- **Why:** the immediate local list already contained the new comment and incorrectly deleted its overlay before the provider ever returned it.
- **Evidence:** actual detail regression8pass/1fail showed only original comment91 after successful add92; focused post-fix add/edit/delete lag regression passed1test/6assertions in8.54seconds. No assertion was removed.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** another mutation can acknowledge retained state from its own optimistic data rather than authoritative reads.
- **Source:** locked by hosting-ui.md stale-write and confirmed-comment retention requirements

## D20: Apply the locked night-mode skip to unstarted optional rounds
- **Question:** should the item start a new full adversarial review or user-dogfood campaign after the night-mode threshold?
- **Options:** start both campaigns; follow the explicit skip while finishing required checks and smoke proof.
- **Chose:** do not start the unstarted cross-family final review or full like-a-user dogfood campaign. Retain their unrun status explicitly; static plugin validation and focused API/CLI/real-PTY evidence are not relabeled as those rounds. Finish required affected tests/scripts/typecheck, an actual built-surface smoke, dependency readiness and normal landing.
- **Why:** canonical LOOP.md explicitly says an already-past-two-hour item lands as soon as its own tests/typecheck pass and skips review/dogfood not yet started. This changes verification scheduling, not the feature acceptance scope or blocker fixes.
- **Evidence:** branch orientation mergeb4ac5836 at2026-10-27T18:25:31-05:00, already after claiming; observed UTC clock2026-10-28T01:43:55Z. No final Gemini dispatch or likeuser begin occurred; only the web doctor ran.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** an exercised check or actual surface smoke identifies a blocker; fix it before landing.
- **Source:** locked by docs/loop/LOOP.md Night mode

## Progress
All three source components and scoped retries merged after barrier audits; original component/gate worktrees removed. Public plugin has67 methods/67 aliases; descriptors and command args aligned. Own Review source no longer appeared in the latest whole-repo compiler diagnostics;69 remaining errors were in pending Tasks/shared-read source and were sent to its owner. Focused detail lag, generation, auth/eligibility/workspace and actual real-PTY delivery paths have exercised evidence; full affected runner/scripts/typecheck and built-surface smoke still pending. Full Tasks parent runtime/helper checkpoint is required before final integration/land. Unstarted full final-review/dogfood rounds are explicitly skipped under D20, not claimed passing. Roadmap catch-up still not run; finish reachable gates, merge the dependency when ready, catch up once and land through queue.ts.
