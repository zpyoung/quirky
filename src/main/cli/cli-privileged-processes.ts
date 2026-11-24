import { runProcess } from '@quirky/process-host'

export async function runMacPrivilegedCommand(command: string): Promise<void> {
  const result = await runProcess({
    program: 'osascript',
    args: ['-e', `do shell script ${quoteAppleScript(command)} with administrator privileges`],
    // Why: the OS authorization prompt is user-paced and previously had no deadline.
    timeoutMs: null
  })
  if (result.code !== 0) {
    throw processFailure('osascript', result)
  }
}

function quoteAppleScript(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

function processFailure(
  program: string,
  result: { code: number | null; stderr: string; stdout: string }
): Error {
  const detail = result.stderr || result.stdout
  const error = new Error(detail || `${program} exited with code ${result.code ?? 'unknown'}`)
  Object.assign(error, { code: result.code, stderr: result.stderr })
  return error
}
