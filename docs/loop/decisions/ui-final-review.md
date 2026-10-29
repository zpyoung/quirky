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

## D5: Reject intended-area loading captures and publish representative surfaces with explicit limits
- **Question:** What counts as area coverage when the dynamic capture helper reports success for a skeleton, or an old contribution mount no longer exists?
- **Options:** trust helper status as visual approval; repair product code; inspect actual pixels, replace transient candidates and map genuine current contributions
- **Chose:** Real before/after pairs for each rollout area and its named contributions, not a claim that every possible dialog or behavior passed. Reject the Tasks issue-list skeleton and unproved GPU-auto terminal candidates. Use actual Tasks Projects empty states and public GPU-acceleration-off PTY captures with visible output. Legacy sidebar-extras Source Control is now the Changes alias; its separators checkbox is visible in Settings. Checks belongs to Reviews, Structured belongs to Session, and repository presentation belongs to Worktrees. Do not invent missing standalone plugin panes.
- **Why:** The approved final-review row asks for every area; the separate acceptance/scoring tools own exhaustive behavior and golden approval. Loading screens cannot demonstrate the intended area. A required fixture input, no origin remote, absent transcript, or an obsolete capture selector is not permission to edit product code in this item.
- **Evidence:** Actual parent-inspected contact sheets and raw images; corrected Tasks Projects and real PTY image observations; ExtrasEntry source survey of tool-layout.ts and Worktrees ActivityFilters; before/after accepted manifests and separate rejected-candidate inventories.
- **Reversibility:** easy
- **Confidence:** high for the displayed states only
- **Revisit if:** A named rollout contribution has no genuine both-theme representation or the screenshots hide an intended-area loading state.
- **Source:** assumed — autonomous

## D6: Compute published image provenance from bytes rather than trusting worker metadata
- **Question:** Which evidence can support the artifact's integrity and source claims?
- **Options:** copy claimed counts/digests; validate source revisions and derive portable records from the actual image bytes
- **Chose:** Parent checks historical source HEAD and tracked-source diff, validates PNG dimensions and byte digests, copies unaltered selected PNGs into the artifact, and generates final relative-path provenance from those bytes. Source revisions are immutable capture points, not a claim that an earlier screenshot was taken after the final documentation merge.
- **Why:** The historical index contained one mistyped terminal-dark digest; actual-byte checking exposed it and the worker corrected the external index without launching anything. Current main-set audit found no digest/dimension mismatches. Absolute scratch paths and runtime credentials do not belong in the portable review artifact.
- **Evidence:** Historical source HEAD98dff3dcb07443154170ccf6cda583c5b0f0c060 with empty tracked diff; byte audit110historical rows and92current main rows; corrected actual terminal-dark SHA25642e23b8cc2a7b309c579e930930c4ff6fbf9d1d02afecc72d371221914a328ea.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** A copied image, source revision or manifest digest changes after the integrity check.
- **Source:** assumed — autonomous

## D7: Keep immutable capture attribution through the sole integration catch-up
- **Question:** Do end-phase changes arriving during capture require new product edits or relabeling the screenshots?
- **Options:** silently describe older captures as latest merge output; restart every area; preserve exact source labels and read the incoming authorities
- **Chose:** Sole planned catch-up to roadmap target07076f966a01d8be8c5e53505f52ed6013fad729, conflict-free. Read all14incoming decision logs including complete Progress and truncated long lines. Preserve their authority/privacy/native limits. Keep after89321c1e as the explicitly declared all-restyles-integrated capture point; do not claim later fixes are pictured.
- **Why:** Incoming editor ChangesSurface adds an accessible preview-error alert, but the displayed Changes examples are Git source-control/diff, not that error state. Vault changes search/scanner readiness rather than the shown layout. Other changes are test fixtures or nonvisual authority/lifecycle fixes. No actual attribution conflict or reason for a product-code change was found.
- **Evidence:** Incoming fix-test-browser D1–D12; editor D1–D19; handoff D1–D11; heimdall D1–D12; hosting D1–D6; loops D1–D11; mobile D1–D16; notifications D1–D12; orchestration D1–D18; session D1–D11; tasks D1–D9; terminal D1–D12; terminal-dock D1–D6; vault D1–D11 (all files suffix -1028.md). IncomingReviewConstraints read all14logs and four raw long lines; no edits by that scout.
- **Reversibility:** easy
- **Confidence:** high for revision attribution, not later behavioral fixes
- **Revisit if:** A consumer treats these images as proof of a later commit or a missing error/native state.
- **Source:** assumed — autonomous

## D8: Land documentation and original pixels with explicit verification boundaries
- **Question:** What actually supports delivery under the build-first no-code item?
- **Options:** infer visual approval from typecheck; run prohibited suites/review campaigns; record the exercised artifact and compiler checks only
- **Chose:** Publish index.md with140unaltered local PNGs:35surface comparisons across13areas, both phases and themes, plus a portable source/digest manifest. Parent inspected actual comparison sheets and key raw Browser, PTY, Loop setup, Projects, palette and Worktrees images. Artifact smoke found140unique image references, every required phase/theme cell exactly once, valid dimensions/digests, all relative links present, and no private path/credential pattern. Standalone UI lint and the caught-up root/mobile/prepared-desktop typecheck passed together in33.60seconds. No product source was edited.
- **Why:** These receipts prove image integrity, portability, actual captured states and compilation, not exhaustive behavior or golden approval. No local Markdown viewer was installed, so the repository viewer itself was not browser-verified; the image originals and page structure/links were checked directly.
- **Evidence:** docs/loop/reviews/ui-final-review/index.md and manifest.json; actual artifact audit output areas13/surfaces35/images140/uniquePageImages140/failures[]; bun run ui:lint and bun run typecheck exit0; three completed capture workers with owned-process cleanup awaited.
- **Reversibility:** easy
- **Confidence:** high for exercised checks only
- **Revisit if:** A renderer cannot display the standard Markdown tables/images or an image is modified after verification.
- **Source:** locked by docs/loop/LOOP.md

## Progress
Complete artifact assembled and integrity-checked; all three capture workers and scouts returned, all capture runtimes cleaned. Sole planned catch-up completed with all14incoming logs read. Standalone UI lint and full caught-up typecheck passed; no suites, formal review, broad dogfood, independent golden score, native run or Markdown-viewer browser verification claimed. All named rollout areas have genuine before/after dark/light representative surfaces; deliberately unpictured states are listed in the page and manifest. No product/script source edit or unbuilt-flow follow-up. Next: commit documentation/assets, detach and canonical queue land ui-final-review, then remove owned historical worktree/scratch and save final loop notes after the authoritative receipt.
