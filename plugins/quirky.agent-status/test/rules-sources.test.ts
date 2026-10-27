import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ContributionInfo } from '@quirky/protocol'
import { RuleSources, TIMED_OUT_REASON } from '../src/rules/sources'
import type { Rule, RuleState } from '../src/rules/types'

let root: string
let userDir: string
let builtinDir: string
let logs: string[]
let contributions: ContributionInfo[]
let contributionCalls: number

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rs-'))
  userDir = join(root, 'user')
  builtinDir = join(root, 'builtin')
  mkdirSync(userDir)
  mkdirSync(builtinDir)
  logs = []
  contributions = []
  contributionCalls = 0
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

const sources = () =>
  new RuleSources({
    userDir,
    builtinDir,
    contributions: async () => {
      contributionCalls += 1
      return contributions
    },
    log: (message) => logs.push(message),
  })

const rule = (id: string, text: string, state: RuleState = 'working'): Rule => ({ id, state, region: 'screen', all: [{ contains: text }] })
const body = (agent: string, ...rules: unknown[]) => JSON.stringify({ agent, rules })

/** Writes a file and pins its mtime, so a rewrite of the same size is still a visible change. */
function put(path: string, text: string, seconds = 1_000_000) {
  writeFileSync(path, text)
  utimesSync(path, seconds, seconds)
}

const contribution = (name: string, data: Record<string, unknown>, extra: Partial<ContributionInfo> = {}): ContributionInfo => ({
  id: `agent-rules:acme:${name}`,
  kind: 'agent-rules',
  name,
  plugin: 'acme',
  override: false,
  status: 'effective',
  data,
  ...extra,
})

describe('rule sources', () => {
  test('the built-in file is used when nothing overrides it', async () => {
    put(join(builtinDir, 'codex.json'), body('codex', rule('idle-composer', '>', 'idle')))
    const found = await sources().effective('codex')
    expect(found?.origin).toEqual({ kind: 'built-in', path: join(builtinDir, 'codex.json') })
    expect(found?.set.rules.map((r) => r.id)).toEqual(['idle-composer'])
  })

  test('an agent with no source has none', async () => {
    expect(await sources().effective('nosuch')).toBeNull()
  })

  test('an agent name that could leave the rules directory has no source', async () => {
    put(join(root, 'evil.json'), body('evil', rule('a', 'x')))
    expect(await sources().effective('../evil')).toBeNull()
    expect(await sources().effective('')).toBeNull()
  })

  test('SC-9: a user file replaces the whole built-in set', async () => {
    put(join(builtinDir, 'codex.json'), body('codex', rule('one', 'a'), rule('two', 'b')))
    const user = join(userDir, 'codex.json')
    put(user, body('codex', rule('held', 'custom marker', 'blocked')))
    const found = await sources().effective('codex')
    expect(found?.origin).toEqual({ kind: 'user', path: user })
    expect(found?.set.rules.map((r) => r.id)).toEqual(['held'])
  })

  test('SC-9: an edit is picked up when only the mtime changes', async () => {
    const user = join(userDir, 'codex.json')
    put(user, body('codex', rule('aaaa', 'x')), 1_000_000)
    const rules = sources()
    expect((await rules.effective('codex'))?.set.rules[0]!.id).toBe('aaaa')
    put(user, body('codex', rule('bbbb', 'x')), 1_000_050)
    expect((await rules.effective('codex'))?.set.rules[0]!.id).toBe('bbbb')
  })

  test('SC-9: an edit is picked up when only the size changes', async () => {
    const user = join(userDir, 'codex.json')
    put(user, body('codex', rule('a', 'x')))
    const rules = sources()
    expect((await rules.effective('codex'))?.set.rules).toHaveLength(1)
    put(user, body('codex', rule('a', 'x'), rule('b', 'y')))
    expect((await rules.effective('codex'))?.set.rules).toHaveLength(2)
  })

  test('SC-9: an unchanged file is not read again', async () => {
    const user = join(userDir, 'codex.json')
    put(user, body('codex', rule('a', 'x')))
    const rules = sources()
    const first = await rules.effective('codex')
    expect((await rules.effective('codex'))?.set).toBe(first!.set)
  })

  test('SC-9: deleting the user file brings the built-in rules back', async () => {
    put(join(builtinDir, 'codex.json'), body('codex', rule('builtin', 'a')))
    const user = join(userDir, 'codex.json')
    put(user, body('codex', rule('mine', 'b')))
    const rules = sources()
    expect((await rules.effective('codex'))?.origin.kind).toBe('user')
    unlinkSync(user)
    const back = await rules.effective('codex')
    expect(back?.origin.kind).toBe('built-in')
    expect(back?.set.rules[0]!.id).toBe('builtin')
  })

  test('creating a user file after the first read is picked up', async () => {
    put(join(builtinDir, 'codex.json'), body('codex', rule('builtin', 'a')))
    const rules = sources()
    expect((await rules.effective('codex'))?.origin.kind).toBe('built-in')
    put(join(userDir, 'codex.json'), body('codex', rule('mine', 'b')))
    expect((await rules.effective('codex'))?.origin.kind).toBe('user')
  })

  test('a missing user directory is not an error', async () => {
    rmSync(userDir, { recursive: true })
    put(join(builtinDir, 'codex.json'), body('codex', rule('builtin', 'a')))
    expect((await sources().effective('codex'))?.origin.kind).toBe('built-in')
  })
})

describe('invalid sources', () => {
  const invalid: [string, string, RegExp][] = [
    ['SC-10 (a): not JSON', '{ nope', /not valid JSON/],
    ['SC-10 (b): missing rules', JSON.stringify({ agent: 'codex' }), /rules/],
    ['SC-10 (c): a repeated variable group', body('codex', { id: 'r', state: 'idle', region: 'screen', all: [{ regex: '(a+)+$' }] }), /repeats a group that can match in more than one way/],
    ['SC-10 (d): a backreference', body('codex', { id: 'r', state: 'idle', region: 'screen', all: [{ regex: '(x)\\1' }] }), /backreference/],
    ['SC-10 (e): an unknown state', body('codex', { id: 'r', state: 'asleep', region: 'screen', all: [{ contains: 'x' }] }), /asleep/],
    ['a file for another agent', body('claude', rule('r', 'x')), /agent/],
  ]
  for (const [name, text, reason] of invalid) {
    test(`${name} is ignored and the built-in rules apply`, async () => {
      put(join(builtinDir, 'codex.json'), body('codex', rule('builtin', 'a')))
      const user = join(userDir, 'codex.json')
      put(user, text)
      const rules = sources()
      const found = await rules.effective('codex')
      expect(found?.origin.kind).toBe('built-in')
      const listing = (await rules.list()).find((entry) => entry.agent === 'codex')!
      expect(listing.origin?.kind).toBe('built-in')
      expect(listing.ignored).toHaveLength(1)
      expect(listing.ignored[0]!.origin).toEqual({ kind: 'user', path: user })
      expect(listing.ignored[0]!.reason).toMatch(reason)
    })
  }

  test('SC-10: the same warning comes from listing(), which explain reads', async () => {
    put(join(builtinDir, 'codex.json'), body('codex', rule('builtin', 'a')))
    put(join(userDir, 'codex.json'), '{ nope')
    const listing = await sources().listing('codex')
    expect(listing?.ignored[0]!.reason).toMatch(/not valid JSON/)
  })

  test('an ignored source is logged once per path and mtime', async () => {
    put(join(builtinDir, 'codex.json'), body('codex', rule('builtin', 'a')))
    const user = join(userDir, 'codex.json')
    put(user, '{ nope', 1_000_000)
    const rules = sources()
    await rules.effective('codex')
    await rules.effective('codex')
    await rules.list()
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain(user)
    expect(logs[0]).toContain('not valid JSON')
    put(user, '{ nope!', 1_000_100)
    await rules.effective('codex')
    expect(logs).toHaveLength(2)
  })

  test('an invalid user file with no fallback leaves the agent with no rules but listed', async () => {
    put(join(userDir, 'codex.json'), '{ nope')
    const rules = sources()
    expect(await rules.effective('codex')).toBeNull()
    expect(await rules.list()).toEqual([
      { agent: 'codex', origin: null, rules: 0, ignored: [{ origin: { kind: 'user', path: join(userDir, 'codex.json') }, reason: expect.stringContaining('not valid JSON') }] },
    ])
  })

  test('a source that cannot be read as a file is ignored without throwing', async () => {
    mkdirSync(join(userDir, 'codex.json'))
    put(join(builtinDir, 'codex.json'), body('codex', rule('builtin', 'a')))
    const rules = sources()
    expect((await rules.effective('codex'))?.origin.kind).toBe('built-in')
    expect((await rules.listing('codex'))?.ignored).toHaveLength(1)
  })

  test('a source path under something that is not a directory is ignored with its error code', async () => {
    put(join(builtinDir, 'codex.json'), body('codex', rule('builtin', 'a')))
    const rules = new RuleSources({ userDir: '/dev/null', builtinDir, contributions: async () => [], log: (message) => logs.push(message) })
    expect((await rules.effective('codex'))?.origin.kind).toBe('built-in')
    const listing = await rules.listing('codex')
    expect(listing?.ignored).toHaveLength(1)
    expect(listing?.ignored[0]!.reason).toContain('ENOTDIR')
    expect(await rules.list()).toHaveLength(1)
    await rules.effective('codex')
    expect(logs.filter((line) => line.includes('ENOTDIR'))).toHaveLength(1)
  })

  test('effective and list resolve to nothing when every source path is unusable', async () => {
    const rules = new RuleSources({ userDir: '/dev/null', builtinDir: '/dev/null', contributions: async () => [], log: (message) => logs.push(message) })
    expect(await rules.effective('fake')).toBeNull()
    expect(await rules.list()).toEqual([])
  })

  test.skipIf(process.getuid?.() === 0)('an unreadable file is ignored with its error code and the next source applies', async () => {
    put(join(builtinDir, 'codex.json'), body('codex', rule('builtin', 'a')))
    const user = join(userDir, 'codex.json')
    put(user, body('codex', rule('user', 'b')))
    chmodSync(user, 0o000)
    const rules = sources()
    expect((await rules.effective('codex'))?.origin.kind).toBe('built-in')
    const listing = await rules.listing('codex')
    expect(listing?.ignored[0]!.origin).toEqual({ kind: 'user', path: user })
    expect(listing?.ignored[0]!.reason).toContain('EACCES')
    chmodSync(user, 0o644)
    expect((await rules.effective('codex'))?.origin.kind).toBe('user')
  })

  test('an invalid built-in file is ignored too', async () => {
    put(join(builtinDir, 'codex.json'), '[]')
    const rules = sources()
    expect(await rules.effective('codex')).toBeNull()
    expect((await rules.listing('codex'))?.ignored[0]!.origin.kind).toBe('built-in')
  })
})

describe('plugin contributions', () => {
  test('SC-11: a contribution is the source when no user file exists, and the user file then wins', async () => {
    contributions = [contribution('aider', { rules: [rule('edits', 'Applied edit')], description: 'aider screens' })]
    const rules = sources()
    const first = await rules.effective('aider')
    expect(first?.origin).toEqual({ kind: 'plugin', plugin: 'acme', contribution: 'aider' })
    expect(first?.set).toEqual({ agent: 'aider', description: 'aider screens', rules: [rule('edits', 'Applied edit')] })

    const user = join(userDir, 'aider.json')
    put(user, body('aider', rule('mine', 'x')))
    const second = await rules.effective('aider')
    expect(second?.origin).toEqual({ kind: 'user', path: user })
  })

  test('a contribution outranks the built-in file', async () => {
    put(join(builtinDir, 'codex.json'), body('codex', rule('builtin', 'a')))
    contributions = [contribution('codex', { rules: [rule('plugin', 'b')] })]
    expect((await sources().effective('codex'))?.origin.kind).toBe('plugin')
  })

  test('only an effective agent-rules contribution counts', async () => {
    contributions = [
      contribution('a1', { rules: [rule('r', 'x')] }, { status: 'overridden' }),
      contribution('a2', { rules: [rule('r', 'x')] }, { status: 'disabled' }),
      contribution('a3', { rules: [rule('r', 'x')] }, { status: 'rejected' }),
      contribution('a4', { rules: [rule('r', 'x')] }, { kind: 'something-else' }),
    ]
    const rules = sources()
    for (const agent of ['a1', 'a2', 'a3', 'a4']) expect(await rules.effective(agent)).toBeNull()
    expect(await rules.list()).toEqual([])
  })

  test('an invalid contribution is ignored and the next source is used', async () => {
    put(join(builtinDir, 'aider.json'), body('aider', rule('builtin', 'a')))
    contributions = [contribution('aider', { rules: [{ id: 'r', state: 'asleep', region: 'screen', all: [{ contains: 'x' }] }] })]
    const rules = sources()
    expect((await rules.effective('aider'))?.origin.kind).toBe('built-in')
    const listing = await rules.listing('aider')
    expect(listing?.ignored[0]!.origin).toEqual({ kind: 'plugin', plugin: 'acme', contribution: 'aider' })
    expect(listing?.ignored[0]!.reason).toMatch(/asleep/)
    expect(logs).toHaveLength(1)
  })

  test('contributions are fetched once until invalidated', async () => {
    const rules = sources()
    await rules.effective('aider')
    await rules.effective('aider')
    await rules.list()
    expect(contributionCalls).toBe(1)
    contributions = [contribution('aider', { rules: [rule('r', 'x')] })]
    expect(await rules.effective('aider')).toBeNull()
    rules.invalidateContributions()
    expect((await rules.effective('aider'))?.origin.kind).toBe('plugin')
    expect(contributionCalls).toBe(2)
  })

  test('a failing contributions call is treated as none and not cached', async () => {
    let calls = 0
    const rules = new RuleSources({
      userDir,
      builtinDir,
      contributions: async () => {
        calls += 1
        if (calls === 1) throw new Error('daemon busy')
        return [contribution('aider', { rules: [rule('r', 'x')] })]
      },
      log: (message) => logs.push(message),
    })
    expect(await rules.effective('aider')).toBeNull()
    expect((await rules.effective('aider'))?.origin.kind).toBe('plugin')
  })
})

describe('listing', () => {
  test('SC-12: list covers every agent with any source, sorted, with its effective origin and rule count', async () => {
    put(join(builtinDir, 'codex.json'), body('codex', rule('a', 'x'), rule('b', 'y')))
    put(join(builtinDir, 'claude.json'), body('claude', rule('a', 'x')))
    put(join(userDir, 'claude.json'), body('claude', rule('a', 'x'), rule('b', 'y'), rule('c', 'z')))
    contributions = [contribution('aider', { rules: [rule('a', 'x')] })]
    writeFileSync(join(builtinDir, 'README.txt'), 'not a rule file')
    const listed = await sources().list()
    expect(listed.map((entry) => [entry.agent, entry.origin?.kind, entry.rules])).toEqual([
      ['aider', 'plugin', 1],
      ['claude', 'user', 3],
      ['codex', 'built-in', 2],
    ])
  })

  test('listing(agent) is null for an agent with no source', async () => {
    expect(await sources().listing('nosuch')).toBeNull()
  })
})

describe('sources whose patterns ran too long', () => {
  test('a source reported as timed out is ignored with the reason until its file changes', async () => {
    put(join(builtinDir, 'codex.json'), body('codex', rule('builtin', 'a')))
    const user = join(userDir, 'codex.json')
    put(user, body('codex', rule('slow', 'x')), 1_000_000)
    const rules = sources()
    const found = await rules.effective('codex')
    rules.reportTimeout(found!.origin, found!.version)

    const after = await rules.effective('codex')
    expect(after?.origin.kind).toBe('built-in')
    const listing = await rules.listing('codex')
    expect(listing?.ignored).toEqual([{ origin: { kind: 'user', path: user }, reason: TIMED_OUT_REASON }])
    expect(TIMED_OUT_REASON).toBe('a pattern ran longer than 250 ms')

    put(user, body('codex', rule('slow', 'x')), 1_000_100)
    expect((await rules.effective('codex'))?.origin.kind).toBe('user')
    expect((await rules.listing('codex'))?.ignored).toEqual([])
  })

  test('a timeout reported for an older version of the file does not blame the newer one', async () => {
    put(join(builtinDir, 'codex.json'), body('codex', rule('builtin', 'a')))
    const user = join(userDir, 'codex.json')
    put(user, body('codex', rule('slow', 'x')), 1_000_000)
    const rules = sources()
    const evaluated = await rules.effective('codex')

    put(user, body('codex', rule('corrected', 'y')), 1_000_100)
    expect((await rules.effective('codex'))?.set.rules[0]?.id).toBe('corrected')
    rules.reportTimeout(evaluated!.origin, evaluated!.version)

    const after = await rules.effective('codex')
    expect(after?.origin.kind).toBe('user')
    expect(after?.set.rules[0]?.id).toBe('corrected')
    expect((await rules.listing('codex'))?.ignored).toEqual([])
  })

  test('a timeout reported for contributions from before an invalidation is ignored', async () => {
    contributions = [contribution('aider', { rules: [rule('r', 'x')] })]
    const rules = sources()
    const evaluated = await rules.effective('aider')
    rules.invalidateContributions()
    rules.reportTimeout(evaluated!.origin, evaluated!.version)
    expect((await rules.effective('aider'))?.origin.kind).toBe('plugin')
  })

  test('a timed-out contribution stays ignored until contributions are invalidated', async () => {
    contributions = [contribution('aider', { rules: [rule('r', 'x')] })]
    const rules = sources()
    const found = await rules.effective('aider')
    rules.reportTimeout(found!.origin, found!.version)
    expect(await rules.effective('aider')).toBeNull()
    expect((await rules.listing('aider'))?.ignored[0]!.reason).toBe(TIMED_OUT_REASON)
    rules.invalidateContributions()
    expect((await rules.effective('aider'))?.origin.kind).toBe('plugin')
  })

  test('the timeout is logged once', async () => {
    const user = join(userDir, 'codex.json')
    put(user, body('codex', rule('slow', 'x')))
    const rules = sources()
    const slow = (await rules.effective('codex'))!
    rules.reportTimeout(slow.origin, slow.version)
    await rules.effective('codex')
    await rules.list()
    expect(logs.filter((line) => line.includes(TIMED_OUT_REASON))).toHaveLength(1)
  })
})
