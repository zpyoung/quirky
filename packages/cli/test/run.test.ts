import { describe, expect, test } from 'bun:test'
import type { QuirkyClient } from '@quirky/protocol'
import { route } from '../src/commands'
import type { OpenResult } from '../src/commands/types'
import { createDaemonLink, type DaemonLink } from '../src/link'
import { run } from '../src/main'

function harness(open: OpenResult) {
  const out: string[] = []
  const err: string[] = []
  const link: DaemonLink = {
    requestBase: crypto.randomUUID(),
    call: () => Promise.resolve({ clients: [{ role: 'desktop' }] } as never),
    callAny: () => Promise.reject(new Error('daemon must not be contacted')),
    reconnect: async () => {},
    close: () => {}
  }
  const exec = (argv: string[]) =>
    run({
      argv,
      env: {},
      cwd: '/',
      platform: 'darwin',
      writer: { stdout: (text) => out.push(text), stderr: (text) => err.push(text) },
      link,
      openDesktopApp: async () => open
    })
  return { exec, out, err }
}

describe('route', () => {
  test('selects the longest matching command name and leaves the rest', () => {
    const target = route(['--json', 'plugin', 'enable', 'acme.tools', 'extra'])
    expect(target.kind).toBe('command')
    if (target.kind === 'command') {
      expect(target.command.name).toBe('plugin enable')
      expect(target.rest).toEqual(['--json', 'acme.tools', 'extra'])
    }
  })

  test('single-word commands stop at the first flag or positional', () => {
    const target = route(['status', '--json'])
    expect(target.kind === 'command' && target.command.name).toBe('status')
  })

  test('reports groups, unknown words and the empty invocation', () => {
    expect(route(['plugin']).kind).toBe('group')
    expect(route(['nope'])).toEqual({ kind: 'unknown', word: 'nope' })
    for (const word of ['repo', 'wt', 'worktree', 'session', 'term', 'terminal', 'ask']) {
      expect(route([word])).toEqual({ kind: 'unknown', word })
    }
    expect(route(['--json']).kind).toBe('top')
    expect(route([]).kind).toBe('top')
  })
})

describe('open', () => {
  test('reports desktop readiness as JSON', async () => {
    const { exec, out } = harness({ ok: true })
    expect(await exec(['open', '--json'])).toBe(0)
    expect(JSON.parse(out.join(''))).toEqual({ ready: true })
  })

  test('reconnects after the initial status read finds no daemon', async () => {
    let connects = 0
    let launches = 0
    const link = createDaemonLink(async () => {
      connects += 1
      if (connects === 1) throw new Error('quirkyd is not running')
      return {
        callAny: async () => ({ clients: [{ role: 'desktop' }] }),
        close() {}
      } as unknown as QuirkyClient
    })
    const out: string[] = []
    const err: string[] = []

    const code = await run({
      argv: ['open', '--json'],
      env: {},
      cwd: '/',
      platform: 'darwin',
      writer: { stdout: (text) => out.push(text), stderr: (text) => err.push(text) },
      link,
      openDesktopApp: async () => {
        launches += 1
        return { ok: true }
      }
    })

    expect(code).toBe(0)
    expect(JSON.parse(out.join(''))).toEqual({ ready: true })
    expect(launches).toBe(1)
    expect(connects).toBe(2)
    expect(err).toEqual([])
  })
})
