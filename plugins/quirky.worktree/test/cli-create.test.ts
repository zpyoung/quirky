import { describe, expect, test } from 'bun:test'
import type { CliContext, Worktree, WorktreeCreateResult } from '@quirky/protocol'
import { formatRecord, formatTable } from '../../../packages/cli/src/output'
import { commands } from '../cli'

const worktree = { id: 'wt_1', name: 'x', branch: 'zoe/x', path: '/w/api/x' } as Worktree

/** A CLI context whose daemon answers `result` and which records the call and the lines printed. */
function fakeContext(result: Partial<WorktreeCreateResult> = {}, json = false) {
  const calls: { method: string; params: Record<string, unknown> }[] = []
  const lines: string[] = []
  const ctx: CliContext = {
    call: async (method, params = {}) => {
      calls.push({ method, params })
      return { worktree, warnings: [], setup: { ran: 'none' }, ...result }
    },
    out: {
      json,
      result: (value, text) => lines.push(json ? JSON.stringify(value) : text()),
      line: (text) => lines.push(text),
      jsonLine: (value) => lines.push(JSON.stringify(value))
    },
    format: { table: formatTable, record: (pairs) => formatRecord(pairs) },
    env: {},
    cwd: '/',
    readFile: async () => '',
    sleep: async () => {},
    now: () => 0,
    usage: (message) => Object.assign(new Error(message), { kind: 'usage' }),
    fail: (message) => new Error(message),
    reconnect: async () => {}
  }
  return { ctx, calls, lines }
}

const run = async (positionals: string[], flags: Record<string, unknown> = {}, result: Partial<WorktreeCreateResult> = {}, json = false) => {
  const made = fakeContext(result, json)
  await commands.create!({ positionals, flags }, made.ctx)
  return made
}

describe('SC-14: the create command reads its positionals and flags', () => {
  test('two positionals are the project and the name; one is the name in the caller\'s project', async () => {
    expect((await run(['api', 'fix-login'])).calls[0]!.params).toEqual({ createdBy: 'cli', repo: 'api', name: 'fix-login' })
    expect((await run(['fix-login'])).calls[0]!.params).toEqual({ createdBy: 'cli', name: 'fix-login' })
    expect((await run([])).calls[0]!.params).toEqual({ createdBy: 'cli' })
    expect((await run(['fix-login'], { repo: 'api' })).calls[0]!.params).toEqual({ createdBy: 'cli', repo: 'api', name: 'fix-login' })
    expect((await run([], { repo: 'api', name: 'by-flag' })).calls[0]!.params).toEqual({ createdBy: 'cli', repo: 'api', name: 'by-flag' })
  })

  test('every flag maps onto its param, and createdBy is always cli', async () => {
    const { calls } = await run(['api', 'n'], {
      group: 'apps',
      base: 'origin/dev',
      github: '#3',
      branch: 'feat/x',
      'branch-name': 'mine',
      'display-name': 'Nice',
      comment: 'note',
      'parent-worktree': 'p',
      setup: 'run',
      'issue-command': 'skip',
      'trust-setup': true,
      'trust-issue-command': true,
      agent: 'claude',
      prompt: 'go',
      'no-fallback': true,
      activate: true
    })
    expect(calls[0]).toEqual({
      method: 'quirky.worktree/create',
      params: {
        createdBy: 'cli',
        repo: 'api',
        name: 'n',
        group: 'apps',
        github: '#3',
        base: 'origin/dev',
        branch: 'feat/x',
        branchName: 'mine',
        displayName: 'Nice',
        comment: 'note',
        parent: 'p',
        setup: 'run',
        agent: 'claude',
        issueCommand: 'skip',
        prompt: 'go',
        trustSetup: true,
        allowLocalBaseFallback: false,
        trustIssueCommand: true,
        activate: true
      }
    })
    expect((await run(['n'], { 'no-parent': true })).calls[0]!.params).toMatchObject({ noParent: true })
  })

  test('contradictory input is a usage error before anything is sent', async () => {
    for (const [positionals, flags] of [
      [['api', 'n'], { repo: 'x' }],
      [['n'], { name: 'm' }],
      [['a', 'b', 'c'], {}],
      [['n'], { 'parent-worktree': 'p', 'no-parent': true }]
    ] as const) {
      const made = fakeContext()
      await expect(commands.create!({ positionals: [...positionals], flags: { ...flags } }, made.ctx)).rejects.toMatchObject({ kind: 'usage' })
      expect(made.calls).toEqual([])
    }
  })

  test('the text output is the record, then each warning, the fallback notice, the setup outcome and the agent on their own lines', async () => {
    const { lines } = await run(
      ['api', 'x'],
      { agent: 'claude' },
      {
        warnings: ['docs was skipped', 'second'],
        baseFallback: { requestedRef: 'origin/main', localRef: 'main', message: 'used local main' },
        setup: { ran: 'terminal', sessionId: 's_1' },
        agentPending: true
      }
    )
    expect(lines).toHaveLength(1)
    expect(lines[0]!.split('\n')).toEqual([
      'id: wt_1',
      'name: x',
      'branch: zoe/x',
      'path: /w/api/x',
      'docs was skipped',
      'second',
      'used local main',
      'setup: running in the Setup terminal s_1',
      'agent: claude starts when setup finishes'
    ])
  })

  test('setup in the daemon reports its exit, and an uneventful create prints only the record', async () => {
    expect((await run(['x'], {}, { setup: { ran: 'daemon', exitCode: 0, timedOut: false } })).lines[0]!.split('\n').slice(4)).toEqual(['setup: ran in the daemon (exit 0)'])
    expect((await run(['x'], {}, { setup: { ran: 'daemon', exitCode: 3, timedOut: false } })).lines[0]).toContain('setup: failed in the daemon (exit 3)')
    expect((await run(['x'], {}, { setup: { ran: 'daemon', exitCode: null, timedOut: true } })).lines[0]).toContain('setup: timed out in the daemon')
    expect((await run(['x'], { agent: 'codex' }, { agentSessionId: 's_9' })).lines[0]).toContain('agent: started codex in session s_9')
    expect((await run(['x'], {}, { setup: { ran: 'skipped' } })).lines[0]!.split('\n')).toHaveLength(4)
  })
  test('the issue command outcome is included in CLI notes', async () => {
    expect((await run(['x'], {}, { issueCommand: { ran: 'terminal', sessionId: 's_issue' } })).lines[0]).toContain('issue command: running in the Issue terminal s_issue')
    expect((await run(['x'], {}, { issueCommand: { ran: 'daemon', exitCode: 4, timedOut: false } })).lines[0]).toContain('issue command: failed in the daemon (exit 4)')
  })

  test('--json prints the whole result', async () => {
    const { lines } = await run(['x'], {}, { warnings: ['w'] }, true)
    expect(JSON.parse(lines[0]!)).toEqual({ worktree, warnings: ['w'], setup: { ran: 'none' } })
  })
})
