import type { CliModule } from '@quirky/protocol'

const notImplemented: CliModule['commands'][string] = async (_args, ctx) => {
  throw ctx.fail('not implemented')
}

/** The `quirky avatar` commands; each fails with exit 1 until it is built. */
export const commands: CliModule['commands'] = {
  handoff: notImplemented,
  status: notImplemented,
  report: notImplemented,
  log: notImplemented,
  'take-back': notImplemented
}
