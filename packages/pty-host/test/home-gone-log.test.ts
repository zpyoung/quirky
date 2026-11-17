import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { HistoryLog } from '../src/history/log'
import { onCleanup, runCleanups, tempHome } from './helpers'

afterEach(runCleanups)

describe('history log home guard', () => {
  test('create and openForAppend do not create paths when canWrite denies writes, and rotation disables', () => {
    const home = tempHome()
    const missing = join(home, 'missing')

    const created = HistoryLog.create(missing, { cols: 80, rows: 24, canWrite: () => false })
    onCleanup(() => created.close())
    expect(existsSync(missing)).toBe(false)
    expect(created.disabled).toBe(true)

    const opened = HistoryLog.openForAppend(missing, { cols: 80, rows: 24, canWrite: () => false })
    onCleanup(() => opened.close())
    expect(existsSync(missing)).toBe(false)
    expect(opened.disabled).toBe(true)

    let canWrite = true
    const rotatingDir = join(home, 'rotating')
    const rotating = HistoryLog.create(rotatingDir, {
      cols: 80,
      rows: 24,
      maxSegmentBytes: 256,
      canWrite: () => canWrite
    })
    onCleanup(() => rotating.close())
    canWrite = false
    rotating.appendOutput(new Uint8Array(1024))
    expect(existsSync(join(rotatingDir, 'output.1.log'))).toBe(false)
    expect(rotating.disabled).toBe(true)
  })

  test('disable closes an open log and makes later appends no-ops', () => {
    const dir = join(tempHome(), 'session')
    const log = HistoryLog.create(dir, { cols: 80, rows: 24 })
    onCleanup(() => log.close())
    const before = readFileSync(join(dir, 'output.log'))

    log.disable('home lost')
    log.appendOutput(new Uint8Array([1, 2, 3]))

    expect(log.disabled).toBe(true)
    expect(log.isOpen).toBe(false)
    expect(readFileSync(join(dir, 'output.log'))).toEqual(before)
  })
})
