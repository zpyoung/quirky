# m4-hosting-api-github decisions

## D1: Take the complete GitHub API slice, not its UI or other providers
- **Question:** what does the queue title cover (brainstorming scope)?
- **Options:** PR lookup and merge only; all GitHub flows in hosting-api.md; every provider.
- **Chose:** all GitHub flows: identity/auth/account binding, branch/number lookup and refresh, creation and stacks, details/checks/comments/files, PR actions, issues/work items and Projects v2. No feature UI; hosting-ui is a separate item. Other providers, Bitbucket connection and worktree creation from PR are separate queue items. The later sitter calls the same merge method as people.
- **Why:** roadmap parity covers every in-scope flow; the title explicitly selects GitHub and a shared merge path.
- **Evidence:** docs/roadmap.md:190-199; hosting-api.md sections What the user can do and Capability matrix; docs/loop/LOOP.md:87-88.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** the queue assigns a GitHub API flow elsewhere.
- **Source:** locked by docs/roadmap.md

## D2: Resolve questions autonomously and keep markdown specs
- **Question:** how to conduct skill approval, visual/adhd offers, and selected gray areas unattended?
- **Options:** ask a person; accept recommended defaults with an audit trail.
- **Chose:** no human questions or orca ask; skip visual/adhd offers; markdown logic and tech specs; self-review design sections and replace approval with the required Codex adversarial spec pass. Select API response/error/auth/rate-limit/pagination, CLI output/flags/errors, Integration auth/retry/conflict/data-mapping and Data idempotency.
- **Why:** LOOP.md supplies the headless protocol and preauthorizes research.
- **Evidence:** docs/loop/LOOP.md:175-200.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** interactive review resumes after this loop.
- **Source:** locked by docs/loop/LOOP.md

## D3: Use OpenAI task implementers and Gemini review after Opus fails preflight
- **Question:** which reachable cross-family pair meets the omp lane rule?
- **Options:** OpenAI task + Opus; OpenAI task + Gemini; same-family fallback.
- **Chose:** IMPLEMENTER=task; AUTHOR_FAMILY=openai; REVIEWER_ALIAS=gemini, high thinking; Codex remains the mandated spec reviewer. Width cap 4. Tech spec required by LOOP.md and subsystem/file-count complexity.
- **Why:** pi-watch --check opus exited 5: no authed/shipping model. The all-alias probe also found Sonnet unavailable; Gemini and Flash available. Actual no-tool prompts returned REVIEW_READY for Gemini and Codex. Bun 1.4.0 is available. Build command bun run build; full suite bun run test; additional gates bun test scripts and bun run typecheck.
- **Evidence:** observed pi-watch preflight 2026-10-27; package.json scripts; docs/loop/LOOP.md:99-105.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** reviewer dispatch fails and the documented ladder must be used.
- **Source:** locked by docs/loop/LOOP.md

## Progress
Step 3: new item claimed on build/m4-hosting-api-github. Context and option research running. Next: finish feasibility survey, resolve all gray-area choices, author and review both specs before implementation.
