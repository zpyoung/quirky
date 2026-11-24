import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const ENVIRONMENT_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['host', 'name'],
    summary: 'Show or set the name this Quirky runtime reports to connected clients',
    usage: 'quirky host name [--name <name>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'name'],
    notes: [
      'With --name, updates the answering runtime over its authenticated connection. Use an empty value to return to the detected computer name.',
      'Without --name, prints the name and platform the answering runtime reports.'
    ],
    examples: ['quirky host name', 'quirky host name --name build-server']
  },
  {
    path: ['host', 'list'],
    summary: 'List every machine this Quirky host can target, and how to name each one',
    usage: 'quirky host list [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    notes: [
      'Answers "what can I target and what do I pass" in one place: this machine, the SSH targets registered on it, and the Quirky servers paired with it.',
      'The three kinds are reached differently. A paired Quirky server is a connection, selected with --environment <name>. An SSH target is a machine the connected Quirky host reaches, selected with --host ssh:<id>. Passing one where the other belongs is the most common way to get an empty or missing-host answer.',
      'Commands that take --host also accept any name this list prints, such as --host "this machine" or --host <ssh-target-name>. A name two hosts share is refused with the exact flag for each.',
      'SSH rows include the detected remote platform after that target has connected (linux, darwin, or win32); disconnected or older targets report platform unknown.',
      'SSH rows also include whether the target is currently connected and its lifecycle status when known.',
      'Paired-server rows come from the pairing store and report platform unknown; ask one server directly with `quirky host name --environment <name>`.',
      "SSH targets are read from this machine's own Quirky runtime, so this lists that machine's targets and not another server's. Run `quirky host list` on the other machine to see the targets registered there.",
      '--environment and --pairing-code are rejected rather than ignored: paired servers come from this machine\u2019s pairing store, so a routed answer would describe two machines at once.'
    ],
    examples: ['quirky host list', 'quirky host list --json']
  },
  {
    path: ['environment', 'add'],
    summary: 'Save a remote Quirky runtime environment from a pairing code',
    usage: 'quirky environment add --name <name> --pairing-code <code> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'name'],
    examples: ['quirky environment add --name work-laptop --pairing-code quirky://pair?code=...']
  },
  {
    path: ['environment', 'list'],
    summary: 'List saved Quirky runtime environments',
    usage: 'quirky environment list [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    notes: [
      'Answers from this machine\u2019s pairing store. --environment and --pairing-code are rejected rather than ignored, because there is no other host that could answer.'
    ]
  },
  {
    path: ['environment', 'show'],
    summary: 'Show one saved Quirky runtime environment',
    usage: 'quirky environment show --environment <selector> [--json]',
    allowedFlags: [...GLOBAL_FLAGS]
  },
  {
    path: ['environment', 'rm'],
    destructive: true,
    summary: 'Remove one saved Quirky runtime environment',
    usage: 'quirky environment rm --environment <selector> [--json]',
    allowedFlags: [...GLOBAL_FLAGS]
  }
]
