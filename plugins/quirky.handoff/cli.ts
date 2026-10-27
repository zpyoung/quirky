import type { CliContext, CliModule } from '@quirky/protocol'

type Template = { id: string; name: string; body: string }
type Catalog = { templates: Template[]; custom: boolean }
type Preview = {
  brief: string
  characters: number
  tokens: number
  warnings: { code: string; message: string }[]
}

type Started = {
  child: { session: string; tab: string; worktreeId: string }
  lineageId: string | null
  worktreeCreated: string | null
  delivery: string
}
type LineageRecord = {
  id: string
  relationship: string
  parent: { session: string | null; agent: string | null }
  child: { session: string | null; agent: string | null }
}

const flagText = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

async function sourceOf(args: Parameters<CliModule['commands'][string]>[0], ctx: CliContext): Promise<Record<string, unknown>> {
  const { flags } = args
  const session = args.positionals[0]
  const agent = flagText(flags['source-agent'])
  if (session !== undefined && agent !== undefined) throw ctx.usage('pass a session or --source-agent, not both')
  if (session !== undefined) return { session }
  if (agent === undefined) throw ctx.usage('missing <session> or --source-agent')
  const archived: Record<string, unknown> = { agent }
  const fields: [string, string][] = [
    ['provider-session', 'providerSessionId'],
    ['transcript', 'transcriptPath'],
    ['last-message', 'lastMessage'],
    ['title', 'title'],
    ['cwd', 'cwd']
  ]
  for (const [flag, param] of fields) {
    const value = flagText(flags[flag])
    if (value !== undefined) archived[param] = value
  }
  return { archived }
}

async function controlsOf(args: Parameters<CliModule['commands'][string]>[0], ctx: CliContext): Promise<Record<string, unknown>> {
  const { flags } = args
  const worktree = flagText(flags.worktree)
  const created = flagText(flags['new-worktree'])
  if (worktree !== undefined && created !== undefined) throw ctx.usage('pass --worktree or --new-worktree, not both')
  const controls: Record<string, unknown> = {
    include: {
      repoState: flags['no-repo-state'] !== true,
      diffBodies: flags['diff-bodies'] === true,
      openEditorTabs: flags['no-editor-tabs'] !== true
    }
  }
  if (worktree !== undefined) {
    const resolved = (await ctx.call('quirky.worktree/resolve', { selector: worktree })) as { id: string }
    controls.target = { worktree: resolved.id }
  } else if (created !== undefined) {
    const base = flagText(flags.base)
    controls.target = { create: { name: created, ...(base === undefined ? {} : { base }) } }
  }
  for (const key of ['agent', 'relationship', 'context', 'note'] as const) {
    const value = flagText(flags[key])
    if (value !== undefined) controls[key] = value
  }
  const template = flagText(flags.template)
  if (template !== undefined) controls.templateId = template
  return controls
}

function describeCatalog(catalog: Catalog): string {
  return catalog.templates.map((template) => `${template.id}  ${template.name}`).join('\n')
}

async function mutate(ctx: CliContext, params: Record<string, unknown>) {
  const result = (await ctx.call('quirky.handoff/templateMutate', params)) as Catalog & { warnings: string[] }
  ctx.out.result(result, () =>
    [describeCatalog(result), ...result.warnings.map((warning) => `warning: ${warning}`)].filter(Boolean).join('\n')
  )
}

export const commands: CliModule['commands'] = {
  async preview(args, ctx) {
    const result = (await ctx.call('quirky.handoff/preview', {
      source: await sourceOf(args, ctx),
      controls: await controlsOf(args, ctx),
      recapture: true
    })) as Preview
    ctx.out.result(result, () =>
      [
        result.brief,
        '',
        `${result.characters} characters · about ${result.tokens} tokens`,
        ...result.warnings.map((warning) => `warning: ${warning.message}`)
      ].join('\n')
    )
  },

  async start(args, ctx) {
    const params: Record<string, unknown> = { source: await sourceOf(args, ctx), controls: await controlsOf(args, ctx), wait: args.flags.wait === true }
    const brief = flagText(args.flags.brief)
    if (brief !== undefined) params.body = brief.startsWith('@') ? await ctx.readFile(brief.slice(1)) : brief
    const result = (await ctx.call('quirky.handoff/start', params)) as Started
    ctx.out.result(result, () =>
      [
        `child: ${result.child.session} (tab ${result.child.tab}, worktree ${result.child.worktreeId})`,
        `lineage: ${result.lineageId ?? 'none'}`,
        `delivery: ${result.delivery}`
      ].join('\n')
    )
  },

  async resend(args, ctx) {
    const session = args.positionals[0]
    if (session === undefined) throw ctx.usage('missing <session>')
    const result = (await ctx.call('quirky.handoff/resend', { session })) as { delivery: string }
    ctx.out.result(result, () => `delivery: ${result.delivery}`)
  },

  async lineage(args, ctx) {
    const session = flagText(args.flags.session)
    const result = (await ctx.call('quirky.handoff/lineage', session === undefined ? {} : { session })) as { records: LineageRecord[] }
    ctx.out.result(result, () =>
      result.records.length === 0
        ? 'no handoffs'
        : ctx.format.table(
            ['ID', 'RELATIONSHIP', 'FROM', 'TO'],
            result.records.map((record) => [
              record.id,
              record.relationship,
              `${record.parent.session ?? 'archived'} (${record.parent.agent ?? '?'})`,
              `${record.child.session ?? 'none'} (${record.child.agent ?? '?'})`
            ])
          )
    )
  },

  async jump(args, ctx) {
    const session = args.positionals[0]
    if (session === undefined) throw ctx.usage('missing <session>')
    const lineage = flagText(args.flags.lineage)
    const result = (await ctx.call('quirky.handoff/jump', { session, ...(lineage === undefined ? {} : { lineage }) })) as {
      focused: { session: string; pane: string }
      lineageId: string
    }
    ctx.out.result(result, () => `focused ${result.focused.session} (pane ${result.focused.pane})`)
  },

  async 'templates-list'(_args, ctx) {
    const result = (await ctx.call('quirky.handoff/templates', {})) as Catalog & { limit: number }
    ctx.out.result(result, () => describeCatalog(result))
  },

  async 'templates-add'(args, ctx) {
    const { name, body } = args.flags
    if (typeof name !== 'string' || typeof body !== 'string') throw ctx.usage('missing --name or --body')
    await mutate(ctx, { op: 'add', template: { name, body } })
  },

  async 'templates-edit'(args, ctx) {
    const id = args.positionals[0]
    if (id === undefined) throw ctx.usage('missing <id>')
    const { name, body } = args.flags
    if (typeof name !== 'string' && typeof body !== 'string') throw ctx.usage('pass --name or --body')
    const { templates } = (await ctx.call('quirky.handoff/templates', {})) as Catalog
    const current = templates.find((template) => template.id === id)
    if (!current) throw ctx.fail(`no template ${id}`)
    await mutate(ctx, {
      op: 'update',
      template: { id, name: typeof name === 'string' ? name : current.name, body: typeof body === 'string' ? body : current.body }
    })
  },

  async 'templates-rm'(args, ctx) {
    const id = args.positionals[0]
    if (id === undefined) throw ctx.usage('missing <id>')
    await mutate(ctx, { op: 'remove', id })
  },

  async 'templates-reset'(_args, ctx) {
    await mutate(ctx, { op: 'reset' })
  }
}
