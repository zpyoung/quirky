import { OWNED_MARKER, POST_IMPORTS, postSource } from './post.ts'

export type OpenCodeFamilyAgent = 'opencode' | 'opencode2' | 'mimo-code'

/**
 * The OpenCode-family plugin: turns OpenCode's session, permission, question and message events
 * into the synthetic events the daemon normalizes. Only root sessions report; a child session's
 * attention is attributed to its root. `opencode` and `opencode2` share one config directory, so
 * each file stays quiet unless the running binary is its own.
 */
export function openCodePluginSource(agent: OpenCodeFamilyAgent): string {
  const sessionStart = agent !== 'mimo-code'
  const gated = agent !== 'mimo-code'
  return `// ${OWNED_MARKER}
${POST_IMPORTS.replace("import { join }", "import { basename, join }")}
${postSource(`'${agent}'`)}
const EMIT_SESSION_START = ${sessionStart}
const GATED = ${gated}
const MESSAGE_MAX_CHARS = 4000
const ASSISTANT_THROTTLE_MS = 500
const CACHE_LIMIT = 128
const MAX_ANCESTRY_DEPTH = 8
const LOOKUP_TIMEOUT_MS = 1000

function runsAsThisAgent() {
  if (!GATED) return true
  const forced = process.env.QUIRKY_OPENCODE_AGENT
  if (forced) return forced === QUIRKY_AGENT
  const isSecond = [process.argv0, process.argv[1]].some((value) => /^opencode2/i.test(basename(String(value || ''))))
  return (QUIRKY_AGENT === 'opencode2') === isSecond
}

function remember(map, key, value) {
  if (map.size >= CACHE_LIMIT && !map.has(key)) map.delete(map.keys().next().value)
  map.set(key, value)
}

function cap(text) {
  return text.length > MESSAGE_MAX_CHARS ? text.slice(0, MESSAGE_MAX_CHARS) : text
}

function createReporter(client) {
  const roots = new Map()
  const roles = new Map()
  const errors = new Map()
  const queue = quirkyQueue()
  let lastStatusKey = ''
  let pendingPart = null
  let partTimer = null
  let lastPartAt = 0

  async function lookupParent(sessionID) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS)
    if (timer.unref) timer.unref()
    try {
      const get = client?.session?.get
      if (typeof get !== 'function') return undefined
      const result = await Promise.race([
        get.call(client.session, { path: { id: sessionID }, sessionID, signal: controller.signal }),
        new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('lookup timed out'))))
      ])
      const session = result?.data ?? result
      if (session?.id !== sessionID) return undefined
      return session.parentID || null
    } catch {
      return undefined
    } finally {
      clearTimeout(timer)
    }
  }

  // the root session id, or null when the lineage can't be read
  async function rootOf(sessionID) {
    if (!sessionID) return null
    if (roots.has(sessionID)) return roots.get(sessionID)
    if (typeof client?.session?.get !== 'function') return sessionID
    const lineage = []
    let current = sessionID
    while (lineage.length < MAX_ANCESTRY_DEPTH) {
      if (roots.has(current)) {
        for (const id of lineage) remember(roots, id, roots.get(current))
        return roots.get(current)
      }
      lineage.push(current)
      const parent = await lookupParent(current)
      if (parent === undefined) return null
      if (parent === null) {
        for (const id of lineage) remember(roots, id, current)
        return current
      }
      current = parent
    }
    return null
  }

  async function postPart(part) {
    lastPartAt = Date.now()
    await quirkyPost('MessagePart', { role: part.role, text: cap(part.text), messageID: part.messageID, sessionID: part.sessionID })
  }

  async function flushPart() {
    if (partTimer) clearTimeout(partTimer)
    partTimer = null
    const part = pendingPart
    pendingPart = null
    if (part) await postPart(part)
  }

  function queueAssistantPart(part) {
    pendingPart = part
    if (partTimer) return
    const wait = Math.max(0, ASSISTANT_THROTTLE_MS - (Date.now() - lastPartAt))
    partTimer = setTimeout(() => {
      partTimer = null
      queue.push(flushPart)
    }, wait)
    if (partTimer.unref) partTimer.unref()
  }

  async function postStatus(kind, sessionID, rootFields) {
    const key = kind + ':' + sessionID
    if (key === lastStatusKey) return
    lastStatusKey = key
    await quirkyPost(kind === 'busy' ? 'SessionBusy' : 'SessionIdle', { sessionID, ...rootFields })
  }

  async function handleStatus(statusType, sessionID) {
    const root = await rootOf(sessionID)
    if (statusType === 'busy' || statusType === 'retry') {
      if (root !== null && root !== sessionID) return
      await postStatus('busy', sessionID, { root_state: 'working' })
      return
    }
    if (statusType === 'idle') {
      if (root === null || root !== sessionID) return
      await flushPart()
      const errorName = errors.get(sessionID)
      errors.delete(sessionID)
      await postStatus('idle', sessionID, { root_state: 'done', ...(errorName ? { root_turn_error_name: errorName } : {}) })
    }
  }

  async function handleAttention(hookEventName, properties) {
    const sessionID = properties.sessionID
    if (!sessionID) return
    const root = (await rootOf(sessionID)) || sessionID
    await flushPart()
    lastStatusKey = ''
    await quirkyPost(hookEventName, { ...properties, sessionID: root })
  }

  async function handleResolution(sessionID) {
    if (!sessionID) return
    const root = (await rootOf(sessionID)) || sessionID
    lastStatusKey = ''
    await postStatus('busy', root, { root_state: 'working' })
  }

  async function handleMessagePart(properties) {
    const part = properties.part
    const sessionID = properties.sessionID || part?.sessionID
    if (!part || part.type !== 'text' || !part.text || part.synthetic === true) return
    const role = roles.get(part.messageID)
    if (!role) return
    const root = await rootOf(sessionID)
    if (root !== null && root !== sessionID) return
    if (role === 'user') {
      await postPart({ role, text: part.text, messageID: part.messageID, sessionID })
      return
    }
    queueAssistantPart({ role, text: part.text, messageID: part.messageID, sessionID })
  }

  async function handle(event) {
    const type = event?.type
    const properties = event?.properties || {}
    if (type === 'message.updated') {
      const info = properties.info
      if (info?.id && info.role) remember(roles, info.id, info.role)
      return
    }
    if (type === 'session.created') {
      const info = properties.info
      if (!info?.id) return
      if (info.parentID) {
        remember(roots, info.id, (await rootOf(info.parentID)) || info.parentID)
        return
      }
      remember(roots, info.id, info.id)
      if (EMIT_SESSION_START && !process.argv.includes('run')) await quirkyPost('SessionStart', { sessionID: info.id })
      return
    }
    if (type === 'session.status') return handleStatus(properties.status?.type ?? event.status?.type, properties.sessionID)
    if (type === 'session.idle') return handleStatus('idle', properties.sessionID)
    if (type === 'session.error') {
      const name = properties.error?.name
      if (properties.sessionID && typeof name === 'string' && name) remember(errors, properties.sessionID, name)
      return
    }
    if (type === 'permission.asked') {
      return handleAttention('PermissionRequest', {
        sessionID: properties.sessionID,
        id: properties.id,
        permission: properties.permission,
        patterns: properties.patterns,
        metadata: properties.metadata
      })
    }
    if (type === 'question.asked') {
      return handleAttention('AskUserQuestion', { sessionID: properties.sessionID, id: properties.id, questions: properties.questions })
    }
    if (type === 'permission.replied' || type === 'question.replied' || type === 'question.rejected') {
      return handleResolution(properties.sessionID)
    }
    if (type === 'message.part.updated') return handleMessagePart(properties)
    if (type === 'quirky.assistant-text') {
      const root = await rootOf(properties.sessionID)
      if (properties.text && (root === null || root === properties.sessionID)) {
        queueAssistantPart({ role: 'assistant', text: properties.text, messageID: properties.messageID, sessionID: properties.sessionID })
      }
    }
  }

  return {
    handle(event) {
      queue.push(() => handle(event))
    },
    // the host is going away: a prompt or reply still waiting for its throttle must not be lost
    dispose() {
      queue.push(flushPart)
    },
    userPrompt(sessionID, text) {
      if (typeof text === 'string' && text) queue.push(() => postPart({ role: 'user', text, messageID: undefined, sessionID }))
    }
  }
}

${agent === 'mimo-code' ? '' : nextGenerationSource()}
export const QuirkyOpenCodeStatusPlugin = async (ctx) => {
  if (!process.env.QUIRKY_SESSION_ID || !runsAsThisAgent()) return {}
  const reporter = createReporter(ctx?.client)
  return {
    event: async ({ event }) => {
      try {
        reporter.handle(event)
      } catch {}
    },
    dispose: async () => {
      try {
        reporter.dispose()
      } catch {}
    }
  }
}

// OpenCode 1 calls a default export; OpenCode 2 reads id/server/setup from it.
const plugin = Object.assign((ctx) => QuirkyOpenCodeStatusPlugin(ctx), {
  id: 'quirky-${agent}-status',
  server: QuirkyOpenCodeStatusPlugin${agent === 'mimo-code' ? '' : ',\n  setup: setupOpenCode2Status'}
})
export default plugin
`
}

/** OpenCode 2's next-generation hook: its events are translated to the 1.x names the reporter handles. */
function nextGenerationSource(): string {
  return `function translateNextEvent(type, data) {
  const properties = data || {}
  if (type === 'session.created') return { type, properties: { info: { ...properties, id: properties.sessionID } } }
  if (type === 'session.execution.started') return { type: 'session.status', properties: { ...properties, status: { type: 'busy' } } }
  if (type === 'session.execution.succeeded') return { type: 'session.status', properties: { ...properties, status: { type: 'idle' } } }
  if (type === 'session.execution.failed' || type === 'session.execution.interrupted') {
    return [
      { type: 'session.error', properties: { ...properties, error: { name: type.endsWith('interrupted') ? 'MessageAbortedError' : 'UnknownError' } } },
      { type: 'session.status', properties: { ...properties, status: { type: 'idle' } } }
    ]
  }
  if (type === 'permission.asked') return { type, properties: { ...properties, permission: properties.action, patterns: properties.resources } }
  if (type === 'session.text.ended' && typeof properties.text === 'string') {
    return { type: 'quirky.assistant-text', properties: { sessionID: properties.sessionID, messageID: properties.assistantMessageID, text: properties.text } }
  }
  return { type, properties }
}

async function setupOpenCode2Status(ctx) {
  const noop = async () => {}
  try {
    if (!process.env.QUIRKY_SESSION_ID || !runsAsThisAgent()) return noop
    if (typeof ctx?.session?.hook !== 'function' || typeof ctx?.event?.subscribe !== 'function') return noop
    const client = {
      session: {
        get: async (input, options) => {
          const result = await ctx.session.get(input, options)
          return result && typeof result.id === 'string' ? { data: result } : result
        }
      }
    }
    const reporter = createReporter(client)
    const controller = new AbortController()
    const registration = await ctx.session.hook('prompt', async (properties) => {
      reporter.userPrompt(properties?.sessionID, properties?.prompt?.text)
    })
    const consuming = (async () => {
      for await (const input of ctx.event.subscribe({ signal: controller.signal })) {
        if (controller.signal.aborted) break
        const translated = translateNextEvent(input.type, input.data)
        for (const event of Array.isArray(translated) ? translated : [translated]) reporter.handle(event)
      }
    })().catch(() => {})
    return async () => {
      try {
        controller.abort()
        await registration?.dispose?.()
        await consuming
        reporter.dispose()
      } catch {}
    }
  } catch {
    return noop
  }
}
`
}
