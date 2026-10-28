import type { CliArgs, CliContext, CliModule } from '@quirky/protocol'

function stringFlag(args: CliArgs, name: string): string | undefined {
  const value = args.flags[name]
  return typeof value === 'string' ? value : undefined
}

function noArgs(args: CliArgs, context: CliContext): void {
  if (args.positionals.length > 0 || Object.keys(args.flags).length > 0) throw context.usage('this command takes no arguments')
}

const named: CliModule['commands'] = {
  async 'notification-poll'(args, context) {
    if (args.positionals.length > 0) throw context.usage('notification-poll accepts only named flags')
    const after = args.flags.after
    const waitMs = args.flags['wait-ms']
    if (after !== undefined && (typeof after !== 'number' || !Number.isSafeInteger(after) || after < 0)) throw context.usage('--after must be a nonnegative safe integer')
    if (waitMs !== undefined && (typeof waitMs !== 'number' || !Number.isInteger(waitMs) || waitMs < 0 || waitMs > 25000)) throw context.usage('--wait-ms must be0..25000')
    const epoch = stringFlag(args, 'epoch')
    const suppressWorktree = stringFlag(args, 'suppress-worktree')
    const subscriptionId = stringFlag(args, 'subscription-id')
    const value = await context.call('quirky.mobile/notificationPoll', {
      ...(after === undefined ? {} : { after }),
      ...(waitMs === undefined ? { waitMs: 0 } : { waitMs }),
      ...(epoch === undefined ? {} : { epoch }),
      ...(suppressWorktree === undefined ? {} : { suppressWorktree }),
      ...(subscriptionId === undefined ? {} : { subscriptionId }),
      ...(args.flags['only-away'] === undefined ? {} : { onlyWhenDesktopAway: args.flags['only-away'] === true })
    })
    context.out.result(value, () => JSON.stringify(value, null, 2))
  },
  async 'notification-test'(args, context) {
    noArgs(args, context)
    const value = await context.call('quirky.mobile/notificationTest', {})
    context.out.result(value, () => JSON.stringify(value))
  },
  async 'notification-cancel'(args, context) {
    if (args.positionals.length > 0) throw context.usage('notification-cancel accepts only --subscription-id')
    const subscriptionId = stringFlag(args, 'subscription-id')
    const value = await context.call('quirky.mobile/notificationCancel', subscriptionId === undefined ? {} : { subscriptionId })
    context.out.result(value, () => JSON.stringify(value))
  },
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
  async open(args, context) {
    if (args.positionals.length > 0 || Object.keys(args.flags).some((key) => key !== 'settings')) throw context.usage('usage: mobile open [--settings]')
    if (args.flags.settings !== undefined && typeof args.flags.settings !== 'boolean') throw context.usage('--settings must be boolean')
    const value = await context.call('quirky.mobile/open', { ...(args.flags.settings === undefined ? {} : { settings: args.flags.settings }) })
    context.out.result(value, () => 'opened Mobile')
  },
  async openSettings(args, context) {
    noArgs(args, context)
    const value = await context.call('quirky.mobile/open', { settings: true })
    context.out.result(value, () => 'opened Mobile settings')
  }
}

/** CLI names and method aliases share the same implementation. */
export const commands: CliModule['commands'] = {
  ...named,
  ...Object.fromEntries(Object.entries(named).map(([name, run]) => [`cli-command:quirky.mobile/${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`, run]))
}
