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

## D5: Repair actual wrapped-menu anchoring instead of bypassing hit tests
- **Question:** Why did the real Browser menu import button fail with covered-by-input after Settings imports worked?
- **Options:** force a DOM click; widen the window; fix the popover's containing block
- **Chose:** position the profile menu against the toolbar, not its wrapping summary; constrain width to the pane. Keep actual pointer hit testing. Parent owns the small BrowserPaneWindow.tsx style/class fix beyond the two original worker scopes.
- **Why:** the toolbar wrapped the summary to its left edge, while right:0 plus420px minimum anchored the menu atx=-64.55 behind the sidebar. A one-variable live geometry hypothesis moved it inside the pane; shipped-source rebundle/reload reproduced the correct position without injected style.
- **Evidence:** actual UI before toolbar left240/popover left-64.55/right355.45; shipped after pane240–1236/menu249–669, direct Import Cookies click works; screenshot omp-sshots-15b7f609d3892f99.webp.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a narrower/split toolbar places import controls outside its owning pane
- **Source:** assumed — autonomous

## D6: Separate focused real-path evidence from unrun suites and OS chooser assurance
- **Question:** What actually ran and which receipts justify landing?
- **Options:** infer broad/native parity; disclose precise exercised paths and native handoff
- **Chose:** both OpenAI workers returned unchanged09f8f41c HEADs; audited two new panel files and four entrypoint paths only, parent committed efac49f8/bd2921d7 and merged; both worktrees removed. Initial root+mobile typecheck exited0 in36.72s. Web bundle built25plugin UI modules. Actual daemon/owned Chrome UI: selected nondefault Import Review, explicit Firefox2source profiles, invalid JSON produced error/no jobs; selected JSON confirmation produced1imported/1Google skipped/2total plus real warning, successful job and JSON badge; Firefox Work confirmation produced1imported/0skipped/1total, persisted Firefox Work badge. Default stayed untouched. Menu and hint both named Import Review; Hide Hint removed the hint; fixed menu screenshot and clean post-reload page errors observed.
- **Why:** permanent acceptance tests were authored but intentionally unrun under build-first. Runtime proof uses only owned synthetic sources and mock-keychain Chrome. First fixture symlinked browser dist outside its plugin root, correctly refused by static serving; copying owned dist into fixture resolved that setup error, not an application authorization change.
- **Evidence:** real jobs b0b7ccf7-f4ae-4fb5-87b4-e5b5c630a653/cd33879d-0aca-409f-8bcb-a53ca56b0f59 both succeeded for profile_50b331d7a6284392b200bd448cb88d27; screenshots omp-sshots-15b7f51d7f892f95.webp,15b7f529bf092f96.webp,15b7f609d3892f99.webp. Supervisor l11-browser-import-ui exited0, cleanup/homeRemoved/scratchRemoved alltrue; managed browser tab closed. Final native chooser interaction/focus is pending docs/loop/native/sa-browser-profile-import-ui.json, not inferred from uploadFile.
- **Reversibility:** easy
- **Confidence:** high for exercised flows only
- **Revisit if:** end-phase suites or native chooser scenario fail
- **Source:** locked by docs/loop/LOOP.md

## Progress
Implementation and focused actual-surface smoke complete; permanent suites/review/full dogfood unrun. Contracts09f8f41c and both components merged, worktrees removed; D5 includes verified wrapped-menu fix, D6 records runtime/cleanup receipts. README and one pending native chooser scenario updated. Next: commit receipts, exactly one roadmap catchup and read incoming decision logs, rerun root+mobile typecheck, detach and canonical queue land. No added follow-up: every named implementation flow ships within existing local managed-Chrome authority.
