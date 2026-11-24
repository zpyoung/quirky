import { describe, expect, it, vi } from 'vitest'
import { findCommandSpec, isCommandGroup, normalizeCommandPositionals, parseArgs } from '../args'
import { dispatch, type HandlerContext } from '../dispatch'
import { COMMAND_SPECS } from '../specs'

const COMMAND_PATHS = COMMAND_SPECS.flatMap((spec) => [spec.path, ...(spec.aliases ?? [])])

/**
 * `quirky ask` is a bare command AND a group prefix (`ask wait`, `ask cancel`) — the one
 * combination this codebase didn't already have a precedent for. These exercise the real
 * `parseArgs` -> `findCommandSpec` -> `dispatch` pipeline (not just ASK_HANDLERS directly) to
 * confirm the bare form still resolves once 'ask' registers its specs and supportsBrowserPageFlag.
 */
describe('quirky ask CLI registration (real parseArgs + dispatch)', () => {
  it('parses the bare form to commandPath ["ask"] with --spec/--timeout-ms/--chunk-ms as flags', () => {
    const parsed = normalizeCommandPositionals(
      COMMAND_SPECS,
      parseArgs(['ask', '--spec', '{"questions":[]}', '--timeout-ms', '5000'], COMMAND_PATHS)
    )
    expect(parsed.commandPath).toEqual(['ask'])
    expect(parsed.flags.get('spec')).toBe('{"questions":[]}')
    expect(parsed.flags.get('timeout-ms')).toBe('5000')
  })

  it('parses subcommands to their own commandPath, not swallowed by the bare group', () => {
    for (const [argv, expected] of [
      [
        ['ask', 'wait', '--id', 'ask_1'],
        ['ask', 'wait']
      ],
      [
        ['ask', 'cancel', '--id', 'ask_1'],
        ['ask', 'cancel']
      ]
    ] as const) {
      const parsed = normalizeCommandPositionals(COMMAND_SPECS, parseArgs([...argv], COMMAND_PATHS))
      expect(parsed.commandPath).toEqual(expected)
    }
  })

  it('resolves an exact CommandSpec for the bare form and both subcommands', () => {
    for (const path of [['ask'], ['ask', 'wait'], ['ask', 'cancel']]) {
      expect(findCommandSpec(COMMAND_SPECS, path)).toBeDefined()
    }
  })

  // Why: isCommandGroup only affects help-path fallbacks (help.ts/index.ts) when no exact
  // spec matches; with an exact 'ask' spec present, this must never shadow dispatch routing.
  it('marks ask as a command group without preventing the exact-spec match from winning', () => {
    expect(isCommandGroup(COMMAND_SPECS, ['ask'])).toBe(true)
    expect(findCommandSpec(COMMAND_SPECS, ['ask'])).toBeDefined()
  })

  it('dispatches the bare form to ASK_HANDLERS.ask, not "Unknown command"', async () => {
    const callMock = vi
      .fn()
      .mockResolvedValue({ result: { status: 'unavailable', reason: 'no surface' } })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const ctx: HandlerContext = {
      flags: new Map([['spec', '{"questions":[{"id":"go","type":"confirm","question":"Go?"}]}']]),
      client: { call: callMock } as unknown as HandlerContext['client'],
      cwd: '/repo',
      json: false
    }
    await expect(dispatch(['ask'], ctx)).resolves.toBeUndefined()
    expect(callMock).toHaveBeenCalledWith('ask.register', expect.any(Object))
    vi.mocked(console.log).mockRestore()
  })

  it('dispatches ask wait / ask cancel to their own handlers, not the bare one', async () => {
    const callMock = vi.fn().mockResolvedValue({
      result: { status: 'declined', askId: 'ask_1', answers: {}, skipped: [], summary: '' }
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const ctx: HandlerContext = {
      flags: new Map([['id', 'ask_1']]),
      client: { call: callMock } as unknown as HandlerContext['client'],
      cwd: '/repo',
      json: false
    }
    await dispatch(['ask', 'wait'], ctx)
    expect(callMock).toHaveBeenCalledWith('ask.wait', expect.any(Object), expect.any(Object))
    callMock.mockClear()
    await dispatch(['ask', 'cancel'], ctx)
    expect(callMock).toHaveBeenCalledWith('ask.cancel', { askId: 'ask_1' })
    vi.mocked(console.log).mockRestore()
  })
})
