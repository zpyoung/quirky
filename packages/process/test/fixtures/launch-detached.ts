import { closeSync, openSync } from 'node:fs'
import { launchDetached } from '../../src/api'

const mode = Bun.argv[2]!

if (mode === 'child') {
  const beats = Number(Bun.argv[4])
  // Real-time writes let the integration test observe the detached process lifecycle.
  console.log(`out ${process.pid}`)
  console.error('err')
  for (let beat = 1; beat <= beats; beat += 1) {
    await Bun.sleep(50)
    console.log(`beat ${beat}`)
  }
} else {
  const log = Bun.argv[3]!
  const beats = Bun.argv[4]!
  const fd = openSync(log, 'a')
  const child = (() => {
    try {
      return launchDetached([process.execPath, Bun.argv[1]!, 'child', log, beats], { stdout: fd, stderr: fd })
    } finally {
      closeSync(fd)
    }
  })()
  console.log(child.pid)
  if (mode === 'wait') {
    // Keep the launcher alive for the process-group kill scenario.
    await Bun.sleep(30_000)
  }
}
