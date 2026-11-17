import type { ModelInfo } from '@anthropic-ai/claude-agent-sdk'
import type { ClaudeQuery, ClaudeQueryParams } from '../../claude-runner'

/** A scripted stand-in for the Agent SDK's `Query`: tests push messages and read what the runner wrote. */
export class FakeQuery implements ClaudeQuery {
  written: any[] = []
  interrupted = 0
  /** Makes `interrupt` never settle, like an agent that ignores it. */
  hangInterrupt = false
  closed = 0
  permissionModes: string[] = []
  models: (string | undefined)[] = []
  flagSettings: Record<string, unknown>[] = []
  private buffer: any[] = []
  private waiting: { resolve: (r: IteratorResult<any>) => void; reject: (e: Error) => void } | null = null
  private failure: Error | null = null
  private ended = false

  constructor(readonly params: ClaudeQueryParams) {
    void (async () => {
      for await (const message of params.prompt) this.written.push(message)
    })()
  }

  emit(message: any) {
    if (this.waiting) {
      this.waiting.resolve({ value: message, done: false })
      this.waiting = null
    } else this.buffer.push(message)
  }

  end() {
    this.ended = true
    this.waiting?.resolve({ value: undefined, done: true })
    this.waiting = null
  }

  fail(error: Error) {
    this.failure = error
    this.waiting?.reject(error)
    this.waiting = null
  }

  async interrupt() {
    this.interrupted++
    if (this.hangInterrupt) await new Promise(() => {})
  }

  permissionModeDelayMs: (mode: string) => number = () => 0
  /** A mode `setPermissionMode` rejects, like the CLI refusing one the account or settings disallow. */
  refusedPermissionMode: { mode: string; message: string } | null = null
  /** What `supportedModels` reports; null leaves the method off, like an older SDK. */
  modelList: ModelInfo[] | null = null

  async setPermissionMode(mode: string) {
    await new Promise((resolve) => setTimeout(resolve, this.permissionModeDelayMs(mode)))
    if (this.refusedPermissionMode?.mode === mode) throw new Error(this.refusedPermissionMode.message)
    this.permissionModes.push(mode)
  }

  get supportedModels(): (() => Promise<ModelInfo[]>) | undefined {
    const list = this.modelList
    return list === null ? undefined : async () => list
  }

  async setModel(model?: string) {
    this.models.push(model)
  }

  async applyFlagSettings(settings: Record<string, unknown>) {
    this.flagSettings.push(settings)
  }

  close() {
    this.closed++
    this.end()
  }

  [Symbol.asyncIterator]() {
    return this
  }

  async next(): Promise<IteratorResult<any>> {
    if (this.buffer.length) return { value: this.buffer.shift(), done: false }
    if (this.failure) throw this.failure
    if (this.ended) return { value: undefined, done: true }
    return new Promise((resolve, reject) => {
      this.waiting = { resolve, reject }
    })
  }
}
