import { OWNED_MARKER, POST_IMPORTS, postSource } from './post.ts'

export const AMP_PLUGIN_FILE = 'quirky-agent-status.ts'

/** Amp's own plugin package; the generated file imports it, Quirky never does. */
const AMP_PLUGIN_PACKAGE = '@ampcode/plugin'

/** The Amp plugin: reports Amp's session, agent and tool events to the daemon. */
export function ampPluginSource(): string {
  return `// ${OWNED_MARKER}
${POST_IMPORTS}import type { PluginAPI } from ${JSON.stringify(AMP_PLUGIN_PACKAGE)}

${postSource("'amp'")}
const queue = quirkyQueue()

function preview(value, maxLength = 4000) {
  if (typeof value === 'string') return value.slice(0, maxLength)
  if (value === null || value === undefined) return undefined
  try {
    return JSON.stringify(value).slice(0, maxLength)
  } catch {
    return String(value).slice(0, maxLength)
  }
}

function jsonSafe(value, depth = 0) {
  if (value === null || value === undefined) return value
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint' || typeof value === 'symbol' || typeof value === 'function') return String(value)
  if (depth >= 4) return preview(value)
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => jsonSafe(item, depth + 1))
  if (typeof value === 'object') {
    const out = {}
    for (const [key, child] of Object.entries(value).slice(0, 20)) out[key] = jsonSafe(child, depth + 1)
    return out
  }
  return String(value)
}

function report(eventName, fields) {
  if (!process.env.QUIRKY_SESSION_ID) return
  queue.push(() => quirkyPost(eventName, fields))
}

// a throw inside a handler would reach Amp, so every handler is guarded
function on(amp: PluginAPI, name, handler, fallback) {
  amp.on(name, (event) => {
    try {
      return handler(event) ?? fallback
    } catch {
      return fallback
    }
  })
}

export default function (amp: PluginAPI) {
  on(amp, 'session.start', (event) => report('session.start', { threadId: event.thread.id }))

  on(amp, 'agent.start', (event) => report('agent.start', { threadId: event.thread.id, id: event.id, message: event.message }))

  on(
    amp,
    'tool.call',
    (event) => {
      report('tool.call', { threadId: event.thread.id, toolUseId: event.toolUseID, tool: event.tool, input: jsonSafe(event.input) })
    },
    { action: 'allow' }
  )

  on(amp, 'tool.result', (event) =>
    report('tool.result', {
      threadId: event.thread.id,
      toolUseId: event.toolUseID,
      tool: event.tool,
      input: jsonSafe(event.input),
      status: event.status,
      error: event.error,
      output: preview(event.output)
    })
  )

  on(amp, 'agent.end', (event) =>
    report('agent.end', { threadId: event.thread.id, id: event.id, message: event.message, status: event.status })
  )
}
`
}
