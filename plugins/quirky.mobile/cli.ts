import type { CliArgs, CliContext, CliModule } from '@quirky/protocol'
import { validMobileBrowserParams } from '@quirky/protocol'

const WATCH_METHODS: Record<string, string> = {
  create: 'quirky.mobile/browserWatchCreate', start: 'quirky.mobile/browserWatchStart',
  frame: 'quirky.mobile/browserWatchFrame', ack: 'quirky.mobile/browserWatchFrameAck',
  stop: 'quirky.mobile/browserWatchStop', navigate: 'quirky.mobile/browserWatchNavigate',
  control: 'quirky.mobile/browserWatchControl', input: 'quirky.mobile/browserWatchInput'
}
const WATCH_FLAGS: Record<string, string> = {
  worktree: 'worktree', 'tab-id': 'tabId', 'watch-id': 'watchId', url: 'url', sequence: 'sequence',
  input: 'input', action: 'action', text: 'text', forward: 'forward', level: 'level', preset: 'preset',
  kind: 'kind', type: 'type', x: 'x', y: 'y', button: 'button', key: 'key', code: 'code',
  'delta-x': 'deltaX', 'delta-y': 'deltaY', modifiers: 'modifiers'
}

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

function tabArgs(args: CliArgs, context: CliContext, fields: readonly string[]): Record<string, unknown> {
  const allowed = ['worktree', ...fields]
  if (args.positionals.length || Object.keys(args.flags).some((key) => !allowed.includes(key))) throw context.usage(`accepted flags: ${allowed.map((field) => `--${field}`).join(', ')}`)
  const worktree = stringFlag(args, 'worktree')
  if (!worktree?.trim()) throw context.usage('--worktree is required')
  const params: Record<string, unknown> = { worktree }
  if (fields.includes('tab-id')) {
    const tabId = stringFlag(args, 'tab-id')
    if (!tabId?.trim()) throw context.usage('--tab-id is required')
    params.tabId = tabId
  }
  if (fields.includes('expected-revision')) {
    const revision = args.flags['expected-revision']
    if (!Number.isSafeInteger(revision) || (revision as number) < 0) throw context.usage('--expected-revision must be a non-negative integer')
    params.expectedRevision = revision
  }
  if (fields.includes('text')) {
    const text = stringFlag(args, 'text')
    if (text === undefined || Buffer.byteLength(text) > 64 * 1024) throw context.usage('--text is required and must fit 64 KiB of UTF-8')
    params.text = text
  }
  return params
}

export const commands: CliModule['commands'] = {
  async 'agent-catalog'(args, context) {
    noArgs(args, context)
    const value = await context.call('quirky.mobile/agentCatalog', {})
    context.out.result(value, () => JSON.stringify(value, null, 2))
  },
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
  async 'owner-pair'(args, context) {
    if (args.positionals.length > 0) throw context.usage('owner-pair accepts only --name, --address, and --confirm')
    const name = stringFlag(args, 'name', true)
    const address = stringFlag(args, 'address')
    if (!booleanFlag(args, 'confirm')) throw context.usage('owner-pair requires explicit --confirm')
    const value = await context.call('quirky.mobile/ownerPair', {
      name,
      confirm: true,
      ...(address === undefined ? {} : { address })
    }) as { offer: string; grant: { grantId: string; name: string; endpoint: string } }
    context.out.result(value, () => `Owner grant ${value.grant.name} (${value.grant.grantId})\n${value.grant.endpoint}\nCopy this owner-cli offer securely:\n${value.offer}`)
  },
  async 'owner-grants'(args, context) {
    noArgs(args, context)
    const grants = await context.call('quirky.mobile/ownerGrants', {}) as { grantId: string; name: string; endpoint: string; createdAt: number }[]
    context.out.result(grants, () => grants.length
      ? context.format.table(['GRANT', 'NAME', 'ENDPOINT', 'CREATED'], grants.map((grant) => [grant.grantId, grant.name, grant.endpoint, new Date(grant.createdAt).toISOString()]))
      : 'no owner CLI grants')
  },
  async 'owner-revoke'(args, context) {
    const [grantId] = args.positionals
    if (!grantId || args.positionals.length !== 1 || Object.keys(args.flags).some((key) => key !== 'confirm') || !booleanFlag(args, 'confirm')) {
      throw context.usage('usage: mobile owner-revoke <grantId> --confirm')
    }
    const value = await context.call('quirky.mobile/ownerRevoke', { grantId, confirm: true })
    context.out.result(value, () => JSON.stringify(value))
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
  async 'session-tabs'(args, context) {
    const value = await context.call('quirky.mobile/sessionTabs', tabArgs(args, context, []))
    context.out.result(value, () => JSON.stringify(value, null, 2))
  },
  async 'markdown-create'(args, context) {
    const value = await context.call('quirky.mobile/markdownCreate', tabArgs(args, context, []))
    context.out.result(value, () => JSON.stringify(value, null, 2))
  },
  async 'markdown-read'(args, context) {
    const value = await context.call('quirky.mobile/markdownRead', tabArgs(args, context, ['tab-id']))
    context.out.result(value, () => JSON.stringify(value, null, 2))
  },
  async 'markdown-write'(args, context) {
    const value = await context.call('quirky.mobile/markdownWrite', tabArgs(args, context, ['tab-id', 'text', 'expected-revision']))
    context.out.result(value, () => JSON.stringify(value, null, 2))
  },
  async 'markdown-save'(args, context) {
    const value = await context.call('quirky.mobile/markdownSave', tabArgs(args, context, ['tab-id', 'expected-revision']))
    context.out.result(value, () => JSON.stringify(value, null, 2))
  },
  async 'session-tab-action'(args, context) {
    const params = tabArgs(args, context, ['tab-id', 'action', 'name', 'discard'])
    const action = stringFlag(args, 'action')
    if (!action || !['rename', 'close', 'refresh'].includes(action)) throw context.usage('--action must be rename, close or refresh')
    params.action = action
    if (action === 'rename') {
      const name = stringFlag(args, 'name')
      if (!name?.trim() || name.length > 128 || args.flags.discard !== undefined) throw context.usage('rename requires --name (1–128 characters), without --discard')
      params.name = name
    } else if (args.flags.name !== undefined) throw context.usage('--name is only accepted for rename')
    if (args.flags.discard !== undefined) {
      if (action !== 'close' || typeof args.flags.discard !== 'boolean') throw context.usage('--discard is a close-only boolean')
      params.discard = args.flags.discard
    }
    const value = await context.call('quirky.mobile/sessionTabAction', params)
    context.out.result(value, () => JSON.stringify(value, null, 2))
  },
  async 'browser-watch'(args, context) {
    const operation = args.positionals[0]
    if (args.positionals.length !== 1 || !operation || !Object.hasOwn(WATCH_METHODS, operation)) throw context.usage('usage: mobile browser-watch <create|start|frame|ack|stop|navigate|control|input> --worktree <id> [typed flags]')
    const method = WATCH_METHODS[operation]!
    const params: Record<string, unknown> = {}
    for (const [flag, value] of Object.entries(args.flags)) {
      if (!Object.hasOwn(WATCH_FLAGS, flag)) throw context.usage(`unsupported Watch flag --${flag}`)
      params[WATCH_FLAGS[flag]!] = value
    }
    if (!validMobileBrowserParams(method, params)) throw context.usage('invalid typed Watch parameters; use the exact workspace, tab, live lease and operation fields')
    const value = await context.call(method, params)
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
