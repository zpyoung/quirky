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

## Progress
Claimed item; dependencies ready. Brainstorm defaults and combined logic spec self-reviewed. Shared cache-result type and public cache method schema committed before dispatch. Next: three disjoint implementation components (hosting cache, extras API/projection, worktree UI), integrate after barrier, run targeted/affected tests, one Gemini review, web dogfood and real daemon/CLI smoke, catch up once then land. Scratch /tmp/quirky-review-filters-lane7.78cxh2. Never stage inherited untracked paths.
