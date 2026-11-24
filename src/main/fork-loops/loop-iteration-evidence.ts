import { parseAgentTailMarkers, parseLoopMarkers } from '../../shared/fork-loops/loop-markers'
import { protectedPathHits } from '../../shared/fork-loops/loop-progress'
import type {
  CheckOutcome,
  EvaluatorVerdict,
  IterationPhase,
  IterationRecord,
  LoopRuntimeState
} from '../../shared/fork-loops/loop-types'
import { errorMessage } from './loop-agent-session'
import type { StoredIteration, StoredLoop } from './loop-database'
import type { IterationContext, LoopDriverRuntime, LoopEvidenceTools } from './loop-driver-types'
import type { IterationSettlement } from './iteration-observer'
import type { LoopWorkspaceTarget } from './loop-notes-file'
import { usageDelta } from './loop-usage'

export const MS_PER_MINUTE = 60_000
const OUTPUT_TAIL_LINES = 300
// filtered here rather than via the repo's exclude file, which loop creation can fail to write
const LOOP_FILES_DIRECTORY = '.quirky/loops'

const NOT_RUN_CHECK: CheckOutcome = {
  ran: false,
  pass: false,
  exitCode: null,
  timedOut: false,
  stdoutTail: '',
  stderrTail: '',
  durationMs: 0,
  error: 'workspace-unavailable'
}

export type GatheredEvidence = Omit<
  IterationRecord,
  'n' | 'attempt' | 'startedAt' | 'endedAt' | 'endReason'
> & {
  outputTail: string
  error: string | null
}

/** An ended attempt as `decideNext` sees it; null while the attempt is still open. */
export function toRecord(row: StoredIteration): IterationRecord | null {
  if (row.endedAt === null || row.endReason === null) {
    return null
  }
  return {
    n: row.n,
    attempt: row.attempt,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    endReason: row.endReason,
    check: row.check,
    evaluator: row.evaluator,
    diff: row.diff,
    treeBefore: row.treeBefore,
    treeAfter: row.treeAfter,
    costUsd: row.costUsd,
    markers: row.markers,
    protectedPathHits: row.protectedPathHits,
    checkpointCommit: row.checkpointCommit
  }
}

function wallClockTicksUpTo(anchor: number, minutes: number, at: number): number {
  return Math.floor((at - anchor) / (minutes * MS_PER_MINUTE))
}

/** Wall-clock ticks that passed while an iteration ran; each is skipped, never made up. */
export function skippedWallClockTicks(
  loop: StoredLoop,
  startedAt: number,
  endedAt: number
): number {
  const { pacing } = loop.config
  return pacing.kind === 'interval' && pacing.anchor === 'wall-clock'
    ? Math.max(
        0,
        wallClockTicksUpTo(loop.createdAt, pacing.minutes, endedAt) -
          wallClockTicksUpTo(loop.createdAt, pacing.minutes, startedAt)
      )
    : 0
}

/** The decision input derived from the stored loop and its ended attempts. */
export function buildRuntimeState(
  loop: StoredLoop,
  last: IterationRecord | null,
  history: IterationRecord[]
): LoopRuntimeState {
  const { pacing } = loop.config
  const nextTick =
    pacing.kind === 'interval' && pacing.anchor === 'wall-clock' && last
      ? loop.createdAt +
        (wallClockTicksUpTo(loop.createdAt, pacing.minutes, last.endedAt) + 1) *
          pacing.minutes *
          MS_PER_MINUTE
      : null
  return {
    state: loop.state,
    iterationsCompleted: loop.iterationsCompleted,
    activeMs: loop.activeMs,
    costUsd: loop.costUsd,
    consecutiveCrashesThisIteration: last
      ? history.filter((r) => r.n === last.n && r.endReason === 'crashed').length
      : 0,
    maxIterationsGranted: null,
    lastIterationEndedAt: last?.endedAt ?? null,
    nextWallClockTickAt: nextTick
  }
}

function isLoopFile(path: string): boolean {
  return path === LOOP_FILES_DIRECTORY || path.startsWith(`${LOOP_FILES_DIRECTORY}/`)
}

async function checkpointCommit(
  ws: LoopWorkspaceTarget,
  ctx: IterationContext,
  changedFiles: string[]
): Promise<{ sha: string | null; error?: string }> {
  const paths = changedFiles
    .filter((file) => !isLoopFile(file))
    .map((file) => `:(top,literal)${file}`)
  if (!ws.runGit || paths.length === 0) {
    return { sha: null }
  }
  try {
    // limited to the iteration's own paths so the user's other staged, modified and untracked work stays out
    await ws.runGit(['add', '-A', '--', ...paths])
    await ws.runGit([
      'commit',
      '--only',
      '-m',
      `loop(${ctx.loop.name}): iteration ${ctx.n}`,
      '--',
      ...paths
    ])
    const head = await ws.runGit(['rev-parse', 'HEAD'])
    return { sha: head.stdout.trim() || null }
  } catch (error) {
    return { sha: null, error: `checkpoint commit failed: ${errorMessage(error)}` }
  }
}

/** The persisted evidence of an attempt; a missing gather (aborted or crashed) leaves it empty. */
export function iterationEvidenceOf(gathered: GatheredEvidence | null, ctx: IterationContext) {
  return {
    check: gathered?.check ?? null,
    evaluator: gathered?.evaluator ?? null,
    diff: gathered?.diff ?? null,
    treeBefore: gathered?.treeBefore ?? ctx.before?.treeId ?? null,
    treeAfter: gathered?.treeAfter ?? null,
    costUsd: gathered?.costUsd ?? null,
    markers: gathered?.markers ?? [],
    protectedPathHits: gathered?.protectedPathHits ?? [],
    checkpointCommit: gathered?.checkpointCommit ?? null
  }
}

export type GatherArgs = {
  ctx: IterationContext
  tools: LoopEvidenceTools
  runtime: LoopDriverRuntime
  paneHandle: string | undefined
  settlement: Extract<IterationSettlement, { kind: 'settled' }>
  signal: AbortSignal
  onPhase(phase: IterationPhase): void
}

export const PROTECTED_PATHS_UNVERIFIED =
  'protected paths unverified: working tree snapshot unavailable'

/**
 * Collects the evidence of a settled iteration: markers, tree diff, protected-path hits, the
 * check, the evaluator, an optional checkpoint commit and the usage delta. Protected-path hits
 * are decided first, so a touched protected path is never committed. An unmeasured diff or an
 * aborted signal also blocks the commit.
 */
export async function gatherIterationEvidence(args: GatherArgs): Promise<GatheredEvidence> {
  const { ctx, tools, runtime, settlement, signal } = args
  const { config, agent } = ctx.loop
  const ws = ctx.targets?.workspace ?? null
  args.onPhase('checking')
  let outputTail = ''
  if (args.paneHandle && typeof runtime.readTerminal === 'function') {
    outputTail = await runtime
      .readTerminal(args.paneHandle, { limit: OUTPUT_TAIL_LINES })
      .then((read) => read.tail.join('\n'))
      .catch(() => '')
  }
  const markers = settlement.lastAssistantMessage
    ? parseLoopMarkers(settlement.lastAssistantMessage)
    : parseAgentTailMarkers(outputTail, ctx.promptSent)
  const after = ws ? await tools.snapshotTree(ws) : null
  const diff = ctx.before && after && ws ? await tools.diffTrees(ctx.before, after, ws) : null
  const protectedPaths = config.protectedPaths ?? []
  // keyed off the loop row so a failed target resolution cannot read as "nothing protected was touched"
  const hits =
    ctx.loop.workspaceKind === 'git' && protectedPaths.length > 0 && diff === null
      ? [PROTECTED_PATHS_UNVERIFIED]
      : protectedPathHits(diff?.files ?? [], protectedPaths)
  const check = config.done.check
  const claimed = markers.some((marker) => marker.kind === 'done')
  let checkOutcome: CheckOutcome | null = null
  if (check && (check.runWhen === 'every-iteration' || claimed)) {
    checkOutcome = ctx.targets
      ? await tools.runCheck(config, ctx.targets.check, signal)
      : NOT_RUN_CHECK
  }
  let evaluator: EvaluatorVerdict | null = null
  if (config.done.evaluator) {
    args.onPhase('evaluating')
    evaluator = await tools.evaluate({
      condition: config.done.evaluator.condition,
      agent,
      checkOutcome,
      outputTail,
      signal,
      ...(settlement.lastAssistantMessage
        ? { lastAssistantMessage: settlement.lastAssistantMessage }
        : {})
    })
  }
  let commitSha: string | null = null
  let error = ctx.error
  const changed = ctx.before !== null && after !== null && ctx.before.treeId !== after.treeId
  const checkpointable = diff !== null && hits.length === 0 && !signal.aborted
  if (config.checkpointCommits && ws?.kind === 'git' && changed && checkpointable) {
    const committed = await checkpointCommit(ws, ctx, diff.files)
    commitSha = committed.sha
    error = committed.error ?? error
  }
  const usageAfter = ctx.loop.paneKey
    ? await tools.readUsage(ctx.loop.paneKey, ctx.loop.worktreeId, agent)
    : null
  return {
    check: checkOutcome,
    evaluator,
    diff,
    treeBefore: ctx.before?.treeId ?? null,
    treeAfter: after?.treeId ?? null,
    costUsd: usageDelta(ctx.usageBefore, usageAfter)?.costUsd ?? null,
    markers,
    protectedPathHits: hits,
    checkpointCommit: commitSha,
    outputTail,
    error
  }
}
