import { startPtyServer } from '../../src/server'

const home = process.env.QUIRKY_HOME
if (!home) throw new Error('QUIRKY_HOME is required')

const server = startPtyServer({ home })
process.once('SIGTERM', () => {
  void server.stop().then(
    () => process.exit(0),
    () => process.exit(1)
  )
})
