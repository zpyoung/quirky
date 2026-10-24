import { dlopen, type Pointer } from 'bun:ffi'

type Ptr = Pointer | null

const LIBOBJC = '/usr/lib/libobjc.A.dylib'

function load() {
  const base = dlopen(LIBOBJC, {
    objc_getClass: { args: ['cstring'], returns: 'ptr' },
    sel_registerName: { args: ['cstring'], returns: 'ptr' }
  })
  const msg0 = dlopen(LIBOBJC, { objc_msgSend: { args: ['ptr', 'ptr'], returns: 'ptr' } })
  const msg1 = dlopen(LIBOBJC, { objc_msgSend: { args: ['ptr', 'ptr', 'ptr'], returns: 'ptr' } })
  const msg3 = dlopen(LIBOBJC, {
    objc_msgSend: { args: ['ptr', 'ptr', 'ptr', 'ptr', 'bool'], returns: 'void' }
  })
  const cstr = (text: string) => Buffer.from(`${text}\0`)
  const cls = (name: string) => base.symbols.objc_getClass(cstr(name)) as Ptr
  const sel = (name: string) => base.symbols.sel_registerName(cstr(name)) as Ptr
  return { msg0: msg0.symbols.objc_msgSend, msg1: msg1.symbols.objc_msgSend, msg3: msg3.symbols.objc_msgSend, cstr, cls, sel }
}

let objc: ReturnType<typeof load> | null | undefined

/**
 * Sets the dock tile badge (empty string clears it). Electrobun has no badge API, so this calls
 * AppKit directly; the change is marshalled to the main thread because AppKit UI is not
 * thread-safe. A no-op off macOS or if the runtime calls fail.
 */
export function setDockBadge(label: string): void {
  if (process.platform !== 'darwin') return
  try {
    if (objc === undefined) objc = load()
    if (!objc) return
    const { msg0, msg1, msg3, cstr, cls, sel } = objc
    const app = msg0(cls('NSApplication'), sel('sharedApplication')) as Ptr
    const tile = msg0(app, sel('dockTile')) as Ptr
    const text = label ? (msg1(cls('NSString'), sel('stringWithUTF8String:'), cstr(label)) as Ptr) : null
    msg3(tile, sel('performSelectorOnMainThread:withObject:waitUntilDone:'), sel('setBadgeLabel:'), text, false)
  } catch (error) {
    objc = null
    console.warn('dock badge unavailable:', error)
  }
}
