# ui-final-review decisions

## D1: Publish a single Markdown comparison page, not a new UI implementation
- **Question:** Format, structure, density and interaction gray areas for the user's single look.
- **Options:** standalone custom HTML gallery; shared React gallery; repository Markdown page with local image pairs
- **Chose:** Markdown page with an area index, dark/light before/after pairs, full-resolution image links and a provenance manifest.
- **Why:** The item explicitly changes no code. Markdown introduces no local CSS/components, runtime, tokens or shipped controls. It is durable and viewable with repository-standard rendering.
- **Evidence:** docs/quirk/specs/2026-10-28-ui-redesign/logic.md:188,194-202; item queue title; ui-final-review logic spec.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** The page cannot present readable image comparisons in the repository viewer.
- **Source:** assumed — autonomous

## D2: Capture historical source where genuine before evidence was not retained
- **Question:** Versioning, evidence completeness and missing-state gray areas.
- **Options:** substitute approved goldens; omit missing before images; recapture genuine historical renderer source
- **Chose:** Historical source recaptures, explicitly labeled with exact commit and capture date, paired with final merged-source captures. Reuse old captures only with truthful source qualification. Never recolor images or portray an initial post-restyle defect as the original pre-restyle app.
- **Why:** EvidenceMap found useful post-restyle captures but no complete all-area historical baseline. The before state remains recoverable in Git. Goldens are conceptual references, not app output.
- **Evidence:** EvidenceMap source inventory; historical ui-screenshot-review finish 98dff3dc before shell/restyle lands; current item base49b9154a.
- **Reversibility:** easy
- **Confidence:** high for historical availability; runtime capture completeness must be observed
- **Revisit if:** A historical flow needs an unavailable dependency or native-only surface.
- **Source:** assumed — autonomous

## D3: Preserve build-first and no-code boundaries while gathering the requested evidence
- **Question:** Execution preflight, API contracts, model pairing, verification and source scope.
- **Options:** broad dogfood/tests/formal review; documentation and requested actual screenshots with lint/typecheck gates
- **Chose:** One combined self-reviewed logic/tech spec committed before work. OpenAI omp task workers gather disjoint before/after evidence using external throwaway harnesses only; parent assembles documentation and owns integration. No public signatures change. No reviewer probe/dispatched model, formal review round, suite, golden score or user approval claim under build-first. Preserve inherited untracked .serena.
- **Why:** LOOP build-first and queue title require this policy. Screenshot gathering is the deliverable, not an acceptance/scoring campaign. Dirty unrelated metadata is not ours to stash or commit.
- **Evidence:** git show build/roadmap:docs/loop/LOOP.md; approved parent scope; initial git status.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Authoritative loop policy changes.
- **Source:** locked by docs/loop/LOOP.md

## D4: Isolate historical and current captures and disclose native/platform boundaries
- **Question:** Runtime safety, missing/error states and platform coverage.
- **Options:** capture real personal workspaces; synthetic disposable fixtures and exclusively owned processes
- **Chose:** macOS renderer screenshots only, separate private HOME/QUIRKY_HOME/provider paths, synthetic credentials or disabled-provider fixtures, Keychain isolation, unique owned Chromium for Testing/Playwright profile and endpoint. No branded Chrome updater, real provider authentication/history or OS notification dialogs. Native-only Browser guest/OS chrome limitations remain explicit.
- **Why:** Provider Keychain and branded Chrome updater state can escape HOME isolation, as prior area logs record. Screenshot pages must not leak runtime credentials or claim native certification.
- **Evidence:** ui-restyle-accounts D6/D11/D15; ui-restyle-ask D6; ui-restyle-agents D12; ui-screenshot-review D2/D5.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Supported platforms expand or a required renderer view cannot be isolated.
- **Source:** deferred: platform

## Progress
Claimed exactly ui-final-review. Read authoritative LOOP, approved parent spec, relevant capture tooling and EvidenceMap inventory. All thirteen area groups including shell are enumerated in the combined spec; self-review complete. Next: commit spec/contracts, gather separate historical/current real screenshot sets without product-code edits, assemble local comparison page/manifest, catch up once, run UI lint/typecheck, then canonical land. No suites/reviews/dogfood run.
