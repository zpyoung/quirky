import type { IterationDetail } from '../src/types'

export type LoopIterationDetailProps = {
  detail: IterationDetail
  onBack(): void
}

export function formatDuration(milliseconds: number | null): string {
  if (milliseconds === null || !Number.isFinite(milliseconds) || milliseconds < 0) return 'Unavailable'
  if (milliseconds < 1_000) return milliseconds === 0 ? '0s' : '<1s'
  const seconds = Math.floor(milliseconds / 1_000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  if (minutes < 60) return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`
  const hours = Math.floor(minutes / 60)
  const minuteRemainder = minutes % 60
  return minuteRemainder === 0 ? `${hours}h` : `${hours}h ${minuteRemainder}m`
}

export function iterationCheckLabel(detail: IterationDetail): 'Pass' | 'Fail' | 'No check' {
  if (detail.check === null || !detail.check.ran) return 'No check'
  return detail.check.pass ? 'Pass' : 'Fail'
}
function detailCheckLabel(detail: IterationDetail): string {
  if (detail.check === null || !detail.check.ran) return 'No check'
  return detail.check.pass ? 'Done check passed' : 'Check failed'
}

function outcomeLabel(detail: IterationDetail): string {
  switch (detail.endReason) {
    case null: return 'Unavailable'
    case 'settled': return 'Finished'
    case 'crashed': return 'Crashed'
    case 'interrupted': return 'Interrupted'
    case 'stopped': return 'Stopped'
    case 'unverifiable': return 'Unverifiable'
  }
}

function checkOutput(detail: IterationDetail): string | null {
  const check = detail.check
  if (check === null || !check.ran) return null
  const output = [check.stdoutTail, check.stderrTail].filter((value) => value.length > 0).join('\n')
  return output.length > 0 ? output : null
}

export function LoopIterationDetail({ detail, onBack }: LoopIterationDetailProps) {
  const duration = detail.endedAt === null ? null : detail.endedAt - detail.startedAt
  const errors = [...new Set([detail.error, detail.check?.error].filter((value): value is string => typeof value === 'string' && value.length > 0))]
  const output = checkOutput(detail)
  const attemptSuffix = detail.attempt > 1 ? ` · attempt ${detail.attempt}` : ''
  const cost = detail.costUsd === null || !Number.isFinite(detail.costUsd) ? 'Unavailable' : `$${detail.costUsd.toFixed(2)}`
  const diff = detail.diff === null ? 'Unavailable' : `+${detail.diff.added} / −${detail.diff.removed}`

  return (
    <section className="loop-iteration-detail" aria-labelledby="loop-iteration-title">
      <button type="button" className="loop-back" onClick={onBack}>Back</button>
      <h3 id="loop-iteration-title">Iteration {detail.n}{attemptSuffix}</h3>
      <dl className="loop-detail-facts">
        <dt>Outcome</dt><dd>{outcomeLabel(detail)}</dd>
        <dt>Duration</dt><dd>{formatDuration(duration)}</dd>
        <dt>Cost</dt><dd>{cost}</dd>
        <dt>Changes</dt><dd>{diff}</dd>
        <dt>Check</dt><dd>{detailCheckLabel(detail)}</dd>
        <dt>Evaluator</dt><dd>{detail.evaluator?.verdict === 'met' ? 'Condition met' : detail.evaluator?.verdict === 'not-met' ? 'Condition not met' : 'Unavailable'}</dd>
      </dl>
      {detail.evaluator !== null && <section className="loop-evaluator-reason" aria-label="Evaluator reason">
        <h4>Evaluator reason</h4>
        <p>{detail.evaluator.reason || 'No reason recorded.'}</p>
      </section>}
      {output !== null && <section className="loop-check-output" aria-label="Check output">
        <h4>Check output</h4>
        <pre>{output}</pre>
      </section>}
      <section className="loop-iteration-errors" aria-label="Errors">
        <h4>Errors</h4>
        {errors.length === 0 ? <p>None recorded.</p> : <ul>{errors.map((error, index) => <li key={`${index}:${error}`}>{error}</li>)}</ul>}
      </section>
      <section className="loop-output-tail" aria-label="Iteration output tail">
        <h4>Output tail</h4>
        {detail.outputTail.length === 0 ? <p>No output recorded.</p> : <pre>{detail.outputTail}</pre>}
      </section>
    </section>
  )
}
