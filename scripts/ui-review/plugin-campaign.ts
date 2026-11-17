import { createHash } from 'node:crypto'
import { basename, resolve } from 'node:path'
import { DEFAULT_THRESHOLD } from './arguments'
import {
  CAPTURE_SCHEMA_VERSION,
  SCORE_DIMENSIONS,
  THEMES,
  type CaptureEvidence,
  type CaptureManifest,
  type CaptureTarget,
  type CaptureTheme,
  type ContributionInventory,
  type ImageEvidence,
  type ModelFamily,
  type ReviewIssue,
  type ReviewerIdentity,
  type ReviewedCapture,
  type VisualAssessment
} from './contracts'
import { scopeCaptureInventory, validateContributionInventory } from './contribution-inventory'
import { hostContractContext, serializeContractContext } from './host-contracts'
import { VIEWPORT } from './goldens'
import type { Inventory } from '../ui-scoreboard/contracts'

export type PluginSampleSlot = 1 | 2 | 3
export type PluginCampaignStatus = 'passed' | 'failed' | 'error'
export type PluginSlotStatus = 'valid' | 'invalid' | 'missing' | 'skipped'
export type PluginArtifact = { path: string; sha256: string }
export type PluginTargetManifest = { targetId: string; path: string; sha256: string }
export type PluginExpectedContext = { targetId: string; theme: CaptureTheme; sha256: string }
export type PluginCampaignTiming = {
  concurrency: 4
  captureMs: number
  reviewMs: number
  totalMs: number
  initialReviewCalls: number
  replacementReviewCalls: number
  maxConcurrency: number
}
export type PluginCellOutcome = {
  targetId: string
  plugin: string
  theme: CaptureTheme
  slots: [PluginSlotOutcome, PluginSlotOutcome, PluginSlotOutcome]
  median: number | null
  range: number | null
  status: 'pass' | 'fail' | 'invalid'
}
export type PluginSlotOutcome = {
  slot: PluginSampleSlot
  score: number | null
  attempts: PluginAttempt[]
  /** Distinguishes an invalid response from a later slot skipped after cell invalidation. */
  status?: PluginSlotStatus
}
export type PluginAttempt = {
  id: string
  retryOf: string | null
  reportPath: string | null
  reportSha256: string | null
  issues: ReviewIssue[]
  sample: ReviewedCapture | null
  startedAt?: number
  endedAt?: number
  preflightIdentity?: Pick<ReviewerIdentity, 'provider' | 'model' | 'family'> | null
  artifacts?: PluginArtifact[]
}
export type PluginCampaignFailure = {
  code: string
  message: string
  targetId?: string
  theme?: CaptureTheme
}
export type PluginCampaignCounts = {
  requiredCells: number
  completeValidCells: number
  passing: number
  belowThreshold: number
  invalid: number
}
export type PluginCampaignExtraAttempt = {
  targetId: string
  theme: CaptureTheme
  slot: number
  attempt: PluginAttempt
}
export type PluginCampaignReport = {
  schemaVersion: 1
  status: PluginCampaignStatus
  goalPassed: false
  threshold: 85
  sampleCount: 3
  source: { commit: string; sourceDigest: string }
  manifest: { path: string; sha256: string } | null
  authorFamily: ModelFamily
  reviewer: ReviewerIdentity | null
  plugins: { id: string; targetIds: string[]; status: 'pass' | 'fail' | 'invalid' | 'not-applicable' }[]
  cells: PluginCellOutcome[]
  counts: PluginCampaignCounts
  failures: PluginCampaignFailure[]
  extraAttempts: PluginCampaignExtraAttempt[]
  contributionInventory?: ContributionInventory
  activatedVisibilitySettings?: string[]
  captureEvidence?: CaptureEvidence[]
  targetManifests?: PluginTargetManifest[]
  expectedContexts?: PluginExpectedContext[]
  timing?: PluginCampaignTiming
}
export type PluginCampaignInput = {
  inventory: Inventory
  manifest: CaptureManifest | null
  authorFamily: ModelFamily
  reviewer: ReviewerIdentity | null
  attempts: { targetId: string; theme: CaptureTheme; slot: PluginSampleSlot; attempt: PluginAttempt }[]
  failures: PluginCampaignFailure[]
  manifestEvidence?: { path: string; sha256: string }
  activatedVisibilitySettings?: string[]
  captureEvidence?: CaptureEvidence[]
  targetManifests?: PluginTargetManifest[]
  expectedContexts?: PluginExpectedContext[]
  timing?: PluginCampaignTiming
}

const TARGET_KINDS: readonly CaptureTarget['kind'][] = [
  'host', 'panel', 'view', 'sidebar-section', 'activity-item',
  'status-bar', 'overlay', 'settings-section'
]
const MODEL_FAMILIES: readonly ModelFamily[] = ['openai', 'anthropic', 'google', 'xai']
const REVIEW_ISSUE_CODES: readonly ReviewIssue['code'][] = [
  'operational', 'response-shape', 'invalid-sample', 'contract-conflict',
  'evidence-changed', 'identity-mismatch', 'persistence', 'aborted', 'usage-limit'
]
const RETRYABLE_ISSUE_CODES: readonly ReviewIssue['code'][] = ['operational', 'response-shape']
const GLOBAL_ISSUE_CODES: readonly ReviewIssue['code'][] = [
  'evidence-changed', 'identity-mismatch', 'persistence', 'aborted', 'usage-limit'
]
const THRESHOLD = DEFAULT_THRESHOLD

type StagedAttempt = {
  targetId: string
  theme: CaptureTheme
  slot: number
  attempt: PluginAttempt
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

function hasText(value: unknown, maxLength = 4096): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function hashText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function inventoryMismatch(message: string): never {
  throw new Error(`inventory-mismatch: ${message}`)
}

function ownerFromId(id: string): string | null {
  const separator = id.indexOf(':')
  const slash = id.indexOf('/', separator + 1)
  return separator >= 0 && slash > separator ? id.slice(separator + 1, slash) : null
}

function isCaptureTarget(value: unknown): value is CaptureTarget {
  if (!isRecord(value) || !exactKeys(value, ['id', 'plugin', 'title', 'kind']) ||
    !hasText(value.id, 512) || typeof value.title !== 'string' ||
    !TARGET_KINDS.includes(value.kind as CaptureTarget['kind']) ||
    (value.plugin !== null && typeof value.plugin !== 'string')) return false
  if (value.kind === 'host') return value.plugin === null && value.id.startsWith('host:')
  return typeof value.plugin === 'string' &&
    value.id.startsWith(`${value.kind}:`) &&
    ownerFromId(value.id) === value.plugin
}

function targetIdentity(target: CaptureTarget): string {
  return `${target.id}\0${target.plugin ?? ''}\0${target.kind}`
}

function sameTargetIdentity(left: CaptureTarget, right: CaptureTarget): boolean {
  return left.id === right.id && left.plugin === right.plugin && left.kind === right.kind
}

function targetMap(targets: readonly CaptureTarget[], context: string): Map<string, CaptureTarget> {
  const byId = new Map<string, CaptureTarget>()
  for (const target of targets) {
    if (!isCaptureTarget(target) || byId.has(target.id)) inventoryMismatch(`${context} has a malformed or duplicate target`)
    byId.set(target.id, target)
  }
  return byId
}

function projectedSourceTargets(value: unknown): CaptureTarget[] {
  if (!isRecord(value) || !Array.isArray(value.declaredTargets) || !Array.isArray(value.toolAliases)) {
    inventoryMismatch('contribution declaration and alias metadata are missing or malformed')
  }
  const aliasIds = new Set<string>()
  for (const alias of value.toolAliases) {
    if (isRecord(alias) && isRecord(alias.declaration) && typeof alias.declaration.id === 'string') {
      aliasIds.add(alias.declaration.id)
    }
  }
  const projected = value.declaredTargets.filter((target): target is CaptureTarget =>
    isCaptureTarget(target) && !aliasIds.has(target.id))
  try {
    validateContributionInventory(value, projected)
  } catch (error) {
    inventoryMismatch(`source contribution metadata is invalid: ${error instanceof Error ? error.message : 'unknown error'}`)
  }
  return projected
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length &&
    new Set(left).size === left.length &&
    new Set(right).size === right.length &&
    left.every((value) => right.includes(value))
}

function sameContributionIdentity(
  actual: ContributionInventory,
  expected: ContributionInventory
): boolean {
  const actualAliases = new Set(actual.toolAliases.map(({ declaration }) => declaration.id))
  const expectedAliases = new Set(expected.toolAliases.map(({ declaration }) => declaration.id))
  if (!sameStringSet([...actualAliases], [...expectedAliases])) return false
  const actualTargets = targetMap(actual.declaredTargets, 'capture contribution metadata')
  const expectedTargets = targetMap(expected.declaredTargets, 'source contribution metadata')
  if (actualTargets.size !== expectedTargets.size) return false
  for (const [id, target] of actualTargets) {
    const expectedTarget = expectedTargets.get(id)
    if (!expectedTarget || !sameTargetIdentity(target, expectedTarget)) return false
  }
  const aliasByDeclaration = new Map(actual.toolAliases.map((alias) => [alias.declaration.id, alias]))
  return expected.toolAliases.every((alias) => {
    const found = aliasByDeclaration.get(alias.declaration.id)
    return found !== undefined &&
      found.toolId === alias.toolId &&
      found.reason === alias.reason &&
      sameTargetIdentity(found.declaration, alias.declaration) &&
      sameTargetIdentity(found.renderedTarget, alias.renderedTarget)
  })
}

export function assertPluginInventory(inventory: Inventory): void {
  if (!isRecord(inventory) || !Array.isArray(inventory.plugins) || !Array.isArray(inventory.targets) ||
    !Array.isArray(inventory.failures) || inventory.dirty !== false ||
    !hasText(inventory.commit, 512) || !isSha256(inventory.sourceDigest)) {
    inventoryMismatch('inventory is empty, dirty, unreadable, or missing source identity')
  }
  if (inventory.failures.length > 0 || inventory.plugins.length === 0) {
    inventoryMismatch('inventory contains source failures or no discovered plugins')
  }

  const pluginIds = new Set<string>()
  for (const plugin of inventory.plugins) {
    if (!isRecord(plugin) || !hasText(plugin.id, 256) || pluginIds.has(plugin.id)) {
      inventoryMismatch('plugin inventory contains a malformed or duplicate plugin ID')
    }
    pluginIds.add(plugin.id)
  }

  const contribution = inventory.contributionInventory
  const sourceTargets = projectedSourceTargets(contribution)
  for (const plugin of inventory.plugins) {
    const declarations = contribution!.declaredTargets
      .filter((target) => target.plugin === plugin.id).map(({ id }) => id)
    if (!Array.isArray(plugin.targets) || !sameStringSet(plugin.targets, declarations)) {
      inventoryMismatch(`plugin ${plugin.id} target declarations differ from its source contribution inventory`)
    }
  }
  const sourceById = targetMap(sourceTargets.filter(({ plugin }) => plugin !== null), 'source plugin inventory')
  const runtimeTargets = targetMap(inventory.targets, 'runtime inventory')
  const runtimeById = new Map([...runtimeTargets].filter(([, target]) => target.plugin !== null))

  for (const target of sourceById.values()) {
    if (!target.plugin || !pluginIds.has(target.plugin)) {
      inventoryMismatch(`source target ${target.id} has no owning plugin record`)
    }
  }
  if (runtimeById.size !== sourceById.size) {
    inventoryMismatch('runtime plugin targets differ from source declarations')
  }
  for (const [id, sourceTarget] of sourceById) {
    const runtimeTarget = runtimeById.get(id)
    if (!runtimeTarget || !sameTargetIdentity(runtimeTarget, sourceTarget)) {
      inventoryMismatch(`runtime target ${id} differs from its source ID, owner, or kind`)
    }
  }
}

function validImageEvidence(value: unknown): value is ImageEvidence {
  return isRecord(value) && exactKeys(value, ['path', 'sha256']) &&
    hasText(value.path, 4096) && isSha256(value.sha256)
}

function sameEvidence(actual: ImageEvidence, expected: ImageEvidence): boolean {
  return resolve(actual.path) === resolve(expected.path) && actual.sha256 === expected.sha256
}

function projectedPluginTargets(inventory: Inventory): CaptureTarget[] {
  return inventory.targets.filter((target) => target.plugin !== null)
}

function exactTargetSet(actual: unknown, expected: readonly CaptureTarget[], context: string): void {
  if (!Array.isArray(actual)) inventoryMismatch(`${context} targets are missing`)
  const actualTargets: CaptureTarget[] = []
  for (const target of actual) {
    if (!isCaptureTarget(target)) inventoryMismatch(`${context} contains a malformed target`)
    actualTargets.push(target)
  }
  const actualById = targetMap(actualTargets, context)
  const expectedById = targetMap(expected, 'expected plugin inventory')
  if (actualById.size !== expectedById.size) inventoryMismatch(`${context} target set differs from plugin inventory`)
  for (const [id, target] of expectedById) {
    const found = actualById.get(id)
    if (!found || !sameTargetIdentity(found, target)) {
      inventoryMismatch(`${context} target ${id} differs from source ID, owner, or kind`)
    }
  }
}

function exactCaptureInventory(
  actual: unknown,
  expected: ContributionInventory
): asserts actual is ContributionInventory {
  const actualTargets = projectedSourceTargets(actual)
  if (!isRecord(actual) || !Array.isArray(actual.declaredTargets) || !Array.isArray(actual.toolAliases)) {
    inventoryMismatch('capture contribution inventory is malformed')
  }
  const actualInventory = actual as unknown as ContributionInventory
  if (actualTargets.some(({ plugin }) => plugin === null)) {
    inventoryMismatch('scoped capture contribution metadata contains host targets')
  }
  if (!sameContributionIdentity(actualInventory, expected)) {
    inventoryMismatch('capture source declarations or navigation aliases differ from the scoped plugin inventory')
  }
}

export function validatePluginCapture(
  inventory: Inventory,
  manifest: CaptureManifest
): { eligibleTargetIds: string[]; invalidTargets: { targetId: string; code: string; message: string }[] } {
  assertPluginInventory(inventory)
  if (!isRecord(manifest) || manifest.schemaVersion !== CAPTURE_SCHEMA_VERSION ||
    manifest.surface !== 'desktop-renderer' || manifest.scope !== 'filtered' ||
    manifest.commit !== inventory.commit ||
    !isRecord(manifest.viewport) || manifest.viewport.width !== VIEWPORT.width ||
    manifest.viewport.height !== VIEWPORT.height ||
    !Array.isArray(manifest.selectors) || !Array.isArray(manifest.captures) ||
    !Array.isArray(manifest.failures) || manifest.failures.some((failure) => typeof failure !== 'string')) {
    inventoryMismatch('capture manifest envelope or source identity is malformed')
  }

  const targets = projectedPluginTargets(inventory)
  exactTargetSet(manifest.targets, targets, 'capture manifest')
  const expectedSelectors = [...new Set(targets.map(({ plugin }) => plugin).filter((id): id is string => id !== null))].sort()
  if (!sameStringSet(manifest.selectors, expectedSelectors)) {
    inventoryMismatch('capture manifest selectors differ from screenshot-bearing plugin IDs')
  }

  const expectedScoped = scopeCaptureInventory(inventory.contributionInventory!, targets)
  exactCaptureInventory(manifest.contributionInventory, expectedScoped)

  const expectedCaptureKeys = new Set<string>()
  for (const target of targets) {
    for (const theme of THEMES) expectedCaptureKeys.add(`${target.id}\0${theme}`)
  }
  const captureByKey = new Map<string, CaptureEvidence>()
  for (const capture of manifest.captures) {
    if (!isRecord(capture) || typeof capture.targetId !== 'string' ||
      !THEMES.includes(capture.theme as CaptureTheme)) {
      inventoryMismatch('capture manifest contains a malformed target/theme row')
    }
    const key = `${capture.targetId}\0${capture.theme}`
    if (!expectedCaptureKeys.has(key) || captureByKey.has(key)) {
      inventoryMismatch('capture manifest contains a foreign or duplicate target/theme row')
    }
    captureByKey.set(key, capture as CaptureEvidence)
  }
  if (captureByKey.size !== expectedCaptureKeys.size) {
    inventoryMismatch('capture manifest omits a required target/theme row')
  }

  const eligibleTargetIds: string[] = []
  const invalidTargets: { targetId: string; code: string; message: string }[] = []
  for (const target of targets) {
    const targetCaptures = THEMES.map((theme) => captureByKey.get(`${target.id}\0${theme}`)!)
    const incomplete = targetCaptures.find((capture) =>
      capture.status !== 'captured' ||
      !validImageEvidence(capture.image) ||
      !validImageEvidence(capture.reference))
    if (incomplete) {
      const message = typeof incomplete.error === 'string' && incomplete.error.length > 0
        ? incomplete.error
        : `Capture evidence is incomplete for ${incomplete.targetId}/${incomplete.theme}.`
      invalidTargets.push({ targetId: target.id, code: 'target-capture-incomplete', message })
    } else {
      eligibleTargetIds.push(target.id)
    }
  }
  return { eligibleTargetIds, invalidTargets }
}

function pluginIssue(
  code: ReviewIssue['code'],
  message: string,
  targetId: string,
  theme: CaptureTheme
): ReviewIssue {
  return { code, message, targetId, theme }
}

function validReviewerIdentity(value: unknown): value is ReviewerIdentity {
  return isRecord(value) &&
    hasText(value.alias, 256) &&
    hasText(value.provider, 256) &&
    hasText(value.model, 512) &&
    MODEL_FAMILIES.includes(value.family as ModelFamily)
}

function sameReviewer(left: ReviewerIdentity, right: ReviewerIdentity): boolean {
  return left.alias === right.alias && left.provider === right.provider &&
    left.model === right.model && left.family === right.family
}

function validateAudit(
  value: unknown,
  assessment: VisualAssessment,
  expectedContextSha256: string,
  knownRuleIds: readonly string[]
): { issue: string | null; penalized: boolean } {
  if (!isRecord(value) || !exactKeys(value, ['contextSha256', 'acknowledgedRuleIds', 'reasonChecks', 'conflicts']) ||
    value.contextSha256 !== expectedContextSha256 ||
    !Array.isArray(value.acknowledgedRuleIds) ||
    !Array.isArray(value.reasonChecks) ||
    !Array.isArray(value.conflicts)) {
    return { issue: 'Contract audit is malformed or has a mismatched context digest.', penalized: false }
  }
  if (value.acknowledgedRuleIds.length !== knownRuleIds.length ||
    value.acknowledgedRuleIds.some((id, index) => id !== knownRuleIds[index])) {
    return { issue: 'Contract acknowledgments are missing, duplicated, unknown, or unsorted.', penalized: false }
  }
  if (value.reasonChecks.length !== assessment.reasons.length) {
    return { issue: 'Contract reason audit does not cover every scored reason exactly once.', penalized: false }
  }
  const known = new Set(knownRuleIds)
  const seenIndexes = new Set<number>()
  let penalized = false
  for (const check of value.reasonChecks) {
    if (!isRecord(check) ||
      !exactKeys(check, ['reasonIndex', 'contractIds', 'conflictsWithContract', 'affectsScore']) ||
      !Number.isInteger(check.reasonIndex) ||
      (check.reasonIndex as number) < 0 ||
      (check.reasonIndex as number) >= assessment.reasons.length ||
      seenIndexes.has(check.reasonIndex as number) ||
      !Array.isArray(check.contractIds) ||
      check.contractIds.some((id) => typeof id !== 'string' || !known.has(id)) ||
      new Set(check.contractIds).size !== check.contractIds.length ||
      typeof check.conflictsWithContract !== 'boolean' ||
      typeof check.affectsScore !== 'boolean') {
      return { issue: 'Contract reason audit contains a duplicate, missing, or unknown entry.', penalized: false }
    }
    seenIndexes.add(check.reasonIndex as number)
    if (check.conflictsWithContract && check.affectsScore) penalized = true
  }
  if (seenIndexes.size !== assessment.reasons.length || value.conflicts.length > 20) {
    return { issue: 'Contract audit has missing reason checks or too many conflict annotations.', penalized: false }
  }
  for (const conflict of value.conflicts) {
    if (!isRecord(conflict) || !exactKeys(conflict, ['contractId', 'reason', 'affectsScore']) ||
      typeof conflict.contractId !== 'string' || !known.has(conflict.contractId) ||
      !hasText(conflict.reason, 1000) || typeof conflict.affectsScore !== 'boolean') {
      return { issue: 'Contract conflict annotation is malformed or references an unknown rule.', penalized: false }
    }
    if (conflict.affectsScore) penalized = true
  }
  return { issue: null, penalized }
}

export function validatePluginSample(
  sample: ReviewedCapture,
  capture: CaptureEvidence,
  target: CaptureTarget,
  authorFamily: ModelFamily,
  reviewer: ReviewerIdentity | null
): ReviewIssue | null {
  if (!isRecord(sample) || sample.targetId !== target.id || sample.theme !== capture.theme ||
    capture.targetId !== target.id || target.plugin === null ||
    !THEMES.includes(capture.theme as CaptureTheme)) {
    return pluginIssue('invalid-sample', 'Review output identity does not match its requested plugin cell.', target.id, capture.theme)
  }
  if (capture.status !== 'captured' || !validImageEvidence(capture.image) ||
    !validImageEvidence(capture.reference) ||
    !validImageEvidence(sample.image) || !validImageEvidence(sample.reference) ||
    !sameEvidence(sample.image, capture.image) ||
    !sameEvidence(sample.reference, capture.reference)) {
    return pluginIssue('evidence-changed', 'Review output image/reference identity differs from frozen capture evidence.', target.id, capture.theme)
  }
  if (!validReviewerIdentity(sample.reviewer) ||
    sample.reviewer.family === authorFamily ||
    (reviewer !== null && !sameReviewer(sample.reviewer, reviewer))) {
    return pluginIssue('identity-mismatch', 'Review output has a missing, author-matched, or changed reviewer identity.', target.id, capture.theme)
  }
  if (!isRecord(sample.assessment)) {
    return pluginIssue('invalid-sample', 'Review assessment is malformed.', target.id, capture.theme)
  }
  const assessment = sample.assessment
  if (assessment.targetVisible !== true || assessment.imagesRead !== true) {
    return pluginIssue('invalid-sample', 'Reviewer did not confirm target visibility and reading both images.', target.id, capture.theme)
  }
  if (!isRecord(assessment.scores) ||
    Object.keys(assessment.scores).length !== SCORE_DIMENSIONS.length ||
    SCORE_DIMENSIONS.some((dimension) => !Object.hasOwn(assessment.scores, dimension) ||
      typeof assessment.scores[dimension] !== 'number' ||
      !Number.isFinite(assessment.scores[dimension]) ||
      (assessment.scores[dimension] as number) < 0 ||
      (assessment.scores[dimension] as number) > 100)) {
    return pluginIssue('invalid-sample', 'Review output does not contain five finite scores from 0 through 100.', target.id, capture.theme)
  }
  if (!Array.isArray(assessment.reasons) || assessment.reasons.length < 2 ||
    assessment.reasons.length > 20 ||
    assessment.reasons.some((reason) => !hasText(reason, 1000))) {
    return pluginIssue('invalid-sample', 'Review reasons are missing or malformed.', target.id, capture.theme)
  }
  const score = SCORE_DIMENSIONS.reduce((total, dimension) =>
    total + (assessment.scores[dimension] as number), 0) / SCORE_DIMENSIONS.length
  if (typeof sample.score !== 'number' || !Number.isFinite(sample.score) ||
    sample.score !== score || typeof sample.passed !== 'boolean' ||
    sample.passed !== (score >= THRESHOLD)) {
    return pluginIssue('invalid-sample', 'Review score/status does not exactly match the five raw dimensions.', target.id, capture.theme)
  }

  const contractReview = sample.contractReview
  if (!isRecord(contractReview) || !hasText(contractReview.contextPath, 4096) ||
    !isSha256(contractReview.contextSha256) || !isRecord(contractReview.audit)) {
    return pluginIssue('response-shape', 'Review omitted the trusted context path, digest, or audit.', target.id, capture.theme)
  }
  const context = hostContractContext(target, capture.theme)
  const expectedContextSha256 = hashText(serializeContractContext(context))
  if (contractReview.contextSha256 !== expectedContextSha256 ||
    contractReview.audit.contextSha256 !== expectedContextSha256) {
    return pluginIssue('evidence-changed', 'Review trusted-context digest differs from the frozen context.', target.id, capture.theme)
  }
  const ruleIds = context.rules.map(({ id }) => id).sort()
  const audit = validateAudit(contractReview.audit, assessment as unknown as VisualAssessment, expectedContextSha256, ruleIds)
  if (audit.issue) return pluginIssue('response-shape', audit.issue, target.id, capture.theme)
  if (audit.penalized) {
    return pluginIssue('contract-conflict', 'A score-affecting contract contradiction invalidates this sample.', target.id, capture.theme)
  }
  return null
}

function cloneAttempt(value: unknown): PluginAttempt {
  if (!isRecord(value)) {
    return { id: '', retryOf: null, reportPath: null, reportSha256: null, issues: [], sample: null }
  }
  const cloned = structuredClone(value)
  return {
    ...cloned,
    id: typeof value.id === 'string' ? value.id : '',
    retryOf: typeof value.retryOf === 'string' ? value.retryOf : null,
    reportPath: typeof value.reportPath === 'string' ? value.reportPath : null,
    reportSha256: typeof value.reportSha256 === 'string' ? value.reportSha256 : null,
    issues: Array.isArray(value.issues) ? cloned.issues as ReviewIssue[] : [],
    sample: value.sample === null || value.sample === undefined
      ? null
      : structuredClone(value.sample) as ReviewedCapture
  } as PluginAttempt
}

function cloneFailure(failure: PluginCampaignFailure): PluginCampaignFailure {
  return structuredClone(failure)
}

function issueKey(issue: ReviewIssue): string {
  return `${issue.code}\0${issue.message}\0${issue.targetId ?? ''}\0${issue.theme ?? ''}`
}

function addIssue(attempt: PluginAttempt, issue: ReviewIssue): void {
  if (!attempt.issues.some((existing) => isRecord(existing) && issueKey(existing as ReviewIssue) === issueKey(issue))) {
    attempt.issues.push(issue)
  }
}

function validIssue(value: unknown, targetId: string, theme: CaptureTheme): ReviewIssue | null {
  if (!isRecord(value) || !REVIEW_ISSUE_CODES.includes(value.code as ReviewIssue['code']) ||
    typeof value.message !== 'string') return null
  const issue = value as unknown as ReviewIssue
  if ((issue.targetId !== undefined && issue.targetId !== targetId) ||
    (issue.theme !== undefined && issue.theme !== theme)) return null
  return issue
}

function retryableFailure(attempt: PluginAttempt): boolean {
  return attempt.sample === null &&
    attempt.issues.length > 0 &&
    attempt.issues.every(({ code }) => RETRYABLE_ISSUE_CODES.includes(code))
}

function validArtifactIdentity(attempt: PluginAttempt): boolean {
  return hasText(attempt.reportPath, 4096) && isSha256(attempt.reportSha256)
}

function createCampaignIssue(code: string, message: string, targetId?: string, theme?: CaptureTheme): PluginCampaignFailure {
  return { code, message, ...(targetId === undefined ? {} : { targetId }), ...(theme === undefined ? {} : { theme }) }
}

function expectedContext(target: CaptureTarget, theme: CaptureTheme): PluginExpectedContext {
  return { targetId: target.id, theme, sha256: hashText(serializeContractContext(hostContractContext(target, theme))) }
}

export function summarizePluginCampaign(input: PluginCampaignInput): PluginCampaignReport {
  assertPluginInventory(input.inventory)
  const targets = projectedPluginTargets(input.inventory)
  const targetById = targetMap(targets, 'plugin campaign')
  const cellsByKey = new Map<string, { target: CaptureTarget; theme: CaptureTheme }>()
  for (const target of targets) {
    for (const theme of THEMES) cellsByKey.set(`${target.id}\0${theme}`, { target, theme })
  }

  let captureValidation: ReturnType<typeof validatePluginCapture> | null = null
  if (input.manifest !== null) captureValidation = validatePluginCapture(input.inventory, input.manifest)
  const captureByKey = new Map<string, CaptureEvidence>()
  if (input.manifest) {
    for (const capture of input.manifest.captures) captureByKey.set(`${capture.targetId}\0${capture.theme}`, capture)
  }
  const invalidCaptureTargets = new Map((captureValidation?.invalidTargets ?? []).map((failure) => [failure.targetId, failure]))
  for (const failure of input.failures) {
    if (failure.code === 'target-capture-incomplete' &&
      typeof failure.targetId === 'string' &&
      targetById.has(failure.targetId)) {
      invalidCaptureTargets.set(failure.targetId, {
        targetId: failure.targetId,
        code: failure.code,
        message: failure.message
      })
    }
  }

  const failures = input.failures.map(cloneFailure)
  let globalError = failures.length > 0 || (input.manifest?.failures.length ?? 0) > 0
  if (input.manifest) {
    for (const message of input.manifest.failures) {
      failures.push(createCampaignIssue('capture-diagnostic', message))
    }
    for (const failure of captureValidation?.invalidTargets ?? []) {
      failures.push(createCampaignIssue(failure.code, failure.message, failure.targetId))
    }
    for (const target of targets) {
      if (!invalidCaptureTargets.has(target.id)) continue
      for (const theme of THEMES) {
        const capture = captureByKey.get(`${target.id}\0${theme}`)
        if (capture?.status === 'failed' || capture?.image === null) {
          failures.push(createCampaignIssue(
            'capture-failure',
            typeof capture.error === 'string' && capture.error.length > 0
              ? capture.error
              : `Original capture failed for ${target.id}/${theme}.`,
            target.id,
            theme
          ))
        } else {
          failures.push(createCampaignIssue(
            'target-capture-incomplete',
            `The paired theme capture is incomplete; ${target.id} is not eligible for review.`,
            target.id,
            theme
          ))
        }
      }
    }
  } else {
    globalError = true
    failures.push(createCampaignIssue('capture-missing', 'Plugin campaign has no capture manifest.'))
  }

  const attemptsByKey = new Map<string, StagedAttempt[]>()
  const extraAttempts: PluginCampaignExtraAttempt[] = []
  const forcedInvalidCellKeys = new Set<string>()
  const seenAttemptIds = new Set<string>()
  for (const rawEntry of input.attempts as unknown[]) {
    if (!isRecord(rawEntry) || !isRecord(rawEntry.attempt)) {
      globalError = true
      failures.push(createCampaignIssue('invalid-sample', 'Campaign contains a malformed attempt record.'))
      continue
    }
    const targetId = typeof rawEntry.targetId === 'string' ? rawEntry.targetId : ''
    const theme = rawEntry.theme as CaptureTheme
    const slot = typeof rawEntry.slot === 'number' ? rawEntry.slot : 0
    const attempt = cloneAttempt(rawEntry.attempt)
    if (seenAttemptIds.has(attempt.id)) {
      addIssue(attempt, pluginIssue(
        'invalid-sample',
        'Attempt ID is duplicated within the campaign.',
        targetId,
        THEMES.includes(theme) ? theme : 'dark'
      ))
      forcedInvalidCellKeys.add(`${targetId}\0${theme}`)
    }
    seenAttemptIds.add(attempt.id)

    if (!targetById.has(targetId) || !THEMES.includes(theme) ||
      !Number.isInteger(slot) || slot < 1 || slot > 3) {
      extraAttempts.push({
        targetId,
        theme: THEMES.includes(theme) ? theme : 'dark',
        slot,
        attempt
      })
      failures.push(createCampaignIssue(
        'invalid-sample',
        `Attempt is foreign or uses an invalid sample slot (${slot}).`,
        targetId || undefined,
        THEMES.includes(theme) ? theme : undefined
      ))
      if (targetById.has(targetId) && THEMES.includes(theme)) forcedInvalidCellKeys.add(`${targetId}\0${theme}`)
      else globalError = true
      continue
    }
    const key = `${targetId}\0${theme}\0${slot}`
    const bucket = attemptsByKey.get(key) ?? []
    bucket.push({ targetId, theme, slot, attempt })
    attemptsByKey.set(key, bucket)
  }

  const cells: PluginCellOutcome[] = []
  let expectedReviewer = input.reviewer === null ? null : structuredClone(input.reviewer)
  for (const target of targets) {
    for (const theme of THEMES) {
      const cellKey = `${target.id}\0${theme}`
      const capture = captureByKey.get(cellKey)
      const captureInvalid = input.manifest === null || invalidCaptureTargets.has(target.id)
      let cellInvalid = captureInvalid
      let stopped = captureInvalid
      const slots: PluginSlotOutcome[] = []
      const cellScores: number[] = []

      for (const slot of [1, 2, 3] as const) {
        const bucketKey = `${cellKey}\0${slot}`
        const staged = attemptsByKey.get(bucketKey) ?? []
        const slotAttempts = staged.map(({ attempt }) => cloneAttempt(attempt))
        if (stopped) {
          if (slotAttempts.length > 0) {
            for (const attempt of slotAttempts) {
              addIssue(attempt, pluginIssue(
                'invalid-sample',
                'Review output arrived for a slot after this cell was no longer eligible.',
                target.id,
                theme
              ))
            }
          }
          slots.push({ slot, score: null, attempts: slotAttempts, status: 'skipped' })
          continue
        }
        if (slotAttempts.length === 0) {
          cellInvalid = true
          stopped = true
          slots.push({ slot, score: null, attempts: [], status: 'missing' })
          failures.push(createCampaignIssue(
            'missing-sample',
            `No valid review attempt was retained for slot ${slot}.`,
            target.id,
            theme
          ))
          continue
        }

        let sequenceValid = slotAttempts.length <= 2 && slotAttempts[0]!.retryOf === null
        if (slotAttempts.length === 2) {
          sequenceValid = sequenceValid &&
            slotAttempts[1]!.retryOf === slotAttempts[0]!.id &&
            retryableFailure(slotAttempts[0]!)
        }
        let validCandidate: ReviewedCapture | null = null
        let slotInvalid = !sequenceValid
        if (!sequenceValid) {
          addIssue(slotAttempts[slotAttempts.length - 1]!, pluginIssue(
            'invalid-sample',
            'Attempt sequence contains a duplicate or unauthorized replacement.',
            target.id,
            theme
          ))
        }

        for (let index = 0; index < slotAttempts.length; index++) {
          const attempt = slotAttempts[index]!
          if (!hasText(attempt.id, 256)) {
            slotInvalid = true
            addIssue(attempt, pluginIssue('invalid-sample', 'Attempt has no stable ID.', target.id, theme))
          }
          const inputIssues = Array.isArray(attempt.issues) ? attempt.issues : []
          for (const rawIssue of inputIssues as unknown[]) {
            const normalized = validIssue(rawIssue, target.id, theme)
            if (!normalized) {
              slotInvalid = true
              addIssue(attempt, pluginIssue('invalid-sample', 'Attempt contains an unknown or malformed issue.', target.id, theme))
              continue
            }
            failures.push(createCampaignIssue(normalized.code, normalized.message, target.id, theme))
            if (GLOBAL_ISSUE_CODES.includes(normalized.code)) globalError = true
            if (normalized.code === 'invalid-sample' || normalized.code === 'contract-conflict') slotInvalid = true
            if (normalized.code === 'operational' || normalized.code === 'response-shape') {
              if (attempt.sample !== null) slotInvalid = true
            }
          }

          if (attempt.sample === null) continue
          if (!validArtifactIdentity(attempt)) {
            slotInvalid = true
            globalError = true
            addIssue(attempt, pluginIssue(
              'persistence',
              'A returned sample has no persisted report path and SHA-256 identity.',
              target.id,
              theme
            ))
            failures.push(createCampaignIssue('persistence', 'A returned sample has no persisted report path and SHA-256 identity.', target.id, theme))
            continue
          }
          if (attempt.preflightIdentity !== undefined && attempt.preflightIdentity !== null) {
            const identity = attempt.preflightIdentity
            if (!isRecord(identity) || !hasText(identity.provider, 256) ||
              !hasText(identity.model, 512) || !MODEL_FAMILIES.includes(identity.family as ModelFamily) ||
              !isRecord(attempt.sample.reviewer) ||
              attempt.sample.reviewer.provider !== identity.provider ||
              attempt.sample.reviewer.model !== identity.model ||
              attempt.sample.reviewer.family !== identity.family) {
              slotInvalid = true
              globalError = true
              addIssue(attempt, pluginIssue(
                'identity-mismatch',
                'Reviewer preflight identity differs from the sample reviewer identity.',
                target.id,
                theme
              ))
            }
          }
          const sampleIssue = validatePluginSample(
            attempt.sample,
            capture!,
            target,
            input.authorFamily,
            expectedReviewer
          )
          if (sampleIssue) {
            addIssue(attempt, sampleIssue)
            failures.push(createCampaignIssue(sampleIssue.code, sampleIssue.message, target.id, theme))
            if (GLOBAL_ISSUE_CODES.includes(sampleIssue.code)) globalError = true
            slotInvalid = true
          } else if (inputIssues.length === 0 && sequenceValid && !slotInvalid) {
            if (validCandidate !== null) {
              slotInvalid = true
              addIssue(attempt, pluginIssue('invalid-sample', 'More than one valid sample was returned for a single slot.', target.id, theme))
            } else {
              validCandidate = attempt.sample
              if (expectedReviewer === null) expectedReviewer = structuredClone(attempt.sample.reviewer)
            }
          }
        }

        if (validCandidate !== null && !slotInvalid && sequenceValid) {
          slots.push({ slot, score: validCandidate.score, attempts: slotAttempts, status: 'valid' })
          cellScores.push(validCandidate.score)
        } else {
          cellInvalid = true
          stopped = true
          slots.push({ slot, score: null, attempts: slotAttempts, status: 'invalid' })
          if (!slotAttempts.some(({ issues }) => issues.some(({ code }) => code === 'contract-conflict' || code === 'invalid-sample'))) {
            failures.push(createCampaignIssue(
              'invalid-sample',
              `Slot ${slot} did not produce exactly one valid sample.`,
              target.id,
              theme
            ))
          }
        }
      }

      if (forcedInvalidCellKeys.has(cellKey)) cellInvalid = true
      const complete = cellScores.length === 3 && !cellInvalid
      const sorted = complete ? [...cellScores].sort((left, right) => left - right) : []
      const median = complete ? sorted[1]! : null
      const range = complete ? sorted[2]! - sorted[0]! : null
      const outcome: PluginCellOutcome['status'] = !complete
        ? 'invalid'
        : median! >= THRESHOLD ? 'pass' : 'fail'
      cells.push({
        targetId: target.id,
        plugin: target.plugin!,
        theme,
        slots: slots as PluginCellOutcome['slots'],
        median,
        range,
        status: outcome
      })
    }
  }

  const pluginResults = input.inventory.plugins.map(({ id }) => {
    const pluginCells = cells.filter((candidate) => candidate.plugin === id)
    const targetIds = targets.filter((target) => target.plugin === id).map(({ id: targetId }) => targetId)
    const status = targetIds.length === 0
      ? 'not-applicable' as const
      : pluginCells.some(({ status: cellStatus }) => cellStatus === 'invalid')
        ? 'invalid' as const
        : pluginCells.some(({ status: cellStatus }) => cellStatus === 'fail')
          ? 'fail' as const
          : 'pass' as const
    return { id, targetIds, status }
  })
  const counts: PluginCampaignCounts = {
    requiredCells: cells.length,
    completeValidCells: cells.filter(({ status }) => status !== 'invalid').length,
    passing: cells.filter(({ status }) => status === 'pass').length,
    belowThreshold: cells.filter(({ status }) => status === 'fail').length,
    invalid: cells.filter(({ status }) => status === 'invalid').length
  }
  const hasInvalid = cells.some(({ status }) => status === 'invalid')
  if (hasInvalid || counts.requiredCells === 0) globalError = true
  const status: PluginCampaignStatus = globalError
    ? 'error'
    : counts.belowThreshold > 0 ? 'failed' : 'passed'
  const computedContexts = targets.flatMap((target) => THEMES.map((theme) => expectedContext(target, theme)))
  const expectedContexts = input.expectedContexts
    ? structuredClone(input.expectedContexts)
    : computedContexts
  const report: PluginCampaignReport = {
    schemaVersion: 1,
    status,
    goalPassed: false,
    threshold: THRESHOLD,
    sampleCount: 3,
    source: { commit: input.inventory.commit, sourceDigest: input.inventory.sourceDigest },
    manifest: input.manifest === null
      ? null
      : input.manifestEvidence ? structuredClone(input.manifestEvidence) : null,
    authorFamily: input.authorFamily,
    reviewer: expectedReviewer,
    plugins: pluginResults,
    cells,
    counts,
    failures,
    extraAttempts,
    contributionInventory: structuredClone(input.inventory.contributionInventory!),
    activatedVisibilitySettings: structuredClone(
      input.activatedVisibilitySettings ?? input.manifest?.activatedVisibilitySettings ?? []
    ),
    captureEvidence: structuredClone(input.captureEvidence ?? input.manifest?.captures ?? []),
    ...(input.targetManifests === undefined ? {} : { targetManifests: structuredClone(input.targetManifests) }),
    expectedContexts,
    ...(input.timing === undefined ? {} : { timing: structuredClone(input.timing) })
  }
  return report
}

function safeMarkdown(value: unknown): string {
  const text = String(value)
    .replace(/(?:\/Users\/[^/\s]+|\/home\/[^/\s]+|~)\/[^\s]*/g, '[home path redacted]')
    .replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\|/g, '\\|')
    .replace(/`/g, '\\`')
    .replace(/\r\n?|\n/g, '<br>')
}

function artifactName(path: string | null): string {
  if (!path) return 'not persisted'
  return basename(path) || 'artifact'
}

function slotStatus(slot: PluginSlotOutcome): PluginSlotStatus {
  return slot.status ?? (slot.score !== null ? 'valid' : slot.attempts.length > 0 ? 'invalid' : 'missing')
}

function renderAttempt(lines: string[], targetId: string, theme: CaptureTheme, slot: PluginSlotOutcome, attempt: PluginAttempt): void {
  lines.push(
    `  - Slot ${slot.slot} attempt \`${safeMarkdown(attempt.id)}\` (retryOf: ${safeMarkdown(attempt.retryOf ?? 'none')}); ` +
    `report: ${safeMarkdown(artifactName(attempt.reportPath))}; SHA-256: \`${safeMarkdown(attempt.reportSha256 ?? 'missing')}\`.`
  )
  if (attempt.startedAt !== undefined || attempt.endedAt !== undefined) {
    lines.push(`    - Timing: start ${safeMarkdown(attempt.startedAt ?? 'unknown')} ms, end ${safeMarkdown(attempt.endedAt ?? 'unknown')} ms.`)
  }
  if (attempt.preflightIdentity) {
    lines.push(
      `    - Preflight identity: ${safeMarkdown(attempt.preflightIdentity.provider)}/` +
      `${safeMarkdown(attempt.preflightIdentity.model)} (${safeMarkdown(attempt.preflightIdentity.family)}).`
    )
  }
  for (const artifact of attempt.artifacts ?? []) {
    lines.push(`    - Artifact: ${safeMarkdown(artifactName(artifact.path))}; SHA-256: \`${safeMarkdown(artifact.sha256)}\`.`)
  }
  for (const issue of attempt.issues) {
    lines.push(`    - Issue ${safeMarkdown(issue.code)}: ${safeMarkdown(issue.message)}`)
  }
  const sample = attempt.sample
  if (!sample) return
  lines.push(`    - Raw sample score: ${safeMarkdown(sample.score)}; reviewer: ${safeMarkdown(sample.reviewer.alias)}/${safeMarkdown(sample.reviewer.model)}.`)
  lines.push(
    `    - Image SHA-256: \`${safeMarkdown(sample.image.sha256)}\`; reference SHA-256: ` +
    `\`${safeMarkdown(sample.reference.sha256)}\`; context SHA-256: ` +
    `\`${safeMarkdown(sample.contractReview?.contextSha256 ?? 'missing')}\`.`
  )
  for (const reason of sample.assessment.reasons) {
    lines.push(`    - Raw reason: ${safeMarkdown(reason)}`)
  }
  const audit = sample.contractReview?.audit
  if (audit) {
    lines.push(`    - Acknowledged contracts: ${safeMarkdown(audit.acknowledgedRuleIds.join(', ') || 'none')}.`)
    for (const check of audit.reasonChecks) {
      lines.push(
        `    - Audit reason ${safeMarkdown(check.reasonIndex)}: contracts ${safeMarkdown(check.contractIds.join(', ') || 'none')}; ` +
        `conflictsWithContract=${safeMarkdown(check.conflictsWithContract)}; affectsScore=${safeMarkdown(check.affectsScore)}.`
      )
    }
    for (const conflict of audit.conflicts) {
      lines.push(
        `    - Contract conflict ${safeMarkdown(conflict.contractId)}: ${safeMarkdown(conflict.reason)} ` +
        `(affectsScore=${safeMarkdown(conflict.affectsScore)}).`
      )
    }
  }
  void targetId
  void theme
}

export function renderPluginCampaign(report: PluginCampaignReport): string {
  const lines = [
    '# Plugin campaign',
    '',
    `Status: **${safeMarkdown(report.status)}**`,
    `Goal passed: **${safeMarkdown(report.goalPassed)}**`,
    `Threshold: ${safeMarkdown(report.threshold)}; samples per cell: ${safeMarkdown(report.sampleCount)}.`,
    `Required cells: ${safeMarkdown(report.counts.requiredCells)}; complete valid cells: ${safeMarkdown(report.counts.completeValidCells)}; ` +
      `passing: ${safeMarkdown(report.counts.passing)}; below 85: ${safeMarkdown(report.counts.belowThreshold)}; ` +
      `invalid: ${safeMarkdown(report.counts.invalid)}.`,
    `After: not measured (no product repair in this PR).`,
    '',
    '## Provenance',
    '',
    `Source commit: \`${safeMarkdown(report.source.commit)}\`; source digest: \`${safeMarkdown(report.source.sourceDigest)}\`.`,
    `Author family: ${safeMarkdown(report.authorFamily)}; reviewer: ${safeMarkdown(report.reviewer?.alias ?? 'unknown')} ` +
      `(${safeMarkdown(report.reviewer?.provider ?? 'unknown')}/${safeMarkdown(report.reviewer?.model ?? 'unknown')}, ` +
      `${safeMarkdown(report.reviewer?.family ?? 'unknown')}).`
  ]
  if (report.manifest) {
    lines.push(`Capture manifest: ${safeMarkdown(artifactName(report.manifest.path))}; SHA-256: \`${safeMarkdown(report.manifest.sha256)}\`.`)
  } else {
    lines.push('Capture manifest: unavailable.')
  }
  if (report.timing) {
    lines.push(
      `Timing: capture ${safeMarkdown(report.timing.captureMs)} ms; review ${safeMarkdown(report.timing.reviewMs)} ms; ` +
      `total ${safeMarkdown(report.timing.totalMs)} ms; concurrency ${safeMarkdown(report.timing.maxConcurrency)}/4; ` +
      `initial calls ${safeMarkdown(report.timing.initialReviewCalls)}; replacements ${safeMarkdown(report.timing.replacementReviewCalls)}.`
    )
  }

  lines.push('', '## Plugins', '', '| Plugin | Projected targets | Status |', '| --- | --- | --- |')
  for (const plugin of report.plugins) {
    lines.push(`| ${safeMarkdown(plugin.id)} | ${safeMarkdown(plugin.targetIds.join(', ') || 'none')} | ${safeMarkdown(plugin.status)} |`)
  }
  lines.push('', '## Navigation aliases', '')
  const aliases = report.contributionInventory?.toolAliases ?? []
  if (aliases.length === 0) lines.push('No navigation aliases.')
  for (const alias of aliases) {
    lines.push(
      `- ${safeMarkdown(alias.declaration.id)} → tool ${safeMarkdown(alias.toolId)} → ` +
      `${safeMarkdown(alias.renderedTarget.id)} (${safeMarkdown(alias.reason)}).`
    )
  }

  lines.push('', '## Capture evidence', '')
  if (!report.captureEvidence || report.captureEvidence.length === 0) {
    lines.push('No capture evidence was retained.')
  } else {
    for (const capture of report.captureEvidence) {
      lines.push(
        `- ${safeMarkdown(capture.targetId)}/${safeMarkdown(capture.theme)}: ${safeMarkdown(capture.status)}; ` +
        `image SHA-256 ${safeMarkdown(capture.image?.sha256 ?? 'missing')}; ` +
        `reference SHA-256 ${safeMarkdown(capture.reference?.sha256 ?? 'missing')}` +
        (capture.error ? `; ${safeMarkdown(capture.error)}` : '') + '.'
      )
    }
  }
  for (const targetManifest of report.targetManifests ?? []) {
    lines.push(
      `- Derived manifest ${safeMarkdown(targetManifest.targetId)}: ${safeMarkdown(artifactName(targetManifest.path))}; ` +
      `SHA-256 \`${safeMarkdown(targetManifest.sha256)}\`.`
    )
  }
  for (const context of report.expectedContexts ?? []) {
    lines.push(`- Trusted context ${safeMarkdown(context.targetId)}/${safeMarkdown(context.theme)}: SHA-256 \`${safeMarkdown(context.sha256)}\`.`)
  }

  lines.push('', '## Cells', '')
  for (const plugin of report.plugins) {
    const pluginCells = report.cells.filter((candidate) => candidate.plugin === plugin.id)
    if (pluginCells.length === 0) continue
    lines.push(`### ${safeMarkdown(plugin.id)}`, '')
    lines.push('| Target | Theme | Slot 1 | Slot 2 | Slot 3 | Median | Range | Status |')
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |')
    for (const cell of pluginCells) {
      const slots = cell.slots.map((slot) => {
        const status = slotStatus(slot)
        return slot.score === null
          ? `${status} (—)`
          : `${safeMarkdown(slot.score)} (${status})`
      })
      lines.push(
        `| ${safeMarkdown(cell.targetId)} | ${safeMarkdown(cell.theme)} | ${slots[0]} | ${slots[1]} | ${slots[2]} | ` +
        `${safeMarkdown(cell.median ?? 'null')} | ${safeMarkdown(cell.range ?? 'null')} | ${safeMarkdown(cell.status)} |`
      )
    }
    lines.push('')
    for (const cell of pluginCells) {
      for (const slot of cell.slots) {
        for (const attempt of slot.attempts) renderAttempt(lines, cell.targetId, cell.theme, slot, attempt)
      }
    }
  }

  if (report.extraAttempts.length > 0) {
    lines.push('', '## Unassigned attempts', '')
    for (const entry of report.extraAttempts) {
      lines.push(`- ${safeMarkdown(entry.targetId)}/${safeMarkdown(entry.theme)} slot ${safeMarkdown(entry.slot)}.`)
      const syntheticSlot: PluginSlotOutcome = {
        slot: 1,
        score: null,
        attempts: [entry.attempt],
        status: 'invalid'
      }
      renderAttempt(lines, entry.targetId, entry.theme, syntheticSlot, entry.attempt)
    }
  }
  lines.push('', '## Failures', '')
  if (report.failures.length === 0) lines.push('None.')
  for (const failure of report.failures) {
    const target = failure.targetId ? ` ${safeMarkdown(failure.targetId)}` : ''
    const theme = failure.theme ? `/${safeMarkdown(failure.theme)}` : ''
    lines.push(`- ${safeMarkdown(failure.code)}${target}${theme}: ${safeMarkdown(failure.message)}`)
  }
  return `${lines.join('\n')}\n`
}
