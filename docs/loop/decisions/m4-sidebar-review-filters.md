# m4-sidebar-review-filters decisions

## D1: Deliver only the M4 review-filter slice
- **Question:** which sidebar-extras flows does this item own?
- **Options:** rebuild all sidebar extras; implement review filters only.
- **Chose:** review filters flows1–3, their cache/stale safeguards, composition, badge, clear, persistence and scripting. Other extras are non-goals owned by M2.
- **Why:** roadmap explicitly places only review filters in M4 and both dependencies are done.
- **Evidence:** docs/roadmap.md:162–163,190–199; external sidebar-extras.md:68–75,122–126,147; queue deps ready:true.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** a named review-filter flow lacks coverage.
- **Source:** locked by docs/roadmap.md

## D2: Apply unattended night-mode defaults and one combined spec
- **Question:** how do brainstorming gray areas and review gates work without a human?
- **Options:** wait for questions; resolve from requirements and existing patterns.
- **Chose:** no asks; no visual/adhd/research swarm; one markdown logic spec with final technical contracts, self-reviewed. Select Visual interaction/error/empty states, API response/error, CLI flag/output and Integration cache mapping/refresh areas. Accept recommended existing-convention defaults documented in logic Decisions Locked.
- **Why:** authoritative LOOP.md night rules supersede the ordinary two-spec process and prohibit human questions.
- **Evidence:** git show build/roadmap:docs/loop/LOOP.md Night mode and Answering a skill's questions.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** operator changes night-mode policy.
- **Source:** locked by docs/loop/LOOP.md

## D3: Keep one daemon visibility result and add cache-only hosting read
- **Question:** where should review filtering run, and can existing forBranch be used directly?
- **Options:** renderer-only filters; call forBranch from projection; expose hosting-owned cache snapshot and extend extras projection.
- **Chose:** existing extras projection plus public cachedReviews. Cache snapshots are populated only by normal hosting lookup resolution; cache reads perform canonical/local git checks but no gh/auth/network. Preserve explicit-vs-inferred lookup provenance, current identity/head, configuration/environment/remote fingerprints, expiry and mutation generations. Unknown/stale stays visible.
- **Why:** renderer-only disagrees with API/CLI; forBranch resolves scope and fetches on misses. Cards do not yet resolve reviews in this sidebar, so no card-specific duplicated resolver is introduced.
- **Evidence:** plugins/quirky.hosting/src/pr-review.ts:514–529,564–685; env.ts:120–178; MapReviewFilters and CacheOnlySeam scout handoffs.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** a future card/provider supplies a richer normalized cache contract.
- **Source:** assumed — autonomous

## D4: Match conservative visibility and preserve activity-only hidden count
- **Question:** selected rows, merged-head mismatches, overlapping filters and clear behavior?
- **Options:** exempt selection from every filter; hide on any old known state; use only current resolved cache facts.
- **Chose:** activity exemption remains activity-only; either active review predicate can hide. Changed head/branch/instance invalidates snapshot. Explicit linked merged reviews with a different head cannot hide unless hosting already established their current relationship. hiddenCount stays activity-only, combined hiddenIds plus separate reviewHiddenIds/count. Activity recovery resets only activity; Clear resets All/off/off. Each enabled toggle counts1.
- **Why:** source review predicates have no selected exception and only activity-hidden rows contribute to the activity hidden message. Unknown checks are not green.
- **Evidence:** external sidebar-extras.md:68–75,118,122–126,147; existing projection.ts hiddenCount contract.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** acceptance exposes an inconsistent hidden count or retained stale result.
- **Source:** locked by sidebar-extras.md

## D5: Use OpenAI task implementers with verified Gemini fallback
- **Question:** which reachable cross-family reviewer satisfies the omp lane rule?
- **Options:** Opus; Gemini; same-family fallback.
- **Chose:** IMPLEMENTER=task; AUTHOR_FAMILY=openai; REVIEWER_ALIAS=gemini, high thinking. Maximum3 independent implementation components after shared contract commit. One final review round and blocking-fix batch.
- **Why:** actual pi-watch --check found Opus/Sonnet unavailable, Gemini and Flash reachable; no language servers configured. Existing inherited .serena/ and test-migrated.test.ts remain untouched and excluded by explicit staging; component worktrees start clean.
- **Evidence:** bg_2 preflight output (7/12 aliases ready); xd://lsp status; initial git status; LOOP.md omp pairing/night rules.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** reviewer dispatch fails and the recorded fallback ladder is needed.
- **Source:** locked by docs/loop/LOOP.md

## D6: Preserve client-local storage and macOS-only verification
- **Question:** flags, storage, unknown errors and platform boundaries?
- **Options:** global flags/new store; existing per-client strict boolean preference store.
- **Chose:** add two required returned preferences, optional set fields/CLI flags. Strict writes and ===true hydration; absent defaults false. Public calls only; no direct sibling-plugin imports. Ordinary hosting errors remain diagnosable while retaining review visibility. No native-only flow; Linux/Windows validation deferred.
- **Why:** source fields are pairing-local and default off; roadmap requires plugins/API/CLI and macOS verification.
- **Evidence:** external sidebar-extras.md:90–100,124; docs/roadmap.md:19–38,43–53,282–287; state.ts client store.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** supported platform/pairing ownership changes.
- **Source:** deferred: platform

## D7: Repair schema-subset and fixture defects without narrowing acceptance
- **Question:** what caused the first affected-suite, smoke and typecheck failures?
- **Options:** waive failing scenarios; enlarge the public schema language; repair new declarations and fixtures to existing contracts.
- **Chose:** remove unsupported maxItems/minLength/maxLength and nullable type arrays from the hosting declaration, retain handler bounds and description-only nullability; remove unsupported maxItems from the controlled cache fixture. Activate the lazy extras plugin before opening its corrupt-state fixture database. Add the test report's missing hiddenIds field and assert absent child-chip behavior without distinguishing null from undefined. CLI smoke uses established --flag=false syntax.
- **Why:** the manifest validator accepts scalar schema types and a fixed keyword subset; invalid declarations removed the entire hosting API. These were implementation/fixture defects, not reasons to weaken any review-filter flow.
- **Evidence:** first affected run49/59files passed; typecheck two TS2339 errors; real daemon first smoke unknown forBranch; packages/protocol/src/schema.ts:1–30,47–59; affected.log failure output in lane scratch.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the public schema subset gains genuine nullable unions or array/string bounds.
- **Source:** assumed — autonomous

## D8: Expire cached review visibility through hosting-owned one-shot events
- **Question:** how does a quiet sidebar stop hiding a row once its usable review snapshot expires?
- **Options:** ignore until another event; add sidebar polling; hosting-owned one-shot expiry notification.
- **Chose:** one earliest-expiry hosting timer, removing expired snapshots and publishing existing reviewCacheChanged events, with replacement/invalidation/disposal cancellation. No provider calls and no new polling loop.
- **Why:** plugin validation traced All plus Hide passing checks retaining the last renderer projection indefinitely after the cache TTL, while a fresh API projection would retain the row. Cache ownership is the correct expiration boundary.
- **Evidence:** plugins/quirky.hosting/src/pr-review.ts snapshot TTL/cachedForWorktree; plugins/quirky.worktree/src/useSidebarActivity.ts activity timer; ValidateReviewPlugins P2 finding (source-derived, not claimed runtime reproduction).
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a normal hosting event can supersede a newer snapshot or an expired row stays hidden.
- **Source:** assumed — autonomous

## D9: Preserve incoming editor contracts and existing refresh behavior
- **Question:** does the single roadmap catch-up or hosting refresh require extra scope?
- **Options:** change unrelated editor/refresh behavior; retain compatible incoming contracts.
- **Chose:** retain the clean M2 editor merge; scout read all D1–D44 and found no conflicts. Keep existing refresh.ts call semantics; its ordinary forBranch path populates snapshots, but it does not currently pass the private noCache option. No claim that every refresh forces noCache.
- **Why:** public API/report/freshness/process-isolation constraints align; modifying unrelated fetch pacing is outside the review-filter requirement.
- **Evidence:** git merge build/roadmap result; ReadIncomingDecisions handoff; hosting refresh.ts callPR; ReviewHosting handoff.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** an acceptance flow cannot populate a current snapshot through normal lookup/refresh.
- **Source:** assumed — autonomous

## D10: Verify the real daemon and a bounded guarded web campaign
- **Question:** what actual surface evidence covers the new user flows?
- **Options:** rely only on controlled API fixtures; exercise real hosting/extras/CLI and built web controls in disposable state.
- **Chose:** ProcessScope-owned real daemon plus isolated HOME/QUIRKY_HOME and controlled upstream gh executable; normal hosting lookup populated real snapshots, while filter toggles/projections/CLI made no additional gh/auth calls. Web dogfood used the real daemon URL, web/yours/unattended, seven guarded actions.
- **Why:** the smoke proved combined API visibility and generated CLI flags; RF01/RF02/RF04 visibly proved independent toggles, conflicting-row retention, badge1/3, and Clear restoring All/off/off/badge0.
- **Evidence:** scratch smoke.ts completed exit0 and removed its home; normal lookup9gh invocations unchanged during projection/CLI; .quirk/using-apps-like-a-user/runs/20261028T004455-f045/report.md: three pass, no findings/gates, no overrides, nothing kept open, no cleanup errors.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a new UI flow changes control behavior; cache expiry event correctness is independently exercised by the hosting regression.
- **Source:** assumed — autonomous

## D11: Close the single final review round without unverified clearance claims
- **Question:** which findings survive the required cross-family correctness/compliance/failure review?
- **Options:** treat every promoted claim as true; use independent refutation and deterministic gates on the fixed source artifact.
- **Chose:** Gemini high, standard-depth promote/fresh-refute for C/S/X over the three changed plugins. All three gates PASS with zero retained blocking/advisory findings, limitations or questions. C1 was refuted because null account and absent binding both normalize to null. X1 was refuted because its quoted location did not contain the claimed loop; its unmeasured latency assertion did not establish the proposed HIGH severity. S promoted no claims.
- **Why:** only reproducible/source-resolved claims justify a blocking fix. Both raised claims were suppressed (2/2), so this is explicitly limited assurance, not a clean-bill/completeness claim. The fixed scope excludes incoming editor code, author rationale and lockfile content; no source changed during review.
- **Evidence:** target075de4d..e405617b; artifact3e11610dacc01b3372c4a11826baa839eda7416a41209d8d6f560d8425ec225b; C/S/X gate and manifest outputs in lane scratch. S refutation initially failed before dispatch on OS argv size; retry used the same source-only artifact instead of an empty-claims full-range fallback. The retry completed as a real fresh dispatch; no JSON or verdict was fabricated.
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** an actual consumer workload exposes latency or another evidence-backed defect.
- **Source:** assumed — autonomous

## D12: Preserve truthful verification scope and retain consumer-visible regression assertions
- **Question:** what proves the corrections after the first two affected-suite failures?
- **Options:** rerun unchanged checks repeatedly; claim a failed suite green; rerun only the corrected remaining file plus typecheck, then use the full landing gate.
- **Chose:** second affected suite passed58/59files, including hosting expiry/replacement and worktree UI tests. Its only remaining failure was a new incidental negative diagnostic pin: an empty head correctly reported malformed data. Deleted that pin while retaining all conservative visibility/reason assertions. Live final prepass then passed the corrected file (4tests/92assertions) and full typecheck. Build passed; scripts passed68tests/532assertions. Full integration verification belongs to queue.ts land.
- **Why:** the test-only correction cannot change production behavior, and pinning incidental error absence would contradict the diagnostic contract. No59/59 single-run claim is made.
- **Evidence:** affected-fixed run58passed/1failed; e405617b test-only correction; live prepass tree7a043dc3cfd1844ebe206679708a580d2753e4e8 command exit0; build-fixed exit0; scripts exit0.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the full landing gate reports an affected regression.
- **Source:** assumed — autonomous

## Progress
Implementation, scoped fixes, one roadmap catch-up, source contract validation, real daemon/CLI smoke, all three guarded UI goals, and one final cross-family review round are complete. All workers and runtime/browser smoke processes returned; disposable runtime home removed. No accepted blocking finding remains. Ready for the normal detached queue.ts land m4-sidebar-review-filters gate. Native-only scenarios: none. Inherited .serena/ and test-migrated.test.ts remain untouched.
