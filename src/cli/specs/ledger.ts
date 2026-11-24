import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

const TARGET_FLAGS = ['workspace', 'group', 'group-selector']
const LEDGER_READ_FLAGS = ['ledger']
const CONTENT_FLAGS = [
  'title',
  'file',
  'description',
  'severity',
  'why-deferred',
  'priority',
  'file-under-test',
  'reason-skipped',
  'context',
  'recommendation',
  'decision',
  'consequences',
  'status'
]

export const LEDGER_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['ledger', 'file'],
    summary: 'File a typed observation in the workspace ledger',
    usage:
      'quirky ledger file --type <type> --title <title> [fields] [--group|--group-selector <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, ...TARGET_FLAGS, 'type', ...CONTENT_FLAGS]
  },
  {
    path: ['ledger', 'list'],
    summary: 'List ledger entries',
    usage:
      'quirky ledger list [--type <type>] [--state <state>] [--reviewed <true|false>] [--stale <true|false>] [--workspace <id>] [--branch <name>] [--ledger <id>] [--group|--group-selector <selector>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      ...TARGET_FLAGS,
      ...LEDGER_READ_FLAGS,
      'type',
      'state',
      'reviewed',
      'stale',
      'branch'
    ]
  },
  {
    path: ['ledger', 'show'],
    summary: 'Show a ledger entry and its history',
    usage: 'quirky ledger show <id> [--ledger <id>] [--group|--group-selector <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, ...TARGET_FLAGS, ...LEDGER_READ_FLAGS, 'id'],
    positionalArgs: ['id']
  },
  {
    path: ['ledger', 'edit'],
    summary: 'Edit a ledger entry with an optimistic revision precondition',
    usage:
      'quirky ledger edit <id> --if-revision <n> [fields] [--group|--group-selector <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, ...TARGET_FLAGS, 'id', 'if-revision', ...CONTENT_FLAGS],
    positionalArgs: ['id']
  },
  {
    path: ['ledger', 'state'],
    summary: 'Change a ledger entry lifecycle state',
    usage:
      'quirky ledger state <id> --state <open|resolved|archived> --if-revision <n> [target] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, ...TARGET_FLAGS, 'id', 'state', 'if-revision'],
    positionalArgs: ['id']
  },
  {
    path: ['ledger', 'review'],
    summary: 'Review ledger entries and report available evidence',
    usage:
      'quirky ledger review [--ledger <id>] [filters] [--group|--group-selector <selector>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      ...TARGET_FLAGS,
      ...LEDGER_READ_FLAGS,
      'type',
      'state',
      'reviewed',
      'stale',
      'branch'
    ]
  },
  {
    path: ['ledger', 'revert'],
    summary: 'Restore editable content from an earlier entry revision',
    usage: 'quirky ledger revert <id> --to-revision <n> --if-revision <n> [target] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, ...TARGET_FLAGS, 'id', 'to-revision', 'if-revision'],
    positionalArgs: ['id']
  },
  {
    path: ['ledger', 'import'],
    summary: 'Import legacy ledger files from the selected workspace',
    usage: 'quirky ledger import [--group|--group-selector <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, ...TARGET_FLAGS]
  }
]
