import { describe, expect, test } from 'bun:test'
import type { CliContext } from '@quirky/protocol'
import { commands } from '../cli'

function context() {
  let calls = 0
  const ctx: CliContext = {
    requestBase: 'automation-cli-test',
    async call() { calls++; return undefined },
    out: {
      json: false,
      result() {},
      line() {},
      jsonLine() {}
    },
    format: { table() { return '' }, record() { return '' } },
    env: {},
    cwd: '/tmp/project',
    async readFile() { throw new Error('unexpected file read') },
    async sleep() {},
    now() { return Date.now() },
    usage(message) { return Object.assign(new Error(message), { kind: 'usage' }) },
    fail(message) { return new Error(message) },
    async reconnect() {}
  }
  return { ctx, callCount: () => calls }
}

async function expectUsage(command: keyof typeof commands, positionals: string[], flags: Record<string, unknown>) {
  const fixture = context()
  await expect(commands[command]!({ positionals, flags }, fixture.ctx)).rejects.toMatchObject({ kind: 'usage' })
  expect(fixture.callCount()).toBe(0)
}

describe('automations CLI input errors', () => {
  test('rejects unsupported triggers, selector conflicts, unknown flags and raw agent args', async () => {
    const required = { name: 'x', prompt: 'p', provider: 'claude', project: 'repo-1' }
    await expectUsage('create', [], { ...required, trigger: 'manual' })
    await expectUsage('create', [], { ...required, trigger: 'daily', schedule: 'hourly' })
    await expectUsage('create', [], { ...required, trigger: 'daily', host: 'local' })
    await expectUsage('create', [], { ...required, trigger: 'daily', 'extra-agent-args': '--model opus' })
  })

  test('rejects preset-only flag misuse', async () => {
    const required = { name: 'x', prompt: 'p', provider: 'claude', project: 'repo-1' }
    await expectUsage('create', [], { ...required, trigger: 'hourly', time: '9:30' })
    await expectUsage('create', [], { ...required, trigger: 'daily', day: '2' })
    await expectUsage('create', [], { ...required, trigger: '30 * * * *', time: '9:30' })
  })

  test('rejects conflicting session and enabled switches and incomplete prechecks', async () => {
    const required = { name: 'x', prompt: 'p', provider: 'claude', project: 'repo-1', trigger: 'daily' }
    await expectUsage('create', [], { ...required, enabled: true, disabled: true })
    await expectUsage('create', [], { ...required, 'reuse-session': true, 'fresh-session': true })
    await expectUsage('create', [], { ...required, 'precheck-timeout': 30 })
    await expectUsage('create', [], { ...required, precheck: '', 'precheck-timeout': 30 })
  })

  test('rejects an unknown edit flag and missing positional IDs before API calls', async () => {
    await expectUsage('edit', ['automation-1'], { host: 'local' })
    await expectUsage('show', [], {})
    await expectUsage('run', [], {})
    await expectUsage('remove', [], {})
  })

  test('rejects unknown run-history flags before API calls', async () => {
    await expectUsage('runs', [], { mystery: true })
  })
})
