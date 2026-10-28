import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { OrchestrationSkillAgent, OrchestrationSkillStatus } from './ui-contracts'
import { skillPathForAgent } from './skill-targets'

export { skillPathForAgent } from './skill-targets'

export type DetectedSkillAgent = { id: string; label: string }

const INSTALL_COMMAND = 'quirky orchestration skill-install'

const SKILL = `---
name: orchestration
description: This skill should be used when the user asks to coordinate supervised agent work, split a change across workers, run parallel agents with durable task tracking, or use /orchestration. Use it only when supervision and coordinator follow-up are required; use the generic quirky CLI skill for a plain unsupervised handoff.
---

# Orchestration

Coordinate supervised work through Quirky's durable Runs, Tasks, Dispatches, and mailbox. Keep the coordinator responsible for planning, review, dependency decisions, cleanup, and the final user response. Workers do only their assigned Task and report through the authenticated CLI.

## Classify the request

- For a plain handoff with no worker supervision, use the generic \u0060quirky\u0060 CLI skill instead. Do not create a Run merely because work is delegated.
- For supervised work, use this skill and keep every worker attached to an explicit Task and Dispatch.
- Treat the nested worker depth policy as an admission limit, not a process sandbox or global access-control boundary. It does not retroactively stop workers already admitted.

## Start a supervised Run

1. Confirm daemon status with the core built-in status command:

   \u0060\u0060\u0060sh
   quirky status --json
   \u0060\u0060\u0060
2. Create and bind one coordinator Run:

   \u0060\u0060\u0060sh
   quirky orchestration run-create --objective "<goal and completion conditions>" --json
   \u0060\u0060\u0060
3. Inspect the returned Run ID. Keep it for inventory and explicit Run-scoped commands. Creating or using another Run does not reset the caller's worker depth.
4. For one task, let \u0060worker-start --spec\u0060 create the Task and first Dispatch together:

   \u0060\u0060\u0060sh
   quirky orchestration worker-start --spec "<bounded task, outputs, and validation>" --worktree current --agent <agent-id> --json
   \u0060\u0060\u0060

   \u0060--task\u0060 and \u0060--spec\u0060 are mutually exclusive. Supply a real agent ID supported by the current agent catalog; use an existing terminal with \u0060--terminal <session-id>\u0060 only when intentionally reusing one.

## Plan dependencies and fan out safely

- Start independent workers before the first wait. Repeat \u0060worker-start --spec\u0060 for each independent Task; do not serialize a wave by waiting after every launch.
- When later work depends on earlier Tasks, create the dependency graph explicitly and start only ready Tasks:

  \u0060\u0060\u0060sh
  quirky orchestration task-create --spec "<phase A>" --task-title "Phase A"
  quirky orchestration task-create --spec "<phase B>" --task-title "Phase B" --deps '["<phase-A-task-id>"]'
  quirky orchestration worker-start --task <phase-A-task-id> --worktree current --agent <agent-id>
  \u0060\u0060\u0060
- \u0060--deps\u0060 is a JSON array of Task IDs in the same Run. A dependent Task stays pending until every dependency is completed. Do not start a pending Task.
- Inspect the real Run and Task state with \u0060quirky orchestration run-show --id <run-id>\u0060 and \u0060quirky orchestration task-list --run <run-id>\u0060; never infer completion from a launch receipt alone.

## Consume mailbox deliveries resumably

Wait for messages by type, but process every message in the returned delivery before acknowledging it:

\u0060\u0060\u0060sh
quirky orchestration check --wait --types "worker_done,escalation,question" --timeout-ms 900000 --json
\u0060\u0060\u0060

- A consuming \u0060check\u0060 returns a durable \u0060deliveryId\u0060. Read and handle all messages in that batch, then acknowledge and wait again:

  \u0060\u0060\u0060sh
  quirky orchestration check --ack <delivery-id> --wait --types "worker_done,escalation,question" --timeout-ms 900000 --json
  \u0060\u0060\u0060
- Do not acknowledge a delivery before processing its messages. On a lost response to a mutation, retry with the same global \u0060--retry-request <uuid>\u0060 so the durable receipt returns the original outcome. Treat a missing receipt as uncertainty, not proof that an effect did not occur.
- Answer questions with \u0060quirky orchestration reply --id <message-id> --body "<decision and rationale>"\u0060.
- Ask the coordinator without creating duplicate questions. If \u0060ask\u0060 times out, resume its returned message ID:

  \u0060\u0060\u0060sh
  quirky orchestration ask --question "<specific decision needed>" --timeout-ms 600000
  quirky orchestration ask --resume <message-id> --timeout-ms 600000
  \u0060\u0060\u0060
- On \u0060worker_done\u0060, inspect the matching Dispatch and evidence before accepting the report. Use \u0060worker-show --dispatch <dispatch-id>\u0060 and, when needed, \u0060worker-read --dispatch <dispatch-id> --source auto\u0060 to verify the result and affected files.

## Report exactly once from a worker

A worker sends one final lifecycle report for its exact Task and Dispatch, with a non-empty body and an explicit outcome:

\u0060\u0060\u0060sh
quirky orchestration send --type worker_done --task-id <task-id> --dispatch-id <dispatch-id> --outcome succeeded --subject "Worker report" --body "<what changed; what was validated; what remains>"
\u0060\u0060\u0060

Use \u0060--outcome failed\u0060 when the assigned work did not succeed. Do not send a second \u0060worker_done\u0060 for the same Dispatch. After reporting, stop implementing, polling, sleeping, and checking; return to an idle prompt for a fresh assignment.

## Choose one disposition after accepting a report

For each accepted \u0060worker_done\u0060, choose exactly one next owner:

- **Reuse** the same terminal for a ready follow-up Task with \u0060worker-start --task <next-task-id> --terminal <session-id> --worktree current\u0060 (add \u0060--agent <agent-id>\u0060 only when launching a new agent instead of reusing an existing session).
- **Retain** the terminal for debugging with \u0060quirky orchestration worker-retain --dispatch <dispatch-id>\u0060.
- **Release** the terminal when its output is no longer needed with \u0060quirky orchestration worker-release --dispatch <dispatch-id>\u0060.

Do not infer that a worker is done from silence, a missing pointer, an empty transcript, or stale liveness. Retain/release follows a validated report or another explicit, evidence-backed disposition.

## Inventory, retry, and uncertainty-safe cleanup

After three empty waits, enumerate the whole Run instead of polling indefinitely. \u0060worker-list\u0060 is paginated. Inspect every page, following \u0060page.nextCursor\u0060 with \u0060--cursor <next-cursor>\u0060 until no cursor remains:

\u0060\u0060\u0060sh
quirky orchestration worker-list --run <run-id> --json
quirky orchestration worker-list --run <run-id> --cursor <next-cursor> --json
\u0060\u0060\u0060

Inspect each row's current projection, liveness, attention, terminal state, and next action. Retry a failed Task only as an explicit new attempt tied to its prior Dispatch:

\u0060\u0060\u0060sh
quirky orchestration worker-start --task <task-id> --retry-of <prior-dispatch-id> --worktree current --agent <agent-id> --json
\u0060\u0060\u0060

- Never stop or abandon a worker because it is quiet, absent from a partial page, or \u0060unverifiable\u0060. Use \u0060worker-stop\u0060 or \u0060worker-abandon\u0060 only with positive exit evidence from a current \u0060worker-show\u0060/inventory result or a worker-observed exit; preserve work whenever evidence is uncertain.
- If a Task still has no trustworthy report, inspect the exact Dispatch, its transcript/terminal evidence, and current custody. Do not stop, abandon, release, or reuse a worker from missing or unverifiable evidence.
- Before ending the coordinator turn, prove that the Run has no reclaimable workers. Query every page and continue with \u0060--cursor\u0060 until \u0060page.nextCursor\u0060 is null:
  
  \u0060\u0060\u0060sh
  quirky orchestration worker-list --run <run-id> --terminal-state reclaimable --json
  quirky orchestration worker-list --run <run-id> --terminal-state reclaimable --cursor <next-cursor> --json
  \u0060\u0060\u0060
  
  End only after every page is exhausted and no page contains a reclaimable worker. An empty page with a non-null cursor is not completion. Do not fabricate a terminal destination for a structured-only worker.
`

/** Stable bytes for the installed skill and the read-only skill-show method. */
export function renderOrchestrationSkill(): string {
  return SKILL
}

function readSkillFile(path: string): { state: 'missing' | 'ready' | 'stale' | 'error'; detail: string | null } {
  try {
    const current = readFileSync(path, 'utf8')
    return current === SKILL
      ? { state: 'ready', detail: null }
      : { state: 'stale', detail: 'Installed content differs from this plugin version.' }
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return { state: 'missing', detail: null }
    }
    return { state: 'error', detail: error instanceof Error ? error.message : String(error) }
  }
}

function writeAtomically(path: string, text: string): void {
  const directory = dirname(path)
  const temporary = join(directory, `.${basename(path)}.${randomBytes(8).toString('hex')}.tmp`)
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    writeFileSync(temporary, text, { flag: 'wx', mode: 0o644 })
    renameSync(temporary, path)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}

function coverageState(agents: readonly OrchestrationSkillAgent[]): OrchestrationSkillStatus['state'] {
  if (agents.length === 0 || agents.every((agent) => agent.state === 'missing')) return 'missing'
  const supported = agents.filter((agent) => agent.state !== 'unsupported')
  if (supported.length === 0) return 'partial'
  if (agents.every((agent) => agent.state === 'ready')) return 'ready'
  if (supported.every((agent) => agent.state === 'error')) return 'error'
  if (agents.some((agent) => agent.state === 'unsupported' || agent.state === 'error') ||
    agents.some((agent) => agent.state === 'ready') && agents.some((agent) => agent.state !== 'ready')) return 'partial'
  if (agents.some((agent) => agent.state === 'stale')) return 'stale'
  return 'missing'
}

function statusText(agents: readonly OrchestrationSkillAgent[], state: OrchestrationSkillStatus['state']): string {
  if (agents.length === 0) return 'No agent CLIs detected on PATH. Install agents in Settings → Agents, then re-check.'
  if (state === 'ready') return `All ${agents.length} detected agents have the current orchestration skill.`
  const ready = agents.filter((agent) => agent.state === 'ready').length
  const unavailable = agents.filter((agent) => agent.state === 'unsupported').length
  if (unavailable === agents.length) return 'Detected agents have no documented native global skill target. Install the skill manually only after configuring a supported skill loader.'
  if (agents.some((agent) => agent.state === 'error')) return `${ready} of ${agents.length} detected agents have the skill; one or more targets need attention. Retry after resolving the reported error.`
  if (state === 'stale') return 'The installed orchestration skill is out of date. Update it, then re-check.'
  if (state === 'partial') return `${ready} of ${agents.length} detected agents have the current skill; unsupported targets are labelled explicitly.`
  return 'Install the orchestration skill above, then re-check.'
}

function inspectAgents(agents: readonly DetectedSkillAgent[], failures: ReadonlyMap<string, string> = new Map()): OrchestrationSkillStatus {
  const status = agents.map((agent): OrchestrationSkillAgent => {
    const path = skillPathForAgent(agent.id)
    if (path === null) {
      return { id: agent.id, label: agent.label, state: 'unsupported', path: null, detail: 'No documented native global skill target exists for this agent.' }
    }
    const inspected = readSkillFile(path)
    const failure = failures.get(agent.id)
    const state = failure && inspected.state !== 'ready' ? 'error' : inspected.state
    const detail = failure && inspected.state !== 'ready' ? failure : inspected.detail
    return { id: agent.id, label: agent.label, state, path, detail }
  })
  const state = coverageState(status)
  return { state, agents: status, installCommand: INSTALL_COMMAND, text: statusText(status, state) }
}

/** Compare detected agents' real current files with this generated build's bytes. */
export function inspectOrchestrationSkill(agents: readonly DetectedSkillAgent[]): OrchestrationSkillStatus {
  return inspectAgents(agents)
}

/** Replace only this plugin's SKILL.md in explicitly selected, detected, supported targets. */
export function installOrchestrationSkill(
  agents: readonly DetectedSkillAgent[],
  selectedAgentIds?: readonly string[]
): OrchestrationSkillStatus {
  const selected = selectedAgentIds === undefined ? null : new Set(selectedAgentIds)
  const failures = new Map<string, string>()
  for (const agent of agents) {
    if (selected !== null && !selected.has(agent.id)) continue
    const path = skillPathForAgent(agent.id)
    if (path === null) continue
    if (readSkillFile(path).state === 'ready') continue
    try {
      writeAtomically(path, SKILL)
    } catch (error) {
      failures.set(agent.id, error instanceof Error ? error.message : String(error))
    }
  }
  return inspectAgents(agents, failures)
}
