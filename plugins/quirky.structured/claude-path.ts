/**
 * Finds the user's `claude` executable the way their terminal would: `command -v claude` in a
 * login shell, so PATH entries added by shell profiles count. Throws when nothing is found.
 */
export async function resolveClaudeThroughLoginShell(shell: string): Promise<string> {
  const proc = Bun.spawn([shell, '-l', '-c', 'command -v claude'], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'ignore'
  })
  const output = (await new Response(proc.stdout).text()).trim().split('\n').pop() ?? ''
  await proc.exited
  if (!output) throw new Error('could not find the claude executable on the login shell PATH')
  return output
}
