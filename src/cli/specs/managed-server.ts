import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

const SELECTOR_NOTE =
  '--environment names a managed Quirky server this machine deployed over SSH (see `quirky environment list`); it is a selector here, not a routing flag.'
const DESKTOP_NOTE =
  'Runs on this machine’s Quirky desktop app, the same action as Settings > Quirky on your SSH hosts. A runtime without the SSH registry (headless `quirky serve`) refuses it.'

export const MANAGED_SERVER_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['environment', 'status'],
    summary: 'Show a managed Quirky server’s active version, terminals and pending work',
    usage: 'quirky environment status --environment <selector> [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    notes: [SELECTOR_NOTE, DESKTOP_NOTE],
    examples: ['quirky environment status --environment build-box']
  },
  {
    path: ['environment', 'update'],
    summary: 'Update a managed Quirky server to this build’s version',
    usage: 'quirky environment update --environment <selector> [--force] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'force'],
    notes: [
      'Without --force, an update that would restart over running terminals is deferred and reported, not applied.',
      SELECTOR_NOTE,
      DESKTOP_NOTE
    ],
    examples: ['quirky environment update --environment build-box']
  },
  {
    path: ['environment', 'rollback'],
    destructive: true,
    summary: 'Roll a managed Quirky server back to its previous version',
    usage: 'quirky environment rollback --environment <selector> [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    notes: [SELECTOR_NOTE, DESKTOP_NOTE]
  },
  {
    path: ['environment', 'recover'],
    summary: 'Finish or undo a managed Quirky server’s interrupted update, rollback or stop',
    usage:
      'quirky environment recover --environment <selector> [--accept-changed-state --yes] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'accept-changed-state', 'yes'],
    notes: [
      'When a rejected build changed profile state, recover refuses rather than restart the previous build over it. --accept-changed-state --yes restores the prelaunch snapshot instead, the same as Restore in Settings > Quirky on your SSH hosts; what the rejected build changed is discarded.',
      SELECTOR_NOTE,
      DESKTOP_NOTE
    ],
    examples: [
      'quirky environment recover --environment build-box',
      'quirky environment recover --environment build-box --accept-changed-state --yes'
    ]
  },
  {
    path: ['environment', 'stop'],
    destructive: true,
    summary: 'Stop a managed Quirky server and unlink it from this machine (decommission)',
    usage: 'quirky environment stop --environment <selector> --yes [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'yes'],
    notes: [
      'Stops quirkyd on the SSH host and, once the host proves it exited, removes the server from this machine. Its terminals end. Requires --yes.',
      'If the host cannot prove quirkyd exited, the server stays linked and the refusal says why; nothing is removed on a guess. For a host that is gone for good, use `quirky environment forget`.',
      'If this server is the default host for new projects, choose another one first. `quirky environment cancel-stop` withdraws a stop quirkyd has not acted on yet.',
      SELECTOR_NOTE,
      DESKTOP_NOTE
    ],
    examples: ['quirky environment stop --environment build-box --yes']
  },
  {
    path: ['environment', 'forget'],
    destructive: true,
    summary: 'Unlink a managed Quirky server whose SSH host is gone, without stopping it',
    usage: 'quirky environment forget --environment <selector> --yes [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'yes'],
    notes: [
      'Removes the server from this machine without contacting its host, so the SSH host can then be removed. Use it when the host was deleted or can never be reached again. Requires --yes.',
      'Nothing on the host is stopped: if it comes back, quirkyd may still be running there, and connecting to it again relinks it.',
      SELECTOR_NOTE,
      DESKTOP_NOTE
    ],
    examples: ['quirky environment forget --environment build-box --yes']
  },
  {
    path: ['environment', 'cancel-stop'],
    summary: 'Withdraw a managed Quirky server stop that quirkyd has not acted on yet',
    usage: 'quirky environment cancel-stop --environment <selector> [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    notes: [SELECTOR_NOTE, DESKTOP_NOTE]
  }
]
