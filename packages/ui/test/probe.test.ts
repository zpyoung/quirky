import { expect, test } from 'bun:test'
import { daemonAnswers } from '../src/lib/probe'

test('true when /health on the same origin answers ok', async () => {
  let requested = ''
  const fetcher = async (url: string) => {
    requested = url
    return new Response('{}', { status: 200 })
  }
  expect(await daemonAnswers('127.0.0.1:4000', fetcher)).toBe(true)
  expect(requested).toBe('http://127.0.0.1:4000/health')
})

test('false on a non-ok answer or a network failure', async () => {
  expect(await daemonAnswers('h', async () => new Response('no', { status: 500 }))).toBe(false)
  expect(
    await daemonAnswers('h', async () => {
      throw new Error('refused')
    })
  ).toBe(false)
})
