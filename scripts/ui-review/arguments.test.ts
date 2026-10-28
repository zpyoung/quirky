import { describe, expect, test } from 'bun:test'
import { parseArguments } from './arguments'

const required = ['--author-family', 'openai', '--output', '/tmp/ui-review-run']


const rejects = (args: string[]) => expect(() => parseArguments(args)).toThrow()

describe('ui review argument parsing', () => {
  test('accepts the bun-run separator before explicit options', () => {
    expect(parseArguments(['--', ...required])).toMatchObject({
      mode: 'capture',
      authorFamily: 'openai',
      outputDir: '/tmp/ui-review-run'
    })
  })
  test('accepts threshold endpoints and finite interior values', () => {
    for (const threshold of ['0', '42.5', '100']) {
      expect(parseArguments([...required, '--threshold', threshold])).toMatchObject({ threshold: Number(threshold) })
    }
  })

  test('rejects out-of-range and non-finite thresholds', () => {
    for (const threshold of ['-0.01', '100.01', 'NaN', 'Infinity', '-Infinity', '']) {
      rejects([...required, '--threshold', threshold])
    }
  })

  test('requires an absolute output directory and author family', () => {
    rejects(['--output', '/tmp/ui-review-run'])
    rejects(['--author-family', 'openai', '--output', 'relative'])
    rejects(['--author-family', 'unknown', '--output', '/tmp/ui-review-run'])
    rejects(['--output', '/tmp/ui-review-run', '--capture-only'])
  })

  test('allows repeatable non-empty exact selectors', () => {
    expect(parseArguments([...required, '--only', 'quirky.tasks', '--only=host:shell'])).toMatchObject({
      only: ['quirky.tasks', 'host:shell']
    })
    rejects([...required, '--only', ''])
    rejects([...required, '--only', '   '])
  })

  test('rejects unknown arguments and duplicate singular flags', () => {
    rejects([...required, '--unknown'])
    rejects([...required, 'unexpected'])
    rejects([...required, '--threshold'])
    rejects([...required, '--threshold', '85', '--threshold', '90'])
    rejects([...required, '--output', '/tmp/another-run'])
    rejects([...required, '--capture-only', '--capture-only'])
  })

  test('rejects contradictory capture and review-only modes', () => {
    rejects([...required, '--capture-only', '--manifest', '/tmp/capture.json'])
    rejects([...required, '--manifest', '/tmp/capture.json', '--skip-build'])
    rejects([...required, '--manifest', '/tmp/capture.json', '--browser', '/usr/bin/chromium'])
    rejects([...required, '--manifest', '/tmp/capture.json', '--only', 'quirky.tasks'])
  })

  test('recognizes help without requiring runtime options', () => {
    expect(parseArguments(['--help'])).toEqual({ mode: 'help' })
  })
})
