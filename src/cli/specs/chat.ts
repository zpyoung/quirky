import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const CHAT_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['chat', 'list'],
    summary: 'List chat sessions with their agent, status, workspace and model',
    usage: 'quirky chat list [--workspace <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'workspace'],
    notes: ['Reads one status snapshot and closes the stream.'],
    examples: ['quirky chat list', 'quirky chat list --workspace current']
  },
  {
    path: ['chat', 'create'],
    summary: 'Start a chat session with an agent in a workspace',
    usage:
      'quirky chat create --workspace <selector> --agent <codex|claude|...> [--message <text>] [--model <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'workspace', 'agent', 'message', 'model'],
    notes: [
      'Prints the new session id. --workspace takes a worktree or folder workspace selector, or `current`.',
      '--message is delivered as the first message; pair it with `quirky chat send <session> <text> --wait` to follow the turn.'
    ],
    examples: ['quirky chat create --workspace current --agent claude --message "run the tests"']
  },
  {
    path: ['chat', 'resume'],
    summary: 'Continue an earlier conversation as a chat session in a workspace',
    usage: 'quirky chat resume <session> --workspace <selector> [--agent <agent>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'session', 'workspace', 'agent'],
    positionalArgs: ['session'],
    notes: [
      "<session> is a chat session id from `quirky chat list`, or the agent's own conversation id with --agent."
    ],
    examples: ['quirky chat resume claude_0b1c2d3e_4f5a --workspace current']
  },
  {
    path: ['chat', 'send'],
    summary: 'Send a message to a chat session',
    usage: 'quirky chat send <session> <text> [--wait] [--timeout <ms>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'session', 'text', 'wait', 'timeout'],
    positionalArgs: ['session', 'text'],
    notes: [
      'Returns {turnId} as soon as the host accepts the message.',
      '--wait blocks until the turn finishes, fails or needs input, then prints the status and the final assistant message. Exits 6 if --timeout (default 600000) elapses first.'
    ],
    examples: ['quirky chat send claude_0b1c2d3e_4f5a "summarize the diff" --wait']
  },
  {
    path: ['chat', 'cancel'],
    summary: 'Stop the turn a chat session is running',
    usage: 'quirky chat cancel <session> [--turn <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'session', 'turn'],
    positionalArgs: ['session'],
    examples: ['quirky chat cancel claude_0b1c2d3e_4f5a']
  },
  {
    path: ['chat', 'rewind'],
    summary: 'Rewind a chat session to an earlier message, discarding what came after',
    usage: 'quirky chat rewind <session> --to <itemId> [--yes] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'session', 'to', 'yes'],
    positionalArgs: ['session'],
    destructive: true,
    notes: [
      'Discards every message after <itemId>. Without --yes the command exits 4 with the command to re-run.',
      'Find item ids with `quirky chat history <session>`.'
    ],
    examples: ['quirky chat rewind claude_0b1c2d3e_4f5a --to item_42 --yes']
  },
  {
    path: ['chat', 'clear'],
    summary: 'Clear a chat session conversation',
    usage: 'quirky chat clear <session> [--yes] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'session', 'yes'],
    positionalArgs: ['session'],
    destructive: true,
    notes: ['Without --yes the command exits 4 with the command to re-run.'],
    examples: ['quirky chat clear claude_0b1c2d3e_4f5a --yes']
  },
  {
    path: ['chat', 'history'],
    summary: 'Read a chat session transcript, newest page first',
    usage: 'quirky chat history <session> [--limit <n>] [--before <cursor>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'session', 'limit', 'before'],
    positionalArgs: ['session'],
    notes: [
      'When older messages remain, the output carries a `nextBefore` cursor to pass as --before. --limit is at most 200.'
    ],
    examples: ['quirky chat history claude_0b1c2d3e_4f5a --limit 20']
  },
  {
    path: ['chat', 'options', 'get'],
    aliases: [['chat', 'options', 'show']],
    summary: 'Show the model and other options a chat session offers and currently uses',
    usage: 'quirky chat options get <session> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'session'],
    positionalArgs: ['session'],
    examples: ['quirky chat options get claude_0b1c2d3e_4f5a']
  },
  {
    path: ['chat', 'options', 'set'],
    summary: 'Set a chat session option, such as its model, for the next turn',
    usage: 'quirky chat options set <session> <key> <value> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'session', 'key', 'value'],
    positionalArgs: ['session', 'key', 'value'],
    examples: ['quirky chat options set claude_0b1c2d3e_4f5a model opus']
  },
  {
    path: ['chat', 'requests'],
    summary: 'List the approvals and questions a chat session is waiting on',
    usage: 'quirky chat requests <session> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'session'],
    positionalArgs: ['session'],
    notes: ['Each request id is the <request> argument of `quirky chat respond`.'],
    examples: ['quirky chat requests claude_0b1c2d3e_4f5a']
  },
  {
    path: ['chat', 'respond'],
    aliases: [['chat', 'answer']],
    summary: 'Allow or deny a permission request, or answer a question, in a chat session',
    usage:
      'quirky chat respond <session> <request> (--allow | --deny | --option <id> | --answer <text>) [--yes] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'session',
      'request',
      'allow',
      'deny',
      'option',
      'answer',
      'yes'
    ],
    positionalArgs: ['session', 'request'],
    destructive: true,
    notes: [
      'Put --allow and --deny after the positional arguments.',
      '--allow and --deny answer a permission request; --option and --answer answer a question. --option also picks a permission option by id.',
      '`quirky chat answer` is the same command. Permission answers need confirmation: without --yes the command exits 4 with the command to re-run.',
      'An unknown <request> exits 3; `quirky chat requests <session>` lists the pending ones.'
    ],
    examples: [
      'quirky chat respond claude_0b1c2d3e_4f5a item_7 --allow --yes',
      'quirky chat respond claude_0b1c2d3e_4f5a item_9 --answer "use postgres" --yes'
    ]
  }
]
