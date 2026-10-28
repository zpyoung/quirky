import type { CliArgs, CliContext, CliModule } from '@quirky/protocol'

const output = (context: CliContext, value: unknown): void => {
  context.out.result(value, () => JSON.stringify(value, null, 2))
}

function stringFlag(args: CliArgs, context: CliContext, name: string): string
function stringFlag(args: CliArgs, context: CliContext, name: string, required: true): string
function stringFlag(args: CliArgs, context: CliContext, name: string, required: false): string | undefined
function stringFlag(args: CliArgs, context: CliContext, name: string, required: boolean): string | undefined
function stringFlag(args: CliArgs, context: CliContext, name: string, required = true): string | undefined {
  const value = args.flags[name]
  if (value === undefined && !required) return undefined
  if (typeof value !== 'string' || value.length === 0) throw context.usage(`--${name} must be a nonempty string`)
  return value
}

function booleanFlag(args: CliArgs, context: CliContext, name: string): boolean {
  const value = args.flags[name]
  if (value === undefined) return false
  if (typeof value !== 'boolean') throw context.usage(`--${name} must be a boolean`)
  return value
}

function integerFlag(args: CliArgs, context: CliContext, name: string): number {
  const value = args.flags[name]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw context.usage(`--${name} must be a nonnegative integer`)
  }
  return value
}

function objectFlag(args: CliArgs, context: CliContext, name: string, required: boolean): Record<string, unknown> | undefined {
  const value = args.flags[name]
  if (value === undefined && !required) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw context.usage(`--${name} must be a JSON object`)
  return value as Record<string, unknown>
}

function stringListFlag(args: CliArgs, context: CliContext, name: string): string[] {
  const value = args.flags[name]
  const values = Array.isArray(value) ? value : value === undefined ? [] : [value]
  if (values.length === 0 || !values.every((item) => typeof item === 'string' && item.length > 0)) {
    throw context.usage(`--${name} must be provided at least once`)
  }
  return values as string[]
}

async function secretFromInput(args: CliArgs, context: CliContext): Promise<string> {
  const file = stringFlag(args, context, 'file', false)
  const stdin = booleanFlag(args, context, 'stdin')
  if (file !== undefined && stdin) throw context.usage('choose either --file or --stdin')
  if (file === undefined && !stdin) throw context.usage('provide a secret with --file or --stdin; never use a command-line value')
  let value: string
  if (file !== undefined) {
    try {
      value = await context.readFile(file)
    } catch {
      throw context.fail('could not read the credential file')
    }
  } else {
    value = await readStdin()
  }
  return value.replace(/\r?\n$/, '')
}

async function readStdin(): Promise<string> {
  const chunks: string[] = []
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
  }
  return chunks.join('')
}

function resetScope(args: CliArgs, context: CliContext): { accountId: string | null; accountRevision: number; offerRevision: string } {
  const systemDefault = booleanFlag(args, context, 'system-default')
  const accountId = systemDefault ? null : stringFlag(args, context, 'account-id') ?? null
  if (!systemDefault && accountId === null) throw context.usage('provide --account-id or --system-default')
  if (systemDefault && args.flags['account-id'] !== undefined) throw context.usage('--account-id and --system-default cannot be used together')
  return {
    accountId,
    accountRevision: integerFlag(args, context, 'account-revision'),
    offerRevision: stringFlag(args, context, 'offer-revision') ?? ''
  }
}

export const commands: CliModule['commands'] = {
  async list(args, context) {
    const provider = stringFlag(args, context, 'provider', false)
    output(context, await context.call('quirky.accounts/list', provider === undefined ? {} : { provider }))
  },

  async usage(_args, context) {
    output(context, await context.call('quirky.accounts/usage'))
  },

  async refresh(args, context) {
    const provider = stringFlag(args, context, 'provider', false)
    output(context, await context.call('quirky.accounts/refresh', { ...(provider === undefined ? {} : { provider }), force: true }))
  },

  async 'inactive-usage'(args, context) {
    output(context, await context.call('quirky.accounts/inactiveUsage', { provider: stringFlag(args, context, 'provider') }))
  },

  async add(args, context) {
    const provider = stringFlag(args, context, 'provider')
    const label = stringFlag(args, context, 'label', false)
    const accountId = stringFlag(args, context, 'account-id', false)
    const copyLink = booleanFlag(args, context, 'copy-link')
    output(context, await context.call('quirky.accounts/beginLogin', {
      provider,
      ...(label === undefined ? {} : { label }),
      ...(accountId === undefined ? {} : { accountId }),
      ...(copyLink ? { copyLink: true } : {})
    }))
  },

  async 'login-status'(args, context) {
    output(context, await context.call('quirky.accounts/loginStatus', { id: stringFlag(args, context, 'id') }))
  },

  async 'session-home'(args, context) {
    output(context, await context.call('quirky.accounts/sessionHome', { session: stringFlag(args, context, 'session') }))
  },

  async 'cancel-login'(args, context) {
    output(context, await context.call('quirky.accounts/cancelLogin', { id: stringFlag(args, context, 'id') }))
  },

  async select(args, context) {
    const provider = stringFlag(args, context, 'provider')
    const accountId = booleanFlag(args, context, 'system-default') ? null : stringFlag(args, context, 'account-id', false) ?? null
    if (args.flags['system-default'] === true && args.flags['account-id'] !== undefined) {
      throw context.usage('--account-id and --system-default cannot be used together')
    }
    if (accountId === null && args.flags['system-default'] !== true) throw context.usage('provide --account-id or --system-default')
    output(context, await context.call('quirky.accounts/select', { provider, accountId }))
  },

  async remove(args, context) {
    output(context, await context.call('quirky.accounts/remove', {
      provider: stringFlag(args, context, 'provider'),
      accountId: stringFlag(args, context, 'account-id')
    }))
  },

  async 'describe-remove'(args, context) {
    output(context, await context.call('quirky.accounts/describeRemove', {
      provider: stringFlag(args, context, 'provider'),
      accountId: stringFlag(args, context, 'account-id')
    }))
  },

  async preferences(args, context) {
    const patch = objectFlag(args, context, 'patch', false)
    if (patch === undefined) {
      const state = await context.call('quirky.accounts/list')
      output(context, state)
      return
    }
    output(context, await context.call('quirky.accounts/setPreferences', patch))
  },

  async 'ui-state'(_args, context) {
    output(context, await context.call('quirky.accounts/uiState'))
  },

  async 'ui-state-set'(args, context) {
    output(context, await context.call('quirky.accounts/setUiState', objectFlag(args, context, 'patch', true) ?? {}))
  },

  async prepare(args, context) {
    const resume = objectFlag(args, context, 'resume', false)
    const result = await context.call('quirky.accounts/prepare', {
      agent: stringFlag(args, context, 'agent'),
      sessionId: stringFlag(args, context, 'session-id'),
      worktreeId: stringFlag(args, context, 'worktree-id'),
      cwd: stringFlag(args, context, 'cwd'),
      homeOverrides: objectFlag(args, context, 'home-overrides', true),
      ...(resume === undefined ? {} : { resume })
    })
    if (typeof result === 'object' && result !== null && !Array.isArray(result)) {
      const record = result as Record<string, unknown>
      const env = typeof record.env === 'object' && record.env !== null ? Object.keys(record.env) : []
      const summary: Record<string, unknown> = {
        account: record.account,
        shellInit: record.shellInit !== null,
        environmentKeys: env
      }
      if (typeof record.resumeTranscriptPath === 'string') summary.resumeTranscriptPath = record.resumeTranscriptPath
      output(context, summary)
      return
    }
    output(context, result)
  },

  async prepareProviderEnv(args, context) {
    const result = await context.call('quirky.accounts/prepareProviderEnv', {
      agent: stringFlag(args, context, 'agent'),
      cwd: stringFlag(args, context, 'cwd'),
      homeOverrides: objectFlag(args, context, 'home-overrides', true)
    })
    if (typeof result === 'object' && result !== null && !Array.isArray(result)) {
      const record = result as Record<string, unknown>
      const env = typeof record.env === 'object' && record.env !== null ? Object.keys(record.env) : []
      output(context, {
        account: record.account,
        shellInit: record.shellInit !== null,
        environmentKeys: env
      })
      return
    }
    output(context, result)
  },

  async restart(args, context) {
    output(context, await context.call('quirky.accounts/restart', {
      sessions: stringListFlag(args, context, 'session'),
      selectionRevision: integerFlag(args, context, 'selection-revision')
    }))
  },

  async keep(args, context) {
    output(context, await context.call('quirky.accounts/keep', {
      sessions: stringListFlag(args, context, 'session'),
      selectionRevision: integerFlag(args, context, 'selection-revision')
    }))
  },

  async 'ingest-claude'(args, context) {
    const payloadFile = stringFlag(args, context, 'payload-file')
    let payload: unknown
    try {
      payload = JSON.parse(await context.readFile(payloadFile))
    } catch {
      throw context.usage('--payload-file must contain a JSON object')
    }
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) throw context.usage('--payload-file must contain a JSON object')
    output(context, await context.call('quirky.accounts/ingestClaude', {
      session: stringFlag(args, context, 'session'),
      configDir: stringFlag(args, context, 'config-dir'),
      payload
    }))
  },

  async 'credential-status'(_args, context) {
    output(context, await context.call('quirky.accounts/credentialStatus'))
  },

  async 'credential-set'(args, context) {
    const value = await secretFromInput(args, context)
    const status = await context.call('quirky.accounts/setCredential', {
      provider: stringFlag(args, context, 'provider'),
      kind: stringFlag(args, context, 'kind'),
      value
    })
    output(context, status)
  },

  async 'credential-clear'(args, context) {
    output(context, await context.call('quirky.accounts/clearCredential', {
      provider: stringFlag(args, context, 'provider'),
      kind: stringFlag(args, context, 'kind')
    }))
  },

  async 'reset-credit'(args, context) {
    const expectedScope = resetScope(args, context)
    output(context, await context.call('quirky.accounts/consumeResetCredit', {
      idempotencyKey: stringFlag(args, context, 'idempotency-key'),
      expectedScope
    }))
  },

  async 'describe-reset'(args, context) {
    const expectedScope = resetScope(args, context)
    output(context, await context.call('quirky.accounts/describeReset', {
      idempotencyKey: stringFlag(args, context, 'idempotency-key'),
      expectedScope
    }))
  }
}
