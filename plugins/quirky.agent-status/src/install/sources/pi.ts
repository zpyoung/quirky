import { OWNED_MARKER, POST_IMPORTS, postSource } from './post.ts'

export type PiAgentKind = 'pi' | 'omp' | 'prime-agent'

export const PI_EXTENSION_FILE = 'quirky-agent-status.ts'

/**
 * The Pi-family extension. Pi and Oh My Pi share one extension API and, when
 * `PI_CODING_AGENT_DIR` is set, one directory, so they share one file that reports as `omp` when
 * it finds itself running in Oh My Pi. Prime Agent has its own directory and reports as itself.
 */
export function piExtensionSource(kind: PiAgentKind): string {
  const prime = kind === 'prime-agent'
  const agentExpression = prime ? "'prime-agent'" : "isOmpRuntime() ? 'omp' : 'pi'"
  const ownerEnv = prime ? 'QUIRKY_PRIME_STATUS_OWNER' : 'QUIRKY_PI_STATUS_OWNER'
  return `// ${OWNED_MARKER}
${POST_IMPORTS}
function isOmpRuntime() {
  ${prime ? 'return false' : `const names = [process.title, process.env._, process.argv[1], process.argv[0]].map((value) => String(value || '').split(/[\\\\/]/).pop().toLowerCase())
  return names.some((name) => ['omp', 'omp.js', 'omp.sh', 'omp.cmd', 'omp.exe', 'omp.bat'].includes(name))`}
}

${postSource(agentExpression)}
const queue = quirkyQueue()
const CREDENTIAL_PATH = /(?:^|[^a-z0-9_.-])\\.(?:ssh|ssh-mcp)(?=$|[^a-z0-9_.-])|\\.mcp-secrets\\.env(?=$|[^a-z0-9_.-])/i
const MAX_DEPTH = 6
const MAX_ENTRIES = 50
const MAX_STRING = 8192

let sessionMetadata = {}
let modelMetadata = {}
let run = 0
let endPostedFor = -1
let turnInFlight = false
let uiPromptDepth = 0
let agentSettledSupported = false
let idleCheck = null

// tool input is shown in the status row, so it is copied with bounds and dropped whole if it names a credential path
function sanitizeToolInput(input) {
  function copy(value, depth) {
    if (typeof value === 'string') {
      if (CREDENTIAL_PATH.test(value.replace(/\\\\/g, '/'))) throw new Error('redact')
      return value.length > MAX_STRING ? value.slice(0, MAX_STRING) : value
    }
    if (value === null || value === undefined || typeof value === 'boolean') return value
    if (typeof value === 'number') return Number.isFinite(value) ? value : null
    if (typeof value !== 'object' || depth > MAX_DEPTH) throw new Error('redact')
    if (Array.isArray(value)) return value.slice(0, MAX_ENTRIES).map((item) => copy(item, depth + 1))
    const out = {}
    for (const [key, child] of Object.entries(value).slice(0, MAX_ENTRIES)) out[key] = copy(child, depth + 1)
    return out
  }
  try {
    return copy(input, 0)
  } catch {
    return { redacted: true }
  }
}

function assistantText(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((part) => (part?.type === 'text' && typeof part.text === 'string' ? part.text : '')).join('')
}

function updateMetadata(ctx) {
  const manager = ctx?.sessionManager
  const id = manager?.getSessionId?.()
  const file = manager?.getSessionFile?.()
  sessionMetadata = typeof id === 'string' && id ? { session_id: id, ...(typeof file === 'string' && file ? { session_file: file } : {}) } : {}
  updateModel(ctx)
}

function updateModel(source) {
  const model = source?.model
  if (model && typeof model.provider === 'string' && typeof model.id === 'string' && model.provider && model.id) {
    modelMetadata = { model: model.provider + '/' + model.id }
  }
}

function report(eventName, extra = {}) {
  if (!process.env.QUIRKY_SESSION_ID) return
  const body = { ...sessionMetadata, ...modelMetadata, ...extra }
  queue.push(() => quirkyPost(eventName, body))
}

function postAgentEnd(extra = {}) {
  if (endPostedFor === run) return
  endPostedFor = run
  turnInFlight = false
  uiPromptDepth = 0
  report('agent_end', extra)
}

function clearIdleCheck() {
  if (idleCheck !== null) clearTimeout(idleCheck)
  idleCheck = null
}

// Pi's agent_end can precede retries and compaction, so it is only a completion once the runner is idle
function checkIdle(ctx, delay) {
  idleCheck = setTimeout(() => {
    idleCheck = null
    if (agentSettledSupported || endPostedFor === run) return
    try {
      if (ctx.isIdle()) return postAgentEnd()
    } catch {
      return
    }
    checkIdle(ctx, Math.min(delay * 2, 250))
  }, delay)
  if (idleCheck.unref) idleCheck.unref()
}

function isStatusOwnerAlive(pid) {
  const parsed = Number(pid)
  if (!Number.isSafeInteger(parsed) || parsed < 1) return false
  try {
    process.kill(parsed, 0)
    return true
  } catch (error) {
    return error?.code !== 'ESRCH'
  }
}

export default function (pi) {
  ${prime ? "if (!process.env.PRIME_AGENT_INTERNAL_DAEMON_WORKER) return\n  " : ''}if (!process.env.QUIRKY_SESSION_ID) return
  // child agents inherit the lead's environment, so only the process that claimed it reports
  const owner = process.env.${ownerEnv}
  const self = String(process.pid)
  if (owner && owner !== self && isStatusOwnerAlive(owner)) return
  process.env.${ownerEnv} = self

  // a throw inside a handler would reach the host
  function onStatus(name, handler) {
    pi.on(name, (event, ctx) => {
      try {
        if (ctx) updateMetadata(ctx)
        handler(event ?? {}, ctx)
      } catch {}
    })
  }

${prime ? '' : `  function closeRun(event) {
    if (!turnInFlight) return
    postAgentEnd(event?.reason === 'fork' || event?.reason === 'resume' ? {} : { session_boundary: true })
  }

  onStatus('session_switch', (event) => {
    if (isOmpRuntime()) closeRun(event)
  })
  onStatus('session_branch', (event) => {
    if (isOmpRuntime()) closeRun(event)
  })
`}
  onStatus('session_start', (event) => {
    uiPromptDepth = 0
    if (event.reason === 'reload') return
    report('session_start')
  })

  onStatus('before_agent_start', (event) => report('before_agent_start', { prompt: event.prompt ?? '' }))

  onStatus('agent_start', () => {
    clearIdleCheck()
    run += 1
    turnInFlight = true
    uiPromptDepth = 0
    report('agent_start')
  })

  onStatus('tool_execution_start', (event) =>
    report('tool_execution_start', { tool_name: event.toolName, tool_input: sanitizeToolInput(event.args) })
  )
  onStatus('tool_call', (event) => report('tool_call', { tool_name: event.toolName, tool_input: sanitizeToolInput(event.input) }))
  onStatus('tool_execution_end', (event) => report('tool_execution_end', { tool_name: event.toolName }))

${prime ? '' : `  onStatus('tool_approval_requested', (event) => {
    if (!isOmpRuntime()) return
    report('tool_approval_requested', { tool_name: event.toolName, reason: event.reason, approval_mode: event.approvalMode })
  })
  onStatus('tool_approval_resolved', (event) => {
    if (!isOmpRuntime()) return
    report('tool_approval_resolved', { tool_name: event.toolName, approved: event.approved })
  })
  onStatus('model_select', (event) => {
    updateModel(event)
    report('model_select')
  })

  onStatus('ui_prompt_start', () => {
    if (isOmpRuntime() || !turnInFlight) return
    uiPromptDepth += 1
    if (uiPromptDepth === 1) report('ui_prompt_start')
  })
  onStatus('ui_prompt_end', (_event, ctx) => {
    if (isOmpRuntime() || uiPromptDepth === 0) return
    uiPromptDepth -= 1
    if (uiPromptDepth > 0) return
    // ctx.isIdle throws once a session-switching modal has invalidated the runner, so the local verdict is the floor
    let idle = !turnInFlight
    try {
      if (!idle && typeof ctx?.isIdle === 'function') idle = ctx.isIdle() === true
    } catch {}
    report('ui_prompt_end', { is_idle: idle })
  })
`}
  onStatus('message_end', (event) => {
    if (event.message?.role !== 'assistant') return
    const text = assistantText(event.message)
    if (text) report('message_end', { role: 'assistant', text })
  })

  onStatus('agent_settled', () => {
    agentSettledSupported = true
    clearIdleCheck()
    postAgentEnd()
  })

  onStatus('agent_end', (event, ctx) => {
    if (event.willContinue === true) return clearIdleCheck()
    if (${prime ? 'false' : 'isOmpRuntime()'} || agentSettledSupported || typeof ctx?.isIdle !== 'function') {
      if (!agentSettledSupported) postAgentEnd()
      return
    }
    clearIdleCheck()
    checkIdle(ctx, 0)
  })

  pi.on('session_shutdown', (event) => {
    try {
      clearIdleCheck()
      uiPromptDepth = 0
      const reason = event?.reason
      if (reason === 'reload' || reason === 'quit') return
      ${prime ? '' : 'if (isOmpRuntime()) return\n      '}if (turnInFlight) postAgentEnd({ session_boundary: true })
    } catch {}
  })
}
`
}
