# m3-accounts-remaining-flows decisions

## D1: Complete existing public flows, not a parallel Accounts implementation
- **Question:** What design and boundary applies to the completion item?
- **Options:** rewrite account service; extend existing plugin and finish named acceptance; mounted-only verification
- **Chose:** existing public plugin/service/UI, real daemon/API and guarded built-web acceptance, fixes only for evidenced defects
- **Why:** queue title explicitly describes deferred user-surface acceptance; core services and native conversation ownership already exist. Original m3-accounts D1–35 and AC1–18 remain binding.
- **Evidence:** external accounts.md; docs/loop/BLOCKERS.md:123-145; AccountsFlowMap and AccountsUiMap source surveys
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** actual flow proves a required public seam absent
- **Source:** locked by docs/loop/LOOP.md and queue item

## D2: Resolve every unattended gray area with feature requirements and conservative defaults
- **Question:** How to resolve layout, information density, loading/error states, interactions, auth, idempotency and scope without a person?
- **Options:** wait for questions; documented behavior and recommended defaults
- **Chose:** existing status-bar/drill-in/settings; Compact/Used defaults, consumed urgency, durable preferences; truthful old-session identity; official CLI native login; captured scope and explicit destructive confirmation; generic secret-free errors; sequential/debounced inactive fetch
- **Why:** each maps to accounts.md and original logic AC2–AC18. No new visual language, OAuth implementation, retries or abstraction. Purpose/consumers/success/constraints/scope/main behavior are all established by the queue and feature doc. Markdown spec accepted autonomously; no research swarm/visual companion/ADHD under night rules.
- **Evidence:** docs/quirk/specs/2026-10-28-m3-accounts-remaining-flows/logic.md; accounts.md Read usage, Switching state machine, Edge cases
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** source and executed flow disagree
- **Source:** locked by accounts.md and docs/loop/LOOP.md

## D3: Preserve inherited metadata and use isolated component worktrees
- **Question:** Which preflight state and execution pairing is safe?
- **Options:** stash unrelated .serena; stage it; leave untouched and isolate all implementers
- **Chose:** preserve unrelated untracked .serena unchanged; external /tmp component worktrees, fixed committed contracts; omp task implementers (AUTHOR_FAMILY=openai), Gemini independent review fallback
- **Why:** pi-watch --check reports opus/sonnet unavailable, gemini google/gemini-3.1-pro-preview:high available; codex/terra/flash also resolve. Bun1.4.0 available; web doctor ready with playwright-cli0.1.22. xd://lsp status reports no configured servers. Serena initial manual read; no native auth/state access authorized.
- **Evidence:** observed alias preflight and doctor; /tmp/quirky-accounts-lane9.YKzHLj; clean tracked branch at claim
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** reviewer fails actual dispatch or tool runtime changes
- **Source:** assumed — autonomous

## D4: Native-only observations remain explicit pending handoffs
- **Question:** Can unattended web/API proof stand in for macOS browser/clipboard/Keychain/OS focus?
- **Options:** falsely infer native completion; perform real user auth; pending native scenario handoff
- **Chose:** pending native scenarios with synthetic-only fixtures; complete reachable web/API behavior without real provider state or foreground control
- **Why:** LOOP explicitly requires native-only handoff and prohibits native/foreground dogfood. Existing m3-accounts native scenarios remain pending; do not claim a run occurred.
- **Evidence:** docs/loop/native/m3-accounts.json; LOOP step6
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** authorized native runner reports results
- **Source:** locked by docs/loop/LOOP.md

## Progress
Claimed lane9 at2026-10-28 01:24CDT. Brainstorm/source survey and combined night-mode spec complete. Existing public contracts/types/schemas are already committed and retained. Next: commit this spec/decision record, dispatch at most three disjoint implementers; integrator verifies real runtime/UI, one final cross-family review, affected checks, catch-up and canonical queue land. No feature pass claimed yet.
