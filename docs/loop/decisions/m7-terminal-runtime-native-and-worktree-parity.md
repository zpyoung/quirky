# m7-terminal-runtime-native-and-worktree-parity decisions

## D1: Preserve the complete inherited obligation and extend existing owners
- **Question:** What is the scope, and which implementation approach should autonomous brainstorming select?
- **Options:** Replace existing authorities; treat old non-goals as exemptions; extend existing public owners and account for every inherited flow.
- **Chose:** Extend current owners. The full predecessor disposition ledger and assigned queue title remain the acceptance inventory. Reconcile later shipped owners before coding; no declaration of exhaustive terminal parity from a bounded landing.
- **Why:** The roadmap requires every source flow and no source defects, while LOOP permits one implementation-only successor for genuinely unbuilt flows. Existing stores/resolvers/identity authorities must not diverge.
- **Evidence:** docs/quirk/specs/2026-10-28-m7-sweep-terminal-completion/logic.md:62-94; docs/roadmap.md:13-56; queue wait lane11 returned this item.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** Current source shows a later owner already implements a ledger row.
- **Source:** locked by docs/loop/LOOP.md and docs/roadmap.md

## D2: Resolve API, CLI and integration gray areas with exact caller and target identity
- **Question:** Which error/output/authentication/selection/conflict defaults are safe across Ask, providers, remote runtimes and worktrees?
- **Options:** Infer identity or execute locally; expose typed refusal; preserve authenticated caller and exact owner through public APIs.
- **Chose:** Preserve authenticated caller/session/incarnation/dispatch identity. Namespaced schema-declared APIs drive both CLI and UI. Local commands keep current usage/runtime exit codes. Explicit remote selection never falls back locally, and ambiguous/stale/unknown owner evidence refuses. Nonempty authoritative model discovery alone may retire saved choices; a failed/empty probe preserves them. Raw arguments retain canonical resolver precedence. Never use terminal status as question/approval authority.
- **Why:** The source feature docs and inherited decisions distinguish absent capability from success; identity spoofing or a second launch/status machine would violate the plugin boundary and consumer expectations.
- **Evidence:** cli.md Remote runtimes and Caller identity; ask.md Server registration routing and Hand-off; launch-settings.md Model retirement; predecessor D4,D6,D14.
- **Reversibility:** hard
- **Confidence:** high
- **Revisit if:** A supported new host/provider capability provides stronger evidence.
- **Source:** locked by docs/architecture.md; assumed — autonomous

## D3: Resolve visual, data, lifecycle and recovery gray areas without hidden authority
- **Question:** How should navigation, filtering, loading/errors, native controls and persistent state behave?
- **Options:** UI-only state or optimistic success; duplicate metadata; reuse owner persistence and explicit loading/empty/error/refusal states.
- **Chose:** Owner-persisted state, readable scriptable commands, stable identities/order and explicit recovery. Hidden rows/counts remain discoverable; selecting sleeping workspaces wakes only their views, never restarts or stops processes. Cleanup rechecks canonical dirty/liveness/removal safety. Inactive views unmount, preserving PTY history and editor leases. Native SDK operations require a public shell bridge; no private FFI, browser prompt substitute, fake notification acknowledgement or invented signing identity.
- **Why:** Source worktrees.md separates sleep from destructive removal; architecture requires visible-only views and plugin API growth, not private imports. Pinned SDK exposes directory selection but no notification permission/click/dismiss utility hooks.
- **Evidence:** worktrees.md:129-198,292-299; term-ui.md tabs/settings; predecessor D6,D9; sa-browser-pane-native-host-controls D3,D6.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** Supported native hooks or signed distribution prerequisites become available.
- **Source:** locked by docs/architecture.md; assumed — autonomous

## D4: Use contract-first, three-component unattended build-first execution
- **Question:** How do the skill approval/research/review/testing gates apply?
- **Options:** Human questions/research/review swarms; autonomous defaults with scoped implementation; skip evidence entirely.
- **Chose:** No human questions, visual companion, adhd, research swarm, suite, formal review or dogfood campaign. One source-mapping scout; one self-reviewed logic spec with final technical contracts, committed before at most three independent omp task implementers. IMPLEMENTER=omp task, AUTHOR_FAMILY=openai; eventual cross-family reviewer preference Opus, no availability or pass claimed. Preserve foreign untracked .serena/. No configured LSP server (status attempted). Parent performs typecheck and developer-required disposable changed-path runtime smoke, catches up once immediately before land, and reads incoming binding decisions.
- **Why:** Authoritative LOOP build-first section overrides the normal skill workflow; higher-priority behavioral verification still requires narrow exercised proof. No test/review/debug successor is allowed.
- **Evidence:** git show build/roadmap:docs/loop/LOOP.md; xd://lsp status returned no language servers; initial git status.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** End phase starts or authoritative loop policy changes.
- **Source:** locked by docs/loop/LOOP.md

## D5: Preserve platform and later feature ownership boundaries
- **Question:** Which existing phone/Browser/editor/automation/orchestration flows must not be rebuilt?
- **Options:** Recreate overlapping features; treat related features as equivalent; retain exact existing owners and build only distinct missing composition.
- **Chose:** Retain landed phone panels/foreground notifications/terminal-artifact grants, immutable automation provenance and sidebar filters, Browser agent/import/routing controls, editor resource leases, host-power/shutdown fencing, dock and existing native clipboard owner. Interactive native chat/voice and provider-owned remote execution remain governed by their own explicit exclusions/prerequisites. GitLab/Bitbucket/Gitea/Azure hosting, Objective runner and PR sitter exclusions remain. Build/smoke on macOS only; Linux/Windows/WSL install/hook/native behavior is not claimed.
- **Why:** A similar feature is not the requested missing flow, and overlapping ownership would fork authority. No operator-controlled signing/service credentials can be invented by this loop.
- **Evidence:** predecessor D7,D13,D14; sb-mobile-app-panels-unbuilt-flows D1-D5,D8,D11; docs/architecture.md Decisions.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** Later landings change the exact public owner contracts.
- **Source:** deferred: platform

## Progress
Claimed and oriented. Source feature docs, predecessor spec/decisions and locked architecture/roadmap read; targeted scout maps current seams. Next: settle concrete contracts, commit combined spec/shared DTO/schema signatures, dispatch at most three disjoint implementers. No tests, product smoke or typecheck run yet. Do not end before landing or blocking this item; do not claim another item.
