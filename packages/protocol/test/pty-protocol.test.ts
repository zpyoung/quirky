import { describe, expect, test } from 'bun:test'
import {
  PTY_PROTOCOL_VERSION,
  type ExitCause,
  type PluginLaunch,
  type PluginPty,
  type PtyEvent,
  type PtyFact,
  type PtyHistoryPage,
  type PtyRequest,
  type PtyResults,
  type PtySessionInfo,
  type PtySnapshot,
  type PtySubscription,
  type ShellState
} from '../src'

describe('pty protocol 3', () => {
  test('speaks version 3', () => {
    expect(PTY_PROTOCOL_VERSION).toBe(3)
  })

  test('shell states, exit causes and facts accept the documented values', () => {
    const shellStates = ['pending', 'ready', 'timed_out', 'unsupported'] as const satisfies readonly ShellState[]
    const causes = ['exited', 'killed', 'host-restart', 'host-lost'] as const satisfies readonly ExitCause[]
    const facts = [
      { kind: 'bell' },
      { kind: 'command-finished', exitCode: null },
      { kind: 'command-finished', exitCode: 2 },
      { kind: 'title', title: 'vim' },
      { kind: 'cwd', cwd: '/tmp' },
      { kind: 'prompt' },
      { kind: 'program-status', body: '?' }
    ] as const satisfies readonly PtyFact[]
    expect(shellStates).toHaveLength(4)
    expect(causes).toHaveLength(4)
    expect(facts.map((f) => f.kind)).toEqual([
      'bell',
      'command-finished',
      'command-finished',
      'title',
      'cwd',
      'prompt',
      'program-status'
    ])
  })

  test('requests, results and events accept the documented shapes', () => {
    const requests = [
      {
        id: 1,
        type: 'create',
        sessionId: 's_1',
        cwd: '/tmp',
        argv: ['zsh'],
        env: {},
        cols: 80,
        rows: 24,
        shellReady: true,
        shellReadyTimeoutMs: 15000,
        restore: false
      },
      { id: 2, type: 'kill', sessionId: 's_1', signal: 'SIGKILL', reason: 'killed' },
      { id: 3, type: 'subscribe', sessionId: 's_1', mode: 'screen', historyLines: 2000 },
      { id: 4, type: 'subscribe', sessionId: 's_1', mode: 'raw' },
      { id: 5, type: 'snapshot', sessionId: 's_1' },
      { id: 6, type: 'history', sessionId: 's_1', lines: 100, before: 'c1', format: 'ansi' },
      { id: 7, type: 'history', sessionId: 's_1' },
      { id: 8, type: 'clear', sessionId: 's_1' },
      { id: 9, type: 'resetModes', sessionId: 's_1' }
    ] as const satisfies readonly PtyRequest[]

    const subscription = {
      replay: '',
      offset: 0,
      historyCursor: null,
      cols: 80,
      rows: 24,
      shellState: 'pending',
      live: true
    } satisfies PtySubscription
    const snapshot = {
      ansi: '',
      cols: 80,
      rows: 24,
      cursor: { x: 0, y: 0 },
      modes: { alternateScreen: false, bracketedPaste: false, mouseTracking: false, applicationCursor: false },
      cwd: '/tmp',
      title: null,
      shellState: 'ready',
      offset: 0
    } satisfies PtySnapshot
    const page = { lines: [], cursor: null } satisfies PtyHistoryPage
    const info = {
      sessionId: 's_1',
      state: 'restorable',
      pid: 0,
      alive: false,
      exitCode: null,
      exitSignal: null,
      exitCause: 'host-lost',
      cols: 80,
      rows: 24,
      argv: ['zsh'],
      cwd: '/tmp',
      title: null,
      shellState: 'unsupported',
      createdAt: 0,
      offset: 0
    } satisfies PtySessionInfo
    const results = {
      create: { pid: 1, restored: false, cwd: '/tmp', cols: 80, rows: 24 },
      subscribe: subscription,
      snapshot,
      history: page,
      clear: {},
      resetModes: {},
      list: [info]
    } satisfies Partial<PtyResults>
    const events = [
      { type: 'exit', sessionId: 's_1', exitCode: 137, exitSignal: 'SIGKILL', exitCause: 'killed' },
      { type: 'fact', sessionId: 's_1', fact: { kind: 'bell' } }
    ] as const satisfies readonly PtyEvent[]

    expect(requests).toHaveLength(9)
    expect(Object.keys(results)).toHaveLength(7)
    expect(events.map((e) => e.type)).toEqual(['exit', 'fact'])
  })

  test('plugin listeners written for the old shapes still type-check', () => {
    const pty = {} as PluginPty
    const launch = {} as PluginLaunch
    const never = () => {
      pty.onExit((sessionId: string, exitCode: number | null) => void [sessionId, exitCode])
      pty.onExit((_sessionId, _exitCode, exit) => void (exit.exitCause satisfies ExitCause))
      pty.onFact((_sessionId, fact) => void (fact.kind satisfies PtyFact['kind']))
      pty.onInput((sessionId, data) => void [sessionId, data satisfies string])
      void (launch.shellReady() satisfies boolean)
    }
    expect(typeof never).toBe('function')
  })
})
