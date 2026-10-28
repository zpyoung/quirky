# m3-accounts-complete-user-acceptance-20261028 decisions

## D1: Complete the inherited acceptance contract on the existing plugin
- **Question:** What scope and approach resolve unattended brainstorming?
- **Options:** rewrite Accounts; mounted-only checks; extend existing public implementation and exercise remaining flows
- **Chose:** extend existing implementation; all inherited remaining flows, not a new switcher or narrowed acceptance
- **Why:** queue title and prior D9 explicitly enumerate the missing user observations. Existing ownership/history/authority rules bind this work.
- **Evidence:** accounts.md; docs/roadmap.md:13–55,183–188; m3-accounts D1–35; m3-accounts-remaining-flows D1–20; BLOCKERS Accounts entries
- **Reversibility:** medium (public behavior)
- **Confidence:** high
- **Revisit if:** a required flow conflicts with a locked decision
- **Source:** locked by docs/loop/LOOP.md and preceding Accounts decisions

## D2: Resolve gray areas with documented conservative defaults
- **Question:** Which purpose/consumer/success/constraints/scope/main-behavior and visual/API/integration defaults apply?
- **Options:** new design and auth protocols; existing layout/protocols with truthful error, identity and scope handling
- **Chose:** existing Usage/settings, Compact/Used defaults, durable preferences, last-good/error semantics, native CLI login, scoped idempotent resets and explicit removal confirmation; every UI flow uses public APIs
- **Why:** feature docs settle layout, information density, loading/empty/error state, interaction, auth, retries, mapping and idempotency. No human asks, visual companion, ADHD or research swarm; self-review the markdown combined specification.
- **Evidence:** completion logic.md AC1–11 and Technical decisions; external accounts.md
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** live source contradicts the acceptance contract
- **Source:** locked by accounts.md and docs/loop/LOOP.md

## D3: Preserve inherited metadata and use isolated implementation trees
- **Question:** How should untracked .serena and execution preflight be handled?
- **Options:** stage/delete inherited metadata; preserve it and isolate implementation
- **Chose:** leave .serena untouched; owned external temporary worktrees, at most3 implementers; IMPLEMENTER=omp task, AUTHOR_FAMILY=openai, REVIEWER_ALIAS=gemini
- **Why:** opus and sonnet probes returned unavailable; Gemini and Flash are reachable cross-family alternatives. Codex and Terra resolve as OpenAI. Bun1.4.0 and guarded web doctor playwright-cli0.1.22 are ready. LSP reports no configured server.
- **Evidence:** actual preflight outputs; initial tracked-clean detached checkout; /tmp/quirky-l11-accounts.fqr6gS
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** actual reviewer dispatch fails
- **Source:** assumed — autonomous

## D4: Resume failed cancellation observation and offer only executable restart choices
- **Question:** What should resolve tracked X1/G2 without hiding errors or changing process identity?
- **Options:** ignore cancel errors; silently relabel background runners; recover polling and restrict terminal restart candidates
- **Chose:** cancellation failure retains/reobserves the pending login with generation fencing; terminal-only stale restart projection while retaining stored background account identity and endpoint refusal
- **Why:** model.ts invalidates polling before cancel RPC and leaves it stopped on rejection. service.ts projects every session kind while restarts.ts rejects non-terminal execution. UI should not advertise an action the backend cannot execute.
- **Evidence:** BLOCKERS:463–464; model.ts:629–669; service.ts:886–926; restarts.ts:45–54
- **Reversibility:** easy
- **Confidence:** high for source-confirmed defect paths; post-fix runtime evidence recorded separately
- **Revisit if:** a public background restart capability is intentionally added
- **Source:** assumed — autonomous

## D5: Preserve native-only handoffs and historical limits
- **Question:** Can synthetic web/API observations close native clipboard/browser/Keychain/OS-focus or past incomplete reviews?
- **Options:** infer native success; retain explicit pending handoffs and exact evidence scope
- **Chose:** retain pending synthetic-only native scenarios; no real provider data, foreground control, credentials or native pass
- **Why:** authoritative LOOP requires web-only unattended dogfood and permits native handoff. Old reduced-independence/timeouts remain historical facts even after new checks.
- **Evidence:** docs/loop/native/m3-accounts-remaining-flows.json; preceding decisions D4/D10/D13
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** authorized native runner supplies results
- **Source:** locked by docs/loop/LOOP.md

## D6: Execute end-phase verification, not the former build-only waiver
- **Question:** Which test policy applies at claim?
- **Options:** typecheck-only build-first phase; normal end-phase testing
- **Chose:** normal verification, affected tests/scripts/typecheck/build and reachable user-surface scenarios
- **Why:** canonical status at claim shows m7-test-triage in-progress on lane8; LOOP says build-only overrides end once it is claimed. Combined logic/technical spec and fixed existing contracts avoid redundant schema work.
- **Evidence:** canonical queue status at claim; authoritative LOOP Build first/The end phase
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** explicit operator policy changes
- **Source:** locked by docs/loop/LOOP.md

## Progress
Scope/spec established; existing public signatures remain unchanged. Next: commit contracts, dispatch disjoint implementers after survey, integrate and exercise remaining acceptance with fresh owned fixture state. Exactly one item owned; no second wait until merged or blocked.
