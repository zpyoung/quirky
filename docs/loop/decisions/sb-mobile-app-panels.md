# sb-mobile-app-panels decisions

## D1: Own every enumerated panel and direct-host notification flow
- **Question:** what does this queue slice include?
- **Options:** mobile foundation again; only static panels; all enumerated flow8 and notification consumer flows.
- **Chose:** mobile Source Control/Review/Files/Tasks/Accounts/History/resume and Notifications consumer flows, on LAN/tailnet. Reuse sb-mobile-app foundation; never duplicate transport or imply nonexistent provider/background-push delivery.
- **Why:** queue title and mobile.md enumerate these flows. API feature owners remain authoritative.
- **Evidence:** queue.ts wait --lane4; mobile.md flow8, Notifications and push, Notifications settings.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** authoritative queue scope changes.
- **Source:** locked by docs/loop/queue.json

## D2: Resolve all relevant gray areas using source-grounded defaults
- **Question:** layout/density/loading/empty/errors/interaction, response/auth/pagination, storage/idempotency and retry/mapping/conflicts.
- **Options:** wholesale Orca port; desktop-panel embedding; thin phone route modules using existing public APIs.
- **Chose:** thin phone route modules with exact Quirky contracts, Changes/Pull Request/Commits tab order, per-host/worktree state, explicit stale/error/empty states, confirmation guards, bounded responsive sheets, no mutation replay and no secret transfer. Detailed default answers and acceptance examples are in logic.md.
- **Why:** source verified phone behavior and existing encrypted bridge preserve one API and existing ownership. Copying upstream would introduce incompatible RPC/cloud/legacy behavior.
- **Evidence:** docs/quirk/specs/2026-10-28-sb-mobile-app-panels/logic.md; docs/architecture.md:298-301; mobile.md:153-182,429-438,500-506.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** real built phone surface disproves usability or bridge feasibility.
- **Source:** assumed — autonomous

## D3: Use night-mode autonomous workflow and isolated implementations
- **Question:** how to apply normal skills unattended with a live early dependency?
- **Options:** human/research/spec gates; autonomous combined spec/contracts and at most three workers.
- **Chose:** no human asks, no research swarm, one combined self-reviewed spec, commit shared contracts first; three disjoint component worktrees and absolute-path-only tools. Parent owns shared integration after dependency arrives. Catch up once before land; one final cross-family review/fix batch; required real smoke and UI dogfood.
- **Why:** authoritative LOOP night rules and prior mobile contamination lessons.
- **Evidence:** git show build/roadmap:docs/loop/LOOP.md; sb-mobile-app D3; sb-mobile-daemon D11.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** loop instructions change.
- **Source:** locked by docs/loop/LOOP.md

## D4: Pair OpenAI omp workers with Gemini reviewer
- **Question:** which reachable cross-family reviewer?
- **Options:** opus; Gemini; same-family fallback.
- **Chose:** IMPLEMENTER=omp-task, AUTHOR_FAMILY=openai, REVIEWER_ALIAS=gemini; three concurrent implementers maximum.
- **Why:** actual pi-watch --check opus exited5 with0/8 shipping/authenticated candidates; --check gemini exited0 google/gemini-3.1-pro-preview:high.
- **Evidence:** this iteration reviewer probes; xd://lsp status reports no configured language servers.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Gemini dispatch cannot run.
- **Source:** assumed — autonomous

## Progress
Claimed item, created build/sb-mobile-app-panels from build/roadmap and merged current sb-mobile-app contracts/spec. Dependency still in progress on lane5. Design and combined spec self-review complete; commit panel contracts/spec/decisions next, then dispatch three disjoint components. Lane5 coordination accepted input, delivery unproven. Inherited untracked .serena metadata untouched. No implementation/test claims yet.
