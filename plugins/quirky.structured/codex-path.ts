import { spawn } from 'node:child_process'

/** Finds the user's `codex` executable through their login shell without touching global config. */
export async function resolveCodexThroughLoginShell(shell: string): Promise<string> {
  const child = spawn(shell, ['-l', '-c', 'command -v codex'], {
    stdio: ['ignore', 'pipe', 'ignore']
  })
  const closed = Promise.withResolvers<number | null>()
  child.once('error', closed.reject)
  child.once('close', (code) => closed.resolve(code))
  const outputPromise = (async () => {
    let output = ''
    for await (const chunk of child.stdout!) output += Buffer.from(chunk).toString('utf8')
    return output
  })()
  const [output, exitCode] = await Promise.all([outputPromise, closed.promise])
  const executable = output.trim().split('\n').at(-1) ?? ''
  if (exitCode !== 0 || !executable) throw new Error('could not find the codex executable on the login shell PATH')
  return executable
}
