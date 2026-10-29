import { homedir } from 'node:os'
import { resolve } from 'node:path'
import type { CliArgs, CliContext, CliModule } from '@quirky/protocol'

type InstalledCommandStatus = { path: string; target: string | null; state: 'missing' | 'managed' | 'foreign'; profileHome: string }
type RuntimeSummary = { id: string; name: string; endpoint: string; pairedDeviceId: string; scope: 'mobile' | 'owner-cli'; grantId?: string; createdAt: number; lastUsedAt: number | null }
type ProfileLauncherStatus = { name: string; path: string; target: string | null; state: 'missing' | 'managed' | 'foreign'; profileHome: string }

function stringFlag(args: CliArgs, context: CliContext, name: string, required = false): string | undefined {
  const value = args.flags[name]
  if (value === undefined && !required) return undefined
  if (typeof value !== 'string' || value.length === 0) throw context.usage(`--${name} must be a non-empty string`)
  return value
}

function booleanFlag(args: CliArgs, context: CliContext, name: string): boolean {
  const value = args.flags[name]
  if (value === undefined) return false
  if (typeof value !== 'boolean') throw context.usage(`--${name} must be a boolean`)
  return value
}

function profileHome(context: CliContext): string {
  return context.env.QUIRKY_HOME ?? resolve(homedir(), '.quirky')
}

function invocationTarget(context: CliContext): { executablePath: string; entrypointPath: string } {
  const entrypoint = process.argv[1]
  if (!entrypoint) throw context.fail('the current CLI entrypoint cannot be identified')
  return { executablePath: process.execPath, entrypointPath: resolve(context.cwd, entrypoint) }
}

function output(context: CliContext, value: unknown, text: string): void {
  context.out.result(value, () => text)
}

function statusText(status: InstalledCommandStatus): string {
  return [
    `state: ${status.state}`,
    `path: ${status.path}`,
    `target: ${status.target ?? 'none'}`,
    `profileHome: ${status.profileHome}`
  ].join('\n')
}

function runtimeText(runtime: RuntimeSummary): string {
  return `${runtime.name}  id=${runtime.id}  ${runtime.endpoint}  scope=${runtime.scope}  ${runtime.scope === 'owner-cli' ? `grantId=${runtime.grantId}` : `pairedDeviceId=${runtime.pairedDeviceId}`}`
}

function profileText(profile: ProfileLauncherStatus): string {
  return `${profile.name}  ${profile.state}  ${profile.path}  QUIRKY_HOME=${profile.profileHome}`
}

export const commands: CliModule['commands'] = {
  async hostIdentity(_args, context) {
    const identity = await context.call('quirky.cli/hostIdentity', {}) as { hostId: string; generation: string }
    output(context, identity, `hostId: ${identity.hostId}\ngeneration: ${identity.generation}`)
  },

  async commandStatus(args, context) {
    const status = await context.call('quirky.cli/commandStatus', {
      ...(stringFlag(args, context, 'path') === undefined ? {} : { path: stringFlag(args, context, 'path') }),
      profileHome: profileHome(context)
    }) as InstalledCommandStatus
    output(context, status, statusText(status))
  },

  async commandInstall(args, context) {
    const target = invocationTarget(context)
    const status = await context.call('quirky.cli/commandInstall', {
      ...(stringFlag(args, context, 'path') === undefined ? {} : { path: stringFlag(args, context, 'path') }),
      ...target,
      profileHome: profileHome(context),
      ...(booleanFlag(args, context, 'replace-foreign') ? { replaceForeign: true } : {})
    }) as InstalledCommandStatus
    output(context, status, statusText(status))
  },

  async commandUninstall(args, context) {
    const result = await context.call('quirky.cli/commandUninstall', {
      ...(stringFlag(args, context, 'path') === undefined ? {} : { path: stringFlag(args, context, 'path') })
    }) as { removed: boolean; state: 'missing' | 'foreign' }
    output(context, result, `removed: ${result.removed}\nstate: ${result.state}`)
  },

  async commandReveal(_args, context) {
    const result = await context.call('quirky.cli/commandReveal', {}) as { path: string; requested: boolean }
    output(context, result, `reveal requested: ${result.path}`)
  },

  async profileLauncherList(_args, context) {
    const result = await context.call('quirky.cli/profileLauncherList', {}) as { launchers: ProfileLauncherStatus[] }
    output(context, result, result.launchers.length ? result.launchers.map(profileText).join('\n') : 'No profile launchers found.')
  },

  async profileLauncherInstall(args, context) {
    const name = stringFlag(args, context, 'name', true)!
    const target = invocationTarget(context)
    const status = await context.call('quirky.cli/profileLauncherInstall', {
      name,
      profileHome: stringFlag(args, context, 'home', true),
      ...target,
      ...(stringFlag(args, context, 'path') === undefined ? {} : { path: stringFlag(args, context, 'path') }),
      ...(booleanFlag(args, context, 'replace-foreign') ? { replaceForeign: true } : {})
    }) as ProfileLauncherStatus
    output(context, status, profileText(status))
  },

  async profileLauncherRemove(args, context) {
    const result = await context.call('quirky.cli/profileLauncherRemove', { path: stringFlag(args, context, 'path', true) }) as {
      removed: boolean; state: 'missing' | 'foreign'
    }
    output(context, result, `removed: ${result.removed}\nstate: ${result.state}`)
  },

  async runtimeAdd(args, context) {
    const runtime = await context.call('quirky.cli/runtimeAdd', {
      name: stringFlag(args, context, 'name', true),
      pairingCode: stringFlag(args, context, 'code', true)
    }) as RuntimeSummary
    output(context, runtime, runtimeText(runtime))
  },

  async runtimeList(_args, context) {
    const result = await context.call('quirky.cli/runtimeList', {}) as { runtimes: RuntimeSummary[] }
    output(context, result, result.runtimes.length ? result.runtimes.map(runtimeText).join('\n') : 'No paired runtimes saved.')
  },

  async runtimeShow(args, context) {
    const runtime = await context.call('quirky.cli/runtimeShow', { selector: stringFlag(args, context, 'selector', true) }) as RuntimeSummary
    output(context, runtime, runtimeText(runtime))
  },

  async runtimeCall(args, context) {
    if (args.positionals.length > 0) throw context.usage('runtime-call accepts only --target, --method, and optional --arguments')
    const runtime = stringFlag(args, context, 'target', true)!
    const method = stringFlag(args, context, 'method', true)!
    const encodedParams = stringFlag(args, context, 'arguments')
    let params: Record<string, unknown> | undefined
    if (encodedParams !== undefined) {
      let parsed: unknown
      try { parsed = JSON.parse(encodedParams) as unknown } catch { throw context.usage('--arguments must be valid JSON') }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw context.usage('--arguments must encode a JSON object')
      params = parsed as Record<string, unknown>
    }
    const result = await context.call('quirky.cli/runtimeCall', { runtime, method, ...(params === undefined ? {} : { params }) })
    output(context, result, JSON.stringify(result, null, 2))
  },

  async runtimeRemove(args, context) {
    const runtime = await context.call('quirky.cli/runtimeRemove', { selector: stringFlag(args, context, 'selector', true) }) as RuntimeSummary
    output(context, runtime, `removed: ${runtime.name}  id=${runtime.id}`)
  },

  async runtimeStatus(_args, context) {
    const result = await context.call('quirky.cli/runtimeStatus', {}) as { runtimes: RuntimeSummary[] }
    output(context, result, result.runtimes.length ? result.runtimes.map(runtimeText).join('\n') : 'No paired runtimes saved.')
  }
}
