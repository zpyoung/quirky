import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { CommandSpec } from '../command-spec'
import type { HandlerContext } from '../dispatch'
import { REPEATED_FLAG_SEPARATOR } from '../args'
import { definePublicMethod } from '../../shared/public-rpc/public-method-spec'
import { COMMAND_SPECS } from '../specs'
import { buildCommandSchema, buildSchemaIndex, createSchemaHandler } from './schema-command'

const respondSpec = definePublicMethod({
  method: 'chat.respond',
  cliPath: ['chat', 'respond'],
  summary: 'Answer a permission request or question in a chat session',
  stability: 'stable',
  effect: 'mutate',
  params: z.object({ session: z.string(), request: z.string(), allow: z.boolean().optional() }),
  result: z.object({ status: z.string() }),
  destructive: { category: 'permission-answers' },
  errors: ['not_found', 'conflict', 'needs_confirmation']
})

const SPECS: CommandSpec[] = [
  {
    path: ['status'],
    summary: 'Show app/runtime/graph readiness',
    usage: 'quirky status',
    allowedFlags: ['json', 'help']
  },
  {
    path: ['chat', 'respond'],
    summary: respondSpec.summary,
    usage: 'quirky chat respond',
    allowedFlags: ['json', 'session', 'request', 'allow', 'yes'],
    positionalArgs: ['session', 'request']
  },
  {
    path: ['chat', 'list'],
    summary: 'List chat sessions',
    usage: 'quirky chat list',
    allowedFlags: []
  },
  { path: ['secret'], hidden: true, summary: 'hidden', usage: 'quirky secret', allowedFlags: [] }
]

function lookup(path: readonly string[]) {
  return path.join(' ') === 'chat respond' ? respondSpec : undefined
}

function run(path: string[], json = false): Promise<void> {
  const flags = new Map<string, string | boolean>()
  if (path.length > 0) {
    flags.set('path', path.join(REPEATED_FLAG_SEPARATOR))
  }
  // SAFETY: the schema handler reads only flags and json; no client or cwd is touched
  const ctx = { flags, json, cwd: '/' } as unknown as HandlerContext
  return createSchemaHandler(() => SPECS, lookup)(ctx)
}

describe('quirky schema', () => {
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    logSpy.mockRestore()
  })

  function printed(): string {
    return logSpy.mock.calls.map((call) => String(call[0])).join('\n')
  }

  it('lists one sorted `<path>  <summary>` line per visible command', async () => {
    await run([])
    expect(printed().split('\n')).toEqual([
      'chat list  List chat sessions',
      `chat respond  ${respondSpec.summary}`,
      'status  Show app/runtime/graph readiness'
    ])
  })

  it('lists as json entries with --json', async () => {
    await run([], true)
    expect(JSON.parse(printed())).toEqual(buildSchemaIndex(SPECS))
  })

  it('prints the contract of a command that has a public spec', async () => {
    await run(['chat', 'respond'])
    const schema = JSON.parse(printed())
    expect(schema).toMatchObject({
      command: 'chat respond',
      method: 'chat.respond',
      stability: 'stable',
      destructive: true,
      approvalCategory: 'permission-answers',
      errors: ['not_found', 'conflict', 'needs_confirmation'],
      positionalArgs: ['session', 'request']
    })
    expect(schema.params.properties).toHaveProperty('session')
    expect(schema.params.required).toEqual(['session', 'request'])
    expect(schema.result.properties).toHaveProperty('status')
  })

  it('prints the flags of a hand-written command that has no public spec', async () => {
    await run(['status'])
    expect(JSON.parse(printed())).toMatchObject({
      command: 'status',
      params: null,
      result: null,
      stability: null,
      destructive: false,
      flags: []
    })
    expect(JSON.parse(printed())).not.toHaveProperty('method')
  })

  it('lists the commands under a group prefix', async () => {
    await run(['chat'])
    expect(printed().split('\n')).toEqual([
      'chat list  List chat sessions',
      `chat respond  ${respondSpec.summary}`
    ])
  })

  it('lists the commands under a group prefix as json entries with --json', async () => {
    await run(['chat'], true)
    expect(JSON.parse(printed())).toEqual([
      { command: 'chat list', summary: 'List chat sessions' },
      { command: 'chat respond', summary: respondSpec.summary }
    ])
  })

  it('rejects an unknown command as not_found with a next step', async () => {
    await expect(run(['nope'])).rejects.toMatchObject({
      code: 'not_found',
      data: { next: [{ command: 'quirky schema' }] }
    })
  })
})

describe('buildCommandSchema', () => {
  it('converts params as input and result as output JSON Schema', () => {
    const spec = definePublicMethod({
      ...respondSpec,
      params: z.object({ n: z.coerce.number() }),
      result: z.object({ at: z.string().default('now') })
    })
    const schema = buildCommandSchema(SPECS[1], spec)
    expect(schema.params).toMatchObject({ type: 'object', properties: { n: { type: 'number' } } })
    expect(schema.result).toMatchObject({ type: 'object', properties: { at: { type: 'string' } } })
  })

  it('reports a null params schema for a method that takes none', () => {
    const spec = definePublicMethod({ ...respondSpec, params: null })
    expect(buildCommandSchema(SPECS[1], spec).params).toBeNull()
  })
})

describe('the real command table', () => {
  it('registers schema, rpc and events as visible commands', () => {
    const paths = COMMAND_SPECS.map((spec) => spec.path.join(' '))
    expect(paths).toEqual(expect.arrayContaining(['schema', 'rpc', 'rpc list', 'events']))
  })
})
