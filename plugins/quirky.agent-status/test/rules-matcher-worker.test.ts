import { afterEach, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { createProcessRunner, type OwnedProcessRunner } from '../../../packages/process/src/api'
import { readMatcherFrames } from '../src/rules/matcher-protocol'

const workerPath = fileURLToPath(new URL('../src/rules/matcher-worker.ts', import.meta.url))
const origin = { kind: 'built-in' as const, path: '/rules/fake.json' }
const encoder = new TextEncoder()
const runners: OwnedProcessRunner[] = []
let nextRunner = 0

afterEach(async () => {
  await Promise.all(runners.splice(0).map(runner => runner.dispose()))
})

function spawnWorker() {
  const runner = createProcessRunner({ owner: `agent-status-matcher-worker-test-${++nextRunner}` })
  runners.push(runner)
  const child = runner.spawn([process.execPath, workerPath], {
    timeoutMs: 5_000,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'ignore'
  })
  return child
}

async function readLine(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const decoder = new TextDecoder()
  let text = ''
  while (!text.includes('\n')) {
    const { value, done } = await reader.read()
    if (done) throw new Error('matcher worker closed stdout before a complete frame')
    text += decoder.decode(value, { stream: true })
  }
  const boundary = text.indexOf('\n')
  return { line: text.slice(0, boundary), remainder: text.slice(boundary + 1) }
}

async function readRemaining(reader: ReadableStreamDefaultReader<Uint8Array>, initialText: string): Promise<string> {
  const decoder = new TextDecoder()
  let text = initialText
  while (true) {
    const { value, done } = await reader.read()
    if (done) return text + decoder.decode()
    text += decoder.decode(value, { stream: true })
  }
}

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    }
  })
}

async function collectFrames(stream: ReadableStream<Uint8Array>): Promise<unknown[]> {
  const frames: unknown[] = []
  for await (const frame of readMatcherFrames(stream)) frames.push(frame)
  return frames
}

test('matcher worker speaks ordered JSONL over stdio without IPC', async () => {
  const child = spawnWorker()
  const reader = child.stdout.getReader()
  const { line: readyLine, remainder } = await readLine(reader)
  expect(readyLine).toBe('{"ready":true}')
  const lineRequest = {
    id: 7,
    op: 'line',
    pattern: 'All (\\d+) passed',
    ignoreCase: false,
    lines: ['x', 'All 12 passed']
  } as const
  const noMatchRequest = {
    id: 8,
    op: 'line',
    pattern: 'zzz',
    ignoreCase: false,
    lines: ['All 12 passed']
  } as const
  const evaluateRequest = {
    id: 9,
    op: 'evaluate',
    file: {
      agent: 'test',
      rules: [{ id: 'busy', state: 'working', region: 'screen', all: [{ regex: 'esc to interrupt' }] }]
    },
    input: { title: '', lines: ['esc to interrupt'], quietForMs: null },
    origin
  } as const
  const unicodeRequest = {
    id: 10,
    op: 'line',
    pattern: '尾🙂',
    ignoreCase: false,
    lines: ['尾🙂']
  } as const
  const combined = `${JSON.stringify(lineRequest)}\n${JSON.stringify(noMatchRequest)}\n`
  expect(await child.write(combined)).toBe(true)

  const split = `${JSON.stringify(evaluateRequest)}\n`
  const middle = Math.floor(split.length / 2)
  expect(await child.write(split.slice(0, middle))).toBe(true)
  expect(await child.write(split.slice(middle))).toBe(true)

  const unicodeFrame = `${JSON.stringify(unicodeRequest)}\n`
  const unicodeBytes = encoder.encode(unicodeFrame)
  const splitAt = encoder.encode(unicodeFrame.slice(0, unicodeFrame.indexOf('尾'))).length + 1
  expect(await child.write(unicodeBytes.slice(0, splitAt))).toBe(true)
  expect(await child.write(unicodeBytes.slice(splitAt))).toBe(true)
  await child.closeInput()

  expect((await child.exited).exitCode).toBe(0)
  const output = `${readyLine}\n${await readRemaining(reader, remainder)}`
  const replies = output.split('\n').filter(Boolean).map(line => JSON.parse(line))
  expect(replies).toEqual([
    { ready: true },
    { id: 7, result: { line: 'All 12 passed', match: 'All 12 passed', groups: ['12'] } },
    { id: 8, result: null },
    { id: 9, result: { verdict: { rule: 'busy', state: 'working', origin } } },
    { id: 10, result: { line: '尾🙂', match: '尾🙂', groups: [] } }
  ])
})

test('matcher worker rejects malformed, unknown, and incomplete input frames', async () => {
  const invalidInputs = [
    '{"id":1,\n',
    `${JSON.stringify({ id: 1, op: 'unknown' })}\n`,
    JSON.stringify({ id: 1, op: 'line', pattern: 'x', ignoreCase: false, lines: ['x'] }),
    '\n',
    new Uint8Array([0xff, 0x0a]),
  ]

  for (const input of invalidInputs) {
    const child = spawnWorker()
    await child.write(input)
    await child.closeInput()
    expect((await child.exited).exitCode).toBe(1)
    const output = await new Response(child.stdout).text()
    expect(output.split('\n').filter(Boolean)).toEqual(['{"ready":true}'])
  }
})

test('matcher frame reader handles combined and split frames, CRLF, and large split UTF-8 strings', async () => {
  const longValue = `${'a'.repeat(70_000)}尾🙂 "quoted" \\ path\nline`
  const complete = encoder.encode(`${JSON.stringify({ id: 1 })}\n${JSON.stringify({ id: 2 })}\r\n`)
  const fullFrame = encoder.encode(`${JSON.stringify({ value: longValue })}\n`)
  const prefix = encoder.encode(JSON.stringify({ value: 'a'.repeat(70_000) }).slice(0, -2))
  const suffixStart = prefix.length
  const suffixBytes = Array.from(fullFrame.slice(suffixStart), byte => new Uint8Array([byte]))
  const chunks = [complete, fullFrame.slice(0, suffixStart), ...suffixBytes]

  expect(await collectFrames(streamOf(chunks))).toEqual([
    { id: 1 },
    { id: 2 },
    { value: longValue }
  ])
})

test('matcher frame reader rejects blank, malformed UTF-8, and unfinished frames', async () => {
  await expect(collectFrames(streamOf([encoder.encode('\n')]))).rejects.toThrow()
  await expect(collectFrames(streamOf([new Uint8Array([0xff, 0x0a])]))).rejects.toThrow()
  await expect(collectFrames(streamOf([encoder.encode('{"id":1}')]))).rejects.toThrow()
})
