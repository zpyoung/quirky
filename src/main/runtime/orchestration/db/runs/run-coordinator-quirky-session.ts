import { quirkySessionAddressSql } from '../quirky-session-address-sql'
import type { QuirkySessionId } from '../../../../../shared/quirky-session-address'
import type { RunRow } from '../../types'

type RunCoordinatorQuirkySessionFields = Pick<
  RunRow,
  | 'coordinator_quirky_session_id'
  | 'coordinator_quirky_session_id_generation'
  | 'consumer_generation'
>

/**
 * A Run coordinator's Quirky session id counts only at the `consumer_generation` it was written at.
 * Every write that rebinds or unbinds a Run bumps that generation, including one from a binary that
 * predates the column, so an id such a write leaves behind stops counting with nothing to clear it.
 */
export function currentRunCoordinatorQuirkySessionId(
  run: RunCoordinatorQuirkySessionFields
): QuirkySessionId | null {
  return run.coordinator_quirky_session_id_generation === run.consumer_generation
    ? run.coordinator_quirky_session_id
    : null
}

/** The same rule in SQL, for a `runs` row named `row` (a table name, alias, or `NEW`). */
export function currentRunCoordinatorQuirkySessionIdSql(row: string): string {
  return `(CASE WHEN ${row}.coordinator_quirky_session_id_generation = ${row}.consumer_generation
    THEN ${row}.coordinator_quirky_session_id END)`
}

/** The coordinator's `quirky_session_id:<id>` address in SQL; NULL when it has no current Quirky session id. */
export function currentRunCoordinatorSessionAddressSql(row: string): string {
  return quirkySessionAddressSql(currentRunCoordinatorQuirkySessionIdSql(row))
}
