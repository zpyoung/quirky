import { execFileCapture } from './exec-file-capture'

type CommandExecOptions = {
  cwd?: string
  encoding?: BufferEncoding
  maxBuffer?: number
  timeout?: number
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
  wslDistro?: string
}

/**
 * Async command execution for fixed binary+argv call sites; never pass shell fragments.
 */
export async function commandExecFileAsync(
  command: string,
  args: string[],
  options: CommandExecOptions = {}
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileCapture(command, args, {
    cwd: options.cwd,
    encoding: options.encoding ?? 'utf-8',
    maxBuffer: options.maxBuffer,
    timeout: options.timeout,
    env: options.env,
    signal: options.signal
  })
  return { stdout: stdout as string, stderr: stderr as string }
}
