import type { CliArgs, CliContext, CliModule } from '@quirky/protocol'

function stringFlag(args: CliArgs, name: string): string | undefined {
  const value = args.flags[name]
  return typeof value === 'string' ? value : undefined
}

function noArgs(args: CliArgs, context: CliContext): void {
  if (args.positionals.length > 0 || Object.keys(args.flags).length > 0) throw context.usage('this command takes no arguments')
}

function bundleReadArgs(args: CliArgs, context: CliContext, withGzip: boolean): { buildId: string; path: string; offset: number; gzip?: boolean } {
  const allowed = withGzip ? ['build-id', 'path', 'offset', 'gzip'] : ['build-id', 'path', 'offset']
  if (args.positionals.length > 0 || Object.keys(args.flags).some((key) => !allowed.includes(key))) throw context.usage('bundle reads accept only --build-id, --path, --offset, and range-only --gzip')
  const buildId = stringFlag(args, 'build-id')
  const path = stringFlag(args, 'path')
  const offset = args.flags.offset
  if (buildId === undefined || !/^[0-9a-f]{64}$/.test(buildId) || path === undefined || !Number.isSafeInteger(offset) || (offset as number) < 0) throw context.usage('bundle reads require --build-id, --path, and a non-negative integer --offset')
  if (withGzip && args.flags.gzip !== undefined && typeof args.flags.gzip !== 'boolean') throw context.usage('--gzip must be boolean')
  return {
    buildId,
    path,
    offset: offset as number,
    ...(withGzip && args.flags.gzip === true ? { gzip: true } : {})
  }
}

export const commands: CliModule['commands'] = {
  async info(args, context) {
    noArgs(args, context)
    const value = await context.call('quirky.mobile/info', {})
    context.out.result(value, () => JSON.stringify(value, null, 2))
  },
  async state(args, context) {
    noArgs(args, context)
    const value = await context.call('quirky.mobile/state', {})
    context.out.result(value, () => JSON.stringify(value, null, 2))
  },
  async interfaces(args, context) {
    noArgs(args, context)
    const value = await context.call('quirky.mobile/interfaces', {})
    context.out.result(value, () => JSON.stringify(value, null, 2))
  },
  async pair(args, context) {
    if (args.positionals.length > 0) throw context.usage('pair accepts only --address and --rotate')
    const address = stringFlag(args, 'address')
    const rotate = args.flags.rotate === true
    if (args.flags.rotate !== undefined && typeof args.flags.rotate !== 'boolean') throw context.usage('--rotate must be boolean')
    const value = await context.call('quirky.mobile/pair', { ...(address === undefined ? {} : { address }), ...(rotate ? { rotate: true } : {}) })
    context.out.result(value, () => JSON.stringify(value, null, 2))
  },
  async devices(args, context) {
    noArgs(args, context)
    const value = await context.call('quirky.mobile/devices', {}) as { deviceId: string; name: string; pairedAt: number; lastSeenAt: number }[]
    context.out.result(value, () => value.length
      ? context.format.table(['DEVICE', 'NAME', 'PAIRED', 'LAST SEEN'], value.map((device) => [device.deviceId, device.name, new Date(device.pairedAt).toISOString(), new Date(device.lastSeenAt).toISOString()]))
      : 'no paired devices')
  },
  async revoke(args, context) {
    const [deviceId] = args.positionals
    if (!deviceId || args.positionals.length !== 1 || Object.keys(args.flags).length > 0) throw context.usage('usage: mobile revoke <deviceId>')
    const value = await context.call('quirky.mobile/revoke', { deviceId })
    context.out.result(value, () => JSON.stringify(value))
  },
  async configure(args, context) {
    if (args.positionals.length > 0) throw context.usage('configure accepts only named flags')
    const show = args.flags['show-mobile-button'] === true
    const hide = args.flags['hide-mobile-button'] === true
    if (show && hide) throw context.usage('--show-mobile-button and --hide-mobile-button cannot be used together')
    const keepPhoneSize = args.flags['keep-phone-size'] === true
    const restoreMs = args.flags['restore-fit-ms']
    if (keepPhoneSize && restoreMs !== undefined) throw context.usage('--keep-phone-size and --restore-fit-ms cannot be used together')
    if (restoreMs !== undefined && (typeof restoreMs !== 'number' || !Number.isFinite(restoreMs))) throw context.usage('--restore-fit-ms must be a finite number')
    const custom = args.flags['custom-address']
    let customAddresses: string[] | undefined
    if (custom !== undefined) {
      const requested: unknown[] = Array.isArray(custom) ? custom : [custom]
      customAddresses = []
      for (const address of requested) {
        if (typeof address !== 'string') throw context.usage('--custom-address must be a string')
        customAddresses.push(address)
      }
    }
    const machineName = stringFlag(args, 'machine-name')
    const value = await context.call('quirky.mobile/configure', {
      ...(machineName === undefined ? {} : { machineName }),
      ...(show || hide ? { showMobileButton: show } : {}),
      ...(args.flags['onboarding-seen'] === true ? { onboardingSeen: true } : {}),
      ...(keepPhoneSize ? { autoRestoreFitMs: null } : restoreMs === undefined ? {} : { autoRestoreFitMs: restoreMs }),
      ...(customAddresses === undefined ? {} : { customAddresses })
    })
    context.out.result(value, () => JSON.stringify(value, null, 2))
  },
  async 'bundle-manifest'(args, context) {
    noArgs(args, context)
    const value = await context.call('quirky.mobile/bundleManifest', {})
    context.out.result(value, () => JSON.stringify(value, null, 2))
  },
  async 'agent-catalog'(args, context) {
    noArgs(args, context)
    const value = await context.call('quirky.mobile/agentCatalog', {})
    context.out.result(value, () => JSON.stringify(value, null, 2))
  },
  async 'bundle-chunk'(args, context) {
    const value = await context.call('quirky.mobile/bundleChunk', bundleReadArgs(args, context, false))
    context.out.result(value, () => JSON.stringify(value, null, 2))
  },
  async 'bundle-range'(args, context) {
    const value = await context.call('quirky.mobile/bundleRange', bundleReadArgs(args, context, true))
    context.out.result(value, () => JSON.stringify(value, null, 2))
  },
  async open(args, context) {
    if (args.positionals.length > 0 || Object.keys(args.flags).some((key) => key !== 'settings')) throw context.usage('usage: mobile open [--settings]')
    if (args.flags.settings !== undefined && typeof args.flags.settings !== 'boolean') throw context.usage('--settings must be boolean')
    const value = await context.call('quirky.mobile/open', { ...(args.flags.settings === undefined ? {} : { settings: args.flags.settings }) })
    context.out.result(value, () => 'opened Mobile')
  },
  async 'open-settings'(args, context) {
    noArgs(args, context)
    const value = await context.call('quirky.mobile/open', { settings: true })
    context.out.result(value, () => 'opened Mobile settings')
  }
}
