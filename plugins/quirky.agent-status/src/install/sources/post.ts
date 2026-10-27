/** Written as the first line of every generated file so install and remove can tell Quirky's files from a user's. */
export const OWNED_MARKER = 'Managed by Quirky. Do not edit; changes may be overwritten.'

/**
 * JavaScript shared by the generated JS and TS plugins: where the daemon's hook endpoint is,
 * a post that never throws, and a bounded serial queue. Plain untyped code so it parses as both.
 * `agentExpression` is JavaScript source for the agent name, so Pi and Oh My Pi can pick theirs at runtime.
 * The plugin does nothing outside a Quirky session.
 */
export function postSource(agentExpression: string): string {
  return `const QUIRKY_AGENT = ${agentExpression}
const QUIRKY_POST_TIMEOUT_MS = 1000
const QUIRKY_QUEUE_LIMIT = 50

function quirkyEndpoint() {
  const sessionId = process.env.QUIRKY_SESSION_ID
  if (!sessionId) return null
  let base = ''
  try {
    const home = process.env.QUIRKY_HOME
    const port = home ? JSON.parse(readFileSync(join(home, 'runtime.json'), 'utf8')).port : 0
    if (Number.isInteger(port) && port > 0) base = 'http://127.0.0.1:' + port + '/hook'
  } catch {}
  if (!base) base = (process.env.QUIRKY_HOOK_URL || '').replace(/\\/+$/, '')
  if (!base) return null
  return { url: base + '/' + QUIRKY_AGENT + '?session=' + encodeURIComponent(sessionId), token: process.env.QUIRKY_HOOK_TOKEN || '' }
}

async function quirkyPost(eventName, fields) {
  const endpoint = quirkyEndpoint()
  if (!endpoint) return false
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), QUIRKY_POST_TIMEOUT_MS)
  if (timer.unref) timer.unref()
  try {
    const response = await fetch(endpoint.url, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', 'x-quirky-hook-token': endpoint.token },
      body: JSON.stringify({ hook_event_name: eventName, ...fields })
    })
    return response.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

function quirkyQueue() {
  const tasks = []
  let draining = false
  async function drain() {
    if (draining) return
    draining = true
    try {
      while (tasks.length > 0) {
        const task = tasks.shift()
        try {
          await task()
        } catch {}
      }
    } finally {
      draining = false
    }
  }
  return {
    push(task) {
      if (tasks.length >= QUIRKY_QUEUE_LIMIT) tasks.shift()
      tasks.push(task)
      void drain()
    }
  }
}
`
}

export const POST_IMPORTS = `import { readFileSync } from 'node:fs'
import { join } from 'node:path'
`
