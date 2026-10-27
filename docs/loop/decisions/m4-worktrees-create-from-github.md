# m4-worktrees-create-from-github decisions

## D1: Extend the existing worktree create owner through the public hosting API
- **Question:** which approach implements GitHub sources without a second lifecycle (brainstorming approach)?
- **Options:** extend quirky.worktree/create and call quirky.hosting; introduce a GitHub-worktree plugin with a second creator; port Orca's separate renderer/runtime implementations.
- **Chose:** extend the existing owner and one create path, with hosting owning authenticated GitHub reads.
- **Why:** m1-worktrees D5 locks one creator; roadmap requires built-in plugins on the public API. A second lifecycle duplicates hook trust, collision, setup and activation rules.
- **Evidence:** docs/loop/decisions/m1-worktrees.md D5; docs/roadmap.md:19-38; hosting-api.md Other GitHub plumbing.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** the public plugin API cannot express an authenticated read needed by creation.
- **Source:** locked by docs/loop/decisions/m1-worktrees.md

## D2: Resolve unattended design questions locally using night-mode protocol
- **Question:** how to conduct brainstorming, spec approvals and research in this unattended iteration?
- **Options:** ask a human; use the provided documents and record recommended defaults.
- **Chose:** no asks, visual companion or divergent-ideation offers; no external research swarms; one markdown logic spec with a final technical section and self-review. Domains: Integration, API, CLI, Visual, Data and Organization. Select naming, duplicate-handling, data-mapping, authentication, conflict-resolution, retries, flags/output, loading/empty/error/selection states and hook execution/trust as gray areas.
- **Why:** night mode explicitly supplies the research, skips separate tech/spec review, and replaces user approvals with recorded decisions.
- **Evidence:** docs/loop/LOOP.md Night mode and Answering a skill's questions; feature-doc worktrees.md section 2 and hosting-api.md Other GitHub plumbing.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the unattended/night-mode instructions change.
- **Source:** locked by docs/loop/LOOP.md

## D3: Use OpenAI task implementation and Gemini review after Opus fails preflight
- **Question:** which verified model pairing satisfies omp lane review independence?
- **Options:** task + Opus; task + Gemini; same-family review fallback.
- **Chose:** IMPLEMENTER=task, AUTHOR_FAMILY=openai, REVIEWER_ALIAS=gemini, high thinking. Maximum three implementers; disjoint scopes in isolated worktrees. Main tree owns integration and the final checks.
- **Why:** pi-watch --check found Opus and Sonnet unavailable, Gemini and Flash available. Bun 1.4.0 is installed. Preserved inherited untracked .serena state in path-limited stash lane2-serena-tool-state rather than include it in feature commits.
- **Evidence:** observed all-alias preflight and stash output in this iteration; package.json scripts.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Gemini dispatch fails and the documented fallback ladder is required.
- **Source:** locked by docs/loop/LOOP.md (pairing); assumed — autonomous (fallback and state preservation)

## D4: GitHub sources keep the existing lifecycle and fail visibly rather than become names
- **Question:** what do source interpretation, auth, failure and retry gray areas mean to consumers?
- **Options:** silently use unresolved input as a name; resolve explicit GitHub inputs authoritatively and surface errors.
- **Chose:** Smart #N and GitHub URLs resolve PRs/issues; GitHub tab lists mixed PRs/issues with distinct labels and explicit selected source/clear. Plain Smart text remains a name option. Failed explicit source resolution never creates a name-only workspace. Use hosting's bound-account/host checks and error semantics; no direct gh subprocess in UI or duplicated authenticated HTTP client; no additional retry layer. Keep existing setup trust/decision gates, naming collision policy, create-more reset and guarded activation.
- **Why:** source errors must not create the wrong checkout; hosting D5/D6/D7/D8 already own auth and failures.
- **Evidence:** worktrees.md:73-119; docs/loop/decisions/m4-hosting-api-github.md D5-D8; docs/loop/decisions/m1-worktrees.md D12/D21/D22/D30.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** a documented source flow needs different input interpretation.
- **Source:** locked by worktrees.md; locked by docs/loop/decisions/m4-hosting-api-github.md

## Progress
Claimed lane 2 item and created build/m4-worktrees-create-from-github from build/roadmap. Read requirements and binding decisions; scouting current implementation seams before writing the combined spec/contracts. No implementation dispatched yet. Three-hour clock begins with this iteration's queue claim. Next: commit spec and shared contracts, then dispatch at most three disjoint implementers.
