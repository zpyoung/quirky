/**
 * The kitty keyboard protocol flags a program has pushed: `CSI > flags u` pushes, `CSI < n u`
 * pops and `CSI = flags ; mode u` replaces, adds or removes bits of the top entry.
 */
export class KittyFlags {
  private stack: number[] = []

  get flags(): number {
    return this.stack.at(-1) ?? 0
  }

  push(flags: number): void {
    this.stack.push(flags)
    if (this.stack.length > 64) this.stack.shift()
  }

  pop(count = 1): void {
    this.stack.length = Math.max(0, this.stack.length - Math.max(1, count))
  }

  set(flags: number, mode = 1): void {
    const current = this.flags
    const next = mode === 2 ? current | flags : mode === 3 ? current & ~flags : flags
    if (this.stack.length === 0) this.stack.push(next)
    else this.stack[this.stack.length - 1] = next
  }
}

type CsiParser = {
  registerCsiHandler(id: { prefix?: string; final: string }, callback: (params: (number | number[])[]) => boolean): { dispose(): void }
}

/** Follows the keyboard protocol sequences the program writes to `parser`. */
export function trackKittyFlags(parser: CsiParser): { kitty: KittyFlags; dispose(): void } {
  const kitty = new KittyFlags()
  const first = (params: (number | number[])[], fallback: number) => {
    const value = params[0]
    return typeof value === 'number' ? value : fallback
  }
  const handlers = [
    parser.registerCsiHandler({ prefix: '>', final: 'u' }, (params) => {
      kitty.push(first(params, 0))
      return true
    }),
    parser.registerCsiHandler({ prefix: '<', final: 'u' }, (params) => {
      kitty.pop(first(params, 1))
      return true
    }),
    parser.registerCsiHandler({ prefix: '=', final: 'u' }, (params) => {
      const mode = typeof params[1] === 'number' ? params[1] : 1
      kitty.set(first(params, 0), mode)
      return true
    })
  ]
  return { kitty, dispose: () => handlers.forEach((handler) => handler.dispose()) }
}
