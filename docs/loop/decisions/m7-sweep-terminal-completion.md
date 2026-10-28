# m7-sweep-terminal-completion decisions

## D1: Follow build-first policy with exhaustive parity accounting
- **Question:** Which workflow governs this completion and its large inherited inventory?
- **Options:** Run all historical reviews/suites; omit inherited gaps; implement independent flows and record every remaining flow under LOOP's single successor rule.
- **Chose:** Build first, tests written but not run, no reviews/dogfood campaign, typecheck gate, one catch-up. Exactly one queue item. Use one permitted successor only for unbuilt flows, never verification/debug tasks.
- **Why:** Authoritative LOOP explicitly moves testing/debugging to m7-test-triage and permits one unbuilt-flow follow-up. The parent inventory is exhaustive; completion is not a parity-complete claim.
- **Evidence:** git show build/roadmap:docs/loop/LOOP.md; parent logic.md audit inventory; canonical queue wait --lane 9.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** End phase has begun or a locked requirement conflicts.
- **Source:** locked by docs/loop/LOOP.md

## D2: Reuse existing authorities in three independent vertical components
- **Question:** Which approach preserves API, data and integration gray-area invariants?
- **Options:** Replace state machines; create UI-only features; extend current public owner APIs.
- **Chose:** Q owns ask presentation/notification lifecycle; D/S owns Dashboard and agent Fork/resume; W owns stock worktree options and safe sleep/cleanup. Three disjoint scopes, no cross-component prerequisites; parent commits all types/spec first.
- **Why:** Existing Ask, Activity, agent resolver and worktree removal already carry durable identity/safety. A second store/launcher would diverge. The current single scout mapped explicit owner paths, not external research.
- **Evidence:** TerminalCompletionMap; plugins/quirky.ask/asks.ts; agent-status/src/activity.ts; agents/src/service.ts; worktree/src/daemon/remove.ts.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** A necessary public capability cannot be added safely within its scope.
- **Source:** assumed — autonomous

## D3: Choose disclosed hidden state and inert previews
- **Question:** Visual/error/attention defaults and data precedence?
- **Options:** Hide acknowledged completions as idle; show total of visible cards only; retain completed state and disclose hidden idle. Render trusted HTML; sandbox untrusted output.
- **Chose:** Completion stays Done regardless of acknowledgment, total includes hidden idle, filters are scriptable. Ask previews are inert sandboxed rich content; actual terminal envelope summary flashes four seconds; delayed unattended notification cancels on focus/resolution and never steals terminal focus.
- **Why:** Avoid source Orca hidden-idle zero-total defect and preserve explicit ask UX/security requirements.
- **Evidence:** agent-status.md Dashboard observations; ask.md preview sandbox, right-sidebar focus, escalation and result summary sections; spec Q1-Q3/D1-D2.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** New provider/surface evidence requires a different observable outcome.
- **Source:** locked by research/orca-features/ask.md and agent-status.md

## D4: Preserve native and remote capability boundaries
- **Question:** Can absent shell/host capabilities be faked to close parity?
- **Options:** Private native FFI/Chrome substitution; silently execute locally; explicit unsupported prerequisite.
- **Chose:** Supported public API only; exact owner or refusal. No new native/private patch, no local fallback for remote. Distinct unbuilt native/remote flows remain in the disposition ledger and eventual successor, existing owners are not duplicated.
- **Why:** Architecture fixes system webviews for humans, plugins on public API, one history and background non-adoption. Native permission/TCC cannot be asserted by source or browser substitutes.
- **Evidence:** docs/architecture.md Decisions; parent D17-D18; sa-browser-pane native constraint decisions; queue owner reconciliation.
- **Reversibility:** hard
- **Confidence:** high
- **Revisit if:** Supported upstream public capability lands.
- **Source:** locked by docs/architecture.md

## D5: Preserve unrelated metadata and use omp implementation without new reviews
- **Question:** How do unattended preflight and backend choices work?
- **Options:** Stash/remove inherited .serena; leave it untouched. Start reviewer probes; skip unstarted reviews under current policy.
- **Chose:** Leave untracked .serena untouched and unstaged. IMPLEMENTER=omp task, AUTHOR_FAMILY=openai; no reviewer run/probe or clearance claimed because LOOP forbids new review rounds in this phase. LSP attempted: no configured server.
- **Why:** Unexpected files belong to user; native task tool is available. Review backend availability adds no assurance when review is prohibited.
- **Evidence:** Initial git status; xd://lsp status reply; authoritative LOOP build-first rules.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** End-phase review work is claimed.
- **Source:** locked by docs/loop/LOOP.md

## Progress
Scope/design self-review complete. Single combined logic spec enumerates entire inherited inventory, Q1-Q3/D1-D2/S1/W1-W3, and public boundaries. Shared package-local types committed before at most three disjoint implementers. Next: dispatch those components, integrate their real implementations and acceptance tests, resolve compiler diagnostics, required isolated smoke, enumerate exact unbuilt flow successor just before landing, catch up once and canonical queue land. No checks/tests/build/dogfood/reviews run yet.
