import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const ADMIN_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['ui', 'state'],
    summary: 'Show what the Quirky window is showing: workspace, view, tab, panels',
    usage: 'quirky ui state [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    notes: ['Needs a running Quirky window; a headless runtime answers unavailable.']
  },
  {
    path: ['action', 'list'],
    summary: 'List the app actions a command can run',
    usage: 'quirky action list [--available] [--workspace <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'available', 'workspace'],
    notes: ['--available keeps only actions that can run right now.']
  },
  {
    path: ['action', 'run'],
    summary: 'Run an app action, such as opening a panel or switching a view',
    usage: 'quirky action run <id> [--workspace <selector>] [--yes] [--wait] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id', 'workspace', 'yes', 'wait'],
    positionalArgs: ['id'],
    notes: [
      'A destructive action needs --yes; without it the command answers needs_confirmation with a preview.',
      '--wait returns on the next ui event, or after 2 seconds with the current `ui state`.'
    ],
    examples: ['quirky action list --available', 'quirky action run view.tasks --wait']
  },
  {
    path: ['layout', 'get'],
    summary: 'Print the current window layout',
    usage: 'quirky layout get',
    allowedFlags: [...GLOBAL_FLAGS],
    notes: [
      'Prints the first frame of the layout stream as JSON. Builds without layout streaming answer unavailable.'
    ]
  },
  {
    path: ['settings', 'get'],
    summary: 'Read the client settings, or one setting by key',
    usage: 'quirky settings get [<key>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'key'],
    positionalArgs: ['key']
  },
  {
    path: ['settings', 'set'],
    summary: 'Change one client setting',
    usage: 'quirky settings set <key> <value> [--yes] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'key', 'value', 'yes'],
    positionalArgs: ['key', 'value'],
    notes: [
      'The value is read as JSON when it parses (true, 3, null, ["a"]) and as plain text otherwise.',
      'Settings that change agent launch behavior or permissions (agentDefaultEnv, agentDefaultArgs, nativeChatPermissionMode, agentStatusHooksEnabled) need --yes.'
    ],
    examples: [
      'quirky settings set compactWorktreeCards true',
      'quirky settings set machineName "build box"'
    ]
  },
  {
    path: ['settings', 'list'],
    summary: 'List every client setting as key: value lines',
    usage: 'quirky settings list [--json]',
    allowedFlags: [...GLOBAL_FLAGS]
  },
  {
    path: ['notifications', 'list'],
    summary: 'List notifications raised after a sequence number',
    usage: 'quirky notifications list [--last-seen-seq <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'last-seen-seq'],
    notes: [
      '--last-seen-seq defaults to 0, which lists every notification the runtime still holds.'
    ]
  },
  {
    path: ['notifications', 'dismiss'],
    summary: 'Dismiss a notification so clients stop showing it',
    usage: 'quirky notifications dismiss <id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id'],
    positionalArgs: ['id'],
    notes: ['Get ids from `quirky notifications list`.']
  },
  {
    path: ['plugins', 'enable'],
    summary: 'Enable a plugin',
    usage: 'quirky plugins enable <key> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'key'],
    positionalArgs: ['key'],
    notes: ['Get plugin keys from `quirky plugins list`.']
  },
  {
    path: ['plugins', 'disable'],
    summary: 'Disable a plugin',
    usage: 'quirky plugins disable <key> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'key'],
    positionalArgs: ['key'],
    notes: ['Get plugin keys from `quirky plugins list`.']
  }
]
