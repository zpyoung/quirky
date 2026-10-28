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

## Progress
Shared read/public Markdown commit0a17328c integrated as a2245435; only extraBuiltins helper conflict reconciled. Parent canonical hosting/Git/Settings seams committed93747fc,71f73d6,292929bc with focused real-daemon/CLI proof. Checks return audit passed; Creation/Detail same-scope retries finish explicitly reported gaps. Parent shared state/env/UI/harness/native/spec docs exist, manifest assembly pending final component exports. No full-item build/typecheck/scripts/affected suite/review/web pass yet. Next: complete retries, authoritative barrier audit, assemble/merge source and full Tasks dependency, then required gates and one final review/web pass, single roadmap catch-up/dependency readiness and normal land.
