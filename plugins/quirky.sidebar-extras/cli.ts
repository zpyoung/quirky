import type { CliArgs, CliContext, CliModule } from '@quirky/protocol'

type Flags = Record<string, unknown>

function clientParams(flags: Flags): Record<string, unknown> {
  return flags.client === undefined ? {} : { client: flags.client }
}

async function call(method: string, params: Record<string, unknown>, context: CliContext): Promise<void> {
  const result = await context.call(`quirky.sidebar-extras/${method}`, params)
  context.out.result(result, () => JSON.stringify(result, null, 2) ?? String(result))
}

const commands: CliModule['commands'] = {
  async state(args, context) {
    await call('state', clientParams(args.flags), context)
  },

  async set(args, context) {
    const params = clientParams(args.flags)
    const names: Record<string, string> = {
      'workspace-activity-window': 'workspaceActivityWindow',
      'workspace-activity-custom-days': 'workspaceActivityCustomDays',
      'always-show-default-branch-workspace': 'alwaysShowDefaultBranchWorkspace',
      'hide-sleeping-workspaces': 'hideSleepingWorkspaces',
      'show-sleeping-workspaces': 'showSleepingWorkspaces'
    }
    for (const [flag, property] of Object.entries(names)) {
      if (args.flags[flag] !== undefined) params[property] = args.flags[flag]
    }
    await call('set', params, context)
  },

  async activate(args, context) {
    const { clear, worktree } = args.flags
    if ((clear === true && worktree !== undefined) || (clear !== true && worktree === undefined)) {
      throw context.usage('pass --worktree <selector> or --clear, not both')
    }
    if (worktree !== undefined && typeof worktree !== 'string') {
      throw context.usage('--worktree must be a selector')
    }
    const params = clientParams(args.flags)
    params.worktree = clear === true ? null : worktree
    await call('activate', params, context)
  },

  async projection(args, context) {
    await call('projection', clientParams(args.flags), context)
  },

  async dirty(args, context) {
    const noActive = args.flags['no-active']
    const worktree = args.flags.worktree
    if (noActive === true && worktree !== undefined) {
      throw context.usage('--no-active and --worktree are mutually exclusive')
    }
    const params: Record<string, unknown> = {}
    if (noActive === true) params.worktree = null
    else if (worktree !== undefined) {
      if (typeof worktree !== 'string') throw context.usage('--worktree must be a selector')
      params.worktree = worktree
    }
    await call('dirty', params, context)
  }
}

export { commands }
