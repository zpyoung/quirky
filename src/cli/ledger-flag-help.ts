/**
 * Help text for the flags that only `quirky ledger` uses.
 *
 * Kept out of the shared flag table because several of these names (`--title`,
 * `--workspace`, `--status`) already describe unrelated things for terminal,
 * automation, and Linear commands.
 */
const LEDGER_FLAG_HELP: Record<string, string> = {
  type: '--type <type>          Entry type: bug|deferred|test-gap|proposal|decision',
  title: '--title <text>         Short summary line, required by every entry type',
  file: '--file <path[:line]>   Source location for a bug entry',
  description: '--description <text>   What the bug is, required by bug entries',
  severity: '--severity <level>     Bug severity: critical|high|medium|low',
  'why-deferred': '--why-deferred <text>  Why the work was deferred',
  priority: '--priority <level>     Deferred-entry priority: high|medium|low',
  'file-under-test': '--file-under-test <path[:line]> Code the missing test would cover',
  'reason-skipped': '--reason-skipped <text> Why the test was skipped or abbreviated',
  context: '--context <text>       Background for a proposal or decision entry',
  recommendation: '--recommendation <text> What a proposal entry recommends',
  decision: '--decision <text>      What a decision entry decided',
  consequences: '--consequences <text>  What a decision entry commits you to',
  status: '--status <status>      Decision status: proposed|accepted|superseded',
  state: '--state <state>        Lifecycle state: open|resolved|archived',
  'if-revision': '--if-revision <n>      Entry revision the edit is based on',
  'to-revision': '--to-revision <n>      Historical revision to restore content from',
  reviewed: '--reviewed <true|false> Filter by whether an entry was reviewed in the app',
  stale: '--stale <true|false>   Filter by staleness against the ledger threshold',
  branch: '--branch <name>        Filter by the branch an entry was filed from',
  workspace: '--workspace <id>       Worktree whose project or group ledger to use',
  group: '--group                Target the group ledger instead of the project ledger',
  'group-selector': '--group-selector <id|name> Target a specific group ledger by id or name',
  ledger: '--ledger <id>          Read a ledger directly by id, including a detached one',
  id: '--id <id>              Ledger entry id'
}

// Why: on list and review the same flag also narrows rows to that worktree's entries,
// which is the difference that makes an unfiltered listing look empty.
const FILTERING_COMMANDS = new Set(['ledger list', 'ledger review'])

/** Returns ledger-specific help for `flag`, or undefined to fall back to the shared table. */
export function describeLedgerFlag(command: string, flag: string): string | undefined {
  if (flag === 'workspace' && FILTERING_COMMANDS.has(command)) {
    return '--workspace <id>       Worktree that owns the ledger; also filters rows to it'
  }
  return LEDGER_FLAG_HELP[flag]
}
