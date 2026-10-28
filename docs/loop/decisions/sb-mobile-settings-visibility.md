# sb-mobile-settings-visibility decisions

## D1: Diagnose the narrow desktop Settings observation
- **Question:** what scope and success criteria should brainstorming use?
- **Options:** desktop Settings reachability only; redo the whole Mobile feature; treat the working standalone page as sufficient.
- **Chose:** desktop Settings at 1280×720, before/after QR expansion, scrolling, keyboard access and actual revoke.
- **Why:** this queue item exists because the alternate page did not resolve Settings reachability.
- **Evidence:** sb-mobile-daemon D22; external feature doc mobile.md flows 2 and 10; roadmap.md Side track B.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** evidence identifies another owner as essential to the same flow.
- **Source:** locked by docs/loop/decisions/sb-mobile-daemon.md

## D2: Preserve layout, density, loading, empty and error behavior unless clipping reproduces
- **Question:** which Visual gray areas need a behavior change?
- **Options:** preserve and measure; add a nested Mobile scrollbar; reorder devices before pairing.
- **Chose:** preserve and measure, then fix only the demonstrated owner if necessary. Existing empty/error/loading outcomes remain.
- **Why:** the host already declares overflow; previous evidence does not establish an app CSS defect.
- **Evidence:** packages/ui/src/styles.css:1149-1160; plugins/quirky.mobile/src/window/MobileSettings.tsx:142-207.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** correct wheel targeting still cannot reach the device action.
- **Source:** assumed — autonomous

## D3: Separate wheel and keyboard focus from guarded-driver outcomes
- **Question:** what interaction evidence distinguishes clipping from targeting?
- **Options:** trust tree presence or automatic scrollIntoView; measure and exercise real inputs; infer a bug from PageDown alone.
- **Chose:** real wheel over visible Settings content and ordinary keyboard focus/navigation, with screenshots and read-only geometry. Guarded-driver outcomes reported separately.
- **Why:** keys sent to inputs and wheel events sent outside the scroller have different recipients; none alone proves unreachable content.
- **Evidence:** sb-mobile-daemon D22; using-apps-like-a-user see-first contract.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** guarded evidence and independent browser interaction disagree.
- **Source:** assumed — autonomous

## D4: Use only a real run-owned encrypted peer and isolated runtime
- **Question:** what fixture and permissions can make revoke safe and representative?
- **Options:** mutate the registry; revoke a real phone; create one encrypted peer against a fresh daemon.
- **Chose:** fresh HOME/QUIRKY_HOME, real production daemon, real encrypted pairing, and owned cleanup; only setup may call APIs outside the UI.
- **Why:** no real user/provider state may be touched, and fake rows cannot prove the actual revoke flow.
- **Evidence:** docs/loop/LOOP.md test-isolation rule; plugins/quirky.mobile/test/support/client.ts; packages/daemon/src/daemon.ts.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** startup cannot isolate native/provider state.
- **Source:** locked by docs/loop/LOOP.md

## D5: Record cross-family fallback and investigation-first execution
- **Question:** which execution/review pairing and decomposition fit this item?
- **Options:** omp tasks plus opus; omp tasks plus available cross-family Gemini; speculative implementation before diagnosis.
- **Chose:** OpenAI omp task workers; Gemini cross-family reviewer after opus probe failed. One diagnostic slice, then at most one bounded fix slice if evidence requires it. Parent owns all checks; workers skip build/lint/test.
- **Why:** opus --check returned no authed/shipping model; gemini --check returned google/gemini-3.1-pro-preview:high. Small investigation does not need parallel source writers.
- **Evidence:** observed pi-watch preflight outputs in this iteration; source mapping scout returned without mutations.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** actual reviewer dispatch fails.
- **Source:** assumed — autonomous

## D6: End-phase verification and two markdown specs apply
- **Question:** which loop mode applies after the lane's prolonged busy wait?
- **Options:** earlier build-first restrictions; normal end-phase workflow.
- **Chose:** normal verification: m7-test-triage was observed claimed on lane 8 before this item was assigned. Write logic.md and tech.md, self-review, cross-family spec review, actual UI exercise and required checks. No human prompts or external research swarm for this narrow diagnostic.
- **Why:** authoritative LOOP.md restores the normal workflow once triage is claimed. A no-defect investigation should not manufacture implementation or permanent tests.
- **Evidence:** canonical wait bg_52 reported m7-test-triage in-progress lane 8; bg_53 assigned this item.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** authoritative loop policy changes.
- **Source:** locked by docs/loop/LOOP.md

## Progress
Claimed and branched from current build/roadmap. Read historical evidence, feature requirements and locked architecture/roadmap rules. Logic and tech specs authored and self-reviewed. Runtime setup worker preparing an isolated actual daemon/pairing runner; parent next reviews specs and builds/runs the UI reproduction. No production mutation justified yet.
