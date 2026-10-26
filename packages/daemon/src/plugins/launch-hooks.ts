import { isReservedLaunchEnv, type LaunchHook, type LaunchHookInput } from '@quirky/protocol'

export type RunLaunchHooksOptions = {
  plugins: {
    contributions(filter: { kind: string }): Array<{ id: string; plugin: string; data: Record<string, unknown> }>
    resolveImplementation(id: string): Promise<unknown>
  }
  input: Omit<LaunchHookInput, 'env' | 'args'>
  /** Bounds each hook's resolve and call together. */
  timeoutMs: number
  warn(pluginId: string, message: string): void
}

export type LaunchAdditions = { env: Record<string, string | null>; args: string[] }

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

class HookTimedOut extends Error {}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isCleanString(value: unknown): value is string {
  return typeof value === 'string' && !value.includes('\0')
}

function isCleanArgs(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isCleanString)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `work` receives `hasTimedOut`, so a step that has not started yet can be skipped once the deadline has passed. */
function timeBound<T>(work: (hasTimedOut: () => boolean) => Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  let expired = false
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expired = true
      reject(new HookTimedOut())
    }, ms)
  })
  return Promise.race([work(() => expired), timeout]).finally(() => clearTimeout(timer))
}

/**
 * Runs the launch hooks that apply to `input.agent`, one at a time in ID order, and returns the
 * env additions (with `null` marking a removal) and extra args they produced. A hook that fails or
 * times out contributes nothing and gets a warning; a bad entry in a hook's patch is dropped with a
 * warning. Never rejects.
 */
export async function runLaunchHooks(options: RunLaunchHooksOptions): Promise<LaunchAdditions> {
  const { plugins, input, timeoutMs, warn } = options
  const env = new Map<string, string | null>()
  const args: string[] = []

  const hooks = plugins
    .contributions({ kind: 'launch-hook' })
    .filter((hook) => hook.data.agents === undefined || (Array.isArray(hook.data.agents) && hook.data.agents.includes(input.agent)))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  for (const hook of hooks) {
    const launch: LaunchHookInput = {
      ...input,
      env: Object.freeze(Object.fromEntries([...env].filter((entry): entry is [string, string] => entry[1] !== null))),
      args: Object.freeze([...args])
    }
    let patch: unknown
    try {
      patch = await timeBound(async (hasTimedOut) => {
        const implementation = (await plugins.resolveImplementation(hook.id)) as LaunchHook
        if (hasTimedOut()) throw new HookTimedOut()
        return implementation(launch)
      }, timeoutMs)
    } catch (error) {
      warn(
        hook.plugin,
        error instanceof HookTimedOut
          ? `launch hook ${hook.id} timed out after ${timeoutMs} ms`
          : `launch hook ${hook.id} failed: ${messageOf(error)}`
      )
      continue
    }

    const warnings: string[] = []
    const additions = new Map<string, string | null>()
    let extraArgs: string[] = []
    try {
      if (patch !== undefined && patch !== null) {
        if (!isRecord(patch) || (patch.env != null && !isRecord(patch.env))) throw new Error('returned something other than a patch object')
        for (const [name, value] of Object.entries(patch.env ?? {})) {
          if (!ENV_NAME.test(name) || !(value === null || isCleanString(value))) {
            warnings.push(`launch hook ${hook.id} set invalid variable ${name}`)
          } else if (isReservedLaunchEnv(name)) {
            warnings.push(`launch hook ${hook.id} tried to set reserved variable ${name}`)
          } else {
            additions.set(name, value)
          }
        }
        if (patch.args !== undefined) {
          if (!isCleanArgs(patch.args)) warnings.push(`launch hook ${hook.id} returned invalid args`)
          else if (input.agent === 'shell') warnings.push(`launch hook ${hook.id} returned args for a shell session, which take none`)
          else extraArgs = [...patch.args]
        }
      }
    } catch (error) {
      warn(hook.plugin, `launch hook ${hook.id} failed: ${messageOf(error)}`)
      continue
    }
    for (const message of warnings) warn(hook.plugin, message)
    for (const [name, value] of additions) env.set(name, value)
    args.push(...extraArgs)
  }

  return { env: Object.fromEntries(env), args }
}
