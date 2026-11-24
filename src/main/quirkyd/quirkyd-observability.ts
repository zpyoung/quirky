// quirkyd's local trace file: the desktop's sink and consent gates under quirkyd's own data root and
// its own name (`<data-root>/logs/quirkyd.trace.ndjson`), so a headless host's spans, its reported
// structured-chat failures among them, reach a file and not only the supervisor's stderr.

import process from 'node:process'
import { flushObservability, initObservability, shutdownObservability } from '../observability'
import { getQuirkydTraceFilePath } from '../observability/logs-directory'

/** Installed before the runtime, so its first span lands. Returns the close, which the host runs
 *  last in its cleanup so every quit handler's spans land too. */
export function installQuirkydObservability(): () => void {
  initObservability({ traceFilePath: getQuirkydTraceFilePath() })
  // `exit` runs synchronously on process.exit and after an uncaught exception; no cleanup does.
  process.once('exit', flushObservability)
  return () => {
    process.off('exit', flushObservability)
    void shutdownObservability()
  }
}
