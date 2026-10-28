/** Closed phone Watch vocabulary shared by the native page bridge and daemon admission. */
export const MOBILE_BROWSER_METHOD_PARAMS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'quirky.mobile/browserWatchCreate': ['worktree', 'url'],
  'quirky.mobile/browserWatchStart': ['worktree', 'tabId'],
  'quirky.mobile/browserWatchFrame': ['worktree', 'tabId', 'watchId'],
  'quirky.mobile/browserWatchFrameAck': ['worktree', 'tabId', 'watchId', 'sequence'],
  'quirky.mobile/browserWatchStop': ['worktree', 'tabId', 'watchId'],
  'quirky.mobile/browserWatchNavigate': ['worktree', 'tabId', 'watchId', 'input'],
  'quirky.mobile/browserWatchControl': ['worktree', 'tabId', 'watchId', 'action', 'text', 'forward', 'level', 'preset'],
  'quirky.mobile/browserWatchInput': ['worktree', 'tabId', 'watchId', 'kind', 'type', 'x', 'y', 'button', 'key', 'code', 'text', 'deltaX', 'deltaY', 'modifiers']
})

const BASE_KEYS = ['worktree', 'tabId', 'watchId']
const VIEWPORTS = ['default', 'mobile-s', 'mobile-m', 'mobile-l', 'tablet', 'laptop', 'laptop-l', 'desktop']
const CONTROL_FIELDS = {
  plain: ['action'], find: ['action', 'text', 'forward'], zoom: ['action', 'level'], viewport: ['action', 'preset']
} as const
const INPUT_FIELDS = {
  text: ['kind', 'text'], key: ['kind', 'type', 'key', 'code', 'text', 'modifiers'],
  wheel: ['kind', 'x', 'y', 'deltaX', 'deltaY', 'modifiers'], mouse: ['kind', 'type', 'x', 'y', 'button', 'modifiers']
} as const
const KEY_TYPES: readonly string[] = ['keyDown', 'keyUp', 'char']
const MOUSE_TYPES: readonly string[] = ['mousePressed', 'mouseReleased', 'mouseMoved']
const BUTTONS: readonly string[] = ['left', 'middle', 'right', 'back', 'forward']
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

function only(params: Record<string, unknown>, extras: readonly string[]): boolean {
  for (const key in params) if (!BASE_KEYS.includes(key) && !extras.includes(key)) return false
  return true
}

/** Structural admission only; the producer must also authorize the exact live lease and frame. */
export function validMobileBrowserParams(method: string, params: Record<string, unknown>): boolean {
  if (!Object.hasOwn(MOBILE_BROWSER_METHOD_PARAMS, method) || !text(params.worktree, 1024)) return false
  for (const key in params) if (!MOBILE_BROWSER_METHOD_PARAMS[method]!.includes(key)) return false
  if (method === 'quirky.mobile/browserWatchCreate') return params.url === undefined || text(params.url, 2048)
  if (!text(params.tabId, 128)) return false
  if (method === 'quirky.mobile/browserWatchStart') return true
  if (!text(params.watchId, 128)) return false
  if (method === 'quirky.mobile/browserWatchFrame' || method === 'quirky.mobile/browserWatchStop') return true
  if (method === 'quirky.mobile/browserWatchFrameAck') return Number.isSafeInteger(params.sequence) && (params.sequence as number) > 0
  if (method === 'quirky.mobile/browserWatchNavigate') return text(params.input, 2048)
  if (method === 'quirky.mobile/browserWatchControl') {
    switch (params.action) {
      case 'back': case 'forward': case 'reload': case 'stop': return only(params, CONTROL_FIELDS.plain)
      case 'find': return only(params, CONTROL_FIELDS.find) && typeof params.text === 'string' && params.text.length <= 256 && (params.forward === undefined || typeof params.forward === 'boolean')
      case 'zoom': return only(params, CONTROL_FIELDS.zoom) && finite(params.level) && params.level >= -3 && params.level <= 5 && Number.isInteger(params.level * 2)
      case 'viewport': return only(params, CONTROL_FIELDS.viewport) && typeof params.preset === 'string' && VIEWPORTS.includes(params.preset)
      default: return false
    }
  }
  if (method !== 'quirky.mobile/browserWatchInput') return false
  if (params.modifiers !== undefined && (!Number.isInteger(params.modifiers) || (params.modifiers as number) < 0 || (params.modifiers as number) > 15)) return false
  switch (params.kind) {
    case 'text': {
      if (!only(params, INPUT_FIELDS.text) || !text(params.text, 64 * 1024)) return false
      let bytes = 0
      for (let index = 0; index < params.text.length; index++) {
        const point = params.text.codePointAt(index)!
        bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4
        if (point > 0xffff) index++
        if (bytes > 64 * 1024) return false
      }
      return true
    }
    case 'key': return only(params, INPUT_FIELDS.key) &&
      typeof params.type === 'string' && KEY_TYPES.includes(params.type) && text(params.key, 128) &&
      (params.code === undefined || text(params.code, 128)) && (params.text === undefined || (text(params.text, 128) && params.type === 'char'))
    case 'mouse': case 'wheel': {
      if (!finite(params.x) || !finite(params.y) || params.x < 0 || params.y < 0 || params.x > 16384 || params.y > 16384) return false
      if (params.kind === 'wheel') return only(params, INPUT_FIELDS.wheel) && finite(params.deltaX) && finite(params.deltaY)
      return only(params, INPUT_FIELDS.mouse) && typeof params.type === 'string' && MOUSE_TYPES.includes(params.type) &&
        (params.type === 'mouseMoved' && params.button === undefined || typeof params.button === 'string' && BUTTONS.includes(params.button))
    }
    default: return false
  }
}
