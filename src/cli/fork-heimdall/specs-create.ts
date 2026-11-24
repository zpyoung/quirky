import { GLOBAL_FLAGS, type CommandSpec } from '../args'

const COMMON_CREATE_FLAGS = [
  'worktree',
  'spec',
  'hours',
  'turns',
  'cap',
  'owner',
  'owner-model',
  'owner-effort'
]

export const HEIMDALL_CREATE_SPECS: CommandSpec[] = [
  {
    path: ['heimdall', 'create', 'objective'],
    summary: 'Enroll an objective watcher',
    usage:
      'quirky heimdall create objective [--objective <text>|--objective-file <path>] [--plan-file <path>] [--worktree <selector>] [--spec <json|@file>] [--hours <n|none>] [--turns <n|none>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      ...COMMON_CREATE_FLAGS,
      'objective',
      'objective-file',
      'plan-file',
      'tier',
      'landing-bar',
      'max-concurrency',
      'territory',
      'role-agent',
      'gate',
      'no-lanes'
    ],
    repeatableFlags: ['cap', 'territory', 'role-agent', 'gate'],
    notes: [
      'Without --worktree, the runtime resolves the active workspace; folder workspaces are supported and run at concurrency 1.',
      '--spec is a partial JSON object with kindPayload, capabilities, budget, owner, or ownerInterventionCapability fields; explicit flags override it.',
      'Provide objective text with --objective, --objective-file, or kindPayload.objectiveText in --spec.',
      'Objective defaults match the renderer: standard tier, files-on-disk landing, 4 hours, 40 turns, three-way concurrency, and whole-workspace territory.',
      'Use --cap <key>=<off|gated|on> to override a capability, repeat --territory and --role-agent, and use --no-lanes to disable lanes.'
    ],
    examples: [
      'quirky heimdall create objective --objective "Ship the report export" --worktree active',
      'quirky heimdall create objective --objective-file ./objective.txt --plan-file ./plan.md --cap land=gated --territory src/** --territory tests/**'
    ]
  },
  {
    path: ['heimdall', 'create', 'hosted-review'],
    summary: 'Enroll a hosted-review watcher',
    usage:
      'quirky heimdall create hosted-review [--worktree <selector>] [--spec <json|@file>] [--hours <n|none>] [--turns <n|none>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, ...COMMON_CREATE_FLAGS, 'branch-update', 'merge-method'],
    repeatableFlags: ['cap'],
    notes: [
      'Without --worktree, the runtime resolves the active workspace; hosted-review watchers require a Git worktree.',
      '--spec is a partial JSON object with kindPayload, capabilities, budget, owner, or ownerInterventionCapability fields; explicit flags override it.',
      'Hosted-review defaults match the renderer: all four capabilities off, a four-hour budget, and provider-default merge method.',
      'Hosted-review creation requires the host-derived payload capability; update or restart Quirky if the selected runtime lacks it.',
      'Candidate branch, provider, reviewNumber, and reviewUrl fields in --spec do not bypass this capability gate.'
    ],
    examples: [
      'quirky heimdall create hosted-review --worktree active',
      'quirky heimdall create hosted-review --worktree branch:feature/report --cap fixChecks=gated --branch-update rebase'
    ]
  }
]
