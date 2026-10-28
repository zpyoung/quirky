import type { DispatchRow, TaskRow } from '../contracts'
import type { SessionIdentity } from '../runtime-contracts'

export function buildWorkerPreamble(
  task: TaskRow,
  dispatch: DispatchRow,
  session: SessionIdentity,
  coordinatorSessionId: string,
  maximumDepth: number,
): string {
  const kind = session.kind === 'structured' ? 'structured background session' : 'terminal session'
  const title = task.displayName.trim() || task.taskTitle.trim() || task.id
  const coordinatorLine = coordinatorSessionId.startsWith('run:')
    ? 'Your coordinator Run mailbox is: ' + coordinatorSessionId
    : 'Your coordinator session ID is: ' + coordinatorSessionId
  const commands = [
    'orchestration send --type worker_done --task-id ' + task.id + ' --dispatch-id ' + dispatch.id + ' --outcome succeeded|failed --subject "Worker report" --body "<three-sentence executive summary>"',
    'orchestration send --type heartbeat --task-id ' + task.id + ' --dispatch-id ' + dispatch.id + ' --phase implementing --subject "Worker heartbeat"',
    'orchestration ask --question "<question for the coordinator>" --timeout-ms 600000',
    'orchestration check --terminal ' + session.sessionId + ' --json',
    'orchestration send --type escalation --subject "Blocked: <reason>" --body "<what is blocked and what decision is needed>"',
  ]
  const subdispatch = dispatch.depth < maximumDepth
    ? [
        '',
        '=== SUB-DISPATCH ===',
        'You may create a child Run, create Tasks, and start workers only while the configured maximum depth permits it.',
        'Wait for every child worker_done report before reporting your own result. The depth limit is strict; do not bypass it with low-level dispatch.',
      ]
    : []

  return [
    'You are working inside Quirky, a multi-agent IDE. You are a dispatched worker in a ' + kind + '.',
    coordinatorLine,
    'Your own Quirky session ID is: ' + session.sessionId,
    'Your workspace ID is: ' + session.worktreeId,
    'Your Run ID is: ' + dispatch.runId,
    'Your Task ID is: ' + task.id,
    'Your Dispatch ID is: ' + dispatch.id,
    'Task title: ' + title,
    '',
    'Work only on this Task in the stated workspace. The coordinator cannot see your private session transcript; a question or result left only here does not reach them.',
    'Use the authenticated orchestration commands below to report. Do not post to Slack, GitHub, or other channels. Do not use a copied session ID, `--from`, or a terminal alias to impersonate another session; Quirky derives authority from this exact live session.',
    '',
    '=== CLI COMMANDS ===',
    '```sh',
    '# Send exactly one final report. Use three sentences: what you did, what you found, and what remains. The body must be non-empty; choose the explicit outcome even when the prose explains the failure.',
    commands[0],
    '# While actively working, send a heartbeat every five minutes. Set --phase to a short phase such as investigating, implementing, reviewing, or waiting. Skip only while blocked inside check --wait or ask.',
    commands[1],
    '# Ask instead of using a local human-question tool. If it times out or disconnects, resume the returned message ID; never create a duplicate question.',
    commands[2],
    'orchestration ask --resume <messageId> --timeout-ms 600000',
    '# At natural checkpoints, before starting each new file, after a test run, and once more before worker_done, inspect coordinator mail:',
    commands[3],
    '# Escalate a blocker visibly to the coordinator:',
    commands[4],
    '```',
    ...subdispatch,
    '',
    '=== AFTER YOU SEND worker_done ===',
    'The final report ends this assignment. Stop working and return to an idle prompt: do not start more work, poll, sleep, or run check again. Do not send further lifecycle messages with these Task or Dispatch IDs. A direct user instruction takes precedence over this idle rule. Keep the terminal open; a new assignment arrives with a fresh preamble and Task block. Structured workers likewise wait without polling for a new instruction.',
    '',
    '=== TASK ===',
    task.spec,
  ].join('\n')
}
