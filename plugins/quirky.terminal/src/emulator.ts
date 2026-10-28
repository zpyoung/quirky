import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { PluginContext } from '@quirky/protocol'

export type EmulatorDevice = { id: string; name: string; state: string; runtime: string }
export type EmulatorListing = { available: boolean; devices: EmulatorDevice[]; reason?: string }
export type EmulatorFrame = { device: string; mime: 'image/png'; data: string; capturedAt: number }
const UDID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const MAX_FRAME = 4 * 1024 * 1024
const MAX_OUTPUT = 1024 * 1024
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

/** Read-only simulator composition; no boot/shutdown, automatic target, or real-device fallback. */
export class EmulatorService {
  private stopped = false
  private readonly kills = new Set<() => void>()
  constructor(private readonly context: PluginContext) {}

  list = async (): Promise<EmulatorListing> => {
    if (process.platform !== 'darwin') return { available: false, devices: [], reason: 'iOS Simulator preview requires macOS and Xcode.' }
    try {
      const bytes = await this.run(['list', 'devices', 'available', '--json'])
      const value: unknown = JSON.parse(bytes.toString('utf8'))
      if (typeof value !== 'object' || value === null || !('devices' in value) || typeof value.devices !== 'object' || value.devices === null || Array.isArray(value.devices)) {
        throw new Error('simctl returned an invalid device list')
      }
      const devices: EmulatorDevice[] = []
      for (const [runtime, rows] of Object.entries(value.devices)) {
        if (!Array.isArray(rows)) continue
        for (const row of rows as unknown[]) {
          if (typeof row !== 'object' || row === null || !('udid' in row) || typeof row.udid !== 'string' || !UDID.test(row.udid)) continue
          if ('isAvailable' in row && row.isAvailable === false) continue
          if (!('name' in row) || typeof row.name !== 'string' || !('state' in row) || typeof row.state !== 'string') continue
          devices.push({ id: row.udid, name: row.name, state: row.state, runtime })
        }
      }
      return { available: true, devices }
    } catch (error) {
      return { available: false, devices: [], reason: error instanceof Error ? error.message : String(error) }
    }
  }

  frame = async (params: Record<string, unknown>): Promise<EmulatorFrame> => {
    const device = params.device
    if (typeof device !== 'string' || !UDID.test(device)) throw this.context.error('invalid-params', 'device must be an exact simulator UDID from emulators; implicit booted targets are not accepted')
    if (process.platform !== 'darwin') throw this.context.error('conflict', 'iOS Simulator preview requires macOS and Xcode.')
    const directory = await mkdtemp(join(tmpdir(), 'quirky-simulator-'))
    try {
      const path = join(directory, 'frame.png')
      await this.run(['io', device, 'screenshot', '--type=png', path])
      const info = await stat(path)
      if (!info.isFile() || info.size > MAX_FRAME) throw new Error('Simulator frame exceeds the 4 MiB preview limit')
      const bytes = await readFile(path)
      if (bytes.length < 24 || bytes.length > MAX_FRAME || !bytes.subarray(0, PNG.length).equals(PNG)) throw new Error('simctl did not return a bounded PNG frame')
      const width = bytes.readUInt32BE(16)
      const height = bytes.readUInt32BE(20)
      if (width === 0 || height === 0 || width * height > 8 * 1024 * 1024) throw new Error('Simulator frame exceeds the 8 megapixel decode limit')
      return { device, mime: 'image/png', data: bytes.toString('base64'), capturedAt: Date.now() }
    } catch (error) {
      throw this.context.error('conflict', `Could not capture exact simulator ${device}: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }

  shutdown(): void {
    this.stopped = true
    for (const kill of this.kills) kill()
  }

  private async run(args: string[]): Promise<Buffer> {
    if (this.stopped) throw new Error('Simulator preview service has stopped')
    const child = Bun.spawn(['xcrun', 'simctl', ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
    const kill = () => { child.kill(9) }
    this.kills.add(kill)
    const timeout = setTimeout(kill, 10_000)
    const readBounded = async (stream: ReadableStream<Uint8Array>) => {
      const reader = stream.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        for (;;) {
          const next = await reader.read()
          if (next.done) return Buffer.concat(chunks, size)
          size += next.value.length
          if (size > MAX_OUTPUT) throw new Error('simctl output exceeds the preview limit')
          chunks.push(next.value)
        }
      } finally { reader.releaseLock() }
    }
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, readBounded(child.stdout), readBounded(child.stderr)])
      if (code !== 0) throw new Error(stderr.toString('utf8').trim() || `simctl exited ${code}`)
      return stdout
    } catch (error) {
      kill()
      await child.exited
      throw error
    } finally {
      clearTimeout(timeout)
      this.kills.delete(kill)
    }
  }
}
