import { reportOf, waitFor, type Features } from '../../../quirky.terminal/test/e2e-ui/features-support'

/** Waits until the window has no history view write in flight, then until the panel's report satisfies `check`. */
export async function quietHistoryReport<T>(f: Features, panel: string, what: string, check: (report: T) => boolean): Promise<T> {
  const historyWritesSettled = () => f.calls.every((call) => (call.method !== 'quirky.vault/setView' && call.method !== 'quirky.vault/resetView') || call.settled)
  await waitFor('history view writes to settle', async () => historyWritesSettled() ? true : undefined)
  return reportOf<T>(f, panel, what, (report) => historyWritesSettled() && check(report))
}
