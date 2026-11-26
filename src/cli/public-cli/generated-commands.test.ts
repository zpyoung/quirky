import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { HandlerContext } from '../dispatch'
import type { RuntimeClient } from '../runtime-client'
import { ADMIN_PUBLIC_METHODS } from '../../shared/public-rpc/public-methods/admin'
import { definePublicMethod } from '../../shared/public-rpc/public-method-spec'
import { PUBLIC_METHOD_SPECS } from '../../shared/public-rpc/public-methods'
import { RuntimeClientError } from '../runtime/types'
import { exitCodeFor } from './exit-codes'
import { buildGeneratedCommands } from './generated-commands'

const renameSpec = definePublicMethod({
  method: 'widget.rename',
  cliPath: ['widget', 'rename'],
  summary: 'Rename a widget',
  stability: 'unstable',
  effect: 'mutate',
  params: z.object({
    widgetId: z.string(),
    newName: z.string(),
    count: z.number().int().optional(),
    dryRun: z.boolean().optional(),
    options: z.object({ a: z.string() }).optional()
  }),
  result: z.object({ id: z.string(), name: z.string(), revision: z.number() }),
  positionals: ['widgetId'],
  errors: ['not_found', 'invalid_argument']
})

const listSpec = definePublicMethod({
  method: 'widget.list',
  cliPath: ['widget', 'list'],
  summary: 'List widgets',
  stability: 'stable',
  effect: 'read',
  params: null,
  result: z.array(z.object({ id: z.string() })),
  errors: []
})

const removeSpec = definePublicMethod({
  method: 'widget.remove',
  cliPath: ['widget', 'remove'],
  summary: 'Remove a widget',
  stability: 'unstable',
  effect: 'mutate',
  params: z.object({ widgetId: z.string() }),
  result: z.object({ removed: z.boolean() }),
  positionals: ['widgetId'],
  destructive: { category: 'workspace-delete' },
  errors: ['not_found', 'needs_confirmation']
})

const watchSpec = definePublicMethod({
  method: 'widget.watch',
  cliPath: ['widget', 'watch'],
  summary: 'Watch widget changes',
  stability: 'unstable',
  effect: 'read',
  params: z.object({ since: z.number().optional() }),
  result: z.object({ type: z.string() }),
  streaming: true,
  errors: []
})

type FakeClient = {
  call: ReturnType<typeof vi.fn>
  stream: ReturnType<typeof vi.fn>
  isRemote: boolean
}

function fakeClient(overrides: Partial<FakeClient> = {}): FakeClient {
  return {
    call: vi.fn(async () => ({
      id: 'req-1',
      ok: true,
      result: { id: 'w1', name: 'x', revision: 2 },
      _meta: { runtimeId: 'runtime-1' }
    })),
    stream: vi.fn(async () => {}),
    isRemote: false,
    ...overrides
  }
}

function contextFor(
  client: FakeClient | (() => FakeClient),
  flags: Record<string, string | boolean>,
  extra: { json?: boolean; rawArgs?: string[] } = {}
): HandlerContext {
  const base = { flags: new Map(Object.entries(flags)), cwd: '/', json: extra.json ?? true }
  // SAFETY: handlers under test touch only call, stream and isRemote on the client
  const asClient = (value: FakeClient): RuntimeClient => value as unknown as RuntimeClient
  if (typeof client === 'function') {
    return {
      ...base,
      rawArgs: extra.rawArgs,
      get client() {
        return asClient(client())
      }
    }
  }
  return { ...base, rawArgs: extra.rawArgs, client: asClient(client) }
}

describe('buildGeneratedCommands', () => {
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    for (const key of [
      'QUIRKY_CALLER_ROLE',
      'QUIRKY_AGENT_SESSION_ID',
      'QUIRKY_WORKTREE_ID',
      'QUIRKY_TERMINAL_HANDLE'
    ]) {
      vi.stubEnv(key, '')
    }
  })

  afterEach(() => {
    logSpy.mockRestore()
    vi.unstubAllEnvs()
  })

  describe('spec mapping', () => {
    it('maps positionals, kebab-case flags and --params-json, and leaves nested params off the flags', () => {
      const { specs } = buildGeneratedCommands([renameSpec], new Set())
      expect(specs).toHaveLength(1)
      const [spec] = specs
      expect(spec.path).toEqual(['widget', 'rename'])
      expect(spec.summary).toBe('Rename a widget')
      expect(spec.positionalArgs).toEqual(['widget-id'])
      expect(spec.allowedFlags).toEqual(
        expect.arrayContaining([
          'widget-id',
          'new-name',
          'count',
          'dry-run',
          'params-json',
          'yes',
          'full'
        ])
      )
      expect(spec.allowedFlags).not.toContain('options')
      expect(spec.usage).toContain('<widget-id>')
      expect(spec.usage).toContain(' --new-name <value> ')
      expect(spec.usage).toContain('[--count <value>]')
      expect(spec.usage).toContain('[--dry-run]')
    })

    it('offers --yes only to commands that change state', () => {
      const { specs } = buildGeneratedCommands([listSpec, renameSpec], new Set())
      expect(specs.find((spec) => spec.path[1] === 'list')?.allowedFlags).not.toContain('yes')
      expect(specs.find((spec) => spec.path[1] === 'rename')?.allowedFlags).toContain('yes')
    })

    it('marks a destructive method destructive for typo recovery', () => {
      const { specs } = buildGeneratedCommands([removeSpec, listSpec], new Set())
      expect(specs.find((spec) => spec.path[1] === 'remove')?.destructive).toBe(true)
      expect(specs.find((spec) => spec.path[1] === 'list')?.destructive).toBeUndefined()
    })

    it('skips a spec whose path is already hand-written', () => {
      const { specs, handlers } = buildGeneratedCommands(
        [renameSpec, listSpec],
        new Set(['widget rename'])
      )
      expect(specs.map((spec) => spec.path.join(' '))).toEqual(['widget list'])
      expect(Object.keys(handlers)).toEqual(['widget list'])
    })

    it('builds a handler for every generated spec, keyed by the space-joined path', () => {
      const { specs, handlers } = buildGeneratedCommands(
        [renameSpec, listSpec, watchSpec],
        new Set()
      )
      expect(Object.keys(handlers).toSorted()).toEqual(
        specs.map((spec) => spec.path.join(' ')).toSorted()
      )
    })

    it('splits camelCase and acronym keys into kebab-case flags', () => {
      const spec = definePublicMethod({
        ...listSpec,
        cliPath: ['widget', 'find'],
        params: z.object({ worktreeID: z.string().optional(), sessionId: z.string().optional() })
      })
      const { specs } = buildGeneratedCommands([spec], new Set())
      expect(specs[0].allowedFlags).toEqual(expect.arrayContaining(['worktree-id', 'session-id']))
    })

    it('keeps a param that shadows a built-in flag reachable through --params-json only', async () => {
      const spec = definePublicMethod({
        ...listSpec,
        cliPath: ['widget', 'show'],
        params: z.object({ full: z.boolean().optional() })
      })
      const { specs, handlers } = buildGeneratedCommands([spec], new Set())
      expect(specs[0].allowedFlags.filter((flag) => flag === 'full')).toHaveLength(1)
      const client = fakeClient()
      await handlers['widget show'](contextFor(client, { 'params-json': '{"full":true}' }))
      expect(client.call.mock.calls[0][1]).toEqual({ full: true })
    })
  })

  describe('handler', () => {
    it('maps positionals, flags and --params-json into one params object and calls with the public contract', async () => {
      vi.stubEnv('QUIRKY_AGENT_SESSION_ID', 'session-9')
      const { handlers } = buildGeneratedCommands([renameSpec], new Set())
      const client = fakeClient()
      await handlers['widget rename'](
        contextFor(client, {
          'widget-id': 'w1',
          'new-name': 'fresh',
          count: '3',
          'dry-run': true,
          'params-json': '{"options":{"a":"b"}}'
        })
      )
      expect(client.call).toHaveBeenCalledWith(
        'widget.rename',
        { widgetId: 'w1', newName: 'fresh', count: 3, dryRun: true, options: { a: 'b' } },
        { publicContract: true, confirm: false, caller: { agentSessionId: 'session-9' } }
      )
    })

    it('lets a named flag override the same key in --params-json', async () => {
      const { handlers } = buildGeneratedCommands([renameSpec], new Set())
      const client = fakeClient()
      await handlers['widget rename'](
        contextFor(client, {
          'widget-id': 'w1',
          'new-name': 'from-flag',
          'params-json': '{"newName":"from-json"}'
        })
      )
      expect(client.call.mock.calls[0][1]).toMatchObject({ newName: 'from-flag' })
    })

    it('sends confirm: true when --yes is passed', async () => {
      const { handlers } = buildGeneratedCommands([renameSpec], new Set())
      const client = fakeClient()
      await handlers['widget rename'](
        contextFor(client, { 'widget-id': 'w1', 'new-name': 'n', yes: true })
      )
      expect(client.call.mock.calls[0][2]).toMatchObject({ publicContract: true, confirm: true })
    })

    it('sends no params for a method that takes none', async () => {
      const { handlers } = buildGeneratedCommands([listSpec], new Set())
      const client = fakeClient()
      await handlers['widget list'](contextFor(client, {}))
      expect(client.call.mock.calls[0][1]).toBeUndefined()
    })

    it('omits the caller when the environment names none', async () => {
      const { handlers } = buildGeneratedCommands([listSpec], new Set())
      const client = fakeClient()
      await handlers['widget list'](contextFor(client, {}))
      expect(client.call.mock.calls[0][2].caller).toBeUndefined()
    })

    it('prints the whole envelope as json', async () => {
      const { handlers } = buildGeneratedCommands([renameSpec], new Set())
      await handlers['widget rename'](
        contextFor(fakeClient(), { 'widget-id': 'w1', 'new-name': 'n' }, { json: true })
      )
      expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toMatchObject({
        ok: true,
        result: { id: 'w1', name: 'x', revision: 2 }
      })
    })

    it('prints the result as text outside json mode', async () => {
      const { handlers } = buildGeneratedCommands([renameSpec], new Set())
      await handlers['widget rename'](
        contextFor(fakeClient(), { 'widget-id': 'w1', 'new-name': 'n' }, { json: false })
      )
      expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toEqual({
        id: 'w1',
        name: 'x',
        revision: 2
      })
    })
  })

  describe('terse output', () => {
    const terseSpec = Object.assign(
      definePublicMethod({ ...renameSpec, cliPath: ['widget', 'terse'] }),
      { terse: ['id', 'revision'] }
    )

    it('keeps only the spec’s terse fields by default', async () => {
      const { handlers } = buildGeneratedCommands([terseSpec], new Set())
      await handlers['widget terse'](
        contextFor(fakeClient(), { 'widget-id': 'w1', 'new-name': 'n' })
      )
      expect(JSON.parse(String(logSpy.mock.calls[0][0])).result).toEqual({ id: 'w1', revision: 2 })
    })

    it('returns the whole result with --full', async () => {
      const { handlers } = buildGeneratedCommands([terseSpec], new Set())
      await handlers['widget terse'](
        contextFor(fakeClient(), { 'widget-id': 'w1', 'new-name': 'n', full: true })
      )
      expect(JSON.parse(String(logSpy.mock.calls[0][0])).result).toEqual({
        id: 'w1',
        name: 'x',
        revision: 2
      })
    })

    it('returns the whole result when the spec names no terse fields', async () => {
      const { handlers } = buildGeneratedCommands([renameSpec], new Set())
      await handlers['widget rename'](
        contextFor(fakeClient(), { 'widget-id': 'w1', 'new-name': 'n' })
      )
      expect(JSON.parse(String(logSpy.mock.calls[0][0])).result).toEqual({
        id: 'w1',
        name: 'x',
        revision: 2
      })
    })
  })

  describe('local validation', () => {
    it('rejects a missing required param with exit code 2 before any client exists', async () => {
      const { handlers } = buildGeneratedCommands([renameSpec], new Set())
      const makeClient = vi.fn(() => fakeClient())
      const error = await handlers['widget rename'](
        contextFor(makeClient, { 'widget-id': 'w1' })
      ).catch((caught: unknown) => caught)
      expect(error).toMatchObject({ code: 'invalid_argument' })
      expect(String((error as Error).message)).toContain('--new-name')
      expect(exitCodeFor(error)).toBe(2)
      expect(makeClient).not.toHaveBeenCalled()
    })

    it('names a missing positional in angle brackets', async () => {
      const { handlers } = buildGeneratedCommands([renameSpec], new Set())
      await expect(
        handlers['widget rename'](contextFor(fakeClient(), { 'new-name': 'n' }))
      ).rejects.toThrow('<widget-id>')
    })

    it('rejects a non-numeric value for a number flag', async () => {
      const { handlers } = buildGeneratedCommands([renameSpec], new Set())
      const client = fakeClient()
      const error = await handlers['widget rename'](
        contextFor(client, { 'widget-id': 'w1', 'new-name': 'n', count: 'many' })
      ).catch((caught: unknown) => caught)
      expect(exitCodeFor(error)).toBe(2)
      expect(client.call).not.toHaveBeenCalled()
    })

    it('rejects a fractional value the schema forbids', async () => {
      const { handlers } = buildGeneratedCommands([renameSpec], new Set())
      const error = await handlers['widget rename'](
        contextFor(fakeClient(), { 'widget-id': 'w1', 'new-name': 'n', count: '1.5' })
      ).catch((caught: unknown) => caught)
      expect(exitCodeFor(error)).toBe(2)
    })

    it('rejects a valueless string flag', async () => {
      const { handlers } = buildGeneratedCommands([renameSpec], new Set())
      const error = await handlers['widget rename'](
        contextFor(fakeClient(), { 'widget-id': 'w1', 'new-name': true })
      ).catch((caught: unknown) => caught)
      expect(exitCodeFor(error)).toBe(2)
    })

    it.each(['{not json', '[1,2]', '"text"'])('rejects --params-json %s', async (raw) => {
      const { handlers } = buildGeneratedCommands([renameSpec], new Set())
      const client = fakeClient()
      const error = await handlers['widget rename'](
        contextFor(client, { 'widget-id': 'w1', 'new-name': 'n', 'params-json': raw })
      ).catch((caught: unknown) => caught)
      expect(exitCodeFor(error)).toBe(2)
      expect(client.call).not.toHaveBeenCalled()
    })

    it('accepts false for a boolean flag written --dry-run=false', async () => {
      const { handlers } = buildGeneratedCommands([renameSpec], new Set())
      const client = fakeClient()
      await handlers['widget rename'](
        contextFor(client, { 'widget-id': 'w1', 'new-name': 'n', 'dry-run': 'false' })
      )
      expect(client.call.mock.calls[0][1]).toMatchObject({ dryRun: false })
    })
  })

  describe('transform-piped string params', () => {
    const pipedString = (message: string) =>
      z
        .unknown()
        .transform((v) => (typeof v === 'string' ? v : ''))
        .pipe(z.string().min(1, message))

    const readSpec = definePublicMethod({
      method: 'widget.read',
      cliPath: ['widget', 'read'],
      summary: 'Read a widget file',
      stability: 'unstable',
      effect: 'read',
      params: z.object({
        worktree: pipedString('Missing worktree'),
        relativePath: pipedString('Missing path'),
        depth: z.number().optional().default(1)
      }),
      result: z.unknown(),
      positionals: ['relativePath'],
      errors: []
    })

    it('exposes them as plain string flags and positionals instead of --params-json only', () => {
      const { specs } = buildGeneratedCommands([readSpec], new Set())
      expect(specs[0].positionalArgs).toEqual(['relative-path'])
      expect(specs[0].allowedFlags).toEqual(expect.arrayContaining(['worktree', 'depth']))
      expect(specs[0].usage).toContain('--worktree <value>')
    })

    it('sends the flag and positional values as strings', async () => {
      const { handlers } = buildGeneratedCommands([readSpec], new Set())
      const client = fakeClient()
      await handlers['widget read'](
        contextFor(client, { worktree: 'id:repo::/w', 'relative-path': 'src/a.ts' })
      )
      expect(client.call.mock.calls[0][1]).toEqual({
        worktree: 'id:repo::/w',
        relativePath: 'src/a.ts'
      })
    })

    it('still rejects a missing required piped value', async () => {
      const { handlers } = buildGeneratedCommands([readSpec], new Set())
      const error = await handlers['widget read'](
        contextFor(fakeClient(), { worktree: 'id:repo::/w' })
      ).catch((caught: unknown) => caught)
      expect(exitCodeFor(error)).toBe(2)
      expect(String((error as Error).message)).toContain('<relative-path>')
    })

    it.each([
      ['file read', 'files.read'],
      ['file write', 'files.write'],
      ['file delete', 'files.delete'],
      ['file list', 'files.readDir']
    ])('maps `quirky %s` to a --worktree flag and a <relative-path> positional', (path, method) => {
      const publicSpec = ADMIN_PUBLIC_METHODS.find((candidate) => candidate.method === method)
      expect(publicSpec?.cliPath.join(' ')).toBe(path)
      const { specs } = buildGeneratedCommands(publicSpec ? [publicSpec] : [], new Set())
      expect(specs[0].positionalArgs).toEqual(['relative-path'])
      expect(specs[0].allowedFlags).toContain('worktree')
    })
  })

  describe('destructive methods', () => {
    it('lets the server gate a local call, sending confirm false without --yes', async () => {
      const { handlers } = buildGeneratedCommands([removeSpec], new Set())
      const client = fakeClient()
      await handlers['widget remove'](contextFor(client, { 'widget-id': 'w1' }))
      expect(client.call.mock.calls[0][2]).toMatchObject({ confirm: false })
    })

    it('sends a remote call to the server gate without a local refusal', async () => {
      const { handlers } = buildGeneratedCommands([removeSpec], new Set())
      const client = fakeClient({ isRemote: true })
      await handlers['widget remove'](
        contextFor(client, { 'widget-id': 'w1' }, { rawArgs: ['widget', 'remove', 'w1'] })
      )
      expect(client.call).toHaveBeenCalledWith(
        'widget.remove',
        { widgetId: 'w1' },
        { publicContract: true, confirm: false, caller: undefined }
      )
    })

    it('sends confirm true on a remote call once --yes is given', async () => {
      const { handlers } = buildGeneratedCommands([removeSpec], new Set())
      const client = fakeClient({ isRemote: true })
      await handlers['widget remove'](contextFor(client, { 'widget-id': 'w1', yes: true }))
      expect(client.call).toHaveBeenCalledWith(
        'widget.remove',
        { widgetId: 'w1' },
        { publicContract: true, confirm: true, caller: undefined }
      )
    })
  })

  describe('streaming', () => {
    it('prints one json line per frame and does not use call', async () => {
      const { handlers } = buildGeneratedCommands([watchSpec], new Set())
      const client = fakeClient({
        stream: vi.fn(
          async (_method: string, _params: unknown, onFrame: (frame: unknown) => void) => {
            onFrame({ type: 'a' })
            onFrame({ type: 'b' })
          }
        )
      })
      await handlers['widget watch'](contextFor(client, { since: '4' }))
      expect(client.call).not.toHaveBeenCalled()
      expect(client.stream).toHaveBeenCalledWith(
        'widget.watch',
        { since: 4 },
        expect.any(Function),
        { publicContract: true, caller: undefined }
      )
      expect(logSpy.mock.calls.map((call) => String(call[0]))).toEqual([
        '{"type":"a"}',
        '{"type":"b"}'
      ])
    })

    it('does not offer --full on a stream', () => {
      const { specs } = buildGeneratedCommands([watchSpec], new Set())
      expect(specs[0].allowedFlags).not.toContain('full')
    })
  })

  describe('layout apply', () => {
    it('is generated in every build, not only a layout-owner one', () => {
      const { specs, handlers } = buildGeneratedCommands(PUBLIC_METHOD_SPECS, new Set())
      expect(specs.some((spec) => spec.path.join(' ') === 'layout apply')).toBe(true)
      expect(handlers['layout apply']).toBeDefined()
    })

    it('reports unavailable, exit 6, when the runtime does not register it', async () => {
      const { handlers } = buildGeneratedCommands(PUBLIC_METHOD_SPECS, new Set())
      const client = fakeClient({
        call: vi.fn(async () => {
          throw new RuntimeClientError('method_not_found', 'Unknown method')
        })
      })
      const error = await handlers['layout apply'](
        contextFor(client, {
          'params-json': JSON.stringify({
            command: { type: 'equalizePanes', workspace: 'w', tabId: 't' }
          })
        })
      ).catch((caught: unknown) => caught)
      expect(exitCodeFor(error)).toBe(6)
    })
  })
})
