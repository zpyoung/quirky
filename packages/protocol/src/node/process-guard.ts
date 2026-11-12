import { inspect } from 'node:util'

export interface ProcessErrorGuardOptions {
  label: string
  write?: (line: string) => void
}

/** Logs stray process errors without terminating; the returned disposer removes only these listeners. */
export function installProcessErrorGuards({ label, write = (line) => { process.stderr.write(line) } }: ProcessErrorGuardOptions): () => void {
  const log = (event: string, error: unknown) => {
    try {
      const detail = error instanceof Error ? error.stack || `${error.name}: ${error.message}` : typeof error === 'string' ? error : inspect(error)
      write(`[${label}] ${event}: ${detail}\n`)
    } catch {}
  }
  const exception = (error: unknown) => log('uncaughtException', error)
  const rejection = (error: unknown) => log('unhandledRejection', error)
  process.on('uncaughtException', exception)
  process.on('unhandledRejection', rejection)
  return () => {
    process.off('uncaughtException', exception)
    process.off('unhandledRejection', rejection)
  }
}
