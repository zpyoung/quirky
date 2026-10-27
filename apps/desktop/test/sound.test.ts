import { describe, expect, test } from 'bun:test'
import { playSound, type SpawnLike } from '../src/bun/sound'

type Call = { cmd: string[]; options: Record<string, unknown> }

function recorder() {
  const calls: Call[] = []
  let unrefs = 0
  const spawn: SpawnLike = (cmd, options) => {
    calls.push({ cmd, options })
    return { unref: () => void (unrefs += 1) }
  }
  return { calls, spawn, unrefs: () => unrefs }
}

describe('playSound', () => {
  test('SC-37: plays with afplay at volume/100 by default', () => {
    const { calls, spawn } = recorder()
    playSound('/sounds/bong.wav', 60, {}, spawn)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.cmd).toEqual(['afplay', '-v', '0.6', '/sounds/bong.wav'])
  })

  test('SC-41: QUIRKY_SOUND_PLAYER replaces afplay and receives file and volume', () => {
    const { calls, spawn } = recorder()
    playSound('/sounds/sonar.wav', 40, { QUIRKY_SOUND_PLAYER: '/tmp/recorder.sh' }, spawn)
    expect(calls[0]?.cmd).toEqual(['/tmp/recorder.sh', '/sounds/sonar.wav', '40'])
  })

  test('an empty QUIRKY_SOUND_PLAYER falls back to afplay', () => {
    const { calls, spawn } = recorder()
    playSound('/s.wav', 100, { QUIRKY_SOUND_PLAYER: '' }, spawn)
    expect(calls[0]?.cmd[0]).toBe('afplay')
  })

  test('ignores stdio and unrefs the child so it never holds the shell open', () => {
    const { calls, spawn, unrefs } = recorder()
    playSound('/s.wav', 50, {}, spawn)
    expect(calls[0]?.options).toMatchObject({ stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
    expect(unrefs()).toBe(1)
  })

  test('swallows a spawn failure', () => {
    const spawn: SpawnLike = () => {
      throw new Error('ENOENT')
    }
    expect(() => playSound('/s.wav', 50, {}, spawn)).not.toThrow()
  })

  test('returns synchronously without a promise, so callers cannot await playback', () => {
    const { spawn } = recorder()
    expect(playSound('/s.wav', 50, {}, spawn)).toBeUndefined()
  })

  test('clamps the afplay volume into 0..1', () => {
    const { calls, spawn } = recorder()
    playSound('/s.wav', 250, {}, spawn)
    playSound('/s.wav', -5, {}, spawn)
    expect(calls[0]?.cmd[2]).toBe('1')
    expect(calls[1]?.cmd[2]).toBe('0')
  })
})
