import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export function installGoalLoopNetworkGuard(preloadPath: string, logPath: string): string {
  const preload = resolve(preloadPath)
  const log = resolve(logPath)
  mkdirSync(dirname(preload), { recursive: true, mode: 0o700 })
  writeFileSync(preload, `const fs = require('node:fs')
const net = require('node:net')
const log = ${JSON.stringify(log)}
const marker = Symbol.for('quirky.goal-loop.fetch-guard')
if (!globalThis[marker]) {
  Object.defineProperty(globalThis, marker, { value: true })
  const upstream = globalThis.fetch
  globalThis.fetch = Object.assign(async (input, init) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    let url
    try { url = new URL(raw) } catch { throw new TypeError('invalid fetch URL refused by goal-loop fixture') }
    const host = url.hostname.toLowerCase()
    const loopback = host === 'localhost' || host === '[::1]' || host === '::1' || (net.isIP(host) === 4 && /^127\\./.test(host))
    if (!loopback) {
      fs.appendFileSync(log, url.href + '\\n', { mode: 0o600 })
      throw new TypeError('non-loopback fetch refused by goal-loop fixture')
    }
    return upstream(input, { ...init, redirect: 'manual' })
  }, { preconnect: upstream.preconnect })
}
`, { mode: 0o600 })
  return preload
}
