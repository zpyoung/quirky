import { startWorkerControl } from './acceptance-control'

// This provider accepts terminal input but never emits working/turn-start evidence.
if (process.argv.slice(2).includes('--version')) {
  process.stdout.write('1.0.0 (isolated orchestration provider fixture)\n')
  process.exit(0)
}

const idle = '\x1b]0;✳ Claude Code\x07\r\n● Ready.\r\n╭─────────────────────────────────────────────╮\r\n│ >                                           │\r\n╰─────────────────────────────────────────────╯\r\n  ? for shortcuts\r\n'
const control = startWorkerControl()
process.stdout.write(idle)
if (process.stdin.isTTY) process.stdin.setRawMode(true)
let outputWritten = false
process.stdin.on('data', (chunk: Buffer) => {
  const text = chunk.toString()
  control.log({ type: 'input', base64: chunk.toString('base64') })
  if (!outputWritten && text.includes('\x1b[201~')) {
    outputWritten = true
    const output = Array.from({ length: 1_400 }, () => 'recovery-output from an accepted worker preamble')
    process.stdout.write(`\r\n${output.join('\r\n')}\r\n`)
  }
})
process.stdin.resume()
const finish = () => {
  control.stop()
  process.exit(0)
}
process.on('SIGTERM', finish)
process.on('SIGHUP', finish)
process.on('SIGINT', finish)
