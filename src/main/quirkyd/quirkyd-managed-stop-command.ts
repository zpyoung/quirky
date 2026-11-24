/**
 * `quirkyd --complete-managed-stop <request-json>`: one stop, one JSON verdict line on stdout.
 * `quirkyd --cancel-managed-stop <request-json>`: one cancellation, one JSON outcome line.
 * Either takes `--request-file <path>` in place of the JSON.
 *
 * Exit 0 means a result was printed — read it, the exit code does not carry it. 64 is a
 * malformed invocation; 1 is a failure before any result, which is never evidence of exit.
 */
import {
  QUIRKYD_CANCEL_MANAGED_STOP_FLAG,
  QUIRKYD_COMPLETE_MANAGED_STOP_FLAG,
  QUIRKYD_MANAGED_STOP_REQUEST_FILE_FLAG,
  QuirkydManagedStopRequestSchema,
  type QuirkydManagedStopCancellation,
  type QuirkydManagedStopCompletion,
  type QuirkydManagedStopRequest
} from '../../shared/quirkyd-stop-request'
import { cancelQuirkydManagedStop } from './quirkyd-managed-stop-cancellation'
import { readQuirkydCompletedStopReceipt } from './quirkyd-completed-stop-receipt'
import { readQuirkydManagedStopRequest } from './quirkyd-managed-stop-request'
import { ZodError } from 'zod'
import {
  completeQuirkydManagedStop,
  type QuirkydManagedStopCompletionOptions
} from './quirkyd-managed-stop-completion'

export async function runQuirkydManagedStopCommand(
  argv: readonly string[],
  options: QuirkydManagedStopCompletionOptions = {}
): Promise<QuirkydManagedStopCompletion> {
  const request = parseRequestArgument(argv, QUIRKYD_COMPLETE_MANAGED_STOP_FLAG)
  const verdict = await completeQuirkydManagedStop(request, options)
  const retirement =
    verdict === 'exited' && request.retireIdleDaemon
      ? readQuirkydCompletedStopReceipt(request)?.retirement
      : undefined
  const completion: QuirkydManagedStopCompletion = {
    ...request,
    kind: 'quirkyd_managed_stop_completion',
    verdict,
    receiptPersisted: verdict === 'exited',
    ...(retirement ? { retirement } : {})
  }
  process.stdout.write(`${JSON.stringify(completion)}\n`)
  return completion
}

export function runQuirkydManagedStopCancelCommand(
  argv: readonly string[]
): QuirkydManagedStopCancellation {
  const request = parseRequestArgument(argv, QUIRKYD_CANCEL_MANAGED_STOP_FLAG)
  const cancellation: QuirkydManagedStopCancellation = {
    ...request,
    kind: 'quirkyd_managed_stop_cancellation',
    outcome: cancelQuirkydManagedStop(request)
  }
  process.stdout.write(`${JSON.stringify(cancellation)}\n`)
  return cancellation
}

function parseRequestArgument(argv: readonly string[], flag: string): QuirkydManagedStopRequest {
  if (argv[0] !== flag) {
    throw new Error('quirkyd_managed_stop_invalid_arguments')
  }
  if (argv[1] === QUIRKYD_MANAGED_STOP_REQUEST_FILE_FLAG) {
    if (argv.length !== 3 || !argv[2]) {
      throw new Error('quirkyd_managed_stop_invalid_arguments')
    }
    return readQuirkydManagedStopRequest(argv[2])
  }
  if (argv.length !== 2 || !argv[1]) {
    throw new Error('quirkyd_managed_stop_invalid_arguments')
  }
  return QuirkydManagedStopRequestSchema.parse(JSON.parse(argv[1]))
}

export const QUIRKYD_MANAGED_STOP_EXIT_VERDICT = 0
export const QUIRKYD_MANAGED_STOP_EXIT_FAILED = 1
export const QUIRKYD_MANAGED_STOP_EXIT_USAGE = 64

export async function runQuirkydManagedStopCommandAndExit(argv: readonly string[]): Promise<void> {
  let code = QUIRKYD_MANAGED_STOP_EXIT_VERDICT
  try {
    if (argv[0] === QUIRKYD_CANCEL_MANAGED_STOP_FLAG) {
      runQuirkydManagedStopCancelCommand(argv)
    } else {
      await runQuirkydManagedStopCommand(argv)
    }
  } catch (error) {
    console.error('quirkyd: managed stop failed:', error)
    code =
      error instanceof ZodError ||
      error instanceof SyntaxError ||
      (error instanceof Error && error.message === 'quirkyd_managed_stop_invalid_arguments')
        ? QUIRKYD_MANAGED_STOP_EXIT_USAGE
        : QUIRKYD_MANAGED_STOP_EXIT_FAILED
  }
  // Why exit after the write drains: the caller reads stdout to EOF.
  process.stdout.write('', () => process.exit(code))
}
