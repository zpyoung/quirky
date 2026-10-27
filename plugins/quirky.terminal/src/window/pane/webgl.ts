/** How many panes may hold a WebGL context at once; browsers drop the oldest context past about 16. */
export const MAX_WEBGL_PANES = 12

/** A counted pool of WebGL slots shared by every pane in the window. */
export class WebglBudget {
  private held = 0

  constructor(private readonly limit: number) {}

  get count(): number {
    return this.held
  }

  tryAcquire(): boolean {
    if (this.held >= this.limit) return false
    this.held += 1
    return true
  }

  release(): void {
    this.held = Math.max(0, this.held - 1)
  }
}

export const webglBudget = new WebglBudget(MAX_WEBGL_PANES)

/** Counts context losses inside a sliding window and reports when one pane has lost too many. */
export class ContextLossGuard {
  private losses: number[] = []

  constructor(
    private readonly limit = 3,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now
  ) {}

  /** Records a loss; true when it is the `limit`th within the window. */
  record(): boolean {
    const at = this.now()
    this.losses = this.losses.filter((time) => at - time < this.windowMs)
    this.losses.push(at)
    return this.losses.length >= this.limit
  }
}

type LoseContext = { loseContext(): void }
type GlContext = { getExtension(name: string): unknown }

/**
 * Asks every WebGL canvas under `root` to release its context. Disposing the addon alone leaves
 * the context allocated until garbage collection, which would eat the browser's context budget.
 */
export function loseWebglContext(root: Element | null | undefined): void {
  if (!root) return
  for (const canvas of Array.from(root.querySelectorAll('canvas'))) {
    try {
      const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as GlContext | null
      ;(gl?.getExtension('WEBGL_lose_context') as LoseContext | null | undefined)?.loseContext()
    } catch {
      // not a WebGL canvas
    }
  }
}
