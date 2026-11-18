/** Written as the first line of the generated extension so install can tell the avatar's file from a user's. */
export const GATE_EXTENSION_MARKER = "Managed by Quirky's avatar. Do not edit; changes may be overwritten."

/** The extension's file name inside a pi or omp `extensions/` directory. */
export const GATE_EXTENSION_FILE = 'quirky-avatar-gate.ts'

/** How long the extension lets the daemon decide, under omp's 30-second `tool_call` budget. */
export const GATE_EXTENSION_DEADLINE_MS = 25_000

/**
 * Source of the pi and omp gate extension. Its `tool_call` handler lets a call through only when
 * the session has no supervision marker or the gate answers allow or passthrough. A deny, a held
 * or retry answer, an unreachable daemon, a bad reply and a timeout all block the call. Written as
 * plain JavaScript so it parses as TypeScript too.
 */
export function gateExtensionSource(): string {
  return `// ${GATE_EXTENSION_MARKER}
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const DEADLINE_MS = ${GATE_EXTENSION_DEADLINE_MS}
const UNAVAILABLE = "Quirky's avatar gate is unavailable; try again shortly."

function isOmpRuntime() {
  const names = [process.title, process.env._, process.argv[1], process.argv[0]].map((value) => String(value || '').split(/[\\\\/]/).pop().toLowerCase())
  return names.some((name) => ['omp', 'omp.js', 'omp.sh', 'omp.cmd', 'omp.exe', 'omp.bat'].includes(name))
}

function supervised() {
  const sessionId = process.env.QUIRKY_SESSION_ID
  const home = process.env.QUIRKY_HOME
  if (!sessionId || !home || /[\\\\/]/.test(sessionId) || sessionId.startsWith('.')) return false
  return existsSync(join(home, 'plugin-data', 'quirky.avatar', 'supervised', sessionId))
}

function gateBase() {
  try {
    const port = JSON.parse(readFileSync(join(process.env.QUIRKY_HOME, 'runtime.json'), 'utf8')).port
    if (Number.isInteger(port) && port > 0) return 'http://127.0.0.1:' + port + '/gate'
  } catch {}
  return (process.env.QUIRKY_HOOK_URL || '').replace(/\\/+$/, '').replace(/\\/hook$/, '/gate')
}

async function askGate(agent, payload) {
  const base = gateBase()
  if (!base) throw new Error('no daemon address')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DEADLINE_MS + 2000)
  try {
    const query = 'session=' + encodeURIComponent(process.env.QUIRKY_SESSION_ID) + '&event=tool_call&deadline=' + DEADLINE_MS
    const response = await fetch(base + '/' + agent + '?' + query, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', 'x-quirky-hook-token': process.env.QUIRKY_HOOK_TOKEN || '' },
      body: JSON.stringify(payload)
    })
    if (!response.ok) throw new Error('the gate answered ' + response.status)
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

function verdict(answer) {
  if (answer && (answer.decision === 'allow' || answer.decision === 'passthrough')) return undefined
  try {
    const encoded = JSON.parse(answer.encoded)
    if (encoded && encoded.block === true) return { block: true, reason: String(encoded.reason || UNAVAILABLE) }
  } catch {}
  return { block: true, reason: (answer && typeof answer.reason === 'string' && answer.reason) || UNAVAILABLE }
}

export default function (pi) {
  pi.on('tool_call', async (event, ctx) => {
    if (!supervised()) return undefined
    try {
      const answer = await askGate(isOmpRuntime() ? 'omp' : 'pi', {
        hook_event_name: 'tool_call',
        tool_name: event.toolName,
        tool_input: event.input,
        cwd: (ctx && ctx.cwd) || process.cwd()
      })
      return verdict(answer)
    } catch {
      return { block: true, reason: UNAVAILABLE }
    }
  })
}
`
}
