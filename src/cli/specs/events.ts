import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const EVENTS_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['events'],
    summary: 'Stream Quirky events as NDJSON',
    usage: 'quirky events [--topic <a,b>] [--after <cursor>] [--until <type>] [--timeout <ms>]',
    allowedFlags: [...GLOBAL_FLAGS, 'topic', 'after', 'until', 'timeout'],
    notes: [
      'Topics: chat, ui, notifications, workspace, activity. With no --topic, every topic streams.',
      'The first frame is {"type":"ready","subscriptionId":...,"cursor":n}. --after replays buffered events past that cursor; an `events.gap` frame says the cursor was too old.',
      '--until exits 0 on the first event whose type matches, and exits 6 if --timeout elapses first. Without --until, --timeout just ends the stream after that many milliseconds.'
    ],
    examples: [
      'quirky events --topic chat',
      'quirky events --topic chat --until turn.finished --timeout 120000'
    ]
  }
]
