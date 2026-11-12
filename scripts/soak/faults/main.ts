import type { PluginContext } from '@quirky/protocol'

type LeakParams = { count: number; everyMs: number; lifetimeSeconds: number }
type ZombiesParams = { holders: number; each: number; lifetimeSeconds: number }
type RefreshParams = { owner: string }
type BlockParams = { ms: number }

const leaked: number[] = []
const holders: number[] = []
let refreshes = 0
let blockedMs: number | null = null
let refreshOwner = ''

/** Registers fault handlers for an explicitly marked soak daemon. */
export function activate(context: PluginContext): void {
  if (process.env.QUIRKY_SOAK_FAULTS !== '1') {
    throw new Error('soak.faults runs only inside a soak')
  }

  context.provide('method:soak.faults/leak', (params: LeakParams) => {
    let started = 0
    const timer = setInterval(() => {
      const child = Bun.spawn(['sleep', String(params.lifetimeSeconds)], {
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'ignore'
      })
      leaked.push(child.pid)
      started += 1
      if (started === params.count) clearInterval(timer)
    }, params.everyMs)

    return { started: true }
  })

  context.provide('method:soak.faults/zombies', (params: ZombiesParams) => {
    for (let index = 0; index < params.holders; index += 1) {
      const command = Array.from({ length: params.each }, () => 'sleep 0.3').join(' & ')
      const child = Bun.spawn(['/bin/sh', '-c', `${command} & exec sleep ${params.lifetimeSeconds}`], {
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'ignore'
      })
      holders.push(child.pid)
    }

    return { holders }
  })

  context.provide('method:soak.faults/refresh', (params: RefreshParams) => {
    refreshes += 1
    refreshOwner = params.owner
    const result = { owner: refreshOwner }
    setTimeout(() => context.emit('changed', { owner: refreshOwner }), 50)
    return result
  })

  context.provide('method:soak.faults/block', (params: BlockParams) => {
    const startedAt = performance.now()
    Bun.spawnSync(['sleep', String(params.ms / 1000)], {
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore'
    })
    blockedMs = Math.round(performance.now() - startedAt)
    return { blockedMs }
  })

  context.provide('method:soak.faults/report', () => ({ leaked, holders, refreshes, blockedMs }))
}
