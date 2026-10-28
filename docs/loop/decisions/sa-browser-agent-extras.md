# sa-browser-agent-extras decisions

## D1: Recover extras onto the current core, not over it
- **Question:** Brainstorming scope/approach: restore all archived files, reimplement, or recover focused modules onto current code?
- **Options:** wholesale snapshot restore loses later pane/Watch fixes; fresh rewrite duplicates helper knowledge; focused recovery retains current invariants
- **Chose:** focused recovery from 1d05b63/build/sa-browser-agent-full-snapshot, three disjoint implementation components and one combined spec with technical contracts committed first.
- **Why:** current core gained exact-new-target binding, Watch lifecycle, safe profiles and design features after the archive. Source discovery/import remains explicitly deferred to this item.
- **Evidence:** sa-browser-agent D19/D21/D23/D26/D37/D38; sa-browser-profiles-settings D19/D22/D24; external browser.md command surface/Cookie import in detail; current service.ts/runtime/driver.ts.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** a recovered method cannot preserve exact target identity or current Watch behavior
- **Source:** assumed — autonomous

## D2: Resolve API, CLI, data and integration gray areas explicitly
- **Question:** What outcomes govern authentication/errors, input representation, overwrite policy, source access, concurrency and shutdown?
- **Options:** raw helper passthrough/global target/implicit @file expansion; current typed RPC and explicit data controls
- **Chose:** existing authenticated schema APIs/errors, scoped mutations and complete profile FIFO; literal inline strings plus explicit mutually exclusive named file/stdin modes; read-only source roots on explicit request only; exact identity/domain-family transactional replace with rollback/Google/partition exclusions; cancellable tracked imports drained at shutdown. Shared cookie types and dependency hooks committed before dispatch.
- **Why:** satisfies all six essentials: agent/API consumers, complete D38 scope, isolated credential model, concrete SC1–SC8 success criteria, safe failure/non-goals and preservation of existing conventions. No successful no-op fallback or plaintext restart staging.
- **Evidence:** external browser.md:208–261,391–435; architecture.md Browser; core C1–C6; combined logic spec.
- **Reversibility:** hard
- **Confidence:** high
- **Revisit if:** CDP cannot faithfully preserve a cookie identity or explicitly selected source cannot be read safely
- **Source:** locked by docs/architecture.md

## D3: Preserve later profile and identity ownership
- **Question:** Does archive profileSet/Delete or identitySet override the current preferences methods and native-completion guard?
- **Options:** restore conflicting methods; retain canonical methods and distinct page-profile operations
- **Chose:** retain current profileSet pane selection and guarded profileDelete/Clear; tabProfileShow/Set/UseDefault handle agent pages; clone targets empty isolated managed Chrome profiles. Identity reuses the current persisted setting/next-runtime behavior. Native deletion remains unavailable until its separate queued prerequisite is solved. Real import UI discloses Chrome versus Native engine destination.
- **Why:** sa-browser-profiles-settings D9 superseded invocation-only native clear. Restoring old profile deletion would silently violate that later binding ruling.
- **Evidence:** sa-browser-profiles-settings D9/D24; preferences/controller.ts; preferences-lifecycle.ts; combined spec SC4/SC8.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** supported native clear completion and isolated storage-root proof land in the designated owner item
- **Source:** locked by docs/loop/decisions/sa-browser-profiles-settings.md

## D4: Apply unattended build-first gates without inventing test evidence
- **Question:** Which process gates apply in this iteration?
- **Options:** run suites/review/dogfood now; follow build-first typecheck-only suite policy
- **Chose:** no user asks, research swarms, suite execution or review round; author behavioral acceptance/defect tests; three OpenAI omp task implementers maximum; parent typecheck and a focused throwaway real-path smoke for the higher-priority runtime-proof requirement, one roadmap catchup and canonical absolute queue land. No cross-family review pass is claimed or unnecessary backend probe performed when no reviewer is dispatched.
- **Why:** authoritative LOOP.md Build first, test at the end replaces the ordinary skills' review/suite gates; developer requires significant changed-path runtime verification.
- **Evidence:** git show build/roadmap:docs/loop/LOOP.md read at iteration start; task-specific combined spec and tool outputs.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** m7-test-triage has been claimed or a real type/runtime failure blocks the changed flow
- **Source:** locked by docs/loop/LOOP.md

## D5: Keep platform and sensitive-state verification bounded
- **Question:** Which platforms/native surfaces can be exercised safely?
- **Options:** inspect real browsers/Keychain/native Default; synthetic sources and owned headless Chrome
- **Chose:** macOS only, fresh ProcessScope homes, mock-keychain Chrome, synthetic source root/key fixtures and private headless clipboard; never real installed browser source imports/native Default. Linux/Windows source roots, secret-tool/DPAPI and process verification deferred.
- **Why:** loop locks macOS and forbids tests touching real state. Existing core source established the supported mock-keychain/nonbacked clipboard boundary.
- **Evidence:** sa-browser-agent D9/D28/D30; LOOP.md tests/platform rules; browser.md cookie formats.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** other platforms are authorized or Chrome stops honoring those isolated test boundaries
- **Source:** deferred: platform

## D6: Preserve the existing dependent import-UI item
- **Question:** Does this engine item also own import menus, source rows, file picker, badges and toast flows?
- **Options:** duplicate their implementation here; preserve the existing named queue slice
- **Chose:** preserve `sa-browser-profile-import-ui` (todo, depends on profiles-settings and extras). This item supplies real API/CLI import methods and JSON-cookie byte-source contracts; no new import UI. Existing UI validators may recognize imported metadata, while visible capability remains honest. Retain `tab profile set --pane`; page-level selection uses distinct `tab profile set-page`.
- **Why:** canonical queue already assigns the full UI integration to that dependent item. Current pane CLI owns its command words; duplicate registrations would conflict.
- **Evidence:** git show build/roadmap:docs/loop/queue.json exact two-item projection; current quirky-plugin.json CLI profileSet; BrowserExtrasSurface confirmed no UI edits had occurred before steering.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** queue ownership is explicitly changed
- **Source:** locked by docs/loop/queue.json

## D7: Integrate only audited component scopes and repair concrete assembly faults
- **Question:** What did the implementation barrier and first checks establish?
- **Options:** trust worker completion; integrate only declared paths and exercise the real public route
- **Chose:** all workers returned with HEAD c18fa91b unchanged; cookies6/runtime6/surface9 changed files were inside declared scopes, parent only its own6 paths. Committed 0ee442f2/ef24b4b5/11561664 and merged all three without conflicts; generated worktrees removed immediately. Parent original .serena untouched. Restore missing profileList service case and seven omitted core catalog registrations, retain as-const method typing, and preserve profile admission for openUrl.
- **Why:** first actual daemon smoke failed -32009 at eval because the recovered catalog omitted the core page-command row. First typecheck found missing BrowserPage/CookieTransport type imports and imprecise CLI/test projection types; repaired those at their source. No checker suppression or suite exclusion.
- **Evidence:** authoritative wave-boundary git outputs and worker reports; initial smoke homeRemoved:true; compiler31diagnostics4files; subsequent full root+mobile typecheck exit0/22.24s. Runtime smoke remains in progress, not called passing.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** final integrated smoke/typecheck exposes another concrete contract mismatch
- **Source:** assumed — autonomous

## D8: Map public property queries onto the pinned helper's actual wire protocol
- **Question:** Why did real get-value fail after commands were registered?
- **Options:** suppress helper failure or return page echo; use exact pinned native action/result fields
- **Chose:** get text/html/value/count/box maps to gettext/innerhtml/inputvalue/count/boundingbox with the actual result field (box is the returned rectangle); is-state maps to isvisible/isenabled/ischecked. No generic get/is wire action exists. Keep validation and projected ref resolution.
- **Why:** actual smoke returned native browser action get failed; pinned v0.27.0 commands.rs parse_get/parse_is and native/actions.rs handlers establish the vocabulary. Next smoke reached real CLI bulk data; its newline expectation exposed a single-line HTML-input fixture constraint, so use an actual textarea for multiline-byte proof rather than alter production data.
- **Evidence:** https://raw.githubusercontent.com/vercel-labs/agent-browser/v0.27.0/cli/src/commands.rs parse_get/parse_is; native/actions.rs handle_inputvalue/gettext/innerhtml/count/boundingbox; actual CLI/error receipts in this run. No permanent suite run or passing review claimed.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the pinned helper version changes wire/result semantics
- **Source:** assumed — autonomous

## D9: Repair the cookie canonicalizer and dynamic CDP event schemas at their source
- **Question:** Why did domain cookies fail sanitizing and actual HAR remain empty?
- **Options:** skip cookies/capture assertions; change cookie URL policy; repair malformed boundary adapters
- **Chose:** correct the double-escaped domain regex so `.example.test` serializes as `.example.test`, not `..example.test`. An attempted URL addition did not fix it and was reverted. Explicitly allow dynamic fields on console args/stackTrace, Network request/header maps and Fetch request maps while retaining their typed outer envelopes and consumed-field validation.
- **Why:** the observed sanitizing failure came from malformed domains. Actual HAR request collection rejected all nonempty nested request objects under the public Schema subset's default additionalProperties:false. This is the same boundary rule as core D36, not a reason to drop real records or weaken results.
- **Evidence:** actual source driver canonicalCookieDomain and EVENT_* schemas; runtime smoke initially reached cookie failure, then passed import/rollback/jobs and reached empty HAR; final actual daemon/CLI smoke EXIT0/2.23s, elapsed2151ms/homeRemoved:true.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** exact-identity or event-admission regression coverage fails during the designated end phase
- **Source:** assumed — autonomous

## D10: Separate changed-path proof from deferred suite and native assurance
- **Question:** What did this build-first iteration actually exercise?
- **Options:** infer whole-suite/native pass; omit failed receipts; record the bounded real paths and their limits
- **Chose:** source-reader smoke passed synthetic Chrome schema24 AES/host-digest decryption and Firefox SQLite, two detected sources, one injected key read only on import, source bytes unchanged and traversal refused. Final real daemon/CLI/owned Chrome smoke passed scoped input/storage; literal and explicit multiline file data/conflict exits0/0/2; Google-excluding JSON import and exact rollback; tracked file import succeeded; full PNG2616px/PDF bytes; real HAR2entries and Back; pending prompt answered exact Unicode out of band. No permanent suite, formal review or full dogfood campaign ran.
- **Why:** typecheck-only policy does not justify claims about unrun tests. Higher-priority changed-path/surface proof was a focused throwaway smoke, not the end-phase campaign.
- **Evidence:** source-smoke stdout SOURCE_SMOKE ok:true/chromeCookies1/firefoxCookies1/keyReads1; final SMOKE_REPORT ok:true/homeRemoved:true/2151ms; full root+mobile typecheck after roadmap EXIT0/25.42s. bun run build EXIT0/16.87s with existing missing-icon/release-URL warnings.
- **Reversibility:** easy
- **Confidence:** high for exercised behavior only
- **Revisit if:** the end phase finds a failing acceptance scenario
- **Source:** locked by docs/loop/LOOP.md

## D11: Verify imported metadata on the built Settings surface without claiming import-menu completion
- **Question:** Do real imported profile records still render in the existing UI?
- **Options:** inspect types only; start native Default; focused owned web surface
- **Chose:** a fresh isolated daemon imported a JSON cookie through the real engine into a newly created profile, then the built Browser Settings rendered Imported smoke profile with Remove and Default with Clear. Clicking Import Cookies disclosed the separately owned integration/API availability and Google exclusion, with no fake sources/success. Browser closed; supervisor exited0/homeRemoved:true. No Native guest/real-home Keychain/source import or OS clipboard used.
- **Why:** imported-scope/source records changed UI admission. Visible proof is separate from native storage and full application assurance.
- **Evidence:** screenshots omp-sshots-15b7ee407a1e73ab.png and15b7ee60149e73ac.png personally observed. Allowlist fixture produced one missing quirky.sidebar-extras setting pageerror in the unrelated worktree view; Browser Settings rendered and no whole-app clean-console pass is claimed. Initial scratch route used view rather than required id, failed -32602 and cleaned home; corrected public id route succeeded.
- **Reversibility:** easy
- **Confidence:** high for listed profile/disclosure rendering, no badge-menu/native parity claim
- **Revisit if:** the existing import-UI owner changes capability presentation
- **Source:** assumed — autonomous

## D12: Reconcile the single roadmap catchup without broadening Native or mobile authority
- **Question:** Do decisions landed during implementation override the extras contracts?
- **Options:** silently ignore incoming logs; restore archived Native/mobile behavior; read and preserve current owner boundaries
- **Chose:** one catchup to roadmap0ed9aa3931b35e97b002cec1becdc2a0cea9b174, merge3efb712e. Resolve only bun.lock's obsolete per-workspace React resolution conflict using incoming removal, then normal bun install; retain declared tldts7.4.16 and its license asset. IncomingBrowserBindings read all21 incoming logs completely and found no binding conflict. No Browser source changes arrived. Preserve all Native refusal/completion/root-isolation boundaries, exact Watch page/epoch/lock ownership, canonical Reviews routing and mobile method ceiling.
- **Why:** Native prerequisite items explicitly remain blocked absent supported host capabilities. Neither those logs nor mobile panels authorize importing native credentials or broadening remote phone authority.
- **Evidence:** incoming complete-read logs: fix-bash53-shell-integration; fix-terminal-dock-unfinished-flows-20261027; followup-m3-session-info-parity-20261027; m2-editor-complete-remaining-flows; m3-accounts-overflow-verification; m3-vault-parity-completion; m4-hosting-ui-review-browser-routing; m5-automations-dispatch-remote-and-args; m5-loops-ui-visible-stop-close-review; m6-heimdall-host-power; m6-orchestration-idle-pointer-shutdown; m7-sweep-automation; m7-sweep-orchestration; sa-browser-localhost-label-routing; sa-browser-native-identity; sa-browser-native-profile-clear-completion; sa-browser-pane-native-events; sa-browser-pane-native-host-controls; sa-browser-pane-workspace-preview; sb-mobile-app-panels; sb-mobile-install-links. Own caught-up root+mobile typecheck EXIT0/25.42s.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** the canonical merge-result typecheck exposes another source integration requirement
- **Source:** assumed — autonomous

## Progress
Ready to land exactly sa-browser-agent-extras. All three implementation workers and the reconciliation scout returned; all component scopes/HEADs audited and worktrees removed. D10/D11 name passing real-path/build/UI evidence and its limits; every smoke home was removed, owned UI/browser closed and supervisor exited0. Single roadmap catchup/reconciliation complete; current root+mobile typecheck passed25.42s. Permanent suites/review/full dogfood intentionally unrun under build-first policy. Existing import-UI/native prerequisite items retain all their named flows; no new deferral/follow-up. Next: commit final receipts, detach, canonical absolute queue land and await outcome; after success remove owned /tmp/quirky-browser-extras-lane5-bvwnJ2 and record notes. Inherited parent .serena untouched.
