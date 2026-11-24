import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  isCommandGroup,
  normalizeCommandPositionals,
  parseArgs,
  validateCommandAndFlags
} from '../args'
import { dispatch, HANDLER_COMMAND_KEYS, type HandlerContext } from '../dispatch'
import { COMMAND_SPECS } from '../specs'
import { HEIMDALL_CHANNELS } from '../../shared/fork-heimdall/api'

const COMMAND_PATHS = COMMAND_SPECS.flatMap((spec) => [spec.path, ...(spec.aliases ?? [])])

afterEach(() => {
  vi.restoreAllMocks()
})

describe('quirky heimdall CLI registration', () => {
  it('normalizes the watcher id positional and accepts output flags', () => {
    const parsed = normalizeCommandPositionals(
      COMMAND_SPECS,
      parseArgs(['heimdall', 'debug', 'watcher-1', '--out', 'report.json', '--json'], COMMAND_PATHS)
    )

    expect(parsed.commandPath).toEqual(['heimdall', 'debug'])
    expect(parsed.flags.get('watcher-id')).toBe('watcher-1')
    expect(parsed.flags.get('out')).toBe('report.json')
    expect(parsed.flags.get('json')).toBe(true)
    expect(() => validateCommandAndFlags(COMMAND_SPECS, parsed)).not.toThrow()
  })

  it('normalizes the set-concurrency positionals', () => {
    const parsed = normalizeCommandPositionals(
      COMMAND_SPECS,
      parseArgs(['heimdall', 'set-concurrency', 'watcher-1', '3', '--json'], COMMAND_PATHS)
    )

    expect(parsed.commandPath).toEqual(['heimdall', 'set-concurrency'])
    expect(parsed.flags.get('watcher-id')).toBe('watcher-1')
    expect(parsed.flags.get('max-concurrency')).toBe('3')
    expect(parsed.flags.get('json')).toBe(true)
    expect(() => validateCommandAndFlags(COMMAND_SPECS, parsed)).not.toThrow()
  })

  it('accepts watcher management paths and their positionals', () => {
    const cases = [
      {
        argv: ['heimdall', 'list', '--kind', 'objective'],
        key: 'heimdall list',
        fields: { kind: 'objective' }
      },
      {
        argv: ['heimdall', 'show', 'watcher-1'],
        key: 'heimdall show',
        fields: { 'watcher-id': 'watcher-1' }
      },
      {
        argv: ['heimdall', 'objective', 'watcher-1'],
        key: 'heimdall objective',
        fields: { 'watcher-id': 'watcher-1' }
      },
      {
        argv: ['heimdall', 'create', 'objective', '--objective', 'Ship it'],
        key: 'heimdall create objective',
        fields: { objective: 'Ship it' }
      },
      {
        argv: ['heimdall', 'create', 'hosted-review'],
        key: 'heimdall create hosted-review',
        fields: {}
      },
      {
        argv: ['heimdall', 'pause', 'watcher-1'],
        key: 'heimdall pause',
        fields: { 'watcher-id': 'watcher-1' }
      },
      {
        argv: ['heimdall', 'resume', 'watcher-1'],
        key: 'heimdall resume',
        fields: { 'watcher-id': 'watcher-1' }
      },
      {
        argv: ['heimdall', 'disarm', 'watcher-1'],
        key: 'heimdall disarm',
        fields: { 'watcher-id': 'watcher-1' }
      },
      {
        argv: ['heimdall', 'rm', 'watcher-1'],
        key: 'heimdall rm',
        fields: { 'watcher-id': 'watcher-1' }
      },
      {
        argv: ['heimdall', 'approve', 'watcher-1', 'escalation-1'],
        key: 'heimdall approve',
        fields: { 'watcher-id': 'watcher-1', 'escalation-id': 'escalation-1' }
      },
      {
        argv: ['heimdall', 'answer', 'watcher-1', 'message-1', '--body', 'yes'],
        key: 'heimdall answer',
        fields: { 'watcher-id': 'watcher-1', 'message-id': 'message-1', body: 'yes' }
      },
      {
        argv: ['heimdall', 'answer-escalation', 'watcher-1', 'escalation-1', '--body', 'yes'],
        key: 'heimdall answer-escalation',
        fields: { 'watcher-id': 'watcher-1', 'escalation-id': 'escalation-1', body: 'yes' }
      },
      {
        argv: ['heimdall', 'stop-worker', 'watcher-1', 'dispatch-1'],
        key: 'heimdall stop-worker',
        fields: { 'watcher-id': 'watcher-1', 'dispatch-id': 'dispatch-1' }
      },
      {
        argv: ['heimdall', 'budget', 'watcher-1', '--hours', '1'],
        key: 'heimdall budget',
        fields: { 'watcher-id': 'watcher-1', hours: '1' }
      }
    ]
    for (const { argv, key, fields } of cases) {
      const parsed = normalizeCommandPositionals(COMMAND_SPECS, parseArgs(argv, COMMAND_PATHS))
      expect(parsed.commandPath.join(' ')).toBe(key)
      for (const [flag, value] of Object.entries(fields)) {
        expect(parsed.flags.get(flag)).toBe(value)
      }
      expect(() => validateCommandAndFlags(COMMAND_SPECS, parsed)).not.toThrow()
      expect(HANDLER_COMMAND_KEYS.has(key)).toBe(true)
    }
    expect(isCommandGroup(COMMAND_SPECS, ['heimdall'])).toBe(true)
    expect(isCommandGroup(COMMAND_SPECS, ['heimdall', 'create'])).toBe(true)
  })

  it('dispatches debug to the watcher owner selected from the fleet', async () => {
    const target = { watcherId: 'watcher-1', connectionId: 'connection-1', pairingRevision: 4 }
    const callMock = vi.fn(async (method: string) => ({
      id: 'request-1',
      ok: true,
      result:
        method === HEIMDALL_CHANNELS.fleet
          ? { entries: [{ target, ownerFence: { epoch: 'epoch-1' } }] }
          : { schemaVersion: 2 }
    }))
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const parsed = normalizeCommandPositionals(
      COMMAND_SPECS,
      parseArgs(['heimdall', 'debug', 'watcher-1'], COMMAND_PATHS)
    )
    const context: HandlerContext = {
      flags: parsed.flags,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: dispatch under test calls only client.call; RuntimeClient's other members are unused.
      client: { call: callMock } as unknown as HandlerContext['client'],
      cwd: '/repo',
      json: false
    }

    await dispatch(parsed.commandPath, context)

    expect(callMock).toHaveBeenCalledWith(HEIMDALL_CHANNELS.fleet, {})
    expect(callMock).toHaveBeenCalledWith(HEIMDALL_CHANNELS.debugReport, target)
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify({ schemaVersion: 2 }, null, 2))
  })
})
