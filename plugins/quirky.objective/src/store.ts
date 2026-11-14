import type { PluginContext } from '@quirky/protocol'
import type { ImplementerReport, PlannerReport } from './plan'

export interface Issued {
  attemptId: string; watcherId: string; role: 'planner' | 'implementer'
  revision: number | null; taskKey: string | null; reportPath: string; issuedAtMs: number
}
export interface AcceptedReport {
  attemptId: string; watcherId: string; dispatchId: string; role: Issued['role']
  report: PlannerReport | ImplementerReport; digest: string; acceptedAtMs: number
}
export interface Revision {
  watcherId: string; number: number; plan: PlannerReport; digest: string; sourceAttemptId: string; approvedAtMs: number
}
export interface ObjectiveStore {
  issue(issued: Issued): void
  issued(watcherId: string): Issued[]
  reports(watcherId: string): AcceptedReport[]
  report(attemptId: string): AcceptedReport | null
  accept(report: AcceptedReport): boolean
  revision(watcherId: string): Revision | null
  activate(watcherId: string, sourceAttemptId: string, digest: string): Revision
}

const migration = `
CREATE TABLE issued (attempt_id TEXT PRIMARY KEY, watcher_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('planner','implementer')), revision INTEGER, task_key TEXT,
  report_path TEXT NOT NULL, issued_at_ms INTEGER NOT NULL);
CREATE TABLE report (attempt_id TEXT PRIMARY KEY REFERENCES issued(attempt_id), watcher_id TEXT NOT NULL,
  dispatch_id TEXT NOT NULL, role TEXT NOT NULL, report_json TEXT NOT NULL, digest TEXT NOT NULL, accepted_at_ms INTEGER NOT NULL);
CREATE TABLE revision (watcher_id TEXT NOT NULL, number INTEGER NOT NULL, plan_json TEXT NOT NULL, digest TEXT NOT NULL,
  source_attempt_id TEXT NOT NULL UNIQUE, approved_at_ms INTEGER NOT NULL, PRIMARY KEY (watcher_id, number));
`
const issuedColumns = 'attempt_id AS attemptId, watcher_id AS watcherId, role, revision, task_key AS taskKey, report_path AS reportPath, issued_at_ms AS issuedAtMs'
const reportColumns = 'attempt_id AS attemptId, watcher_id AS watcherId, dispatch_id AS dispatchId, role, report_json AS json, digest, accepted_at_ms AS acceptedAtMs'
const revisionColumns = 'watcher_id AS watcherId, number, plan_json AS json, digest, source_attempt_id AS sourceAttemptId, approved_at_ms AS approvedAtMs'
type ReportRow = Omit<AcceptedReport, 'report'> & { json: string }
type RevisionRow = Omit<Revision, 'plan'> & { json: string }
function decodeReport({ json, ...row }: ReportRow): AcceptedReport { return { ...row, report: JSON.parse(json) } }
function decodeRevision({ json, ...row }: RevisionRow): Revision { return { ...row, plan: JSON.parse(json) } }

/** Keeps report acceptance immutable and plan activation replay-safe across daemon restarts. */
export function createObjectiveStore(context: PluginContext): ObjectiveStore {
  const db = context.openStore([migration], { newerVersion: 'read-only' })
  if (!db.readOnly) db.exec('PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;')
  const getReport = (attemptId: string): AcceptedReport | null => {
    const row = db.get<ReportRow>(`SELECT ${reportColumns} FROM report WHERE attempt_id=?`, attemptId)
    return row ? decodeReport(row) : null
  }
  return {
    issue(issued: Issued): void {
      const existing = db.get<Issued>(`SELECT ${issuedColumns} FROM issued WHERE attempt_id=?`, issued.attemptId)
      if (existing) {
        if (existing.watcherId !== issued.watcherId || existing.role !== issued.role || existing.revision !== issued.revision ||
          existing.taskKey !== issued.taskKey || existing.reportPath !== issued.reportPath) throw new Error('Attempt was already issued with different authority')
        return
      }
      db.run('INSERT INTO issued VALUES (?,?,?,?,?,?,?)', issued.attemptId, issued.watcherId, issued.role, issued.revision, issued.taskKey, issued.reportPath, issued.issuedAtMs)
    },
    issued(watcherId: string): Issued[] {
      return db.all<Issued>(`SELECT ${issuedColumns} FROM issued WHERE watcher_id=? ORDER BY issued_at_ms, attempt_id`, watcherId)
    },
    reports(watcherId: string): AcceptedReport[] {
      return db.all<ReportRow>(`SELECT ${reportColumns} FROM report WHERE watcher_id=? ORDER BY accepted_at_ms, attempt_id`, watcherId).map(decodeReport)
    },
    report: getReport,
    accept(report: AcceptedReport): boolean {
      return db.transaction(() => {
        const previous = getReport(report.attemptId)
        if (previous) return previous.digest === report.digest
        db.run('INSERT INTO report VALUES (?,?,?,?,?,?,?)', report.attemptId, report.watcherId, report.dispatchId, report.role,
          JSON.stringify(report.report), report.digest, report.acceptedAtMs)
        return true
      })
    },
    revision(watcherId: string): Revision | null {
      const row = db.get<RevisionRow>(`SELECT ${revisionColumns} FROM revision WHERE watcher_id=? ORDER BY number DESC LIMIT 1`, watcherId)
      return row ? decodeRevision(row) : null
    },
    activate(watcherId: string, sourceAttemptId: string, digest: string): Revision {
      return db.transaction(() => {
        const previous = db.get<RevisionRow>(`SELECT ${revisionColumns} FROM revision WHERE source_attempt_id=?`, sourceAttemptId)
        if (previous) {
          if (previous.watcherId !== watcherId || previous.digest !== digest) throw new Error('Plan activation authority changed')
          return decodeRevision(previous)
        }
        const report = getReport(sourceAttemptId)
        if (!report || report.watcherId !== watcherId || report.role !== 'planner' || report.digest !== digest) throw new Error('Accepted planner report no longer matches the draft')
        const number = (db.get<{ number: number }>('SELECT MAX(number) AS number FROM revision WHERE watcher_id=?', watcherId)?.number ?? 0) + 1
        const approvedAtMs = Date.now()
        db.run('INSERT INTO revision VALUES (?,?,?,?,?,?)', watcherId, number, JSON.stringify(report.report), digest, sourceAttemptId, approvedAtMs)
        return { watcherId, number, plan: report.report as PlannerReport, digest, sourceAttemptId, approvedAtMs }
      })
    }
  }
}
