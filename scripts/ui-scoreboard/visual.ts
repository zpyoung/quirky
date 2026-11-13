import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CAPTURE_SCHEMA_VERSION,
  SCORE_DIMENSIONS,
  THEMES,
  type CaptureEvidence,
  type CaptureManifest,
  type CaptureOptions,
  type CaptureTarget,
  type CaptureTheme,
  type ImageEvidence,
  type ReviewReport,
  type ReviewedCapture,
  type VisualAssessment
} from '../ui-review/contracts'
import { CAPTURE_TIMEOUT_MS, DEFAULT_THRESHOLD, REVIEW_TIMEOUT_MS } from '../ui-review/arguments'
import type { Evidence, Inventory, VisualCell, VisualDependencies, VisualOptions, VisualResult } from './contracts'
import { collectInventory } from './inventory'

const TARGET_KINDS = ['host', 'panel', 'view', 'sidebar-section', 'activity-item', 'status-bar', 'overlay', 'settings-section'] as const

type CellKey = `${string}\0${CaptureTheme}`
type CaptureRows = Map<CellKey, CaptureEvidence[]>
type CellMap = Map<CellKey, VisualCell>

function key(targetId: string, theme: CaptureTheme): CellKey {
  return `${targetId}\0${theme}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function evidence(code: string, message: string, targetId?: string, theme?: CaptureTheme): Evidence {
  return {
    code,
    message,
    ...(targetId === undefined ? {} : { targetId }),
    ...(theme === undefined ? {} : { theme }),
    basis: 'rendered-review'
  }
}

function failedCell(
  target: CaptureTarget,
  theme: CaptureTheme,
  code: string,
  reason: string,
  capture?: CaptureEvidence,
  partial?: Partial<Pick<VisualCell, 'assessment' | 'reviewer' | 'score'>>
): VisualCell {
  return {
    targetId: target.id,
    plugin: target.plugin,
    theme,
    status: 'fail',
    code,
    reasons: [reason],
    score: null,
    assessment: null,
    image: capture?.image ?? null,
    reference: capture?.reference ?? null,
    reviewer: null,
    ...partial
  }
}


function validTarget(value: unknown): value is CaptureTarget {
  return isRecord(value) && typeof value.id === 'string' && value.id.trim().length > 0 &&
    (value.plugin === null || typeof value.plugin === 'string') && typeof value.title === 'string' &&
    TARGET_KINDS.includes(value.kind as typeof TARGET_KINDS[number])
}

function validManifest(value: unknown): value is CaptureManifest {
  return isRecord(value) && value.schemaVersion === CAPTURE_SCHEMA_VERSION &&
    typeof value.createdAt === 'string' && typeof value.commit === 'string' &&
    value.surface === 'desktop-renderer' && (value.scope === 'full' || value.scope === 'filtered') &&
    Array.isArray(value.selectors) && value.selectors.every((selector) => typeof selector === 'string') &&
    Array.isArray(value.targets) && value.targets.every(validTarget) &&
    Array.isArray(value.captures) && Array.isArray(value.failures) &&
    value.failures.every((failure) => typeof failure === 'string')
}

function imageEvidence(value: unknown): value is ImageEvidence {
  return isRecord(value) && typeof value.path === 'string' && typeof value.sha256 === 'string'
}

function validAssessment(value: unknown): value is VisualAssessment {
  if (!isRecord(value) || typeof value.targetVisible !== 'boolean' || typeof value.imagesRead !== 'boolean' ||
      !isRecord(value.scores) || !Array.isArray(value.reasons) || value.reasons.some((reason) => typeof reason !== 'string')) return false
  const dimensions = Object.keys(value.scores)
  if (dimensions.length !== SCORE_DIMENSIONS.length || dimensions.some((dimension) => !SCORE_DIMENSIONS.includes(dimension as typeof SCORE_DIMENSIONS[number]))) return false
  return SCORE_DIMENSIONS.every((dimension) => {
    const score = value.scores[dimension]
    return typeof score === 'number' && Number.isFinite(score) && score >= 0 && score <= 100
  })
}

function validReviewedCapture(value: unknown): value is ReviewedCapture {
  if (!isRecord(value) || typeof value.targetId !== 'string' || !THEMES.includes(value.theme as CaptureTheme) ||
      !imageEvidence(value.image) || !imageEvidence(value.reference) || !isRecord(value.reviewer) ||
      typeof value.reviewer.alias !== 'string' || typeof value.reviewer.provider !== 'string' ||
      typeof value.reviewer.model !== 'string' || !['openai', 'anthropic', 'google', 'xai'].includes(String(value.reviewer.family)) ||
      !validAssessment(value.assessment) || typeof value.score !== 'number' || typeof value.passed !== 'boolean') return false
  return true
}

function validReviewReport(value: unknown): value is ReviewReport {
  return isRecord(value) && value.schemaVersion === 1 &&
    ['passed', 'failed', 'error'].includes(String(value.status)) && value.scope === 'filtered' &&
    typeof value.threshold === 'number' && value.threshold === DEFAULT_THRESHOLD &&
    Array.isArray(value.captures) && Array.isArray(value.failures) &&
    value.failures.every((failure) => typeof failure === 'string') &&
    value.captures.every(validReviewedCapture)
}

function fullTargets(inventory: Inventory, manifest: CaptureManifest): { targets: CaptureTarget[]; sourceTargets: Map<string, CaptureTarget>; invalid: Map<string, string> } {
  const sourceTargets = new Map<string, CaptureTarget>()
  const invalid = new Map<string, string>()
  for (const target of inventory.targets) {
    if (sourceTargets.has(target.id)) invalid.set(target.id, `Source inventory contains duplicate target ${target.id}.`)
    else sourceTargets.set(target.id, target)
  }

  const runtimeTargets = new Map<string, CaptureTarget>()
  for (const target of manifest.targets) {
    if (runtimeTargets.has(target.id)) {
      invalid.set(target.id, `Capture manifest contains duplicate target ${target.id}.`)
      continue
    }
    runtimeTargets.set(target.id, target)
  }

  const pluginById = new Map(inventory.plugins.map((plugin) => [plugin.id, plugin]))
  for (const target of inventory.targets) {
    if (target.plugin === null) {
      if (target.kind !== 'host') invalid.set(target.id, `Host target ${target.id} has non-host kind ${target.kind}.`)
      continue
    }
    const plugin = pluginById.get(target.plugin)
    if (!plugin || !plugin.targets.includes(target.id)) {
      invalid.set(target.id, `Source target ${target.id} has unknown or inconsistent owner ${target.plugin}.`)
    }
  }

  for (const target of manifest.targets) {
    const source = sourceTargets.get(target.id)
    if (!source) {
      const plugin = target.plugin === null ? undefined : pluginById.get(target.plugin)
      const detail = plugin ? `is not declared by source plugin ${plugin.id}` : `has unknown owner ${String(target.plugin)}`
      invalid.set(target.id, `Runtime target ${target.id} ${detail}.`)
    } else if (source.plugin !== target.plugin || source.kind !== target.kind) {
      invalid.set(target.id, `Runtime target ${target.id} has owner or kind different from its source manifest.`)
    }
  }

  const targets = new Map(sourceTargets)
  for (const [id, target] of runtimeTargets) if (!targets.has(id)) targets.set(id, target)
  return { targets: [...targets.values()].sort((left, right) => left.id.localeCompare(right.id)), sourceTargets, invalid }
}

function appendManifestFailures(result: VisualResult, failures: string[]): void {
  for (const failure of failures) result.failures.push(evidence('capture-failure', failure))
}

function setAllFailure(cells: CellMap, targets: CaptureTarget[], code: string, reason: string): void {
  for (const target of targets) for (const theme of THEMES) cells.set(key(target.id, theme), failedCell(target, theme, code, reason))
}

function captureRows(manifest: CaptureManifest): { rows: CaptureRows; malformed: string[] } {
  const rows: CaptureRows = new Map()
  const malformed: string[] = []
  for (const capture of manifest.captures) {
    if (!isRecord(capture) || typeof capture.targetId !== 'string' || !THEMES.includes(capture.theme as CaptureTheme)) {
      malformed.push('Capture manifest contains a malformed cell.')
      continue
    }
    const cellKey = key(capture.targetId, capture.theme as CaptureTheme)
    const values = rows.get(cellKey) ?? []
    values.push(capture as CaptureEvidence)
    rows.set(cellKey, values)
  }
  return { rows, malformed }
}

function sameEvidence(left: ImageEvidence, right: ImageEvidence): boolean {
  return left.path === right.path && left.sha256 === right.sha256
}

function reviewedCell(
  target: CaptureTarget,
  theme: CaptureTheme,
  capture: CaptureEvidence,
  reviewed: ReviewedCapture
): { cell: VisualCell; malformed?: string } {
  const assessment = reviewed.assessment
  if (!validAssessment(assessment)) {
    return { cell: failedCell(target, theme, 'malformed-review', 'Reviewer returned an invalid visual assessment.', capture) , malformed: 'Reviewer returned an invalid visual assessment.' }
  }
  const score = SCORE_DIMENSIONS.reduce((total, dimension) => total + assessment.scores[dimension], 0) / SCORE_DIMENSIONS.length
  if (!Number.isFinite(reviewed.score) || reviewed.score !== score) {
    return {
      cell: failedCell(target, theme, 'inconsistent-score', 'Reviewer total does not match the five dimension scores.', capture, { assessment, reviewer: reviewed.reviewer, score }),
      malformed: 'Reviewer total does not match the five dimension scores.'
    }
  }
  if (!sameEvidence(capture.image!, reviewed.image) || !sameEvidence(capture.reference, reviewed.reference)) {
    return {
      cell: failedCell(target, theme, 'review-evidence-mismatch', 'Reviewer returned evidence for a different capture or golden.', capture, { assessment, reviewer: reviewed.reviewer, score }),
      malformed: 'Reviewer returned evidence for a different capture or golden.'
    }
  }

  const reasons = [...assessment.reasons]
  let code = 'pass'
  if (!assessment.targetVisible) {
    code = 'target-not-visible'
    reasons.push('Reviewer did not confirm that the target was visible.')
  } else if (!assessment.imagesRead) {
    code = 'images-not-read'
    reasons.push('Reviewer did not confirm reading both images.')
  } else if (score < DEFAULT_THRESHOLD) {
    code = 'below-threshold'
    reasons.push(`Score ${score} is below threshold ${DEFAULT_THRESHOLD}.`)
  }
  return {
    cell: {
      targetId: target.id,
      plugin: target.plugin,
      theme,
      status: code === 'pass' ? 'pass' : 'fail',
      code,
      reasons,
      score,
      assessment,
      image: reviewed.image,
      reference: reviewed.reference,
      reviewer: reviewed.reviewer
    }
  }
}

function completeTargetRows(targetId: string, rows: CaptureRows): CaptureEvidence[] | undefined {
  const captures = THEMES.map((theme) => rows.get(key(targetId, theme)))
  if (captures.some((matches) => matches?.length !== 1)) return undefined
  const values = captures.map((matches) => matches![0]!)
  if (values.some((capture) => capture.status !== 'captured' || !capture.image || !imageEvidence(capture.reference))) return undefined
  return values
}

function reviewOutputDir(options: VisualOptions, targetId: string): string {
  const hash = createHash('sha256').update(targetId).digest('hex')
  const directory = join(options.outputDir, 'reviews', hash)
  mkdirSync(directory, { recursive: true })
  return directory
}

function recordReviewFailure(result: VisualResult, code: string, detail: string, targetId?: string): void {
  result.failures.push(evidence(code, detail, targetId))
  result.operationalError = true
}

function mapReviewReport(
  result: VisualResult,
  cells: CellMap,
  target: CaptureTarget,
  options: VisualOptions,
  targetCaptures: CaptureEvidence[],
  reportValue: unknown
): { operational: boolean; reason?: string } {
  if (!validReviewReport(reportValue)) return { operational: true, reason: 'Reviewer returned a malformed report.' }
  const report = reportValue
  if (report.authorFamily !== options.authorFamily || report.reviewerAlias !== options.reviewerAlias) {
    return { operational: true, reason: 'Reviewer report identity or author family does not match the request.' }
  }

  const capturesByKey = new Map<string, CaptureEvidence>()
  for (const capture of targetCaptures) capturesByKey.set(key(capture.targetId, capture.theme), capture)
  const reviewedKeys = new Set<CellKey>()
  let malformed: string | undefined
  for (const reviewed of report.captures) {
    if (reviewed.targetId !== target.id || !capturesByKey.has(key(reviewed.targetId, reviewed.theme))) {
      malformed = `Reviewer returned an unexpected cell for ${reviewed.targetId} (${reviewed.theme}).`
      continue
    }
    const cellKey = key(reviewed.targetId, reviewed.theme)
    if (reviewedKeys.has(cellKey)) {
      cells.set(cellKey, failedCell(target, reviewed.theme, 'duplicate-review-cell', 'Reviewer returned the same image more than once.', capturesByKey.get(cellKey)))
      malformed = `Reviewer returned a duplicate cell for ${reviewed.targetId} (${reviewed.theme}).`
      continue
    }
    reviewedKeys.add(cellKey)
    const capture = capturesByKey.get(cellKey)!
    const measured = reviewedCell(target, reviewed.theme, capture, reviewed)
    cells.set(cellKey, measured.cell)
    malformed ??= measured.malformed
  }

  const operational = report.status === 'error' || malformed !== undefined
  const reason = malformed ?? (report.status === 'error' ? report.failures.join(' ') || 'Reviewer could not complete this target.' : undefined)
  if (report.status === 'error') {
    for (const failure of report.failures) result.failures.push(evidence('review-error', failure, target.id))
    if (report.failures.length === 0) result.failures.push(evidence('review-error', 'Reviewer could not complete this target.', target.id))
    result.operationalError = true
  }
  if (malformed) recordReviewFailure(result, 'malformed-review', malformed, target.id)

  for (const theme of THEMES) {
    const cellKey = key(target.id, theme)
    if (!reviewedKeys.has(cellKey)) {
      cells.set(cellKey, failedCell(target, theme, 'review-not-completed', reason ?? `Reviewer omitted ${target.id} (${theme}).`, capturesByKey.get(cellKey)))
      if (!malformed && report.status !== 'error') {
        recordReviewFailure(result, 'malformed-review', `Reviewer omitted ${target.id} (${theme}).`, target.id)
      }
    }
  }
  return { operational, reason }
}

function filteredManifest(manifest: CaptureManifest, target: CaptureTarget, captures: CaptureEvidence[]): CaptureManifest {
  return { ...manifest, scope: 'filtered', selectors: [target.id], targets: [target], captures, failures: [] }
}

function markSourceChanged(result: VisualResult, reason: string): void {
  result.failures.push(evidence('source-changed', reason))
  result.operationalError = true
}

function initialResult(inventory: Inventory, code: string, reason: string): { result: VisualResult; cells: CellMap } {
  const targets = [...inventory.targets].sort((left, right) => left.id.localeCompare(right.id))
  const cells: CellMap = new Map()
  for (const target of targets) for (const theme of THEMES) cells.set(key(target.id, theme), failedCell(target, theme, code, reason))
  return {
    result: { cells: [...cells.values()], targets, failures: [], operationalError: false },
    cells
  }
}

export function notRunVisuals(inventory: Inventory, code = 'not-run'): VisualResult {
  const { result, cells } = initialResult(inventory, code, code)
  result.cells = [...cells.values()]
  return result
}

export async function measureVisuals(inventory: Inventory, options: VisualOptions, dependencies: VisualDependencies): Promise<VisualResult> {
  const { result, cells } = initialResult(inventory, 'review-not-completed', 'Visual review has not completed.')
  if (inventory.dirty) {
    setAllFailure(cells, result.targets, 'dirty-source', 'Production source is dirty; visual capture was not started.')
    result.failures.push(evidence('dirty-source', 'Production source is dirty; visual capture was not started.'))
    result.operationalError = true
    result.cells = [...cells.values()]
    return result
  }

  let captured: CaptureManifest | undefined
  try {
    const captureOptions: CaptureOptions = {
      repoRoot: inventory.repoRoot,
      outputDir: options.outputDir,
      only: [],
      skipBuild: false,
      themes: THEMES,
      timeoutMs: CAPTURE_TIMEOUT_MS,
      ...(options.browserExecutable === undefined ? {} : { browserExecutable: options.browserExecutable }),
      ...(options.signal === undefined ? {} : { signal: options.signal })
    }
    const rawManifest: unknown = await dependencies.capture(captureOptions)
    captured = rawManifest as CaptureManifest
    try {
      writeFileSync(join(options.outputDir, 'capture-manifest.json'), `${JSON.stringify(rawManifest, null, 2)}\n`, { flag: 'w' })
    } catch (error) {
      recordReviewFailure(result, 'capture-artifact-error', `Could not preserve capture manifest: ${message(error)}`)
    }
  } catch (error) {
    const detail = message(error)
    result.failures.push(evidence('capture-error', detail))
    result.operationalError = true
    setAllFailure(cells, result.targets, 'capture-error', detail)
  }

  let stopReviews = false
  if (captured !== undefined) {
    if (!validManifest(captured)) {
      const detail = 'Capture returned a malformed or non-full manifest.'
      result.failures.push(evidence('invalid-capture-manifest', detail))
      result.operationalError = true
      setAllFailure(cells, result.targets, 'invalid-capture-manifest', detail)
    } else {
      appendManifestFailures(result, captured.failures)
      const targets = fullTargets(inventory, captured)
      result.targets.splice(0, result.targets.length, ...targets.targets)
      for (const [targetId, detail] of targets.invalid) {
        result.failures.push(evidence('target-ownership', detail, targetId))
        result.operationalError = true
        const target = targets.targets.find((candidate) => candidate.id === targetId)
        if (target) for (const theme of THEMES) cells.set(key(targetId, theme), failedCell(target, theme, 'target-ownership', detail))
      }
      if (captured.scope !== 'full' || captured.selectors.length !== 0) {
        const detail = 'Capture must cover the full unfiltered target inventory.'
        result.failures.push(evidence('filtered-capture', detail))
        result.operationalError = true
        setAllFailure(cells, result.targets, 'filtered-capture', detail)
      } else if (captured.commit !== inventory.commit) {
        const detail = `Capture commit ${captured.commit} does not match source inventory commit ${inventory.commit}.`
        result.failures.push(evidence('capture-commit-mismatch', detail))
        result.operationalError = true
        setAllFailure(cells, result.targets, 'capture-commit-mismatch', detail)
      } else {
        const manifestTargets = new Set(captured.targets.map((target) => target.id))
        const { rows, malformed } = captureRows(captured)
        for (const detail of malformed) {
          result.failures.push(evidence('invalid-capture-cell', detail))
          result.operationalError = true
        }
        const captureTargetIds = new Set(captured.targets.map((target) => target.id))
        for (const rowKey of rows.keys()) {
          const targetId = rowKey.slice(0, rowKey.lastIndexOf('\0'))
          if (!captureTargetIds.has(targetId)) {
            const detail = `Capture evidence references target ${targetId} missing from the manifest target list.`
            result.failures.push(evidence('invalid-capture-cell', detail, targetId))
            result.operationalError = true
          }
        }

        const eligible: Array<{ target: CaptureTarget; captures: CaptureEvidence[] }> = []
        for (const target of result.targets) {
          const ownershipError = targets.invalid.get(target.id)
          const sourceTarget = targets.sourceTargets.has(target.id)
          if (ownershipError) continue
          if (!sourceTarget) {
            const detail = `Runtime target ${target.id} is not present in the source inventory.`
            for (const theme of THEMES) cells.set(key(target.id, theme), failedCell(target, theme, 'unmanifested-target', detail))
            continue
          }
          if (!manifestTargets.has(target.id)) {
            for (const theme of THEMES) cells.set(key(target.id, theme), failedCell(target, theme, 'surface-not-captured', `Source surface ${target.id} is missing from the full capture.`))
            continue
          }

          let complete = true
          for (const theme of THEMES) {
            const cellKey = key(target.id, theme)
            const matches = rows.get(cellKey) ?? []
            if (matches.length === 0) {
              cells.set(cellKey, failedCell(target, theme, 'missing-cell', `Capture manifest has no ${theme} cell for ${target.id}.`))
              complete = false
            } else if (matches.length > 1) {
              cells.set(cellKey, failedCell(target, theme, 'duplicate-cell', `Capture manifest has duplicate ${theme} cells for ${target.id}.`, matches[0]))
              complete = false
            } else {
              const capture = matches[0]!
              if (!capture.image) {
                cells.set(cellKey, failedCell(target, theme, 'missing-image', `Capture has no ${theme} screenshot for ${target.id}.`, capture))
                complete = false
              } else if (capture.status !== 'captured') {
                cells.set(cellKey, failedCell(target, theme, 'capture-failed', capture.error ?? `Capture failed for ${target.id} (${theme}).`, capture))
                complete = false
              } else if (!imageEvidence(capture.reference)) {
                cells.set(cellKey, failedCell(target, theme, 'missing-reference', `Capture has no ${theme} golden reference for ${target.id}.`, capture))
                complete = false
                result.failures.push(evidence('invalid-capture-cell', `Capture has no ${theme} golden reference for ${target.id}.`, target.id, theme))
                result.operationalError = true
              }
            }
          }
          if (complete) eligible.push({ target, captures: completeTargetRows(target.id, rows)! })
          else {
            for (const theme of THEMES) {
              const cellKey = key(target.id, theme)
              if (cells.get(cellKey)?.code === 'review-not-completed') {
                const capture = rows.get(cellKey)?.[0]
                cells.set(cellKey, failedCell(target, theme, 'review-not-completed', `Target ${target.id} lacks complete two-theme capture coverage.`, capture))
              }
            }
          }
        }

        for (const item of eligible) {
          if (stopReviews) break
          const reviewManifestValue = filteredManifest(captured, item.target, item.captures)
          let report: unknown
          try {
            const directory = reviewOutputDir(options, item.target.id)
            report = await dependencies.review(reviewManifestValue, {
              outputDir: directory,
              reviewerAlias: options.reviewerAlias,
              authorFamily: options.authorFamily,
              threshold: DEFAULT_THRESHOLD,
              timeoutMs: REVIEW_TIMEOUT_MS,
              ...(options.signal === undefined ? {} : { signal: options.signal })
            })
          } catch (error) {
            const detail = message(error)
            recordReviewFailure(result, 'review-error', detail, item.target.id)
            for (const theme of THEMES) {
              const cellKey = key(item.target.id, theme)
              if (cells.get(cellKey)?.code === 'review-not-completed') {
                cells.set(cellKey, failedCell(item.target, theme, 'review-error', detail, rows.get(cellKey)?.[0]))
              }
            }
            stopReviews = true
            continue
          }

          const mapped = mapReviewReport(result, cells, item.target, options, item.captures, report)
          if (mapped.operational) {
            if (!result.failures.some((failure) => failure.targetId === item.target.id && failure.code === 'review-error') && mapped.reason) {
              result.failures.push(evidence('review-error', mapped.reason, item.target.id))
            }
            result.operationalError = true
            stopReviews = true
          }
        }

        if (stopReviews) {
          for (const target of result.targets) for (const theme of THEMES) {
            const cellKey = key(target.id, theme)
            if (cells.get(cellKey)?.code === 'review-not-completed') {
              cells.set(cellKey, failedCell(target, theme, 'review-not-completed', `Review was not completed after an operational reviewer error for ${target.id}.`, rows.get(cellKey)?.[0]))
            }
          }
        }
      }
    }
  }

  try {
    const current = collectInventory(inventory.repoRoot)
    if (current.commit !== inventory.commit || current.sourceDigest !== inventory.sourceDigest || current.dirty || current.failures.length > 0) {
      markSourceChanged(result, 'Production source changed during screenshot capture or review.')
    }
  } catch (error) {
    markSourceChanged(result, `Could not re-collect production source after screenshot review: ${message(error)}`)
  }

  result.cells = [...cells.values()].sort((left, right) => left.targetId.localeCompare(right.targetId) || THEMES.indexOf(left.theme) - THEMES.indexOf(right.theme))
  result.targets.sort((left, right) => left.id.localeCompare(right.id))
  return result
}
