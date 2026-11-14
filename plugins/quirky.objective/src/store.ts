import type { PluginContext, PluginStore } from '@quirky/protocol'
import {
  applyRepairPatchToRevision,
  reportDigest,
  type ImplementerReport,
  type IntegratorReport,
  type PlannerReport,
  type RepairPlannerReport,
  type ReviewerReport
} from './plan'

export interface Issued {
  attemptId: string; watcherId: string; role: 'planner' | 'implementer' | 'reviewer' | 'integrator'
  revision: number | null; taskKey: string | null; reportPath: string; issuedAtMs: number
  plannerMode?: 'initial' | 'repair'; baselineTree?: string | null; contentIdentity?: string | null
}
export interface AcceptedReport {
  attemptId: string; watcherId: string; dispatchId: string; role: Issued['role']
  report: PlannerReport | RepairPlannerReport | ImplementerReport | ReviewerReport | IntegratorReport
  digest: string; acceptedAtMs: number
}
export interface Revision {
  watcherId: string; number: number; plan: PlannerReport; digest: string; sourceAttemptId: string; approvedAtMs: number
}
export interface CheckRecord {
  attemptId: string; watcherId: string; revision: number; kind: 'criterion' | 'gate'; targetKey: string
  contentIdentity: string; command: string; status: 'passed' | 'failed' | 'stale'; exitCode: number | null
  timedOut: boolean; stdoutTail: string; stderrTail: string; checkedAtMs: number
}
export interface VerdictRecord {
  attemptId: string; watcherId: string; dispatchId: string; revision: number; role: 'reviewer' | 'integrator'
  contentIdentity: string; verdict: 'approve' | 'block'; criteriaResults: ReviewerReport['criteriaResults']
  checksRun: IntegratorReport['checksRun']; summary: string; digest: string; acceptedAtMs: number
}
export interface LandingRecord {
  watcherId: string; rung: 'files-on-disk' | 'committed-local-branch'; contentIdentity: string; attemptId: string
  payload: Record<string, unknown>; recordedAtMs: number
}
export interface DraftRejection {
  attemptId: string; watcherId: string; digest: string; reason: string | null; rejectedAtMs: number
}
export interface OverrunRecord {
  attemptId: string; watcherId: string; revision: number | null; taskKey: string | null; observedPaths: string[]
  outsidePaths: string[]; unreportedPaths: string[]; code: string; recordedAtMs: number
}
export interface RevisionRepair {
  watcherId: string; revision: number; ordinal: number; attemptId: string; beforeDigest: string; afterDigest: string
  touchedTaskKeys: string[]; patch: RepairPlannerReport; appliedAtMs: number
}
export interface ObjectiveStore {
  issue(issued: Issued): void
  issued(watcherId: string): Issued[]
  reports(watcherId: string): AcceptedReport[]
  report(attemptId: string): AcceptedReport | null
  accept(report: AcceptedReport): boolean
  revision(watcherId: string): Revision | null
  activate(watcherId: string, sourceAttemptId: string, digest: string): Revision
  recordCheck(row: CheckRecord): void
  checks(watcherId: string): CheckRecord[]
  acceptVerdict(row: VerdictRecord): boolean
  verdicts(watcherId: string): VerdictRecord[]
  recordLanding(row: LandingRecord): void
  landings(watcherId: string): LandingRecord[]
  rejectDraft(row: DraftRejection): void
  rejectedDrafts(watcherId: string): DraftRejection[]
  recordOverrun(row: OverrunRecord): void
  overruns(watcherId: string): OverrunRecord[]
  repairs(watcherId: string): RevisionRepair[]
  applyRepair(watcherId: string, revision: number, ordinal: number, attemptId: string, digest: string): Revision
}

const migrationV1 = `
CREATE TABLE issued (attempt_id TEXT PRIMARY KEY, watcher_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('planner','implementer')), revision INTEGER, task_key TEXT,
  report_path TEXT NOT NULL, issued_at_ms INTEGER NOT NULL);
CREATE TABLE report (attempt_id TEXT PRIMARY KEY REFERENCES issued(attempt_id), watcher_id TEXT NOT NULL,
  dispatch_id TEXT NOT NULL, role TEXT NOT NULL, report_json TEXT NOT NULL, digest TEXT NOT NULL, accepted_at_ms INTEGER NOT NULL);
CREATE TABLE revision (watcher_id TEXT NOT NULL, number INTEGER NOT NULL, plan_json TEXT NOT NULL, digest TEXT NOT NULL,
  source_attempt_id TEXT NOT NULL UNIQUE, approved_at_ms INTEGER NOT NULL, PRIMARY KEY (watcher_id, number));
`
function migrateV1ToV2(db: PluginStore): void {
  db.exec(`
    PRAGMA defer_foreign_keys = ON;
    CREATE TABLE issued_v2 (
      attempt_id TEXT PRIMARY KEY, watcher_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('planner','implementer','reviewer','integrator')),
      revision INTEGER, task_key TEXT, report_path TEXT NOT NULL, issued_at_ms INTEGER NOT NULL,
      planner_mode TEXT, baseline_tree TEXT, content_identity TEXT
    );
    INSERT INTO issued_v2 (attempt_id, watcher_id, role, revision, task_key, report_path, issued_at_ms)
      SELECT attempt_id, watcher_id, role, revision, task_key, report_path, issued_at_ms FROM issued;
    -- Keep the final table name in this FK; renaming a temporary parent is not reliably rewritten
    -- when SQLite legacy alter-table behavior is enabled.
    CREATE TABLE report_v2 (
      attempt_id TEXT PRIMARY KEY REFERENCES issued(attempt_id), watcher_id TEXT NOT NULL,
      dispatch_id TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('planner','implementer','reviewer','integrator')),
      report_json TEXT NOT NULL, digest TEXT NOT NULL, accepted_at_ms INTEGER NOT NULL
    );
    INSERT INTO report_v2 SELECT attempt_id, watcher_id, dispatch_id, role, report_json, digest, accepted_at_ms FROM report;
    DROP TABLE report;
    DROP TABLE issued;
    ALTER TABLE issued_v2 RENAME TO issued;
    ALTER TABLE report_v2 RENAME TO report;

    CREATE TABLE check_result (
      attempt_id TEXT PRIMARY KEY, watcher_id TEXT NOT NULL, revision INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('criterion','gate')), target_key TEXT NOT NULL,
      content_identity TEXT NOT NULL, command TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('passed','failed','stale')), exit_code INTEGER,
      timed_out INTEGER NOT NULL, stdout_tail TEXT NOT NULL, stderr_tail TEXT NOT NULL, checked_at_ms INTEGER NOT NULL
    );
    CREATE INDEX check_result_lookup
      ON check_result (watcher_id, revision, kind, target_key, content_identity, checked_at_ms);
    CREATE TABLE verdict (
      attempt_id TEXT PRIMARY KEY REFERENCES issued(attempt_id), watcher_id TEXT NOT NULL,
      dispatch_id TEXT NOT NULL UNIQUE, revision INTEGER NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('reviewer','integrator')), content_identity TEXT NOT NULL,
      verdict TEXT NOT NULL CHECK (verdict IN ('approve','block')), criteria_results_json TEXT NOT NULL,
      checks_run_json TEXT NOT NULL, summary TEXT NOT NULL, digest TEXT NOT NULL, accepted_at_ms INTEGER NOT NULL
    );
    CREATE TABLE landing (
      watcher_id TEXT NOT NULL, rung TEXT NOT NULL CHECK (rung IN ('files-on-disk','committed-local-branch')),
      content_identity TEXT NOT NULL, attempt_id TEXT NOT NULL, payload_json TEXT NOT NULL,
      recorded_at_ms INTEGER NOT NULL, PRIMARY KEY (watcher_id, rung, content_identity)
    );
    CREATE TABLE draft_rejection (
      attempt_id TEXT PRIMARY KEY REFERENCES issued(attempt_id), watcher_id TEXT NOT NULL,
      digest TEXT NOT NULL, reason TEXT, rejected_at_ms INTEGER NOT NULL
    );
    CREATE TABLE territory_overrun (
      attempt_id TEXT PRIMARY KEY REFERENCES issued(attempt_id), watcher_id TEXT NOT NULL,
      revision INTEGER, task_key TEXT, observed_paths_json TEXT NOT NULL, outside_paths_json TEXT NOT NULL,
      unreported_paths_json TEXT NOT NULL, code TEXT NOT NULL, recorded_at_ms INTEGER NOT NULL
    );
    CREATE TABLE revision_repair (
      watcher_id TEXT NOT NULL, revision INTEGER NOT NULL, ordinal INTEGER NOT NULL,
      attempt_id TEXT NOT NULL UNIQUE REFERENCES issued(attempt_id), before_digest TEXT NOT NULL,
      after_digest TEXT NOT NULL, touched_task_keys_json TEXT NOT NULL, patch_json TEXT NOT NULL,
      applied_at_ms INTEGER NOT NULL, PRIMARY KEY (watcher_id, revision, ordinal)
    );
  `)
}

const issuedColumns = `attempt_id AS attemptId, watcher_id AS watcherId, role, revision, task_key AS taskKey,
  report_path AS reportPath, issued_at_ms AS issuedAtMs, planner_mode AS plannerMode,
  baseline_tree AS baselineTree, content_identity AS contentIdentity`
const reportColumns = 'attempt_id AS attemptId, watcher_id AS watcherId, dispatch_id AS dispatchId, role, report_json AS json, digest, accepted_at_ms AS acceptedAtMs'
const revisionColumns = 'watcher_id AS watcherId, number, plan_json AS json, digest, source_attempt_id AS sourceAttemptId, approved_at_ms AS approvedAtMs'
const checkColumns = `attempt_id AS attemptId, watcher_id AS watcherId, revision, kind, target_key AS targetKey,
  content_identity AS contentIdentity, command, status, exit_code AS exitCode, timed_out AS timedOut,
  stdout_tail AS stdoutTail, stderr_tail AS stderrTail, checked_at_ms AS checkedAtMs`
const verdictColumns = `attempt_id AS attemptId, watcher_id AS watcherId, dispatch_id AS dispatchId, revision, role,
  content_identity AS contentIdentity, verdict, criteria_results_json AS criteriaResultsJson,
  checks_run_json AS checksRunJson, summary, digest, accepted_at_ms AS acceptedAtMs`
const landingColumns = `watcher_id AS watcherId, rung, content_identity AS contentIdentity, attempt_id AS attemptId,
  payload_json AS payloadJson, recorded_at_ms AS recordedAtMs`
const draftRejectionColumns = `attempt_id AS attemptId, watcher_id AS watcherId, digest, reason, rejected_at_ms AS rejectedAtMs`
const overrunColumns = `attempt_id AS attemptId, watcher_id AS watcherId, revision, task_key AS taskKey,
  observed_paths_json AS observedPathsJson, outside_paths_json AS outsidePathsJson,
  unreported_paths_json AS unreportedPathsJson, code, recorded_at_ms AS recordedAtMs`
const repairColumns = `watcher_id AS watcherId, revision, ordinal, attempt_id AS attemptId,
  before_digest AS beforeDigest, after_digest AS afterDigest, touched_task_keys_json AS touchedTaskKeysJson,
  patch_json AS patchJson, applied_at_ms AS appliedAtMs`

type IssuedRow = Omit<Issued, 'plannerMode' | 'baselineTree' | 'contentIdentity'> & {
  plannerMode: 'initial' | 'repair' | null
  baselineTree: string | null
  contentIdentity: string | null
}
type ReportRow = Omit<AcceptedReport, 'report'> & { json: string }
type RevisionRow = Omit<Revision, 'plan'> & { json: string }
type CheckRow = Omit<CheckRecord, 'timedOut'> & { timedOut: number }
type VerdictRow = Omit<VerdictRecord, 'criteriaResults' | 'checksRun'> & { criteriaResultsJson: string; checksRunJson: string }
type LandingRow = Omit<LandingRecord, 'payload'> & { payloadJson: string }
type OverrunRow = Omit<OverrunRecord, 'observedPaths' | 'outsidePaths' | 'unreportedPaths'> & {
  observedPathsJson: string; outsidePathsJson: string; unreportedPathsJson: string
}
type RevisionRepairRow = Omit<RevisionRepair, 'touchedTaskKeys' | 'patch'> & {
  touchedTaskKeysJson: string; patchJson: string
}
function decodeIssued({ plannerMode, baselineTree, contentIdentity, ...row }: IssuedRow): Issued {
  return {
    ...row,
    ...(plannerMode === null ? {} : { plannerMode }),
    ...(baselineTree === null ? {} : { baselineTree }),
    ...(contentIdentity === null ? {} : { contentIdentity })
  }
}
function decodeReport({ json, ...row }: ReportRow): AcceptedReport { return { ...row, report: JSON.parse(json) } }
function decodeRevision({ json, ...row }: RevisionRow): Revision { return { ...row, plan: JSON.parse(json) } }
function decodeCheck({ timedOut, ...row }: CheckRow): CheckRecord { return { ...row, timedOut: Boolean(timedOut) } }
function decodeVerdict({ criteriaResultsJson, checksRunJson, ...row }: VerdictRow): VerdictRecord {
  return { ...row, criteriaResults: JSON.parse(criteriaResultsJson), checksRun: JSON.parse(checksRunJson) }
}
function decodeLanding({ payloadJson, ...row }: LandingRow): LandingRecord { return { ...row, payload: JSON.parse(payloadJson) } }
function decodeOverrun({ observedPathsJson, outsidePathsJson, unreportedPathsJson, ...row }: OverrunRow): OverrunRecord {
  return {
    ...row, observedPaths: JSON.parse(observedPathsJson), outsidePaths: JSON.parse(outsidePathsJson),
    unreportedPaths: JSON.parse(unreportedPathsJson)
  }
}
function decodeRepair({ touchedTaskKeysJson, patchJson, ...row }: RevisionRepairRow): RevisionRepair {
  return { ...row, touchedTaskKeys: JSON.parse(touchedTaskKeysJson), patch: JSON.parse(patchJson) }
}
function isRepairReport(report: AcceptedReport['report']): report is RepairPlannerReport {
  return typeof report === 'object' && report !== null && 'repair' in report
}
function revisionRepairRow(db: PluginStore, watcherId: string, number: number): Revision {
  const row = db.get<RevisionRow>(`SELECT ${revisionColumns} FROM revision WHERE watcher_id=? AND number=?`, watcherId, number)
  if (!row) throw new Error('Plan revision no longer exists')
  return decodeRevision(row)
}

/** Keeps report acceptance immutable and plan activation replay-safe across daemon restarts. */
export function createObjectiveStore(context: PluginContext): ObjectiveStore {
  const db = context.openStore([migrationV1, migrateV1ToV2], { newerVersion: 'read-only' })
  if (!db.readOnly) db.exec('PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;')
  const getReport = (attemptId: string): AcceptedReport | null => {
    const row = db.get<ReportRow>(`SELECT ${reportColumns} FROM report WHERE attempt_id=?`, attemptId)
    return row ? decodeReport(row) : null
  }
  return {
    issue(issued: Issued): void {
      const existingRow = db.get<IssuedRow>(`SELECT ${issuedColumns} FROM issued WHERE attempt_id=?`, issued.attemptId)
      const existing = existingRow ? decodeIssued(existingRow) : null
      if (existing) {
        if (existing.watcherId !== issued.watcherId || existing.role !== issued.role || existing.revision !== issued.revision ||
          existing.taskKey !== issued.taskKey || existing.reportPath !== issued.reportPath || existing.plannerMode !== issued.plannerMode ||
          (existing.baselineTree ?? null) !== (issued.baselineTree ?? null) ||
          (existing.contentIdentity ?? null) !== (issued.contentIdentity ?? null)) {
          throw new Error('Attempt was already issued with different authority')
        }
        return
      }
      db.run(`INSERT INTO issued
        (attempt_id, watcher_id, role, revision, task_key, report_path, issued_at_ms, planner_mode, baseline_tree, content_identity)
        VALUES (?,?,?,?,?,?,?,?,?,?)`, issued.attemptId, issued.watcherId, issued.role, issued.revision, issued.taskKey,
      issued.reportPath, issued.issuedAtMs, issued.plannerMode ?? null, issued.baselineTree ?? null, issued.contentIdentity ?? null)
    },
    issued(watcherId: string): Issued[] {
      return db.all<IssuedRow>(`SELECT ${issuedColumns} FROM issued WHERE watcher_id=? ORDER BY issued_at_ms, attempt_id`, watcherId).map(decodeIssued)
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
        const issued = db.get<{ plannerMode: 'initial' | 'repair' | null }>('SELECT planner_mode AS plannerMode FROM issued WHERE attempt_id=?', sourceAttemptId)
        if (!report || report.watcherId !== watcherId || report.role !== 'planner' || report.digest !== digest ||
          issued?.plannerMode === 'repair' || isRepairReport(report.report)) {
          throw new Error('Accepted planner report no longer matches the draft')
        }
        const number = (db.get<{ number: number }>('SELECT MAX(number) AS number FROM revision WHERE watcher_id=?', watcherId)?.number ?? 0) + 1
        const approvedAtMs = Date.now()
        db.run('INSERT INTO revision VALUES (?,?,?,?,?,?)', watcherId, number, JSON.stringify(report.report), digest, sourceAttemptId, approvedAtMs)
        return { watcherId, number, plan: report.report as PlannerReport, digest, sourceAttemptId, approvedAtMs }
      })
    },
    recordCheck(row: CheckRecord): void {
      db.run(`INSERT OR IGNORE INTO check_result
        (attempt_id, watcher_id, revision, kind, target_key, content_identity, command, status, exit_code, timed_out,
          stdout_tail, stderr_tail, checked_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      row.attemptId, row.watcherId, row.revision, row.kind, row.targetKey, row.contentIdentity, row.command,
      row.status, row.exitCode, Number(row.timedOut), row.stdoutTail, row.stderrTail, row.checkedAtMs)
    },
    checks(watcherId: string): CheckRecord[] {
      return db.all<CheckRow>(`SELECT ${checkColumns} FROM check_result WHERE watcher_id=? ORDER BY checked_at_ms, attempt_id`, watcherId).map(decodeCheck)
    },
    acceptVerdict(row: VerdictRecord): boolean {
      return db.transaction(() => {
        const previous = db.get<{ digest: string }>('SELECT digest FROM verdict WHERE attempt_id=?', row.attemptId)
        if (previous) return previous.digest === row.digest
        db.run(`INSERT INTO verdict
          (attempt_id, watcher_id, dispatch_id, revision, role, content_identity, verdict, criteria_results_json,
            checks_run_json, summary, digest, accepted_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        row.attemptId, row.watcherId, row.dispatchId, row.revision, row.role, row.contentIdentity, row.verdict,
        JSON.stringify(row.criteriaResults), JSON.stringify(row.checksRun), row.summary, row.digest, row.acceptedAtMs)
        return true
      })
    },
    verdicts(watcherId: string): VerdictRecord[] {
      return db.all<VerdictRow>(`SELECT ${verdictColumns} FROM verdict WHERE watcher_id=? ORDER BY accepted_at_ms, attempt_id`, watcherId).map(decodeVerdict)
    },
    recordLanding(row: LandingRecord): void {
      db.run(`INSERT OR IGNORE INTO landing
        (watcher_id, rung, content_identity, attempt_id, payload_json, recorded_at_ms) VALUES (?,?,?,?,?,?)`,
      row.watcherId, row.rung, row.contentIdentity, row.attemptId, JSON.stringify(row.payload), row.recordedAtMs)
    },
    landings(watcherId: string): LandingRecord[] {
      return db.all<LandingRow>(`SELECT ${landingColumns} FROM landing WHERE watcher_id=? ORDER BY recorded_at_ms, rung, content_identity`, watcherId).map(decodeLanding)
    },
    rejectDraft(row: DraftRejection): void {
      db.run(`INSERT OR IGNORE INTO draft_rejection (attempt_id, watcher_id, digest, reason, rejected_at_ms)
        VALUES (?,?,?,?,?)`, row.attemptId, row.watcherId, row.digest, row.reason, row.rejectedAtMs)
    },
    rejectedDrafts(watcherId: string): DraftRejection[] {
      return db.all<DraftRejection>(`SELECT ${draftRejectionColumns} FROM draft_rejection WHERE watcher_id=? ORDER BY rejected_at_ms, attempt_id`, watcherId)
    },
    recordOverrun(row: OverrunRecord): void {
      db.run(`INSERT INTO territory_overrun
        (attempt_id, watcher_id, revision, task_key, observed_paths_json, outside_paths_json, unreported_paths_json, code, recorded_at_ms)
        VALUES (?,?,?,?,?,?,?,?,?)
        ON CONFLICT(attempt_id) DO UPDATE SET
          watcher_id=excluded.watcher_id, revision=excluded.revision, task_key=excluded.task_key,
          observed_paths_json=excluded.observed_paths_json, outside_paths_json=excluded.outside_paths_json,
          unreported_paths_json=excluded.unreported_paths_json, code=excluded.code, recorded_at_ms=excluded.recorded_at_ms
        WHERE territory_overrun.code != 'observed-change-outside-write-territory'
          OR excluded.code = 'observed-change-outside-write-territory'`,
      row.attemptId, row.watcherId, row.revision, row.taskKey, JSON.stringify(row.observedPaths),
      JSON.stringify(row.outsidePaths), JSON.stringify(row.unreportedPaths), row.code, row.recordedAtMs)
    },
    overruns(watcherId: string): OverrunRecord[] {
      return db.all<OverrunRow>(`SELECT ${overrunColumns} FROM territory_overrun WHERE watcher_id=? ORDER BY recorded_at_ms, attempt_id`, watcherId).map(decodeOverrun)
    },
    repairs(watcherId: string): RevisionRepair[] {
      return db.all<RevisionRepairRow>(`SELECT ${repairColumns} FROM revision_repair WHERE watcher_id=? ORDER BY revision, ordinal`, watcherId).map(decodeRepair)
    },
    applyRepair(watcherId: string, revision: number, ordinal: number, attemptId: string, digest: string): Revision {
      return db.transaction(() => {
        const report = getReport(attemptId)
        const issued = db.get<{ watcherId: string; role: string; revision: number | null; plannerMode: string | null }>(
          'SELECT watcher_id AS watcherId, role, revision, planner_mode AS plannerMode FROM issued WHERE attempt_id=?', attemptId
        )
        if (!report || report.watcherId !== watcherId || report.role !== 'planner' || report.digest !== digest ||
          !isRepairReport(report.report) || !issued || issued.watcherId !== watcherId || issued.role !== 'planner' ||
          issued.revision !== revision || issued.plannerMode !== 'repair') {
          throw new Error('Accepted repair report no longer matches the revision')
        }

        const previous = db.get<RevisionRepairRow>(
          `SELECT ${repairColumns} FROM revision_repair WHERE watcher_id=? AND revision=? AND ordinal=?`,
          watcherId, revision, ordinal
        )
        const previousAttempt = db.get<{ watcherId: string; revision: number; ordinal: number }>(
          'SELECT watcher_id AS watcherId, revision, ordinal FROM revision_repair WHERE attempt_id=?', attemptId
        )
        if (previous || previousAttempt) {
          if (!previous || previous.attemptId !== attemptId || previousAttempt?.watcherId !== watcherId ||
            previousAttempt.revision !== revision || previousAttempt.ordinal !== ordinal) {
            throw new Error('Repair application authority changed')
          }
          return revisionRepairRow(db, watcherId, revision)
        }

        const current = revisionRepairRow(db, watcherId, revision)
        const latest = db.get<{ number: number }>('SELECT MAX(number) AS number FROM revision WHERE watcher_id=?', watcherId)?.number
        if (latest !== revision) throw new Error('Plan revision is no longer active')
        const nextPlan = applyRepairPatchToRevision(current.plan, report.report)
        const afterDigest = reportDigest(nextPlan)
        const touchedTaskKeys = [...new Set([
          ...report.report.repair.upsertTasks.map(task => task.taskKey),
          ...report.report.repair.dropTaskKeys
        ])]
        const appliedAtMs = Date.now()
        const updated = db.run('UPDATE revision SET plan_json=?, digest=? WHERE watcher_id=? AND number=? AND digest=?',
          JSON.stringify(nextPlan), afterDigest, watcherId, revision, current.digest)
        if (updated.changes !== 1) throw new Error('Plan revision changed during repair application')
        db.run(`INSERT INTO revision_repair
          (watcher_id, revision, ordinal, attempt_id, before_digest, after_digest, touched_task_keys_json, patch_json, applied_at_ms)
          VALUES (?,?,?,?,?,?,?,?,?)`, watcherId, revision, ordinal, attemptId, current.digest, afterDigest,
        JSON.stringify(touchedTaskKeys), JSON.stringify(report.report), appliedAtMs)
        return { ...current, plan: nextPlan, digest: afterDigest }
      })
    }
  }
}
