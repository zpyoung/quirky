import { describe, expect, test } from 'bun:test'
import { daemonUrl, errorPageHtml } from '../src/bun/page'

describe('daemonUrl', () => {
  test('puts the token in the hash', () => {
    expect(daemonUrl({ port: 4242, token: 'abc+/=' })).toBe('http://127.0.0.1:4242/#token=abc%2B%2F%3D')
  })
})

describe('errorPageHtml', () => {
  test('shows the escaped message and the log path', () => {
    const html = errorPageHtml('quirkyd <failed>', '/home/u/.quirky/logs/daemon.log')
    expect(html).toContain('quirkyd &lt;failed&gt;')
    expect(html).toContain('/home/u/.quirky/logs/daemon.log')
    expect(html).not.toContain('<failed>')
  })
})
