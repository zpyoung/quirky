import { RpcErrorCode } from '@quirky/protocol'
import { isDockState, type DockState } from './types'

/** Delays between retries after the initial dock state read. */
export const DOCK_RETRY_DELAYS_MS: readonly number[] = [500, 1000, 2000, 4000, 8000]

export type DockLoaderOptions = {
  call(method: string, params: Record<string, unknown>): Promise<unknown>
  pane: string
  session: string
  onState(state: DockState): void
  onFailure(error: unknown): void
  retryDelaysMs?: readonly number[]
}

/** Reads a pane's dock state with bounded retries and drops replies overtaken by newer work. */
export class DockLoader {
  private readonly options: DockLoaderOptions
  private readonly retryDelaysMs: readonly number[]
  private sequence = 0
  private retryIndex = 0
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private disposed = false

  constructor(options: DockLoaderOptions) {
    this.options = options
    this.retryDelaysMs = options.retryDelaysMs ?? DOCK_RETRY_DELAYS_MS
  }

  /** Starts a fresh read and resets the bounded retry sequence. */
  load(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    this.clearRetry()
    this.retryIndex = 0
    return this.read(++this.sequence)
  }

  /** Invalidates in-flight reads and cancels pending retries. */
  settle(): void {
    this.sequence += 1
    this.retryIndex = 0
    this.clearRetry()
  }

  /** Invalidates reads and prevents future loads. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.settle()
  }

  private async read(sequence: number): Promise<void> {
    let result: unknown
    try {
      result = await this.options.call('quirky.terminal-dock/get', {
        pane: this.options.pane,
        session: this.options.session
      })
    } catch (error) {
      this.fail(sequence, error)
      return
    }

    if (!this.isCurrent(sequence)) return
    if (!isDockState(result) || result.pane !== this.options.pane || result.session !== this.options.session) {
      this.fail(sequence, new Error('The dock state response was invalid.'))
      return
    }
    this.options.onState(result)
  }

  private fail(sequence: number, error: unknown): void {
    if (!this.isCurrent(sequence)) return
    this.options.onFailure(error)
    if (!this.isCurrent(sequence)) return
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === RpcErrorCode.MethodNotFound) return
    const delay = this.retryDelaysMs[this.retryIndex]
    if (delay === undefined) return
    this.retryIndex += 1
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      if (this.isCurrent(sequence)) void this.read(sequence)
    }, delay)
  }

  private isCurrent(sequence: number): boolean {
    return !this.disposed && this.sequence === sequence
  }

  private clearRetry(): void {
    clearTimeout(this.retryTimer)
    this.retryTimer = undefined
  }
}
