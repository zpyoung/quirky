import type { Store } from '../persistence'
import {
  listQuirkydMigrationSourceCutovers,
  setQuirkydMigrationJournalChangeListener
} from './quirkyd-migration-cutover-journal'

/** Keeps the store's scrollback retention in step with the journal, from startup on. */
export function installQuirkydMigrationScrollbackRetention(
  userDataPath: string,
  store: Pick<Store, 'syncQuirkydMigrationScrollbackRetention'>
): void {
  const sync = (path: string): void => {
    try {
      // Held until the destination has the bytes; committed or abandoned migrations release them.
      const pending = listQuirkydMigrationSourceCutovers(path).filter(
        (cutover) => cutover.phase === 'source-fenced' || cutover.phase === 'destination-staged'
      )
      store.syncQuirkydMigrationScrollbackRetention(pending.map((cutover) => cutover.manifest))
    } catch (error) {
      // An unreadable journal keeps whatever is held; releasing on a guess could lose bytes.
      console.warn('[quirkyd-migration] Could not sync scrollback retention:', error)
    }
  }
  setQuirkydMigrationJournalChangeListener(sync)
  sync(userDataPath)
}
