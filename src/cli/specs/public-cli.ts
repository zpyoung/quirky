import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const PUBLIC_CLI_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['schema'],
    summary: 'List every command, or print the JSON Schema contract of one',
    usage: 'quirky schema [<command>...] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'path'],
    positionalArgs: ['path'],
    variadicPositional: true,
    repeatableFlags: ['path'],
    notes: [
      'With no command, prints one `<command>  <summary>` line per command.',
      'With a command, prints {command, method?, params, result, stability, destructive, approvalCategory, errors} as JSON; a command with no public contract reports its flags.',
      'Pure local read of the command registry: works without a running Quirky app.'
    ],
    examples: ['quirky schema', 'quirky schema chat respond']
  },
  {
    path: ['rpc', 'list'],
    // an empty alias list keeps positional normalization from reading `list` as the <method> of `rpc`
    aliases: [],
    summary: 'List the RPC methods the CLI knows, with class and stability',
    usage: 'quirky rpc list [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    notes: [
      'Pure local read: prints every RPC method this CLI knows with its class and stability tier.'
    ],
    examples: ['quirky rpc list']
  },
  {
    path: ['rpc'],
    summary: 'Call any RPC method directly (unstable)',
    usage: "quirky rpc <method> [--params '<json>'] [--yes] [--json]",
    allowedFlags: [...GLOBAL_FLAGS, 'method', 'params', 'yes'],
    positionalArgs: ['method'],
    destructive: true,
    notes: [
      'Reaches every method, including those without a stable contract. Prefer a named command where one exists.',
      'A destructive method answers needs_confirmation with a preview; re-run with --yes to confirm.'
    ],
    examples: ['quirky rpc status.get', "quirky rpc settings.get --params '{}'"]
  }
]
