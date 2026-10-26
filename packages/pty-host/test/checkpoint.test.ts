import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Checkpoint, readCheckpoint, writeCheckpoint } from '../src/history/checkpoint'
import { type SessionMeta, readMeta, writeMeta } from '../src/history/meta'

const roots: string[] = []
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qcp-'))
  roots.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const checkpoint: Checkpoint = {
  version: 1,
  offset: 1234,
  cols: 80,
  rows: 24,
  ansi: '\x1b[31mRED\x1b[0m\r\n',
  cwd: '/tmp/work',
  title: null,
  savedAt: 1_700_000_000_000
}

const meta: SessionMeta = {
  version: 1,
  sessionId: 'abc',
  argv: ['/bin/zsh', '-l'],
  startCwd: '/home/me',
  cwd: '/home/me/src',
  cols: 80,
  rows: 24,
  createdAt: 1_700_000_000_000,
  endedAt: null,
  exitCode: null,
  exitSignal: null,
  exitCause: null,
  restorable: false
}

describe('checkpoint file', () => {
  test('round trips and leaves no tmp file behind', () => {
    const dir = freshDir()
    writeCheckpoint(dir, checkpoint)
    expect(readCheckpoint(dir)).toEqual(checkpoint)
    writeCheckpoint(dir, { ...checkpoint, offset: 9, title: 'vim' })
    expect(readCheckpoint(dir)).toEqual({ ...checkpoint, offset: 9, title: 'vim' })
    expect(readdirSync(dir)).toEqual(['checkpoint.json'])
    expect(statSync(join(dir, 'checkpoint.json')).mode & 0o777).toBe(0o600)
  })

  test('is null for a missing, corrupt or wrong-shape file', () => {
    const dir = freshDir()
    expect(readCheckpoint(dir)).toBeNull()
    const path = join(dir, 'checkpoint.json')
    writeFileSync(path, '{not json')
    expect(readCheckpoint(dir)).toBeNull()
    writeFileSync(path, '[]')
    expect(readCheckpoint(dir)).toBeNull()
    writeFileSync(path, JSON.stringify({ ...checkpoint, version: 2 }))
    expect(readCheckpoint(dir)).toBeNull()
    writeFileSync(path, JSON.stringify({ ...checkpoint, offset: 'x' }))
    expect(readCheckpoint(dir)).toBeNull()
    writeFileSync(path, JSON.stringify({ ...checkpoint, offset: -1 }))
    expect(readCheckpoint(dir)).toBeNull()
    writeFileSync(path, JSON.stringify({ ...checkpoint, ansi: undefined }))
    expect(readCheckpoint(dir)).toBeNull()
    writeFileSync(path, JSON.stringify({ ...checkpoint, title: 5 }))
    expect(readCheckpoint(dir)).toBeNull()
  })

  test('a stale tmp file does not affect the committed checkpoint', () => {
    const dir = freshDir()
    writeCheckpoint(dir, checkpoint)
    writeFileSync(join(dir, 'checkpoint.json.tmp'), '{half')
    expect(readCheckpoint(dir)).toEqual(checkpoint)
    writeCheckpoint(dir, { ...checkpoint, offset: 5 })
    expect(readCheckpoint(dir)?.offset).toBe(5)
    expect(readdirSync(dir)).toEqual(['checkpoint.json'])
  })
})

describe('meta file', () => {
  test('round trips and leaves no tmp file behind', () => {
    const dir = freshDir()
    writeMeta(dir, meta)
    expect(readMeta(dir)).toEqual(meta)
    const ended: SessionMeta = { ...meta, endedAt: 1_700_000_100_000, exitCode: 0, exitCause: 'exited', restorable: true }
    writeMeta(dir, ended)
    expect(readMeta(dir)).toEqual(ended)
    expect(readdirSync(dir)).toEqual(['meta.json'])
    expect(statSync(join(dir, 'meta.json')).mode & 0o777).toBe(0o600)
  })

  test('is null for a missing, corrupt or wrong-shape file', () => {
    const dir = freshDir()
    expect(readMeta(dir)).toBeNull()
    const path = join(dir, 'meta.json')
    writeFileSync(path, 'nope')
    expect(readMeta(dir)).toBeNull()
    writeFileSync(path, JSON.stringify({ ...meta, argv: 'zsh' }))
    expect(readMeta(dir)).toBeNull()
    writeFileSync(path, JSON.stringify({ ...meta, exitCause: 'vanished' }))
    expect(readMeta(dir)).toBeNull()
    writeFileSync(path, JSON.stringify({ ...meta, restorable: 'yes' }))
    expect(readMeta(dir)).toBeNull()
  })

  test('works inside a nested directory created by the caller', () => {
    const dir = join(freshDir(), 'sessions', 'abc')
    mkdirSync(dir, { recursive: true })
    writeMeta(dir, meta)
    expect(readMeta(dir)?.sessionId).toBe('abc')
  })
})
