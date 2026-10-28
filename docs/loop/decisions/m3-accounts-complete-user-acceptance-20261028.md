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

## D7: Gate the actual integrated implementation and repair fixture boundaries
- **Question:** What did the isolated implementation and first gates establish?
- **Options:** trust worker completion; weaken failing assertions; audit scopes and repair the observed fixture/compile errors
- **Chose:** three disjoint components at4624dd97; parent-owned audit, targeted gates and integration71009b45/2ee40246; scratch-only runtime support
- **Why:** first UI gate exposed a removed import, then duplicate local declaration, then an incidental expanded-button text pin and ReactDOM input feature-detection before DOM registration. Repairs restore imports, remove the incidental pin in favor of visible Active/disabled selection, and intentionally initialize UI after test DOM. API gate exposed missing quirky.cli prerequisite and reset tests stopping at confirmation instead of intended errors; install the actual prerequisite and choose the public opt-out before capturing scope. No producer assertion or authority fence was weakened.
- **Evidence:** renderer23pass/0fail/200assertions4.82s, with React act warnings; daemon9pass/0fail/55assertions12.33s. typecheck/build exit0, combined132.26s; packaged build warns missing icon source. Component HEADs unchanged until parent commits; source writes matched scopes. Runtime1200-line helper moved outside repo rather than retained as permanent dead weight.
- **Reversibility:** easy
- **Confidence:** high for exercised gates
- **Revisit if:** post-catch-up evidence differs
- **Source:** assumed — autonomous

All three component clones lacked the same parent-only .serena entries; workers report no metadata operations. Parent metadata stayed untouched. Clone metadata was archived before owned trees were removed with the prescribed force removal; temporary branches were deleted only after merge (empty runtime branch was an ancestor). No unsupported attribution to a worker or deletion of parent metadata.

## D8: Prove actual continuation and native login recovery at their real boundaries
- **Question:** What smoke evidence can be claimed without real provider credentials?
- **Options:** account/ID echoes; actual daemon/PTY native-format transcripts with isolated external CLIs
- **Chose:** real daemon, transport, PTY and production AccountsUiStore; fake only external provider CLI/quota/security and one explicit Cancel transport-delivery failure
- **Why:** Codex A→B→remove-A→C read accumulated A/B user messages in C, appended continuation and rendered A/B/C identities after A's home vanished. A separate real native pending login retained its pending state after injected transport failure, resumed status reads and projected the completed account into the renderer store. This is not a browser/native OS pass.
- **Evidence:** codex-smoke result passed3.26s, all eight content/identity/home booleans true; cancellation smoke passed2.14s including teardown, actualDaemonNativeLoginCompleted/failedCancelTransportRetainedPending/statusPollingResumed/completionReachedRendererAccountState=true. Both owned smoke services exited0 after explicit stop.
- **Reversibility:** easy
- **Confidence:** high for named runtime boundaries only
- **Revisit if:** provider native formats or public resume contract changes
- **Source:** assumed — autonomous

Runtime fixture repairs were not product changes: match current main.js/vendor asset layout; use POST for loopback transport carrying external POST bodies; declare metadata state; include quirky.cli prerequisite; emit Codex's actual native URL marker and invoke Claude's run-owned BROWSER capture script. The smoke originally awaited an unobserved poll and later incorrectly required a null login after completion; production retains a completed status envelope, so readiness now waits for the trusted link and the consumer assertion requires completion rather than a spinning pending state. No URL allowlist or login parser was relaxed.

## D9: Coordinate shared repairs instead of duplicating owners
- **Question:** Which incoming failures belong to this item versus active repairs?
- **Options:** duplicate confirmation/model/CLI/overflow fixes; preserve named owners and merge their final contracts
- **Chose:** lane12 owns fix-test-ask-1028 confirmation repair; lane3 owns usage geometry/public Open/CLI key alignment and Codex discovery diagnostics; this item owns cancel polling, terminal eligibility and the isolated Accounts fixture prerequisite
- **Why:** explicit operator messages identify the owners and forbid aliases/bypasses. Current scripts gate113pass/13fail/945assertions157.72s exactly matches the already-done fix-test-scripts-1028 queue item, not a new defect to repair here. Final catch-up must bring that repair; no second queue item added.
- **Evidence:** operator interjections; canonical queue inspected m7-test-triage done and fix-test-scripts-1028 done; scripts/ui-review review+CLI failures; support/index.ts prerequisite communicated explicitly
- **Reversibility:** easy
- **Confidence:** high for ownership and observed failure signatures
- **Revisit if:** merged repaired source still fails
- **Source:** locked by operator coordination

## Progress
Both scoped production defects integrated; local targeted gates, typecheck/build and actual native-content/cancellation smokes have receipts. Three isolated guarded UI campaigns are running on independent real daemon/PTY homes: presentation, lifecycle, and switching/reset. Broader affected suite still running; scripts failure matches an already-landed owner repair awaiting the sole catch-up. Next: finish every reachable UI flow, retain driver/native limits, complete one bounded review/fix batch, merge current roadmap once and read incoming decisions, rerun checks, stop all owned services and canonical land. No full UI/native or broad-suite pass claimed.
