import type { DesignGuestAction } from '../design-contract'
import { selectionOverlayProgram } from '@quirky/ui/selection-overlay'

const OWNER_ATTRIBUTE = 'data-quirky-browser-design-owner'
const OWNER_VALUE = 'design-picker-v1'
const STATE_PROPERTY = '__quirkyBrowserDesignState_v1'

const ARM_PROGRAM = `(function(opId, mode) {
  const ownerAttribute = ${JSON.stringify(OWNER_ATTRIBUTE)}
  const ownerValue = ${JSON.stringify(OWNER_VALUE)}
  const stateProperty = ${JSON.stringify(STATE_PROPERTY)}
  const secretMarkers = ['access_token', 'auth_token', 'api_key', 'apikey', 'client_secret', 'oauth_state', 'x-amz-', 'session_id', 'sessionid', 'csrf', 'secret', 'password', 'passwd']
  const allowedAttributes = { id: true, class: true, name: true, type: true, role: true, href: true, src: true, alt: true, title: true, placeholder: true, for: true, action: true, method: true }
  const urlAttributes = { href: true, src: true, action: true }
  const voidTags = { area: true, base: true, br: true, col: true, embed: true, hr: true, img: true, input: true, link: true, meta: true, param: true, source: true, track: true, wbr: true }
  const computedStyleProperties = {
    display: 'display', position: 'position', width: 'width', height: 'height', margin: 'margin', padding: 'padding',
    color: 'color', backgroundColor: 'background-color', border: 'border', borderRadius: 'border-radius',
    fontFamily: 'font-family', fontSize: 'font-size', fontWeight: 'font-weight', lineHeight: 'line-height',
    textAlign: 'text-align', zIndex: 'z-index'
  }
  const safeText = (value, max) => {
    if (typeof value !== 'string') return ''
    const lower = value.toLowerCase()
    if (secretMarkers.some((marker) => lower.includes(marker))) return '[redacted]'
    if (value.length <= max) return value
    const suffix = ' (truncated)'
    if (max <= suffix.length) return suffix.slice(0, max)
    let end = max - suffix.length
    const beforeSuffix = value.charCodeAt(end - 1)
    const suffixStart = value.charCodeAt(end)
    if (beforeSuffix >= 0xd800 && beforeSuffix <= 0xdbff && suffixStart >= 0xdc00 && suffixStart <= 0xdfff) end--
    return value.slice(0, end) + suffix
  }
  const safeUrl = (value, base) => {
    if (typeof value !== 'string') return ''
    if (value === 'about:blank') return value
    try {
      const url = base === undefined ? new URL(value) : new URL(value, base)
      if (!['http:', 'https:', 'file:'].includes(url.protocol)) return ''
      url.username = ''
      url.password = ''
      url.search = ''
      url.hash = ''
      return secretMarkers.some((marker) => url.href.toLowerCase().includes(marker)) ? 'about:blank' : url.href
    } catch { return '' }
  }
  const escapeCss = (value) => value.replace(/(^-?\\d)|[^a-zA-Z0-9_-]/g, (char) => '\\\\' + char.codePointAt(0).toString(16) + ' ')
  const stableClasses = (element) => {
    const result = []
    let inspected = 0
    for (const name of element.classList) {
      if (inspected++ >= 64 || result.length >= 2) break
      if (/^css-[a-z0-9]+$/i.test(name) || (/[0-9]/.test(name) && /[A-Z]/.test(name) && name.length >= 12)) continue
      result.push(safeText(name, 100))
    }
    return result
  }
  const isUnique = (selector, element) => {
    try { const matches = document.querySelectorAll(selector); return matches.length === 1 && matches[0] === element }
    catch { return false }
  }
  const selectorFor = (element) => {
    const parts = []
    let node = element
    for (let depth = 0; node && node.nodeType === 1 && depth < 10; depth++, node = node.parentElement) {
      const tag = node.tagName.toLowerCase()
      const id = node.getAttribute('id')
      let part = tag
      if (id && id.length <= 700) part += '#' + escapeCss(id)
      else {
        const classes = stableClasses(node)
        if (classes.length) part += '.' + classes.map(escapeCss).join('.')
      }
      parts.unshift(part)
      let selector = parts.join(' > ')
      if (isUnique(selector, element)) return safeText(selector, 700)
      const parent = node.parentElement
      if (parent) {
        let position = 0
        for (let sibling = parent.firstElementChild; sibling; sibling = sibling.nextElementSibling) {
          if (sibling.tagName === node.tagName) position++
          if (sibling === node) break
        }
        if (position > 0) {
          parts[0] = part + ':nth-of-type(' + position + ')'
          selector = parts.join(' > ')
          if (isUnique(selector, element)) return safeText(selector, 700)
        }
      }
    }
    return safeText(parts.join(' > '), 700)
  }
  const implicitRole = (element) => {
    const tag = element.tagName.toLowerCase()
    const type = (element.getAttribute('type') || '').toLowerCase()
    if (tag === 'a' && element.hasAttribute('href')) return 'link'
    if (tag === 'button' || (tag === 'input' && ['button', 'submit', 'reset'].includes(type))) return 'button'
    if (tag === 'textarea' || (tag === 'input' && ['text', 'search', 'email', 'url', 'tel', ''].includes(type))) return 'textbox'
    if (tag === 'input' && type === 'checkbox') return 'checkbox'
    if (tag === 'input' && type === 'radio') return 'radio'
    if (tag === 'input' && type === 'range') return 'slider'
    if (tag === 'select') return element.multiple ? 'listbox' : 'combobox'
    if (tag === 'img') return 'img'
    if (tag === 'main') return 'main'
    if (tag === 'nav') return 'navigation'
    if (tag === 'form') return 'form'
    if (/^h[1-6]$/.test(tag)) return 'heading'
    if (tag === 'li') return 'listitem'
    if (tag === 'ul' || tag === 'ol') return 'list'
    return ''
  }
  const textOf = (element, max = 2048) => {
    if (!element) return ''
    let text = ''
    let visited = 0
    let truncated = false
    const walk = (node) => {
      if (visited++ >= 512) { truncated = true; return }
      if (node.nodeType === 3) {
        const value = node.nodeValue || ''
        const remaining = Math.max(0, max + 1 - text.length)
        if (value.length > remaining) truncated = true
        text += value.slice(0, remaining)
        return
      }
      if (node.nodeType !== 1 && node.nodeType !== 9 && node.nodeType !== 11) return
      if (node.nodeType === 1 && ['SCRIPT', 'STYLE', 'NOSCRIPT', 'INPUT', 'TEXTAREA', 'SELECT', 'OPTION'].includes(node.tagName)) return
      for (let child = node.firstChild; child; child = child.nextSibling) {
        if (text.length > max) { truncated = true; break }
        walk(child)
      }
    }
    walk(element)
    const collapsed = text.replace(/\\s+/g, ' ').trim()
    if (truncated) return safeText(collapsed.slice(0, Math.max(0, max - 12)) + ' (truncated)', max)
    return safeText(collapsed, max)
  }
  const accessibleName = (element) => {
    const aria = element.getAttribute('aria-label') || ''
    if (aria) return safeText(aria, 2048)
    const labelledBy = element.getAttribute('aria-labelledby') || ''
    if (labelledBy) {
      const text = labelledBy.slice(0, 500).split(/\\s+/).slice(0, 10).map((id) => document.getElementById(id)).filter(Boolean).map((label) => textOf(label)).filter(Boolean).join(' ')
      if (text) return safeText(text, 2048)
    }
    if (['BUTTON', 'A', 'LABEL'].includes(element.tagName)) {
      const text = textOf(element)
      if (text) return safeText(text, 2048)
    }
    return safeText(element.getAttribute('title') || element.getAttribute('alt') || '', 2048)
  }
  const classText = (element) => safeText(element.getAttribute('class') || '', 500)
  const nodePathPart = (element, full) => {
    const tag = element.tagName.toLowerCase()
    const id = element.getAttribute('id')
    if (id) return tag + '#' + safeText(id, 200)
    if (full) {
      const classes = stableClasses(element)
      return tag + (classes.length ? '.' + classes.join('.') : '')
    }
    const aria = element.getAttribute('aria-label')
    if (aria) return tag + '[aria-label=' + JSON.stringify(safeText(aria, 100)) + ']'
    const role = element.getAttribute('role')
    if (role) return tag + '[role=' + JSON.stringify(safeText(role, 100)) + ']'
    const classes = stableClasses(element)
    return tag + (classes.length ? '.' + classes[0] : '')
  }
  const attributesFor = (element, base) => {
    const result = Object.create(null)
    for (const attribute of element.attributes) {
      const name = attribute.name.toLowerCase()
      if (!(Object.hasOwn(allowedAttributes, name) || /^aria-[a-zA-Z0-9_-]+$/i.test(name))) continue
      let value = attribute.value
      if (Object.hasOwn(urlAttributes, name)) {
        if (value === '') continue
        value = safeUrl(value, base)
        if (!value) continue
      }
      result[name] = safeText(value, name === 'class' ? 200 : 500)
    }
    return result
  }
  const cleanHtml = (element, base) => {
    let html = ''
    let visited = 0
    let truncated = false
    const append = (value) => {
      const remaining = 4097 - html.length
      if (remaining <= 0) { truncated = true; return }
      if (value.length > remaining) truncated = true
      html += value.slice(0, remaining)
      if (html.length > 4096) truncated = true
    }
    const escape = (value, attribute) => {
      let escaped = value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
      if (attribute) escaped = escaped.replaceAll('\"', '&quot;')
      return escaped
    }
    const serialize = (node, depth) => {
      if (html.length > 4096 || depth > 40 || visited++ >= 512) { truncated = true; return }
      if (node.nodeType === 3) {
        append(escape(safeText(node.nodeValue || '', Math.max(0, 4096 - html.length)), false))
        return
      }
      if (node.nodeType !== 1) return
      const name = node.tagName.toLowerCase()
      if (['script', 'style', 'noscript'].includes(name)) return
      append('<' + name)
      for (const attribute of node.attributes) {
        if (html.length > 4096) { truncated = true; break }
        const attributeName = attribute.name.toLowerCase()
        if (attributeName.startsWith('on') || ['value', 'checked', 'selected'].includes(attributeName) ||
            !(Object.hasOwn(allowedAttributes, attributeName) || /^aria-[a-zA-Z0-9_-]+$/i.test(attributeName))) continue
        let value = attribute.value
        if (Object.hasOwn(urlAttributes, attributeName)) {
          if (value === '') continue
          value = safeUrl(value, base)
          if (!value) continue
        }
        value = safeText(value, attributeName === 'class' ? 200 : 500)
        append(' ' + attributeName + '=\"' + escape(value, true) + '\"')
      }
      append('>')
      if (Object.hasOwn(voidTags, name)) return
      if (name !== 'textarea') {
        for (let child = node.firstChild; child; child = child.nextSibling) {
          if (html.length > 4096) { truncated = true; break }
          serialize(child, depth + 1)
        }
      }
      append('</' + name + '>')
    }
    serialize(element, 0)
    if (truncated || html.length > 4096) {
      const suffix = ' (truncated)'
      html = html.slice(0, Math.max(0, 4096 - suffix.length)) + suffix
    }
    return safeText(html, 4096)
  }
  const pathFor = (element, full, maxDepth) => {
    const parts = []
    for (let node = element, depth = 0; node && node.nodeType === 1 && depth < maxDepth; node = node.parentElement, depth++) parts.unshift(nodePathPart(node, full))
    return parts.join(' > ')
  }
  const nearbyFor = (element) => {
    if (!element.parentElement) return { text: [], elements: [] }
    const text = []
    const nearby = []
    let before = element.previousElementSibling
    let after = element.nextElementSibling
    let scanned = 0
    while (scanned < 80 && (text.length < 10 || nearby.length < 6) && (before || after)) {
      const candidates = [before, after]
      before = before ? before.previousElementSibling : null
      after = after ? after.nextElementSibling : null
      for (const sibling of candidates) {
        if (!sibling || scanned >= 80) continue
        scanned++
        if (['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(sibling.tagName)) continue
        const siblingText = textOf(sibling, 200)
        if (!siblingText) continue
        if (text.length < 10) text.push(siblingText)
        if (nearby.length < 6) {
          const classes = classText(sibling).replace(/\\s+/g, '.')
          nearby.push(safeText(sibling.tagName.toLowerCase() + (classes ? '.' + classes : '') + ' \"' + siblingText + '\"', 160))
        }
      }
    }
    return { text, elements: nearby }
  }
  const reactInfo = (element) => {
    try {
      const key = Object.getOwnPropertyNames(element).slice(0, 64).find((name) => name.startsWith('__reactFiber$') || name.startsWith('__reactInternalInstance$'))
      const descriptor = key ? Object.getOwnPropertyDescriptor(element, key) : undefined
      let fiber = descriptor && 'value' in descriptor ? descriptor.value : null
      const names = []
      let source = null
      for (let depth = 0; fiber && depth < 35; depth++, fiber = fiber.return) {
        const debug = fiber._debugSource
        if (!source && debug && typeof debug === 'object') {
          const file = typeof debug.fileName === 'string' ? debug.fileName : typeof debug.path === 'string' ? debug.path : ''
          if (file) {
            let stripped = file
            if (stripped.startsWith('webpack-internal:///./')) stripped = stripped.slice('webpack-internal:///./'.length)
            if (stripped.startsWith('turbopack:///[project]/')) stripped = stripped.slice('turbopack:///[project]/'.length)
            const protocol = stripped.indexOf('://')
            if ((stripped.startsWith('http://') || stripped.startsWith('https://')) && protocol >= 0) {
              const slash = stripped.indexOf('/', protocol + 3)
              stripped = slash < 0 ? '' : stripped.slice(slash + 1)
            }
            stripped = safeText(stripped, 500)
            source = safeText(stripped + (Number.isFinite(debug.lineNumber) ? ':' + debug.lineNumber : '') + (Number.isFinite(debug.columnNumber) ? ':' + debug.columnNumber : ''), 500)
          }
        }
        const type = fiber.elementType || fiber.type
        const rawName = typeof type === 'function' ? type.displayName || type.name : type && typeof type === 'object' ? type.displayName || type.name : ''
        const name = typeof rawName === 'string' ? safeText(rawName, 500) : ''
        if (name.length > 2 && !['Fragment', 'Provider'].includes(name) && !/Boundary$|Router$/.test(name) && !names.includes(name)) names.push(name)
        if (names.length >= 6) break
      }
      return { components: names.length ? safeText(names.reverse().join(' '), 500) : null, source }
    } catch { return { components: null, source: null } }
  }
  const makePayload = (element) => {
    const bounds = element.getBoundingClientRect()
    const pageUrl = safeUrl(location.href) || 'about:blank'
    const style = getComputedStyle(element)
    const computedStyles = Object.create(null)
    for (const [name, property] of Object.entries(computedStyleProperties)) computedStyles[name] = safeText(style.getPropertyValue(property), 500)
    const role = element.getAttribute('role') || implicitRole(element)
    const ariaLabel = element.getAttribute('aria-label') || ''
    const ariaLabelledBy = element.getAttribute('aria-labelledby') || ''
    const selection = window.getSelection()
    const selected = selection ? selection.toString() : ''
    const selectedText = selected ? safeText(selected, 500) : null
    const nearby = nearbyFor(element)
    const react = reactInfo(element)
    const ancestors = []
    for (let node = element, depth = 0; node && node.nodeType === 1 && depth < 10; node = node.parentElement, depth++) {
      const ancestorRole = node.getAttribute('role')
      ancestors.unshift(node.tagName.toLowerCase() + (ancestorRole ? '[role=' + JSON.stringify(safeText(ancestorRole, 100)) + ']' : ''))
    }
    return {
      page: {
        sanitizedUrl: pageUrl, title: safeText(document.title || '', 500), viewportWidth: window.innerWidth, viewportHeight: window.innerHeight,
        scrollX: window.scrollX, scrollY: window.scrollY, devicePixelRatio: window.devicePixelRatio, capturedAt: new Date().toISOString()
      },
      target: {
        tagName: element.tagName.toLowerCase(), selector: selectorFor(element), elementPath: pathFor(element, false, 6), fullPath: pathFor(element, true, 20),
        cssClasses: classText(element), nearbyElements: nearby.elements, selectedText, isFixed: style.position === 'fixed',
        reactComponents: react.components, sourceFile: react.source, textSnippet: textOf(element, 200), htmlSnippet: cleanHtml(element, pageUrl),
        attributes: attributesFor(element, pageUrl), accessibility: { role: safeText(role, 2048), accessibleName: accessibleName(element), ariaLabel: safeText(ariaLabel, 2048), ariaLabelledBy: safeText(ariaLabelledBy, 2048) },
        rectViewport: { x: bounds.left, y: bounds.top, width: bounds.width, height: bounds.height },
        rectPage: { x: bounds.left + window.scrollX, y: bounds.top + window.scrollY, width: bounds.width, height: bounds.height }, computedStyles
      },
      nearbyText: nearby.text, ancestorPath: ancestors, screenshot: null
    }
  }
  const { host, shadow, surface, highlight, label } = ${selectionOverlayProgram}
  host.setAttribute(ownerAttribute, ownerValue)
  const priorFocus = document.activeElement
  const priorEditable = !!priorFocus && (['INPUT', 'TEXTAREA'].includes(priorFocus.tagName) || priorFocus.isContentEditable === true)
  const state = { owner: ownerValue, opId, mode, host, surface, highlight, label, hover: null, selection: null, expiresAt: Date.now() + 120000, priorEditable, captureHidden: false, captureVisibility: '' }
  const remove = () => { if (host.parentNode) host.parentNode.removeChild(host) }
  for (const old of document.querySelectorAll('[' + ownerAttribute + '=\\\"' + ownerValue + '\\\"]')) {
    if (old === host || old.tagName !== 'DIV' || old.hasAttribute('is')) continue
    const descriptor = Object.getOwnPropertyDescriptor(old, stateProperty)
    if (!descriptor || !('value' in descriptor) || !descriptor.value || typeof descriptor.value !== 'object' || !old.parentNode) continue
    try {
      if (descriptor.value.owner === ownerValue && typeof descriptor.value.opId === 'string') old.parentNode.removeChild(old)
    } catch { /* never call page-owned cleanup properties */ }
  }
  Object.defineProperty(host, stateProperty, { value: state, configurable: true })
  const editableFocus = () => {
    const active = document.activeElement
    return !!active && (['INPUT', 'TEXTAREA'].includes(active.tagName) || active.isContentEditable === true)
  }
  const suppress = (event) => {
    if (event.cancelable) event.preventDefault()
    event.stopPropagation()
  }
  const live = () => {
    if (Date.now() < state.expiresAt) return true
    state.selection = null
    remove()
    return false
  }
  const atPoint = (x, y) => {
    const pointerEvents = host.style.getPropertyValue('pointer-events')
    const pointerPriority = host.style.getPropertyPriority('pointer-events')
    const surfacePointer = surface.style.getPropertyValue('pointer-events')
    const surfacePriority = surface.style.getPropertyPriority('pointer-events')
    const annotations = Array.from(document.querySelectorAll('[data-orca-browser-annotation-overlay]')).map((node) => ({
      node,
      value: node.style.getPropertyValue('pointer-events'),
      priority: node.style.getPropertyPriority('pointer-events')
    }))
    host.style.setProperty('pointer-events', 'none', 'important')
    surface.style.setProperty('pointer-events', 'none', 'important')
    for (const annotation of annotations) annotation.node.style.setProperty('pointer-events', 'none', 'important')
    let element = null
    try { element = document.elementFromPoint(x, y) }
    finally {
      if (pointerEvents === '') host.style.removeProperty('pointer-events')
      else host.style.setProperty('pointer-events', pointerEvents, pointerPriority)
      if (surfacePointer === '') surface.style.removeProperty('pointer-events')
      else surface.style.setProperty('pointer-events', surfacePointer, surfacePriority)
      for (const annotation of annotations) {
        if (annotation.value === '') annotation.node.style.removeProperty('pointer-events')
        else annotation.node.style.setProperty('pointer-events', annotation.value, annotation.priority)
      }
    }
    if (!element || element === host || host.contains(element) || shadow.contains(element)) return null
    return element
  }
  const render = (element, x, y) => {
    if (!element) {
      state.hover = null
      highlight.hidden = true
      label.hidden = true
      return null
    }
    const payload = makePayload(element)
    const rect = payload.target.rectViewport
    const role = payload.target.accessibility.role
    const accessible = payload.target.accessibility.accessibleName
    const dims = Math.round(rect.width) + 'x' + Math.round(rect.height)
    label.textContent = payload.target.tagName + (role ? ' role=' + role : '') + (accessible ? ' "' + accessible.slice(0, 60) + '"' : '') + ' ' + dims
    highlight.hidden = false
    label.hidden = false
    highlight.style.left = rect.x + 'px'
    highlight.style.top = rect.y + 'px'
    highlight.style.width = Math.max(0, rect.width) + 'px'
    highlight.style.height = Math.max(0, rect.height) + 'px'
    label.style.left = Math.max(0, Math.min(window.innerWidth - 20, rect.x)) + 'px'
    label.style.top = Math.max(0, Math.min(window.innerHeight - 24, rect.y - 28)) + 'px'
    state.hover = { element, payload, x, y }
    return state.hover
  }
  const choose = (event, kind) => {
    if (!live()) return
    const hovered = render(atPoint(event.clientX, event.clientY), event.clientX, event.clientY)
    if (hovered) {
      state.selection = { kind, payload: hovered.payload }
      host.style.visibility = 'hidden'
    }
  }
  const onPointerMove = (event) => {
    if (!live()) return
    suppress(event)
    render(atPoint(event.clientX, event.clientY), event.clientX, event.clientY)
  }
  const onPointer = (event) => {
    if (!live()) return
    suppress(event)
  }
  const onClick = (event) => {
    suppress(event)
    if (event.button === 0) choose(event, 'selected')
  }
  const onContextMenu = (event) => {
    suppress(event)
    choose(event, 'context-selected')
  }
  const onKeyDown = (event) => {
    const key = String(event.key || '').toLowerCase()
    if ((key !== 'c' && key !== 's') || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || state.priorEditable || editableFocus()) return
    const selection = window.getSelection()
    if (selection && selection.toString() !== '') return
    suppress(event)
    const hovered = state.hover
    if (live() && hovered) state.selection = { kind: key === 'c' ? 'copy' : 'screenshot', payload: hovered.payload }
  }
  const listeners = [['pointermove', onPointerMove], ['mousemove', onPointerMove], ['pointerdown', onPointer], ['pointerup', onPointer], ['mousedown', onPointer], ['mouseup', onPointer], ['click', onClick], ['auxclick', onPointer], ['contextmenu', onContextMenu], ['wheel', onPointer], ['touchstart', onPointer], ['touchmove', onPointer], ['touchend', onPointer], ['keydown', onKeyDown]]
  for (const [type, listener] of listeners) shadow.addEventListener(type, listener, true)
  const api = (action, expectedOpId) => {
    if (expectedOpId !== opId) return { opId: expectedOpId, status: 'cancelled' }
    if (!live()) return { opId, status: 'expired' }
    if (action === 'read') {
      const selection = state.selection
      state.selection = null
      return { opId, status: 'armed', ...(selection ? { selection } : {}) }
    }
    if (action === 'hover') return { payload: state.hover ? state.hover.payload : null }
    return { opId, status: 'cancelled' }
  }
  Object.defineProperty(state, 'api', { value: api, configurable: true })
  const root = document.documentElement
  if (!root) return { opId, status: 'cancelled' }
  root.appendChild(host)
  surface.focus()
  return { opId, status: 'armed' }
})`

const COMMAND_PROGRAM = `(function(action, opId) {
  const ownerAttribute = ${JSON.stringify(OWNER_ATTRIBUTE)}
  const ownerValue = ${JSON.stringify(OWNER_VALUE)}
  const stateProperty = ${JSON.stringify(STATE_PROPERTY)}
  const findOwned = (expectedOpId) => {
    for (const candidate of document.querySelectorAll('[' + ownerAttribute + '=\\"' + ownerValue + '\\"]')) {
      if (candidate.tagName !== 'DIV') continue
      const descriptor = Object.getOwnPropertyDescriptor(candidate, stateProperty)
      if (!descriptor || !('value' in descriptor) || !descriptor.value || typeof descriptor.value !== 'object') continue
      const state = descriptor.value
      try {
        if (state.owner === ownerValue && (expectedOpId === undefined || state.opId === expectedOpId)) return { host: candidate, state }
      } catch { continue }
    }
    return null
  }
  if (action === 'cancel') {
    const found = findOwned(opId)
    if (found && found.host.parentNode) found.host.parentNode.removeChild(found.host)
    return { cancelled: true }
  }
  const found = findOwned(action === 'hide' || action === 'show' ? undefined : opId)
  if (!found) return action === 'hover' ? { payload: null } : action === 'read' ? { opId, status: 'cancelled' } : { hidden: false }
  const { host, state } = found
  if (action === 'hide') {
    if (!state.captureHidden) {
      state.captureVisibility = host.style.visibility
      state.captureHidden = true
    }
    host.style.visibility = 'hidden'
    return { hidden: true }
  }
  if (action === 'show') {
    if (state.captureHidden) {
      host.style.visibility = state.captureVisibility
      state.captureHidden = false
      state.captureVisibility = ''
    }
    return { hidden: false }
  }
  const descriptor = Object.getOwnPropertyDescriptor(state, 'api')
  if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'function') return action === 'hover' ? { payload: null } : { opId, status: 'cancelled' }
  try { return descriptor.value(action, opId) }
  catch { return action === 'hover' ? { payload: null } : { opId, status: 'cancelled' } }
})`

export function guestProgram(action: DesignGuestAction, opId: string, mode: 'grab' | 'annotate' = 'grab'): string {
  if (action === 'arm') return `(${ARM_PROGRAM})(${JSON.stringify(opId)},${JSON.stringify(mode)})`
  return `(${COMMAND_PROGRAM})(${JSON.stringify(action)},${JSON.stringify(opId)})`
}
