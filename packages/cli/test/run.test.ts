import { describe, expect, test } from 'bun:test'
import { route } from '../src/commands'
import type { OpenResult } from '../src/commands/types'
import type { DaemonLink } from '../src/link'
import { run } from '../src/main'

function harness(open: OpenResult) {
  const out: string[] = []
  const err: string[] = []
  const link: DaemonLink = {
    call: () => Promise.reject(new Error('daemon must not be contacted')),
    reconnect: async () => {},
    close: () => {}
  }
  const exec = (argv: string[]) =>
    run({
      argv,
      env: {},
      cwd: '/',
      writer: { stdout: (text) => out.push(text), stderr: (text) => err.push(text) },
      link,
      openDesktopApp: async () => open
    })
  return { exec, out, err }
}

describe('route', () => {
  test('selects the longest matching command name and leaves the rest', () => {
    const target = route(['--json', 'wt', 'create', 'repo_1', 'name'])
    expect(target.kind).toBe('command')
    if (target.kind === 'command') {
      expect(target.command.name).toBe('wt create')
      expect(target.rest).toEqual(['--json', 'repo_1', 'name'])
    }
  })

  test('single-word commands stop at the first flag or positional', () => {
    const target = route(['status', '--json'])
    expect(target.kind === 'command' && target.command.name).toBe('status')
  })

  test('reports groups, unknown words and the empty invocation', () => {
    expect(route(['repo']).kind).toBe('group')
    expect(route(['nope'])).toEqual({ kind: 'unknown', word: 'nope' })
    expect(route(['--json']).kind).toBe('top')
    expect(route([]).kind).toBe('top')
  })
})

describe('open', () => {
  test('reports success', async () => {
    const { exec, out } = harness({ ok: true })
    expect(await exec(['open'])).toBe(0)
    expect(out.join('')).toContain('opened Quirky')
  })

  test('reports a missing app as a runtime error', async () => {
    const { exec, err } = harness({ ok: false, reason: 'the Quirky desktop app is not installed' })
    expect(await exec(['open'])).toBe(1)
    expect(err.join('')).toBe('quirky: the Quirky desktop app is not installed\n')
  })
})
