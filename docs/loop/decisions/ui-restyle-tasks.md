# ui-restyle-tasks decisions

## D1: Preserve feature behavior and host-owned default slots
- **Question:** brainstorming essential purpose, scope, consumers, success, constraints and integration gray areas
- **Options:** visual-only migration; combine functional changes; invent a new panel layout model
- **Chose:** desktop visual-only migration across tasks and automations, existing left-bottom host placement and all current public behavior
- **Why:** approved redesign explicitly excludes changed behavior, APIs and shortcuts
- **Evidence:** docs/quirk/specs/2026-10-28-ui-redesign/logic.md:25-59,117-119,183,192-227
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** a shared primitive cannot preserve a current interaction
- **Source:** locked by docs/quirk/specs/2026-10-28-ui-redesign/logic.md

## D2: Use shared controls and canonical semantic feature layouts
- **Question:** layout/density/interaction/loading/empty/error gray areas
- **Options:** inject old plugin CSS with new colors; reuse shared primitives plus central semantic layouts; build private wrappers
- **Chose:** public shared controls with tokenized central layouts; preserve labeled semantic native data controls where no primitive fits; preserve existing empty/loading/error actions and true data-derived geometry
- **Why:** consistent graphite appearance without changing issue, Projects or automation authority/state machines; merely relocating old CSS is insufficient
- **Evidence:** parent spec design-system and behavior; current tasks/style.ts and automations/style.ts; @quirky/ui design-system contracts
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** actual narrow-panel or both-theme smoke exposes unreadable state or inaccessible control
- **Source:** assumed — autonomous

## D3: Execute three isolated source slices under build-first override
- **Question:** workflow questions, research, review, pairing, inherited metadata and checks
- **Options:** standard research/review/test rounds; authoritative build-first combined spec/contracts and bounded smoke
- **Chose:** commit dependencies and combined spec first; at most three OpenAI task implementers in disjoint external worktrees, no worker checks/commits; parent barrier/scope audit, typecheck and minimum actual changed-surface smoke. No reviewer dispatched or backend falsely claimed reachable. Preserve unrelated .serena metadata without staging it. Answer all questions autonomously, no human asks
- **Why:** authoritative loop forbids suites/review/dogfood before end-phase items and requires contracts first; developer still requires significant behavior execution evidence
- **Evidence:** git show build/roadmap:docs/loop/LOOP.md Build first; xd://lsp status returned no configured servers; scratch /tmp/quirky-tasks-restyle-lane9.xeHAFL
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** compiler or bounded smoke identifies an integration defect
- **Source:** locked by docs/loop/LOOP.md

## Progress
Scope/spec written; shared public component contracts unchanged. Next commit plugin @quirky/ui dependencies plus spec/decisions, then dispatch three isolated slices and integrate parent-owned tasks shell/lint/CSS imports. No suites/reviews/golden scoring run or claimed.
