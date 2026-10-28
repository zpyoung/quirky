import { dlopen, JSCallback, ptr, type Pointer } from 'bun:ffi'
import { randomUUID } from 'node:crypto'
import type { HostPowerTransition, NativeHostPowerSource } from './host-power-contracts'

type NativePointer = Pointer | null

const IOKIT_FRAMEWORK = '/System/Library/Frameworks/IOKit.framework/IOKit'
const CORE_FOUNDATION_FRAMEWORK = '/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation'
const PRIVATE_RUN_LOOP_MODE = 'quirky.host-power.private'
const POLL_INTERVAL_MS = 250
const CF_STRING_ENCODING_UTF8 = 0x08000100
const MESSAGE_CAN_SYSTEM_SLEEP = 0xe0000270
const MESSAGE_SYSTEM_WILL_SLEEP = 0xe0000280
const MESSAGE_SYSTEM_HAS_POWERED_ON = 0xe0000300

function openIOKit() {
  return dlopen(IOKIT_FRAMEWORK, {
    IORegisterForSystemPower: { args: ['ptr', 'ptr', 'ptr', 'ptr'], returns: 'u32' },
    IONotificationPortGetRunLoopSource: { args: ['ptr'], returns: 'ptr' },
    IONotificationPortDestroy: { args: ['ptr'], returns: 'void' },
    IODeregisterForSystemPower: { args: ['ptr'], returns: 'i32' },
    IOAllowPowerChange: { args: ['u32', 'ptr'], returns: 'i32' },
    IOServiceClose: { args: ['u32'], returns: 'i32' }
  })
}

function openCoreFoundation() {
  return dlopen(CORE_FOUNDATION_FRAMEWORK, {
    CFStringCreateWithCString: { args: ['ptr', 'cstring', 'u32'], returns: 'ptr' },
    CFRunLoopGetCurrent: { args: [], returns: 'ptr' },
    CFRunLoopAddSource: { args: ['ptr', 'ptr', 'ptr'], returns: 'void' },
    CFRunLoopRemoveSource: { args: ['ptr', 'ptr', 'ptr'], returns: 'void' },
    CFRunLoopRunInMode: { args: ['ptr', 'f64', 'bool'], returns: 'i32' },
    CFRelease: { args: ['ptr'], returns: 'void' }
  })
}

function errorMessage(error: unknown): string {
  try {
    if (error instanceof Error) return error.message || error.name
    return String(error)
  } catch {
    return '<unprintable error>'
  }
}

function readPointerSlot(slot: Buffer): NativePointer {
  const value = slot.readBigUInt64LE(0)
  // IOKit populated this pointer-sized out parameter; Bun brands its numeric pointer ABI.
  return value === 0n ? null : Number(value) as Pointer
}

/** Create a trusted IOKit power source; delivery is polled on the Bun JS thread. */
export function createMacOSHostPowerSource(log: (message: string) => void = message => console.error(message)): NativeHostPowerSource {
  if (process.platform !== 'darwin') throw new Error('macOS host power source is only available on macOS')
  if (process.arch !== 'arm64' && process.arch !== 'x64') {
    throw new Error(`macOS host power source does not support the ${process.arch} pointer ABI`)
  }

  return {
    start(listener: (transition: HostPowerTransition) => void): () => void {
      let io: ReturnType<typeof openIOKit> | null = null
      let cf: ReturnType<typeof openCoreFoundation> | null = null
      let callback: JSCallback | null = null
      let runLoop: NativePointer = null
      let mode: NativePointer = null
      let port: NativePointer = null
      let runLoopSource: NativePointer = null
      let connection = 0
      let sourceAdded = false
      let active = false
      let disposed = false
      let nativeCallbackDepth = 0
      let servicingRunLoop = false
      let teardownPending = false
      let pollTimer: ReturnType<typeof setInterval> | null = null
      const portSlot = Buffer.alloc(8)
      const notifierSlot = Buffer.alloc(4)

      const report = (message: string) => {
        try {
          log(message)
        } catch {
          // Logging must not escape the native callback boundary.
        }
      }
      const stopDelivery = () => {
        active = false
        if (pollTimer) {
          clearInterval(pollTimer)
          pollTimer = null
        }
      }
      const attemptCleanup = (description: string, action: () => void) => {
        try {
          action()
        } catch (error) {
          report(`macOS host power ${description} failed: ${errorMessage(error)}`)
        }
      }
      const checkIOReturn = (operation: string, result: number) => {
        if (result !== 0) report(`macOS host power ${operation} returned IOReturn ${result}`)
      }
      const acknowledge = (message: string, notificationID: NativePointer) => {
        if (!io) return
        try {
          checkIOReturn(`IOAllowPowerChange for ${message}`, io.symbols.IOAllowPowerChange(connection, notificationID))
        } catch (error) {
          report(`macOS host power IOAllowPowerChange for ${message} failed: ${errorMessage(error)}`)
        }
      }
      const deliver = (transition: HostPowerTransition) => {
        try {
          listener(transition)
        } catch (error) {
          report(`macOS host power ${transition} delivery failed before acknowledgment: ${errorMessage(error)}`)
        }
      }
      const cleanup = () => {
        stopDelivery()
        if (sourceAdded && cf && runLoop && runLoopSource && mode) {
          attemptCleanup('run-loop source removal', () => cf!.symbols.CFRunLoopRemoveSource(runLoop!, runLoopSource!, mode!))
          sourceAdded = false
        }
        if (io && notifierSlot.readUInt32LE(0) !== 0) {
          attemptCleanup('system power deregistration', () => {
            checkIOReturn('IODeregisterForSystemPower', io!.symbols.IODeregisterForSystemPower(ptr(notifierSlot)))
          })
          notifierSlot.writeUInt32LE(0, 0)
        }
        if (io && port) {
          const ownedPort = port
          port = null
          attemptCleanup('notification port destruction', () => io!.symbols.IONotificationPortDestroy(ownedPort))
        }
        if (io && connection !== 0) {
          const ownedConnection = connection
          connection = 0
          attemptCleanup('service connection close', () => {
            checkIOReturn('IOServiceClose', io!.symbols.IOServiceClose(ownedConnection))
          })
        }
        if (cf && mode) {
          const ownedMode = mode
          mode = null
          attemptCleanup('private run-loop mode release', () => cf!.symbols.CFRelease(ownedMode))
        }
        if (callback) {
          const ownedCallback = callback
          callback = null
          attemptCleanup('native callback release', () => ownedCallback.close())
        }
        if (cf) {
          const ownedLibrary = cf
          cf = null
          attemptCleanup('CoreFoundation library close', () => ownedLibrary.close())
        }
        if (io) {
          const ownedLibrary = io
          io = null
          attemptCleanup('IOKit library close', () => ownedLibrary.close())
        }
      }

      try {
        io = openIOKit()
        cf = openCoreFoundation()
        const modeName = Buffer.from(`${PRIVATE_RUN_LOOP_MODE}.${randomUUID()}\0`)
        mode = cf.symbols.CFStringCreateWithCString(null, ptr(modeName), CF_STRING_ENCODING_UTF8) as NativePointer
        if (!mode) throw new Error('CFStringCreateWithCString returned null for the private run-loop mode')
        runLoop = cf.symbols.CFRunLoopGetCurrent() as NativePointer
        if (!runLoop) throw new Error('CFRunLoopGetCurrent returned null on the Bun JS thread')

        callback = new JSCallback((
          _refcon: Pointer | null,
          _service: number,
          messageType: number,
          messageArgument: Pointer | null
        ) => {
          nativeCallbackDepth++
          try {
            try {
              if (!active) return
              if (messageType === MESSAGE_CAN_SYSTEM_SLEEP) {
                acknowledge('CanSystemSleep', messageArgument)
              } else if (messageType === MESSAGE_SYSTEM_WILL_SLEEP) {
                try {
                  deliver('suspend')
                } finally {
                  acknowledge('SystemWillSleep', messageArgument)
                }
              } else if (messageType === MESSAGE_SYSTEM_HAS_POWERED_ON) {
                deliver('resume')
              }
            } catch (error) {
              report(`macOS host power native callback failed: ${errorMessage(error)}`)
            }
          } finally {
            nativeCallbackDepth--
          }
        }, {
          args: ['ptr', 'u32', 'u32', 'ptr'],
          returns: 'void'
        })

        try {
          connection = io.symbols.IORegisterForSystemPower(null, ptr(portSlot), callback.ptr, ptr(notifierSlot))
        } finally {
          port = readPointerSlot(portSlot)
        }
        if (connection === 0) throw new Error('IORegisterForSystemPower returned a null service connection')
        if (!port) throw new Error('IORegisterForSystemPower returned a null notification port')
        if (notifierSlot.readUInt32LE(0) === 0) throw new Error('IORegisterForSystemPower returned a null notifier')

        runLoopSource = io.symbols.IONotificationPortGetRunLoopSource(port) as NativePointer
        if (!runLoopSource) throw new Error('IONotificationPortGetRunLoopSource returned null')
        sourceAdded = true
        cf.symbols.CFRunLoopAddSource(runLoop, runLoopSource, mode)
        active = true

        pollTimer = setInterval(() => {
          if (!active || !cf || !mode) return
          servicingRunLoop = true
          try {
            cf.symbols.CFRunLoopRunInMode(mode, 0, true)
          } catch (error) {
            report(`macOS host power run-loop poll failed: ${errorMessage(error)}`)
          } finally {
            servicingRunLoop = false
            if (teardownPending) {
              teardownPending = false
              cleanup()
            }
          }
        }, POLL_INTERVAL_MS)
        pollTimer.unref()
      } catch (error) {
        cleanup()
        throw new Error(`Unable to initialize macOS host power notifications: ${errorMessage(error)}`, { cause: error })
      }

      return () => {
        if (disposed) return
        disposed = true
        stopDelivery()
        if (servicingRunLoop) {
          teardownPending = true
        } else if (nativeCallbackDepth > 0) {
          queueMicrotask(cleanup)
        } else {
          cleanup()
        }
      }
    }
  }
}
