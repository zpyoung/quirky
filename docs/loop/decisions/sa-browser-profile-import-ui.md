# sa-browser-profile-import-ui decisions

## D1: Reuse the real importer and one shared tracked-job UI
- **Question:** Brainstorming domain/approach and six essentials: who consumes this, which flows, what state and success boundary?
- **Options:** independent menu/settings imports; synchronous RPC; shared panel over tracked daemon jobs
- **Chose:** shared panel over detectBrowsers/importStart/importGet, all named menu/hint/Settings/file/badge/toast flows, explicit destination and visible managed Chrome boundary.
- **Why:** real engine and public CLI already landed; this item owns only the human integration. Jobs expose long-running progress and terminal failure without keeping React alive.
- **Evidence:** browser.md section2 and391–435; sa-browser-agent-extras D2,D3,D6; cookies/types.ts; quirky-plugin.json116–120; architecture.md180–203.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** job/result schema or engine destination changes
- **Source:** locked by docs/architecture.md

## D2: Resolve visual, data and integration gray areas without a person
- **Question:** Loading/empty/errors, selection density, profile mapping, auth, replacement confirmation, file input, concurrency, warnings and source access?
- **Options:** startup detection, guessed paths, unconfirmed mutation and generic success; explicit source opening and selected bytes with captured destination
- **Chose:** compact existing React controls, loading/empty/error distinct, detected-only source/profile rows, browser file picker plus JSON bytes, replacement confirmation, single-flight UI, cleanup-fenced results, real terminal summary and warning/error toasts, metadata refresh and badges. No cookie values in messages.
- **Why:** source doc requires explicit detection and Google exclusion; browser file input does not grant a daemon-side path; profile changes must not retarget credentials. Existing engine serializes mutations and owns rollback.
- **Evidence:** browser.md18,80–85,406,413–435; preferences-window shared/menu/settings; cookies/importer.ts214–337.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** actual focused UI smoke identifies unavailable chooser/API behavior
- **Source:** assumed — autonomous

## D3: Follow unattended build-first process and isolate implementation
- **Question:** Which skill review/test/approval and backend-pair gates apply?
- **Options:** wait for a person or run full campaigns; apply authoritative LOOP overrides
- **Chose:** no asks, research swarms, tech.md, review rounds or permanent-suite execution; combined self-reviewed spec; commit shared contracts before at most two disjoint omp OpenAI implementers. No review pairing/probe is claimed when no reviewer runs. Parent typecheck and developer-required focused isolated runtime/surface proof, one roadmap catchup then canonical absolute queue land.
- **Why:** latest LOOP explicitly overrides ordinary skills during build-first. Developer still requires exercised behavior. Foreign untracked .serena is left untouched and outside every worker scope; owned workers begin clean in external worktrees.
- **Evidence:** authoritative LOOP read via git show; initial git status; xd://lsp references attempted and returned no server, so grep enumerated all PreferencesState/ImportDetails/capability consumers.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** end-phase triage is claimed or a real check fails
- **Source:** locked by docs/loop/LOOP.md

## D4: Preserve native and platform boundaries
- **Question:** Can this item promise Native/paired-host imports, or exercise installed credential stores?
- **Options:** extend native/remote engine; preserve managed local Chrome and synthetic owned source boundaries
- **Chose:** local managed Chrome only, explicit Native exclusion; no host picker implying remote support. Verify with owned temporary homes, synthetic files/source roots and mock-keychain Chrome only. Linux/Windows source/chooser/native integration deferred to platform verification.
- **Why:** architecture separates engines; extras D3/D5/D12 retain native isolation and phone ceilings. This item cannot manufacture missing native APIs.
- **Evidence:** architecture.md180–203; sa-browser-agent-extras D3,D5,D12; sa-browser-profiles-settings D9.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** public native or host-owned credential import capability is explicitly authorized
- **Source:** deferred: platform

## Progress
Requirements and prerequisite map complete. Combined spec self-reviewed. Next commit shared contracts/capability, dispatch two disjoint implementation components, integrate, typecheck and focused actual-surface proof; catch up once, read incoming decisions, commit/detach/land. No tests or review campaign run.
