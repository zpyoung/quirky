import { startWorkerControl } from './acceptance-control'

// A provider transport fixture, not an orchestration substitute: every commanded
// operation runs the real quirky CLI with this actual launched process's environment.
if (process.argv.slice(2).includes('--version')) {
  process.stdout.write('1.0.0 (isolated orchestration provider fixture)\n')
  process.exit(0)
}
const idle = '\x1b]0;✳ Claude Code\x07\r\n● Ready.\r\n╭─────────────────────────────────────────────╮\r\n│ >                                           │\r\n╰─────────────────────────────────────────────╯\r\n  ? for shortcuts\r\n'
const control = startWorkerControl(() => process.stdout.write(idle))
process.stdout.write(idle)
if (process.stdin.isTTY) process.stdin.setRawMode(true)
let pasted = false
let receivingPaste = false
process.stdin.on('data', (chunk: Buffer) => {
  const text = chunk.toString()
  control.log({ type: 'input', base64: chunk.toString('base64') })
  if (text.includes('\x1b[200~')) receivingPaste = true
  const end = text.indexOf('\x1b[201~')
  if (end >= 0) {
    pasted = true
    receivingPaste = false
  }
  if (pasted && (text === '\r' || text === '\n' || (end >= 0 && /[\r\n]$/.test(text.slice(end + 6))))) {
    pasted = false
    process.stdout.write('\x1b]0;⠋ Claude Code\x07\r\n✻ Working… (esc to interrupt)\r\n')
    control.log({ type: 'turn_started' })
  } else if (!receivingPaste && !pasted && !text.includes('\x1b')) {
    process.stdout.write(text)
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
