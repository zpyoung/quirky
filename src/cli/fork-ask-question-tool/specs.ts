import { GLOBAL_FLAGS, type CommandSpec } from '../args'

/** CommandSpec entries for `quirky ask` / `quirky ask wait` / `quirky ask cancel` (tech.md C5). */
export const ASK_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['ask'],
    summary: 'Ask the user a question and block until answered',
    usage: 'quirky ask --spec <json|@file> [--timeout-ms <n>] [--chunk-ms <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'spec', 'timeout-ms', 'chunk-ms'],
    notes: [
      'The envelope always prints as bare JSON on stdout, with or without --json, because the consumer is always a model.',
      'Prints {"status":"registered","askId":"..."} immediately, then blocks for one chunk before printing the result.',
      'If the ask is still unanswered at the chunk boundary, resume with `quirky ask wait --id <askId>`.',
      'Interrupting with SIGINT or SIGTERM cancels the ask (exit 130 / 143). --chunk-ms is capped at 2147478647.'
    ],
    examples: [
      'quirky ask --spec \'{"questions":[{"id":"db","type":"select","question":"Which database?","options":[{"value":"postgres","label":"PostgreSQL"}]}]}\'',
      'quirky ask --spec @question.json --timeout-ms 60000'
    ]
  },
  {
    path: ['ask', 'wait'],
    summary: 'Resume blocking on a pending ask',
    usage: 'quirky ask wait --id <ask_id> [--chunk-ms <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id', 'chunk-ms'],
    examples: ['quirky ask wait --id ask_01J000000000000000000000']
  },
  {
    path: ['ask', 'cancel'],
    summary: 'Cancel a pending ask as declined',
    usage: 'quirky ask cancel --id <ask_id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id'],
    examples: ['quirky ask cancel --id ask_01J000000000000000000000']
  }
]
