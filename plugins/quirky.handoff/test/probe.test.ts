import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { probeTranscript } from '../src/daemon/probe'

const MINUTE = 60_000
const BASE = Date.UTC(2026, 9, 27, 10, 0, 0)
const CWD = '/work/my.repo_1'
const FOLDER = '-work-my-repo-1'
const PROVIDER_ID = '0c1d2e3f-aaaa-bbbb-cccc-1234567890ab'

let home: string
let outside: string

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'probe-home-')))
  outside = realpathSync(mkdtempSync(join(tmpdir(), 'probe-outside-')))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

function put(path: string, at = BASE) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, '{}\n')
  utimesSync(path, new Date(at), new Date(at))
  return path
}

const claudeFile = (folder: string, name: string, at?: number) => put(join(home, '.claude', 'projects', folder, name), at)
const codexFile = (name: string, at?: number) => put(join(home, '.codex', 'sessions', '2026', '10', '27', name), at)

function probe(over: Partial<Parameters<typeof probeTranscript>[0]> = {}) {
  return probeTranscript({
    agent: 'claude',
    sessionId: 's_1',
    providerSessionId: null,
    reportedPath: null,
    cwd: CWD,
    history: [],
    claimed: new Set(),
    env: { HOME: home },
    ...over
  })
}

describe('reported path', () => {
  test('SC-25: a reported transcript inside the claude root is usable', async () => {
    const path = claudeFile(FOLDER, 'a.jsonl')
    expect(await probe({ reportedPath: path })).toEqual({ verdict: 'usable', path, reason: null, candidate: 'reported' })
  })

  test('a reported codex transcript inside the codex root is usable', async () => {
    const path = codexFile('rollout-2026-10-27T10-00-00-abc.jsonl')
    expect(await probe({ agent: 'codex', reportedPath: path })).toEqual({ verdict: 'usable', path, reason: null, candidate: 'reported' })
  })

  test('the usable path is the realpath', async () => {
    const real = claudeFile(FOLDER, 'a.jsonl')
    const link = join(home, '.claude', 'projects', FOLDER, 'link.jsonl')
    symlinkSync(real, link)
    expect(await probe({ reportedPath: link })).toMatchObject({ verdict: 'usable', path: real })
  })

  test('SC-30: a reported transcript that does not exist is unreachable', async () => {
    const path = join(home, '.claude', 'projects', FOLDER, 'gone.jsonl')
    mkdirSync(dirname(path), { recursive: true })
    expect(await probe({ reportedPath: path })).toEqual({ verdict: 'unreachable', path, reason: null, candidate: 'reported' })
  })

  test('a missing root makes a reported transcript unreachable', async () => {
    const path = join(home, '.claude', 'projects', FOLDER, 'gone.jsonl')
    expect(await probe({ reportedPath: path })).toMatchObject({ verdict: 'unreachable', candidate: 'reported' })
  })

  test('nothing reported and nothing found is none', async () => {
    expect(await probe()).toEqual({ verdict: 'none', path: null, reason: null, candidate: null })
  })
})

describe('refusals', () => {
  test('SC-29: a path outside the root is unverifiable', async () => {
    const path = put(join(outside, 'elsewhere.jsonl'))
    expect(await probe({ reportedPath: path })).toEqual({
      verdict: 'unverifiable',
      path,
      reason: 'path-outside-known-roots',
      candidate: 'reported'
    })
  })

  test('a missing path outside the root is unreachable, not a leak of existence', async () => {
    const path = join(outside, 'elsewhere.jsonl')
    expect(await probe({ reportedPath: path })).toMatchObject({ verdict: 'unreachable', path })
  })

  test('a path without the .jsonl suffix is unverifiable', async () => {
    const path = put(join(home, '.claude', 'projects', FOLDER, 'a.txt'))
    expect(await probe({ reportedPath: path })).toMatchObject({ verdict: 'unverifiable', reason: 'path-outside-known-roots' })
  })

  test('a symlink inside the root that leads outside is unverifiable', async () => {
    const target = put(join(outside, 'secret.jsonl'))
    const link = join(home, '.claude', 'projects', FOLDER, 'link.jsonl')
    mkdirSync(dirname(link), { recursive: true })
    symlinkSync(target, link)
    expect(await probe({ reportedPath: link })).toMatchObject({ verdict: 'unverifiable', reason: 'path-outside-known-roots' })
  })

  test('a dotted path that climbs out of the root is unverifiable', async () => {
    put(join(home, 'escape.jsonl'))
    const path = `${home}/.claude/projects/../../escape.jsonl`
    expect(await probe({ reportedPath: path })).toMatchObject({ verdict: 'unverifiable', reason: 'path-outside-known-roots' })
  })

  test('a sibling folder sharing the root prefix is outside the root', async () => {
    const path = put(join(home, '.claude', 'projects-old', 'a.jsonl'))
    expect(await probe({ reportedPath: path })).toMatchObject({ verdict: 'unverifiable', reason: 'path-outside-known-roots' })
  })

  test('an agent with no known root cannot discover a reported path', async () => {
    const path = put(join(outside, 'a.jsonl'))
    expect(await probe({ agent: 'gemini', reportedPath: path })).toEqual({
      verdict: 'unverifiable',
      path,
      reason: 'undiscoverable-path',
      candidate: 'reported'
    })
  })

  test('an agent with no known root and no path is none', async () => {
    expect(await probe({ agent: 'gemini', providerSessionId: PROVIDER_ID })).toMatchObject({ verdict: 'none' })
  })

  test('a stat error other than not-found is unverifiable', async () => {
    const dir = join(home, '.claude', 'projects', FOLDER)
    const path = join(dir, 'a.jsonl')
    put(path)
    const { chmodSync } = await import('node:fs')
    chmodSync(dir, 0)
    try {
      const result = await probe({ reportedPath: path })
      if (process.getuid?.() === 0) expect(result.verdict).toBe('usable')
      else expect(result).toMatchObject({ verdict: 'unverifiable', reason: 'stat-failed', path })
    } finally {
      chmodSync(dir, 0o755)
    }
  })

  test('a directory named like a transcript is unverifiable', async () => {
    const path = join(home, '.claude', 'projects', FOLDER, 'dir.jsonl')
    mkdirSync(path, { recursive: true })
    expect(await probe({ reportedPath: path })).toMatchObject({ verdict: 'unverifiable', reason: 'stat-failed' })
  })

  test('any thrown error is unverifiable', async () => {
    const result = await probe({ claimed: null as unknown as Set<string>, providerSessionId: null })
    expect(result.verdict).toBe('unverifiable')
    expect(result.reason).toBe('stat-failed')
  })

  test('the first refusal wins over a missing candidate', async () => {
    const refused = put(join(outside, 'a.jsonl'))
    const missing = join(home, '.claude', 'projects', FOLDER, 'gone.jsonl')
    expect(await probe({ reportedPath: missing, history: [refused] })).toMatchObject({
      verdict: 'unverifiable',
      path: refused,
      candidate: 'history'
    })
  })

  test('a refusal does not hide a later usable candidate', async () => {
    const refused = put(join(outside, 'a.jsonl'))
    const good = claudeFile(FOLDER, 'b.jsonl')
    expect(await probe({ reportedPath: refused, history: [good] })).toMatchObject({ verdict: 'usable', path: good, candidate: 'history' })
  })
})

describe('session id', () => {
  test('SC-26: a stale reported path is recovered by claude session id in another folder', async () => {
    const found = claudeFile('-elsewhere', `${PROVIDER_ID}.jsonl`)
    claudeFile('-elsewhere', 'other.jsonl')
    const stale = join(home, '.claude', 'projects', FOLDER, 'stale.jsonl')
    expect(await probe({ reportedPath: stale, providerSessionId: PROVIDER_ID })).toEqual({
      verdict: 'usable',
      path: found,
      reason: null,
      candidate: 'session-id'
    })
  })

  test('a reported path that is usable wins over the session id file', async () => {
    const reported = claudeFile(FOLDER, 'a.jsonl')
    claudeFile('-elsewhere', `${PROVIDER_ID}.jsonl`)
    expect(await probe({ reportedPath: reported, providerSessionId: PROVIDER_ID })).toMatchObject({ path: reported, candidate: 'reported' })
  })

  test('the newest claude file wins when the id is in two folders', async () => {
    claudeFile('-a', `${PROVIDER_ID}.jsonl`, BASE)
    const newer = claudeFile('-b', `${PROVIDER_ID}.jsonl`, BASE + MINUTE)
    expect(await probe({ providerSessionId: PROVIDER_ID })).toMatchObject({ path: newer, candidate: 'session-id' })
  })

  test('codex finds a rollout file by session id anywhere under sessions', async () => {
    const found = codexFile(`rollout-2026-10-27T10-00-00-${PROVIDER_ID}.jsonl`)
    codexFile('rollout-2026-10-27T10-00-00-other.jsonl')
    expect(await probe({ agent: 'codex', providerSessionId: PROVIDER_ID })).toMatchObject({
      verdict: 'usable',
      path: found,
      candidate: 'session-id'
    })
  })

  test('codex ignores a file whose name only ends with the id', async () => {
    codexFile(`notrollout-${PROVIDER_ID}.jsonl`)
    expect(await probe({ agent: 'codex', providerSessionId: PROVIDER_ID })).toMatchObject({ verdict: 'none' })
  })

  test('an id with path separators is never looked up', async () => {
    put(join(home, '.claude', 'secret.jsonl'))
    expect(await probe({ providerSessionId: '../secret' })).toMatchObject({ verdict: 'none' })
  })

  test('a session id match is not subject to the claimed set', async () => {
    const found = claudeFile('-elsewhere', `${PROVIDER_ID}.jsonl`)
    expect(await probe({ providerSessionId: PROVIDER_ID, claimed: new Set([found]) })).toMatchObject({ verdict: 'usable', path: found })
  })
})

describe('history', () => {
  test('SC-27: an earlier path that exists is used when the newest is not written yet', async () => {
    const p1 = claudeFile(FOLDER, 'p1.jsonl')
    const p2 = join(home, '.claude', 'projects', FOLDER, 'p2.jsonl')
    expect(await probe({ reportedPath: p2, history: [p2, p1] })).toEqual({ verdict: 'usable', path: p1, reason: null, candidate: 'history' })
  })

  test('the first usable history entry in order is used', async () => {
    const p1 = claudeFile(FOLDER, 'p1.jsonl')
    const p2 = claudeFile(FOLDER, 'p2.jsonl')
    expect(await probe({ history: [p2, p1] })).toMatchObject({ path: p2 })
  })

  test('history with only missing files is unreachable', async () => {
    const p1 = join(home, '.claude', 'projects', FOLDER, 'p1.jsonl')
    expect(await probe({ history: [p1] })).toMatchObject({ verdict: 'unreachable', path: p1, candidate: 'history' })
  })

  test('history is tried before the project scan', async () => {
    const p1 = claudeFile('-elsewhere', 'p1.jsonl')
    claudeFile(FOLDER, 'newest.jsonl', BASE + 30 * MINUTE)
    expect(await probe({ history: [p1] })).toMatchObject({ path: p1, candidate: 'history' })
  })
})

describe('project scan', () => {
  test('SC-28a: the newest file is used when the two newest are far apart', async () => {
    claudeFile(FOLDER, 'old.jsonl', BASE)
    const newest = claudeFile(FOLDER, 'new.jsonl', BASE + 20 * MINUTE)
    expect(await probe()).toEqual({ verdict: 'usable', path: newest, reason: null, candidate: 'project-scan' })
  })

  test('SC-28b: two files written within 5 minutes are withheld as ambiguous', async () => {
    claudeFile(FOLDER, 'a.jsonl', BASE + 18 * MINUTE)
    claudeFile(FOLDER, 'b.jsonl', BASE + 20 * MINUTE)
    expect(await probe()).toEqual({ verdict: 'none', path: null, reason: 'ambiguous', candidate: 'project-scan' })
  })

  test('exactly 300,000 ms apart is still ambiguous, one more millisecond is not', async () => {
    claudeFile(FOLDER, 'a.jsonl', BASE)
    claudeFile(FOLDER, 'b.jsonl', BASE + 5 * MINUTE)
    expect(await probe()).toMatchObject({ verdict: 'none', reason: 'ambiguous' })
    const c = claudeFile(FOLDER, 'c.jsonl', BASE + 10 * MINUTE + 1)
    expect(await probe()).toMatchObject({ verdict: 'usable', path: c })
  })

  test('a single file is used', async () => {
    const only = claudeFile(FOLDER, 'only.jsonl')
    expect(await probe()).toMatchObject({ verdict: 'usable', path: only, candidate: 'project-scan' })
  })

  test('a file another live session reported is never chosen', async () => {
    claudeFile(FOLDER, 'old.jsonl', BASE)
    const claimed = claudeFile(FOLDER, 'claimed.jsonl', BASE + 20 * MINUTE)
    expect(await probe({ claimed: new Set([claimed]) })).toMatchObject({ verdict: 'usable', path: join(home, '.claude', 'projects', FOLDER, 'old.jsonl') })
  })

  test('a claimed file does not count toward ambiguity', async () => {
    const old = claudeFile(FOLDER, 'old.jsonl', BASE)
    const claimed = claudeFile(FOLDER, 'claimed.jsonl', BASE + MINUTE)
    expect(await probe({ claimed: new Set([claimed]) })).toMatchObject({ verdict: 'usable', path: old })
  })

  test('a claimed file is matched through its realpath', async () => {
    const real = claudeFile(FOLDER, 'claimed.jsonl')
    const link = join(outside, 'link.jsonl')
    symlinkSync(real, link)
    expect(await probe({ claimed: new Set([link]) })).toMatchObject({ verdict: 'none' })
  })

  test('only .jsonl files count', async () => {
    claudeFile(FOLDER, 'notes.txt')
    expect(await probe()).toMatchObject({ verdict: 'none', reason: null })
  })

  test('an empty or missing project folder is none', async () => {
    expect(await probe()).toMatchObject({ verdict: 'none', candidate: null })
    mkdirSync(join(home, '.claude', 'projects', FOLDER), { recursive: true })
    expect(await probe()).toMatchObject({ verdict: 'none', candidate: null })
  })

  test('another workspace folder is not scanned', async () => {
    claudeFile('-work-other', 'a.jsonl')
    expect(await probe()).toMatchObject({ verdict: 'none' })
  })

  test('codex has no project scan', async () => {
    codexFile('rollout-2026-10-27T10-00-00-abc.jsonl')
    expect(await probe({ agent: 'codex' })).toMatchObject({ verdict: 'none' })
  })

  test('a missing reported path with an ambiguous scan is unreachable', async () => {
    claudeFile(FOLDER, 'a.jsonl', BASE)
    claudeFile(FOLDER, 'b.jsonl', BASE + MINUTE)
    const gone = join(home, '.claude', 'projects', FOLDER, 'gone.jsonl')
    expect(await probe({ reportedPath: gone })).toMatchObject({ verdict: 'unreachable', path: gone })
  })

  test('a missing reported path still lets the scan find the newest file', async () => {
    claudeFile(FOLDER, 'old.jsonl', BASE)
    const newest = claudeFile(FOLDER, 'new.jsonl', BASE + 20 * MINUTE)
    const gone = join(home, '.claude', 'projects', FOLDER, 'gone.jsonl')
    expect(await probe({ reportedPath: gone })).toMatchObject({ verdict: 'usable', path: newest, candidate: 'project-scan' })
  })
})

describe('roots', () => {
  test('CLAUDE_CONFIG_DIR replaces the claude root', async () => {
    const config = join(outside, 'claude-config')
    const path = put(join(config, 'projects', FOLDER, 'a.jsonl'))
    const defaultRoot = claudeFile(FOLDER, 'b.jsonl')
    expect(await probe({ env: { HOME: home, CLAUDE_CONFIG_DIR: config }, reportedPath: path })).toMatchObject({ verdict: 'usable', path })
    expect(await probe({ cwd: '/nowhere', env: { HOME: home, CLAUDE_CONFIG_DIR: config }, reportedPath: defaultRoot })).toMatchObject({
      verdict: 'unverifiable',
      reason: 'path-outside-known-roots'
    })
  })

  test('CODEX_HOME replaces the codex root', async () => {
    const codexHome = join(outside, 'codex-home')
    const path = put(join(codexHome, 'sessions', '2026', 'a.jsonl'))
    expect(await probe({ agent: 'codex', env: { HOME: home, CODEX_HOME: codexHome }, reportedPath: path })).toMatchObject({
      verdict: 'usable',
      path
    })
  })

  test('the session scan honours CLAUDE_CONFIG_DIR', async () => {
    const config = join(outside, 'claude-config')
    const path = put(join(config, 'projects', FOLDER, 'a.jsonl'))
    expect(await probe({ env: { HOME: home, CLAUDE_CONFIG_DIR: config } })).toMatchObject({ verdict: 'usable', path, candidate: 'project-scan' })
  })

  test('the injected HOME is used instead of the process HOME', async () => {
    const path = claudeFile(FOLDER, 'a.jsonl')
    const before = process.env.HOME
    process.env.HOME = outside
    try {
      expect(await probe({ reportedPath: path })).toMatchObject({ verdict: 'usable' })
    } finally {
      process.env.HOME = before
    }
  })
})
