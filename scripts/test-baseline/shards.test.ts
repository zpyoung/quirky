import { describe, expect, test } from 'bun:test'
import { MAX_SHARDS_MAIN, MAX_SHARDS_PR, SHARD_TARGET_MS, splitShards } from './shards'

const opts = { targetMs: 1000, maxShards: 4 }
const load = (shard: string[], durations: Record<string, number>) => shard.reduce((sum, file) => sum + durations[file]!, 0)

describe('splitShards', () => {
  test('uses the tech spec constants', () => {
    expect(SHARD_TARGET_MS).toBe(180000)
    expect(MAX_SHARDS_PR).toBe(6)
    expect(MAX_SHARDS_MAIN).toBe(12)
  })

  test('returns no shards for no files', () => {
    expect(splitShards([], {}, opts)).toEqual([])
  })

  test('keeps a small selection in one shard', () => {
    expect(splitShards(['a', 'b'], { a: 100, b: 200 }, opts)).toEqual([['b', 'a']])
  })

  test('sizes the shard count by total duration over the target', () => {
    const durations = { a: 900, b: 900, c: 900, d: 100 }
    expect(splitShards(Object.keys(durations), durations, opts)).toHaveLength(3)
  })

  test('balances longest first onto the least loaded shard', () => {
    const durations = { a: 700, b: 600, c: 500, d: 400, e: 300, f: 200 }
    const shards = splitShards(Object.keys(durations), durations, { targetMs: 1000, maxShards: 10 })
    expect(shards).toHaveLength(3)
    expect(shards.map((shard) => load(shard, durations))).toEqual([900, 900, 900])
    expect(shards.flat().sort()).toEqual(Object.keys(durations).sort())
  })

  test('caps the shard count at maxShards', () => {
    const durations = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`f${i}`, 1000]))
    const shards = splitShards(Object.keys(durations), durations, opts)
    expect(shards).toHaveLength(4)
    expect(shards.flat()).toHaveLength(20)
  })

  test('does not return empty shards when one file exceeds the target many times over', () => {
    expect(splitShards(['big'], { big: 10_000 }, opts)).toEqual([['big']])
  })

  test('counts a file with no recorded duration as the median of the known ones', () => {
    const durations = { a: 100, b: 300, c: 900 }
    const shards = splitShards(['a', 'b', 'c', 'new'], durations, { targetMs: 600, maxShards: 10 })
    // new = 300 so total 1600 -> 3 shards; c alone, then b and new tie for the next two
    expect(shards).toEqual([['c'], ['b', 'a'], ['new']])
  })

  test('uses 5000 ms for every file when no durations are known', () => {
    const shards = splitShards(['a', 'b', 'c'], {}, { targetMs: 5000, maxShards: 10 })
    expect(shards).toEqual([['a'], ['b'], ['c']])
  })

  test('is deterministic and breaks ties by path regardless of input order', () => {
    const durations = { a: 500, b: 500, c: 500, d: 500 }
    const forward = splitShards(['a', 'b', 'c', 'd'], durations, opts)
    const backward = splitShards(['d', 'c', 'b', 'a'], durations, opts)
    expect(backward).toEqual(forward)
    expect(forward).toEqual([['a', 'c'], ['b', 'd']])
  })

  test('puts every input file in exactly one shard', () => {
    const files = Array.from({ length: 37 }, (_, i) => `t${i}.test.ts`)
    const durations = Object.fromEntries(files.map((file, i) => [file, (i * 97) % 800]))
    const shards = splitShards(files, durations, { targetMs: 2000, maxShards: 6 })
    expect(shards.flat().sort()).toEqual([...files].sort())
  })
})
