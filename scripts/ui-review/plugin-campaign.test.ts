import { createHash } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import type { UiModel, UiSlotEntry, UiToolEntry } from '@quirky/protocol'
import { projectCaptureInventory, scopeCaptureInventory } from './contribution-inventory'
import { hostContractContext, serializeContractContext } from './host-contracts'
import { SCORE_DIMENSIONS, THEMES, type CaptureEvidence, type CaptureManifest, type CaptureTarget, type CaptureTheme, type ContributionInventory, type ImageEvidence, type ModelFamily, type ReviewIssue, type ReviewerIdentity, type ReviewedCapture, type VisualAssessment } from './contracts'
import type { Inventory } from '../ui-scoreboard/contracts'
import {
  assertPluginInventory,
  renderPluginCampaign,
  summarizePluginCampaign,
  validatePluginCapture,
  validatePluginSample,
  type PluginAttempt,
  type PluginCampaignInput,
  type PluginCampaignReport,
  type PluginSampleSlot
} from './plugin-campaign'

const AUTHOR_FAMILY: ModelFamily = 'openai'
const REVIEWER: ReviewerIdentity = {
  alias: 'gemini',
  provider: 'google',
  model: 'fixture-vision',
  family: 'google'
}
const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
const HASH_C = 'c'.repeat(64)
const ROOT = '/repo'

type PluginTargetSpec = { id: string; kind: Exclude<CaptureTarget['kind'], 'host'> }
type InventoryFixture = { inventory: Inventory; pluginTargets: CaptureTarget[]; aliases: ContributionInventory['toolAliases'] }

function emptyModel(): UiModel {
  return {
    sidebarSections: [],
    statusBars: [],
    activityItems: [],
    panels: [],
    settingsSections: [],
    views: [],
    overlays: [],
    commands: [],
    keybindings: [],
    settings: [],
    menuItems: [],
    themes: [],
    theme: { chosen: 'default', active: 'default' },
    modules: {},
    tools: []
  } as UiModel
}

function ownerOf(id: string): string {
  const separator = id.indexOf(':')
  const slash = id.indexOf('/', separator + 1)
  if (separator < 0 || slash < 0) throw new Error(`Invalid fixture target ID: ${id}`)
  return id.slice(separator + 1, slash)
}

function addSlot(model: UiModel, { id, kind }: PluginTargetSpec): UiSlotEntry {
  const entry: UiSlotEntry = {
    id,
    kind: kind as UiSlotEntry['kind'],
    plugin: ownerOf(id),
    title: id,
    order: 0,
    module: `/plugins/${ownerOf(id)}/dist/ui.js`
  }
  switch (kind) {
    case 'sidebar-section': model.sidebarSections.push(entry); break
    case 'status-bar': model.statusBars.push(entry); break
    case 'activity-item': model.activityItems.push(entry); break
    case 'panel': model.panels.push(entry); break
    case 'view': model.views.push(entry); break
    case 'overlay': model.overlays.push(entry); break
    case 'settings-section': model.settingsSections.push(entry); break
  }
  return entry
}

function addNavigationAlias(model: UiModel, declarationId: string, bodyId: string): void {
  const tool: UiToolEntry = {
    id: declarationId,
    title: declarationId,
    icon: 'pulse',
    hue: 'slate',
    defaultSlot: 'left-top',
    contributionId: bodyId,
    aliases: [declarationId, bodyId]
  }
  model.tools!.push(tool)
}

function makeInventoryFixture(options: {
  targets?: PluginTargetSpec[]
  aliases?: Array<{ declarationId: string; bodyId: string }>
  noTargetPlugins?: string[]
} = {}): InventoryFixture {
  const targets = options.targets ?? [
    { id: 'view:acme.one/home', kind: 'view' },
    { id: 'panel:acme.two/settings', kind: 'panel' },
    { id: 'activity-item:acme.three/items', kind: 'activity-item' }
  ]
  const aliases = options.aliases ?? [
    { declarationId: 'sidebar-section:acme.one/navigation', bodyId: 'view:acme.one/home' },
    { declarationId: 'sidebar-section:acme.one/secondary', bodyId: 'view:acme.one/home' }
  ]
  const model = emptyModel()
  for (const target of targets) addSlot(model, target)
  for (const alias of aliases) {
    addSlot(model, { id: alias.declarationId, kind: 'sidebar-section' })
    addNavigationAlias(model, alias.declarationId, alias.bodyId)
  }
  const projection = projectCaptureInventory(model)
  const allPluginIds = new Set<string>()
  for (const target of projection.contributionInventory.declaredTargets) {
    if (target.plugin !== null) allPluginIds.add(target.plugin)
  }
  for (const plugin of options.noTargetPlugins ?? ['acme.empty']) allPluginIds.add(plugin)
  const plugins = [...allPluginIds].sort().map((id) => {
    const sourceTargets = projection.contributionInventory.declaredTargets
      .filter((target) => target.plugin === id)
      .map(({ id: targetId }) => targetId)
    return {
      id,
      directory: `plugins/${id}`,
      hasUi: sourceTargets.length > 0,
      targets: sourceTargets,
      sources: []
    }
  })
  const inventory: Inventory = {
    repoRoot: ROOT,
    commit: 'fixture-commit',
    sourceDigest: HASH_C,
    dirty: false,
    plugins,
    targets: projection.targets,
    contributionInventory: projection.contributionInventory,
    sharedSources: [],
    exclusions: [],
    failures: []
  }
  return {
    inventory,
    pluginTargets: inventory.targets.filter((target) => target.plugin !== null),
    aliases: projection.contributionInventory.toolAliases
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function image(path: string, hash = HASH_A): ImageEvidence {
  return { path, sha256: hash }
}

function captureEvidence(target: CaptureTarget, theme: CaptureTheme, options: {
  status?: CaptureEvidence['status']
  image?: ImageEvidence | null
  reference?: ImageEvidence
  error?: string
} = {}): CaptureEvidence {
  return {
    targetId: target.id,
    theme,
    image: options.image === undefined
      ? image(`/captures/${target.id}-${theme}.png`, theme === 'dark' ? HASH_A : HASH_B)
      : options.image,
    reference: options.reference ?? image(`/goldens/${target.id}-${theme}.png`, theme === 'dark' ? HASH_B : HASH_C),
    status: options.status ?? 'captured',
    ...(options.error === undefined ? {} : { error: options.error })
  }
}

function manifestFor(fixture: InventoryFixture, overrides: {
  captures?: CaptureEvidence[]
  targets?: CaptureTarget[]
  failures?: string[]
} = {}): CaptureManifest {
  const pluginTargets = overrides.targets ?? fixture.pluginTargets
  const pluginIds = [...new Set(pluginTargets.map(({ plugin }) => plugin).filter((plugin): plugin is string => plugin !== null))].sort()
  return {
    schemaVersion: 1,
    createdAt: '2026-11-16T00:00:00.000Z',
    commit: fixture.inventory.commit,
    surface: 'desktop-renderer',
    viewport: { width: 1400, height: 880 },
    scope: 'filtered',
    selectors: pluginIds,
    targets: pluginTargets,
    captures: overrides.captures ?? pluginTargets.flatMap((target) => THEMES.map((theme) => captureEvidence(target, theme))),
    failures: overrides.failures ?? [],
    contributionInventory: scopeCaptureInventory(fixture.inventory.contributionInventory!, pluginTargets)
  }
}

function reviewerSample(target: CaptureTarget, theme: CaptureTheme, score = 90, options: {
  capture?: CaptureEvidence
  identity?: ReviewerIdentity
  assessment?: Partial<VisualAssessment>
  contractReview?: ReviewedCapture['contractReview']
} = {}): ReviewedCapture {
  const sourceCapture = options.capture ?? captureEvidence(target, theme)
  const context = hostContractContext(target, theme)
  const contextSha256 = sha256(serializeContractContext(context))
  const assessment: VisualAssessment = {
    targetVisible: true,
    imagesRead: true,
    scores: Object.fromEntries(SCORE_DIMENSIONS.map((dimension) => [dimension, score])) as VisualAssessment['scores'],
    reasons: ['The named plugin contribution is visible.', 'The spacing and hierarchy are clear.'],
    ...options.assessment
  }
  const audit = {
    contextSha256,
    acknowledgedRuleIds: context.rules.map(({ id }) => id).sort(),
    reasonChecks: assessment.reasons.map((_, reasonIndex) => ({
      reasonIndex,
      contractIds: [],
      conflictsWithContract: false,
      affectsScore: false
    })),
    conflicts: []
  }
  return {
    targetId: target.id,
    theme,
    image: structuredClone(sourceCapture.image ?? image(`/captures/${target.id}-${theme}.png`)),
    reference: structuredClone(sourceCapture.reference),
    reviewer: options.identity ?? structuredClone(REVIEWER),
    assessment,
    score: SCORE_DIMENSIONS.reduce((sum, dimension) => sum + assessment.scores[dimension], 0) / SCORE_DIMENSIONS.length,
    passed: score >= 85,
    contractReview: options.contractReview ?? {
      contextPath: `/private/reviewer/${encodeURIComponent(target.id)}-${theme}.context.json`,
      contextSha256,
      audit
    }
  }
}

function attempt(id: string, sample: ReviewedCapture | null, options: {
  retryOf?: string | null
  issues?: ReviewIssue[]
  reportPath?: string | null
  reportSha256?: string | null
} = {}): PluginAttempt {
  return {
    id,
    retryOf: options.retryOf ?? null,
    reportPath: options.reportPath === undefined ? `/private/reports/${id}.json` : options.reportPath,
    reportSha256: options.reportSha256 === undefined ? sha256(`report:${id}`) : options.reportSha256,
    issues: options.issues ?? [],
    sample
  }
}

function campaignInput(fixture: InventoryFixture, options: Partial<PluginCampaignInput> = {}): PluginCampaignInput {
  return {
    inventory: fixture.inventory,
    manifest: options.manifest === undefined ? manifestFor(fixture) : options.manifest,
    authorFamily: options.authorFamily ?? AUTHOR_FAMILY,
    reviewer: options.reviewer === undefined ? REVIEWER : options.reviewer,
    attempts: options.attempts ?? [],
    failures: options.failures ?? [],
    ...(options.targetManifests === undefined ? {} : { targetManifests: options.targetManifests }),
    ...(options.expectedContexts === undefined ? {} : { expectedContexts: options.expectedContexts }),
    ...(options.timing === undefined ? {} : { timing: options.timing })
  }
}

function cell(report: PluginCampaignReport, targetId: string, theme: CaptureTheme) {
  const result = report.cells.find((candidate) => candidate.targetId === targetId && candidate.theme === theme)
  if (!result) throw new Error(`Missing campaign cell ${targetId}/${theme}`)
  return result
}

function validAttemptsFor(
  fixture: InventoryFixture,
  target: CaptureTarget,
  theme: CaptureTheme,
  scores: readonly number[],
  start = 1
): PluginCampaignInput['attempts'] {
  return scores.map((score, index) => {
    const slot = (index + start) as PluginSampleSlot
    return {
      targetId: target.id,
      theme,
      slot,
      attempt: attempt(`${target.id}-${theme}-${slot}`, reviewerSample(target, theme, score))
    }
  })
}

function issue(code: ReviewIssue['code'], targetId: string, theme: CaptureTheme, message: string): ReviewIssue {
  return { code, targetId, theme, message }
}

describe('plugin inventory projection and denominator', () => {
  test('uses exactly two cells per projected plugin target and discloses aliases and no-target plugins separately', () => {
    const fixture = makeInventoryFixture()
    const report = summarizePluginCampaign(campaignInput(fixture, { manifest: null }))
    const pluginTargetIds = fixture.inventory.targets
      .filter(({ plugin }) => plugin !== null)
      .map(({ id }) => id)

    expect(pluginTargetIds).toHaveLength(3)
    expect(fixture.inventory.targets.filter(({ kind }) => kind === 'host')).toHaveLength(5)
    expect(fixture.aliases).toHaveLength(2)
    expect(report.cells).toHaveLength(6)
    expect(new Set(report.cells.map(({ targetId }) => targetId))).toEqual(new Set(pluginTargetIds))
    expect(report.cells.every(({ theme }) => THEMES.includes(theme))).toBe(true)
    expect(report.plugins.find(({ id }) => id === 'acme.empty')).toEqual({
      id: 'acme.empty',
      targetIds: [],
      status: 'not-applicable'
    })
    expect(report.cells.some(({ plugin }) => plugin === 'acme.empty')).toBe(false)
    expect(report.contributionInventory?.toolAliases.map(({ declaration }) => declaration.id)).toEqual(
      fixture.aliases.map(({ declaration }) => declaration.id)
    )
  })

  test('adding one projected target adds exactly its two theme cells', () => {
    const initial = makeInventoryFixture()
    const expanded = makeInventoryFixture({
      targets: [
        { id: 'view:acme.one/home', kind: 'view' },
        { id: 'panel:acme.two/settings', kind: 'panel' },
        { id: 'activity-item:acme.three/items', kind: 'activity-item' },
        { id: 'overlay:acme.four/dialog', kind: 'overlay' }
      ],
      aliases: [
        { declarationId: 'sidebar-section:acme.one/navigation', bodyId: 'view:acme.one/home' },
        { declarationId: 'sidebar-section:acme.one/secondary', bodyId: 'view:acme.one/home' }
      ]
    })

    const initialReport = summarizePluginCampaign(campaignInput(initial, { manifest: null }))
    const expandedReport = summarizePluginCampaign(campaignInput(expanded, { manifest: null }))

    expect(initialReport.cells).toHaveLength(6)
    expect(expandedReport.cells).toHaveLength(8)
    expect(expandedReport.cells.length - initialReport.cells.length).toBe(2)
  })

  test('includes every projected plugin target kind while excluding all five host targets', () => {
    const kinds: PluginTargetSpec[] = [
      { id: 'panel:acme.kinds/panel', kind: 'panel' },
      { id: 'view:acme.kinds/view', kind: 'view' },
      { id: 'sidebar-section:acme.kinds/sidebar', kind: 'sidebar-section' },
      { id: 'activity-item:acme.kinds/activity', kind: 'activity-item' },
      { id: 'status-bar:acme.kinds/status', kind: 'status-bar' },
      { id: 'overlay:acme.kinds/overlay', kind: 'overlay' },
      { id: 'settings-section:acme.kinds/settings', kind: 'settings-section' }
    ]
    const fixture = makeInventoryFixture({ targets: kinds, aliases: [], noTargetPlugins: ['acme.empty'] })
    const report = summarizePluginCampaign(campaignInput(fixture, { manifest: null }))

    expect(new Set(fixture.pluginTargets.map(({ kind }) => kind))).toEqual(new Set(kinds.map(({ kind }) => kind)))
    expect(report.cells).toHaveLength(14)
    expect(report.cells.map(({ targetId }) => targetId)).not.toContain('host:shell')
    expect(report.cells.every(({ plugin }) => plugin === 'acme.kinds')).toBe(true)
  })

  test('reconciles source declarations and runtime targets by ID, owner, and kind but not title', () => {
    const fixture = makeInventoryFixture()
    expect(() => assertPluginInventory(fixture.inventory)).not.toThrow()
    const renamed = structuredClone(fixture.inventory)
    renamed.targets = renamed.targets.map((target) => ({ ...target, title: `Runtime title: ${target.title}` }))
    expect(() => assertPluginInventory(renamed)).not.toThrow()

    const missingTarget = structuredClone(fixture.inventory)
    missingTarget.targets = missingTarget.targets.filter((target) => target.id !== 'panel:acme.two/settings')
    expect(() => assertPluginInventory(missingTarget)).toThrow(/inventory-mismatch/i)

    const foreignTarget = structuredClone(fixture.inventory)
    foreignTarget.targets.push({
      id: 'view:outsider.foreign/extra',
      plugin: 'outsider.foreign',
      title: 'Foreign target',
      kind: 'view'
    })
    expect(() => assertPluginInventory(foreignTarget)).toThrow(/inventory-mismatch/i)

    const duplicateTarget = structuredClone(fixture.inventory)
    duplicateTarget.targets.push(structuredClone(duplicateTarget.targets[0]!))
    expect(() => assertPluginInventory(duplicateTarget)).toThrow(/inventory-mismatch/i)

    const changedOwner = structuredClone(fixture.inventory)
    const pluginTargetIndex = changedOwner.targets.findIndex(({ plugin }) => plugin !== null)
    changedOwner.targets[pluginTargetIndex] = { ...changedOwner.targets[pluginTargetIndex]!, plugin: 'acme.forged' }
    expect(() => assertPluginInventory(changedOwner)).toThrow(/inventory-mismatch/i)

    const changedKind = structuredClone(fixture.inventory)
    const pluginKindTargetIndex = changedKind.targets.findIndex(({ plugin }) => plugin !== null)
    const pluginKindTarget = changedKind.targets[pluginKindTargetIndex]!
    changedKind.targets[pluginKindTargetIndex] = {
      ...pluginKindTarget,
      kind: pluginKindTarget.kind === 'panel' ? 'view' : 'panel'
    }
    expect(() => assertPluginInventory(changedKind)).toThrow(/inventory-mismatch/i)
  })

  test('rejects dropped and forged navigation alias mappings rather than shrinking the denominator', () => {
    const fixture = makeInventoryFixture()
    const dropped = structuredClone(fixture.inventory)
    dropped.contributionInventory!.toolAliases.pop()
    expect(() => assertPluginInventory(dropped)).toThrow(/inventory-mismatch/i)

    const forged = structuredClone(fixture.inventory)
    forged.contributionInventory!.toolAliases[0]!.toolId = 'sidebar-section:acme.other/navigation'
    expect(() => assertPluginInventory(forged)).toThrow(/inventory-mismatch/i)
  })

  test('rejects an omitted capture theme as an inventory mismatch', () => {
    const fixture = makeInventoryFixture()
    const manifest = manifestFor(fixture)
    manifest.captures = manifest.captures.filter((capture) =>
      !(capture.targetId === 'panel:acme.two/settings' && capture.theme === 'light'))

    expect(() => validatePluginCapture(fixture.inventory, manifest)).toThrow(/inventory-mismatch/i)
    expect(() => assertPluginInventory(fixture.inventory)).not.toThrow()
  })
  test('rejects missing contribution metadata and source/runtime target-ID drift', () => {
    const fixture = makeInventoryFixture()
    const missingMetadata = structuredClone(fixture.inventory)
    delete missingMetadata.contributionInventory
    expect(() => assertPluginInventory(missingMetadata)).toThrow(/inventory-mismatch/i)

    const forgedSource = structuredClone(fixture.inventory)
    const sourceTarget = forgedSource.contributionInventory!.declaredTargets
      .find(({ id }) => id === 'panel:acme.two/settings')!
    sourceTarget.id = 'panel:acme.two/renamed'
    expect(() => assertPluginInventory(forgedSource)).toThrow(/inventory-mismatch/i)

    const empty = structuredClone(fixture.inventory)
    empty.plugins = []
    empty.targets = []
    empty.contributionInventory = { declaredTargets: [], toolAliases: [] }
    expect(() => assertPluginInventory(empty)).toThrow(/inventory-mismatch/i)
  })

})

describe('plugin sample validation', () => {
  const fixture = makeInventoryFixture()
  const target = fixture.pluginTargets.find(({ id }) => id === 'view:acme.one/home')!
  const capture = captureEvidence(target, 'dark')

  test('accepts one exact five-dimension mean with trusted context and an unpenalized conflict', () => {
    const original = reviewerSample(target, 'dark', 82.4, { capture })
    const context = hostContractContext(target, 'dark')
    const rule = context.rules[0]!
    original.contractReview!.audit.conflicts.push({
      contractId: rule.id,
      reason: 'The older shell reference differs from this approved contract.',
      affectsScore: false
    })

    const validated = validatePluginSample(original, capture, target, AUTHOR_FAMILY, REVIEWER)

    expect(validated).toBeNull()
    expect(original.score).toBe(82.4)
    for (const dimension of SCORE_DIMENSIONS) expect(original.assessment.scores[dimension]).toBe(82.4)
  })

  test('rejects a foreign target or theme as an invalid sample', () => {
    const foreignTarget = reviewerSample(target, 'dark', 90, { capture })
    foreignTarget.targetId = 'view:acme.foreign/other'
    expect(validatePluginSample(foreignTarget, capture, target, AUTHOR_FAMILY, REVIEWER)?.code).toBe('invalid-sample')

    const foreignTheme = reviewerSample(target, 'dark', 90, { capture })
    foreignTheme.theme = 'light'
    expect(validatePluginSample(foreignTheme, capture, target, AUTHOR_FAMILY, REVIEWER)?.code).toBe('invalid-sample')
  })

  test('classifies image and approved-reference hash mismatches as changed evidence', () => {
    const wrongImage = reviewerSample(target, 'dark', 90, { capture })
    wrongImage.image.sha256 = HASH_C
    expect(validatePluginSample(wrongImage, capture, target, AUTHOR_FAMILY, REVIEWER)?.code).toBe('evidence-changed')

    const wrongReference = reviewerSample(target, 'dark', 90, { capture })
    wrongReference.reference.sha256 = HASH_C
    expect(validatePluginSample(wrongReference, capture, target, AUTHOR_FAMILY, REVIEWER)?.code).toBe('evidence-changed')
  })

  test('classifies reviewer identity changes and author/reviewer family collisions as identity mismatches', () => {
    const wrongIdentity = reviewerSample(target, 'dark', 90, {
      capture,
      identity: { ...REVIEWER, model: 'different-model' }
    })
    expect(validatePluginSample(wrongIdentity, capture, target, AUTHOR_FAMILY, REVIEWER)?.code).toBe('identity-mismatch')

    const authorIdentity = reviewerSample(target, 'dark', 90, {
      capture,
      identity: { ...REVIEWER, family: AUTHOR_FAMILY }
    })
    expect(validatePluginSample(authorIdentity, capture, target, AUTHOR_FAMILY, null)?.code).toBe('identity-mismatch')
  })

  test('rejects invisible and unread targets even when dimensions are otherwise valid', () => {
    for (const assessment of [{ targetVisible: false }, { imagesRead: false }]) {
      const sample = reviewerSample(target, 'dark', 90, { capture, assessment })
      expect(validatePluginSample(sample, capture, target, AUTHOR_FAMILY, REVIEWER)?.code).toBe('invalid-sample')
    }
  })

  test('rejects missing, extra, nonfinite, and out-of-range score dimensions', () => {
    const malformedScores: Array<VisualAssessment['scores']> = [
      { palette: 90, typography: 90, spacing: 90, components: 90 } as VisualAssessment['scores'],
      { palette: 90, typography: 90, spacing: 90, components: 90, hierarchy: 90, extra: 90 } as VisualAssessment['scores'],
      { palette: Number.NaN, typography: 90, spacing: 90, components: 90, hierarchy: 90 },
      { palette: Number.POSITIVE_INFINITY, typography: 90, spacing: 90, components: 90, hierarchy: 90 },
      { palette: -0.01, typography: 90, spacing: 90, components: 90, hierarchy: 90 },
      { palette: 100.01, typography: 90, spacing: 90, components: 90, hierarchy: 90 }
    ]
    for (const scores of malformedScores) {
      const sample = reviewerSample(target, 'dark', 90, { capture, assessment: { scores } })
      expect(validatePluginSample(sample, capture, target, AUTHOR_FAMILY, REVIEWER)?.code).toBe('invalid-sample')
    }
  })

  test('rejects a submitted score that is not the exact arithmetic mean of unchanged dimensions', () => {
    const sample = reviewerSample(target, 'dark', 90, { capture })
    sample.assessment.scores = { palette: 80, typography: 90, spacing: 90, components: 90, hierarchy: 90 }
    sample.score = 90
    sample.passed = true

    expect(validatePluginSample(sample, capture, target, AUTHOR_FAMILY, REVIEWER)?.code).toBe('invalid-sample')
  })

  test('classifies missing context metadata as response-shape and changed trusted-context digests as evidence changes', () => {
    const missing = reviewerSample(target, 'dark', 90, { capture })
    delete missing.contractReview
    expect(validatePluginSample(missing, capture, target, AUTHOR_FAMILY, REVIEWER)?.code).toBe('response-shape')

    const changedContext = reviewerSample(target, 'dark', 90, { capture })
    changedContext.contractReview!.contextSha256 = HASH_C
    changedContext.contractReview!.audit.contextSha256 = HASH_C
    expect(validatePluginSample(changedContext, capture, target, AUTHOR_FAMILY, REVIEWER)?.code).toBe('evidence-changed')
  })

  test('rejects a g3-68 review context after the trusted contract changes', () => {
    const legacyTarget = { ...target, id: 'view:quirky.accounts/session-accessory' }
    const legacyCapture = captureEvidence(legacyTarget, 'dark')
    const sample = reviewerSample(legacyTarget, 'dark', 90, { capture: legacyCapture })

    expect(validatePluginSample(sample, legacyCapture, legacyTarget, AUTHOR_FAMILY, REVIEWER)).toBeNull()

    const legacyDigest = 'a42800e1234e171fcf18cf045ea18eaa208d2f102fa46cb2626950aa58a969cf'
    sample.contractReview!.contextSha256 = legacyDigest
    sample.contractReview!.audit.contextSha256 = legacyDigest
    expect(validatePluginSample(sample, legacyCapture, legacyTarget, AUTHOR_FAMILY, REVIEWER)?.code).toBe('evidence-changed')
  })

  test('rejects malformed trusted-context audits and undeclared contract IDs', () => {
    const missingAcknowledgment = reviewerSample(target, 'dark', 90, { capture })
    missingAcknowledgment.contractReview!.audit.acknowledgedRuleIds.pop()
    expect(validatePluginSample(missingAcknowledgment, capture, target, AUTHOR_FAMILY, REVIEWER)?.code).toBe('response-shape')

    const malformedReasonIndex = reviewerSample(target, 'dark', 90, { capture })
    malformedReasonIndex.contractReview!.audit.reasonChecks[0]!.reasonIndex = 4
    expect(validatePluginSample(malformedReasonIndex, capture, target, AUTHOR_FAMILY, REVIEWER)?.code).toBe('response-shape')

    const unknownContract = reviewerSample(target, 'dark', 90, { capture })
    unknownContract.contractReview!.audit.conflicts.push({
      contractId: 'not-a-trusted-rule',
      reason: 'Forged conflict reference.',
      affectsScore: false
    })
    expect(validatePluginSample(unknownContract, capture, target, AUTHOR_FAMILY, REVIEWER)?.code).toBe('response-shape')
  })

  test('invalidates a declared score-affecting contract contradiction without discarding its raw score', () => {
    const sample = reviewerSample(target, 'dark', 100, { capture })
    const rule = hostContractContext(target, 'dark').rules[0]!
    sample.contractReview!.audit.reasonChecks[0] = {
      reasonIndex: 0,
      contractIds: [rule.id],
      conflictsWithContract: true,
      affectsScore: true
    }
    sample.contractReview!.audit.conflicts.push({
      contractId: rule.id,
      reason: 'Requested a prohibited token change.',
      affectsScore: true
    })

    expect(validatePluginSample(sample, capture, target, AUTHOR_FAMILY, REVIEWER)?.code).toBe('contract-conflict')
    expect(sample.score).toBe(100)
    expect(sample.contractReview!.audit.conflicts[0]?.reason).toBe('Requested a prohibited token change.')
  })
})

describe('plugin campaign reduction and reporting', () => {
  function oneTargetFixture(): InventoryFixture {
    return makeInventoryFixture({
      targets: [{ id: 'view:acme.one/home', kind: 'view' }],
      aliases: [],
      noTargetPlugins: ['acme.empty']
    })
  }

  test('uses the unrounded middle per-image score and the absolute threshold independently per theme', () => {
    const fixture = oneTargetFixture()
    const target = fixture.pluginTargets[0]!
    const cases = [
      { theme: 'dark' as const, scores: [84, 85, 86], median: 85, range: 2, status: 'pass' as const },
      { theme: 'light' as const, scores: [84, 84, 100], median: 84, range: 16, status: 'fail' as const }
    ]
    const attempts = cases.flatMap(({ theme, scores }) => validAttemptsFor(fixture, target, theme, scores))
    const report = summarizePluginCampaign(campaignInput(fixture, { attempts }))

    for (const expected of cases) {
      const outcome = cell(report, target.id, expected.theme)
      expect(outcome.slots.map(({ score }) => score)).toEqual(expected.scores)
      expect(outcome.median).toBe(expected.median)
      expect(outcome.range).toBe(expected.range)
      expect(outcome.status).toBe(expected.status)
    }
    expect(report.plugins.find(({ id }) => id === 'acme.one')?.status).toBe('fail')
    expect(report.status).toBe('failed')
    expect(report.goalPassed).toBe(false)
  })

  test('does not round 84.999 up to the 85 threshold', () => {
    const fixture = oneTargetFixture()
    const target = fixture.pluginTargets[0]!
    const attempts = [
      ...validAttemptsFor(fixture, target, 'dark', [84.999, 84.999, 100]),
      ...validAttemptsFor(fixture, target, 'light', [85, 85, 85])
    ]
    const report = summarizePluginCampaign(campaignInput(fixture, { attempts }))

    expect(cell(report, target.id, 'dark').median).toBe(84.999)
    expect(cell(report, target.id, 'dark').status).toBe('fail')
    expect(cell(report, target.id, 'light').median).toBe(85)
  })

  test('leaves a cell with fewer than three valid slots incomplete with a null median and range', () => {
    const fixture = oneTargetFixture()
    const target = fixture.pluginTargets[0]!
    const attempts = [
      ...validAttemptsFor(fixture, target, 'dark', [90, 91]),
      ...validAttemptsFor(fixture, target, 'light', [90, 90, 90])
    ]
    const report = summarizePluginCampaign(campaignInput(fixture, { attempts }))

    expect(cell(report, target.id, 'dark').slots.map(({ score }) => score)).toEqual([90, 91, null])
    expect(cell(report, target.id, 'dark').median).toBeNull()
    expect(cell(report, target.id, 'dark').range).toBeNull()
    expect(cell(report, target.id, 'dark').status).toBe('invalid')
    expect(report.status).toBe('error')
  })

  const reducerValidationCases: Array<{
    name: string
    code: ReviewIssue['code']
    mutate: (sample: ReviewedCapture, target: CaptureTarget) => void
  }> = [
    {
      name: 'a changed image hash',
      code: 'evidence-changed',
      mutate: (sample) => { sample.image.sha256 = HASH_C }
    },
    {
      name: 'an invisible target',
      code: 'invalid-sample',
      mutate: (sample) => { sample.assessment.targetVisible = false }
    },
    {
      name: 'a penalized known contract conflict',
      code: 'contract-conflict',
      mutate: (sample, target) => {
        const rule = hostContractContext(target, 'dark').rules[0]!
        sample.contractReview!.audit.reasonChecks[0] = {
          reasonIndex: 0,
          contractIds: [rule.id],
          conflictsWithContract: true,
          affectsScore: true
        }
        sample.contractReview!.audit.conflicts.push({
          contractId: rule.id,
          reason: 'Requested a prohibited plugin token change.',
          affectsScore: true
        })
      }
    }
  ]
  for (const scenario of reducerValidationCases) {
    test(`revalidates ${scenario.name} inside the reducer without caller issues`, () => {
      const fixture = makeInventoryFixture({
        targets: [
          { id: 'view:acme.one/home', kind: 'view' },
          { id: 'panel:acme.one/settings', kind: 'panel' }
        ],
        aliases: [],
        noTargetPlugins: []
      })
      const [target, sibling] = fixture.pluginTargets
      const affectedAttempts = validAttemptsFor(fixture, target!, 'dark', [90, 91, 92])
      const siblingAttempts = validAttemptsFor(fixture, sibling!, 'dark', [87, 88, 89])
      scenario.mutate(affectedAttempts[1]!.attempt.sample!, target!)
      const attempts = [...affectedAttempts, ...siblingAttempts]
      expect(attempts.every(({ attempt }) => attempt.issues.length === 0)).toBe(true)

      const report = summarizePluginCampaign(campaignInput(fixture, { attempts }))

      expect(cell(report, target!.id, 'dark')).toMatchObject({ median: null, status: 'invalid' })
      expect(report.failures).toContainEqual(expect.objectContaining({
        code: scenario.code,
        targetId: target!.id,
        theme: 'dark'
      }))
      expect(cell(report, sibling!.id, 'dark')).toMatchObject({ median: 88, range: 2, status: 'pass' })
    })
  }

  test('does not certify duplicate slot samples alongside otherwise complete triples', () => {
    const fixture = oneTargetFixture()
    const target = fixture.pluginTargets[0]!
    const dark = validAttemptsFor(fixture, target, 'dark', [90, 91, 92])
    const attempts = [
      ...dark,
      ...validAttemptsFor(fixture, target, 'light', [85, 85, 85]),
      {
        targetId: target.id,
        theme: 'dark' as const,
        slot: 2 as PluginSampleSlot,
        attempt: attempt('duplicate-slot-two', reviewerSample(target, 'dark', 100), {
          retryOf: dark[1]!.attempt.id
        })
      }
    ]
    const report = summarizePluginCampaign(campaignInput(fixture, { attempts }))

    expect(cell(report, target.id, 'dark')).toMatchObject({ median: null, status: 'invalid' })
    expect(cell(report, target.id, 'light')).toMatchObject({ median: 85, status: 'pass' })
    expect(report.failures).toContainEqual(expect.objectContaining({
      code: 'invalid-sample',
      targetId: target.id,
      theme: 'dark'
    }))
    expect(report.status).toBe('error')
  })

  test('does not certify a foreign sample inside an otherwise complete triple', () => {
    const fixture = oneTargetFixture()
    const target = fixture.pluginTargets[0]!
    const dark = validAttemptsFor(fixture, target, 'dark', [90, 91, 92])
    dark[1]!.attempt.sample!.targetId = 'view:acme.foreign/other'
    const attempts = [
      ...dark,
      ...validAttemptsFor(fixture, target, 'light', [90, 90, 90])
    ]
    const report = summarizePluginCampaign(campaignInput(fixture, { attempts }))

    expect(cell(report, target.id, 'dark')).toMatchObject({ median: null, status: 'invalid' })
    expect(cell(report, target.id, 'light')).toMatchObject({ median: 90, status: 'pass' })
    expect(report.failures).toContainEqual(expect.objectContaining({
      code: 'invalid-sample',
      targetId: target.id,
      theme: 'dark'
    }))
    expect(report.status).toBe('error')
  })

  test('retains and rejects a fourth valid result after an otherwise complete triple', () => {
    const fixture = oneTargetFixture()
    const target = fixture.pluginTargets[0]!
    const fourthSlot = {
      targetId: target.id,
      theme: 'dark' as const,
      slot: 4 as PluginSampleSlot,
      attempt: attempt('fourth-valid-slot', reviewerSample(target, 'dark', 100))
    }
    const report = summarizePluginCampaign(campaignInput(fixture, {
      attempts: [
        ...validAttemptsFor(fixture, target, 'dark', [90, 91, 92]),
        ...validAttemptsFor(fixture, target, 'light', [90, 90, 90]),
        fourthSlot
      ]
    }))

    expect(cell(report, target.id, 'dark')).toMatchObject({ median: null, status: 'invalid' })
    expect(cell(report, target.id, 'light')).toMatchObject({ median: 90, status: 'pass' })
    expect(report.extraAttempts).toContainEqual(expect.objectContaining({
      targetId: target.id,
      theme: 'dark',
      slot: 4,
      attempt: expect.objectContaining({ id: 'fourth-valid-slot', sample: expect.objectContaining({ score: 100 }) })
    }))
    expect(report.status).toBe('error')
  })


  test('retains the exact six-cell capture/conflict table while continuing independent cells', () => {
    const fixture = makeInventoryFixture({
      targets: [
        { id: 'view:plugin-a/target-a', kind: 'view' },
        { id: 'panel:plugin-b/target-b', kind: 'panel' },
        { id: 'activity-item:plugin-c/target-c', kind: 'activity-item' }
      ],
      aliases: [],
      noTargetPlugins: []
    })
    const [targetA, targetB, targetC] = fixture.pluginTargets
    const sourceManifest = manifestFor(fixture)
    const captures = sourceManifest.captures.map((item) =>
      item.targetId === targetA!.id && item.theme === 'light'
        ? { ...item, image: null, status: 'failed' as const, error: 'original capture error' }
        : item)
    const manifest = manifestFor(fixture, { captures, failures: ['original capture error'] })
    const bDarkTarget = targetB!
    const conflicting = reviewerSample(bDarkTarget, 'dark', 100, {
      capture: manifest.captures.find((item) => item.targetId === bDarkTarget.id && item.theme === 'dark')
    })
    const conflictingRule = hostContractContext(bDarkTarget, 'dark').rules[0]!
    conflicting.contractReview!.audit.reasonChecks[0] = {
      reasonIndex: 0,
      contractIds: [conflictingRule.id],
      conflictsWithContract: true,
      affectsScore: true
    }
    conflicting.contractReview!.audit.conflicts.push({
      contractId: conflictingRule.id,
      reason: 'Raw 100 response contradicts the approved contract.',
      affectsScore: true
    })
    const conflictIssue = issue('contract-conflict', bDarkTarget.id, 'dark', 'Declared score-affecting contract conflict.')
    const attempts: PluginCampaignInput['attempts'] = [
      { targetId: bDarkTarget.id, theme: 'dark', slot: 1, attempt: attempt('b-dark-1', reviewerSample(bDarkTarget, 'dark', 90)) },
      { targetId: bDarkTarget.id, theme: 'dark', slot: 2, attempt: attempt('b-dark-2', conflicting, { issues: [conflictIssue] }) },
      ...validAttemptsFor(fixture, bDarkTarget, 'light', [85, 85, 85]),
      ...validAttemptsFor(fixture, targetC!, 'dark', [84, 84, 84]),
      ...validAttemptsFor(fixture, targetC!, 'light', [86, 86, 86])
    ]
    const report = summarizePluginCampaign(campaignInput(fixture, { manifest, attempts }))

    expect(report.cells).toHaveLength(6)
    expect(report.cells.map(({ targetId, theme }) => `${targetId}/${theme}`)).toEqual([
      'view:plugin-a/target-a/dark', 'view:plugin-a/target-a/light',
      'panel:plugin-b/target-b/dark', 'panel:plugin-b/target-b/light',
      'activity-item:plugin-c/target-c/dark', 'activity-item:plugin-c/target-c/light'
    ])
    expect(cell(report, targetA!.id, 'dark')).toMatchObject({ median: null, range: null, status: 'invalid' })
    expect(cell(report, targetA!.id, 'light')).toMatchObject({ median: null, range: null, status: 'invalid' })
    expect(cell(report, bDarkTarget.id, 'dark')).toMatchObject({ median: null, range: null, status: 'invalid' })
    expect(cell(report, bDarkTarget.id, 'dark').slots.map(({ score }) => score)).toEqual([90, null, null])
    expect(cell(report, bDarkTarget.id, 'dark').slots[1]!.attempts[0]!.sample?.score).toBe(100)
    expect(cell(report, bDarkTarget.id, 'dark').slots[1]!.attempts[0]!.issues).toContainEqual(conflictIssue)
    expect(cell(report, bDarkTarget.id, 'light')).toMatchObject({ median: 85, range: 0, status: 'pass' })
    expect(cell(report, targetC!.id, 'dark')).toMatchObject({ median: 84, range: 0, status: 'fail' })
    expect(cell(report, targetC!.id, 'light')).toMatchObject({ median: 86, range: 0, status: 'pass' })
    expect(cell(report, targetA!.id, 'dark').slots.every(({ attempts }) => attempts.length === 0)).toBe(true)
    expect(cell(report, targetA!.id, 'light').slots.every(({ attempts }) => attempts.length === 0)).toBe(true)
    expect(cell(report, bDarkTarget.id, 'dark').slots[2]!.attempts).toEqual([])
    expect(report.plugins).toEqual([
      { id: 'plugin-a', targetIds: [targetA!.id], status: 'invalid' },
      { id: 'plugin-b', targetIds: [bDarkTarget.id], status: 'invalid' },
      { id: 'plugin-c', targetIds: [targetC!.id], status: 'fail' }
    ])
    expect(report.status).toBe('error')
    expect(report.goalPassed).toBe(false)
    expect(report.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'capture-failure',
        targetId: targetA!.id,
        theme: 'light',
        message: 'original capture error'
      }),
      expect.objectContaining({
        code: 'target-capture-incomplete',
        targetId: targetA!.id,
        theme: 'dark',
        message: `The paired theme capture is incomplete; ${targetA!.id} is not eligible for review.`
      }),
      expect.objectContaining({ code: 'contract-conflict', targetId: bDarkTarget.id, theme: 'dark' })
    ]))

    expect(report.counts).toEqual({
      requiredCells: 6,
      completeValidCells: 3,
      passing: 2,
      belowThreshold: 1,
      invalid: 3
    })
    expect(cell(report, bDarkTarget.id, 'dark').slots.map(({ status }) => status)).toEqual([
      'valid', 'invalid', 'skipped'
    ])
    const markdown = renderPluginCampaign(report)
    expect(markdown).toContain('skipped')
    expect(markdown).toContain('Raw 100 response contradicts the approved contract.')
  })

  test('renders all plugin cell rows contiguously before attempt details', () => {
    const fixture = makeInventoryFixture({
      targets: [
        { id: 'view:acme.one/home', kind: 'view' },
        { id: 'panel:acme.one/settings', kind: 'panel' }
      ],
      aliases: [],
      noTargetPlugins: []
    })
    const [targetA, targetB] = fixture.pluginTargets
    const attempts = [
      ...validAttemptsFor(fixture, targetA!, 'dark', [80, 82, 84]),
      ...validAttemptsFor(fixture, targetA!, 'light', [90, 92, 94]),
      ...validAttemptsFor(fixture, targetB!, 'dark', [70, 75, 80]),
      ...validAttemptsFor(fixture, targetB!, 'light', [85, 87, 89])
    ]
    const report = summarizePluginCampaign(campaignInput(fixture, { attempts }))
    const markdown = renderPluginCampaign(report)
    const lines = markdown.split('\n')
    const pluginHeading = lines.indexOf('### acme.one')
    const nextHeadingOffset = lines.slice(pluginHeading + 1).findIndex((line) => /^##+ /.test(line))
    const pluginSection = lines.slice(
      pluginHeading,
      nextHeadingOffset < 0 ? undefined : pluginHeading + 1 + nextHeadingOffset
    )
    const header = '| Target | Theme | Slot 1 | Slot 2 | Slot 3 | Median | Range | Status |'
    expect(report.cells).toHaveLength(4)
    const separator = '| --- | --- | --- | --- | --- | --- | --- | --- |'
    const expectedRowsByCell = new Map<string, string>([
      [`${targetA!.id}/dark`, `| ${targetA!.id} | dark | 80 (valid) | 82 (valid) | 84 (valid) | 82 | 4 | fail |`],
      [`${targetA!.id}/light`, `| ${targetA!.id} | light | 90 (valid) | 92 (valid) | 94 (valid) | 92 | 4 | pass |`],
      [`${targetB!.id}/dark`, `| ${targetB!.id} | dark | 70 (valid) | 75 (valid) | 80 (valid) | 75 | 10 | fail |`],
      [`${targetB!.id}/light`, `| ${targetB!.id} | light | 85 (valid) | 87 (valid) | 89 (valid) | 87 | 4 | pass |`]
    ])
    const expectedRows = report.cells.map(({ targetId, theme }) => {
      const row = expectedRowsByCell.get(`${targetId}/${theme}`)
      if (!row) throw new Error(`Unexpected cell in renderer fixture: ${targetId}/${theme}`)
      return row
    })
    const headerIndex = pluginSection.indexOf(header)
    const firstAttemptDetailIndex = pluginSection.findIndex((line) =>
      line.startsWith('  - Slot ') || line.startsWith('    - '))

    expect(headerIndex).toBeGreaterThanOrEqual(0)
    expect(pluginSection.slice(headerIndex, headerIndex + expectedRows.length + 2))
      .toEqual([header, separator, ...expectedRows])
    expect(firstAttemptDetailIndex).toBeGreaterThan(headerIndex + expectedRows.length + 1)
    expect(markdown).toContain('After: not measured (no product repair in this PR).')
  })

  test('serializes complete reasons, contexts, statuses, counts, and failed raw attempts in JSON and Markdown', () => {
    const fixture = makeInventoryFixture({
      targets: [{ id: 'view:acme.one/home', kind: 'view' }],
      noTargetPlugins: ['acme.empty']
    })
    const target = fixture.pluginTargets[0]!
    const first = reviewerSample(target, 'dark', 84.999)
    first.assessment.reasons = [
      'Unchanged raw reason: the row baseline is below the approved spacing | tokens.',
      'Unchanged raw reason: the supporting label wraps at capture width.\n| injected | pass |'
    ]
    first.contractReview!.audit.reasonChecks = first.assessment.reasons.map((_, reasonIndex) => ({
      reasonIndex,
      contractIds: [],
      conflictsWithContract: false,
      affectsScore: false
    }))
    const conflict = reviewerSample(target, 'dark', 100)
    const rule = hostContractContext(target, 'dark').rules[0]!
    conflict.contractReview!.audit.reasonChecks[0] = {
      reasonIndex: 0,
      contractIds: [rule.id],
      conflictsWithContract: true,
      affectsScore: true
    }
    conflict.contractReview!.audit.conflicts.push({
      contractId: rule.id,
      reason: 'Unchanged raw conflict reason: requests a forbidden host token change.',
      affectsScore: true
    })
    const conflictIssue = issue('contract-conflict', target.id, 'dark', 'Score-affecting conflict was retained.')
    const attempts: PluginCampaignInput['attempts'] = [
      { targetId: target.id, theme: 'dark', slot: 1, attempt: attempt('raw-first', first) },
      { targetId: target.id, theme: 'dark', slot: 2, attempt: attempt('raw-conflict', conflict, { issues: [conflictIssue] }) },
      ...validAttemptsFor(fixture, target, 'light', [90, 90, 90])
    ]
    const rawAttempt = attempts[0]!.attempt
    rawAttempt.reportPath = '/Users/private/.quirky/reports/raw-first.json'
    rawAttempt.startedAt = 1_000
    rawAttempt.endedAt = 1_250
    rawAttempt.preflightIdentity = { provider: 'google', model: 'fixture-vision', family: 'google' }
    rawAttempt.artifacts = [{ path: '/Users/private/.quirky/reports/stdout.txt', sha256: HASH_B }]
    const report = summarizePluginCampaign(campaignInput(fixture, {
      attempts,
      failures: [{ code: 'capture-note', message: 'Unchanged original capture failure reason.' }],
      targetManifests: [{ targetId: target.id, path: '/Users/private/.quirky/target.json', sha256: HASH_A }],
      expectedContexts: [{ targetId: target.id, theme: 'dark', sha256: first.contractReview!.contextSha256 }],
      timing: {
        concurrency: 4,
        captureMs: 10,
        reviewMs: 20,
        totalMs: 30,
        initialReviewCalls: 5,
        replacementReviewCalls: 0,
        maxConcurrency: 4
      }
    }))
    const json = JSON.parse(JSON.stringify(report)) as PluginCampaignReport
    const markdown = renderPluginCampaign(report)

    expect(json.goalPassed).toBe(false)
    expect(json.plugins.find(({ id }) => id === 'acme.empty')?.status).toBe('not-applicable')
    expect(json.cells).toHaveLength(2)
    expect(json.cells[0]!.slots[0]!.attempts.map(({ id }) => id)).toContain('raw-first')
    expect(json.cells[0]!.slots[1]!.attempts[0]!.sample?.score).toBe(100)
    expect(json.cells[0]!.slots[1]!.attempts[0]!.issues).toContainEqual(conflictIssue)
    expect(json.cells[0]!.slots[0]!.attempts[0]!.sample?.assessment.reasons).toEqual(first.assessment.reasons)
    expect(json.cells[0]!.slots[1]!.attempts[0]!.sample?.contractReview?.audit.conflicts[0]?.reason)
      .toBe('Unchanged raw conflict reason: requests a forbidden host token change.')
    expect(json.failures).toContainEqual(expect.objectContaining({ message: 'Unchanged original capture failure reason.' }))
    expect(json.targetManifests).toEqual([{ targetId: target.id, path: '/Users/private/.quirky/target.json', sha256: HASH_A }])
    expect(json.expectedContexts).toEqual([{ targetId: target.id, theme: 'dark', sha256: first.contractReview!.contextSha256 }])
    expect(json.counts).toEqual({
      requiredCells: 2,
      completeValidCells: 1,
      passing: 1,
      belowThreshold: 0,
      invalid: 1
    })
    expect(json.cells[0]!.slots.map(({ score }) => score)).toEqual([84.999, null, null])
    expect(json.cells[1]!.slots.map(({ score }) => score)).toEqual([90, 90, 90])
    expect(json.cells[0]!.slots[0]!.attempts[0]).toMatchObject({
      reportPath: '/Users/private/.quirky/reports/raw-first.json',
      startedAt: 1_000,
      endedAt: 1_250,
      preflightIdentity: { provider: 'google', model: 'fixture-vision', family: 'google' },
      artifacts: [{ path: '/Users/private/.quirky/reports/stdout.txt', sha256: HASH_B }]
    })
    expect(json.targetManifests).toEqual([{ targetId: target.id, path: '/Users/private/.quirky/target.json', sha256: HASH_A }])
    expect(json.contributionInventory?.toolAliases.map(({ declaration }) => declaration.id)).toEqual(
      fixture.aliases.map(({ declaration }) => declaration.id)
    )
    expect(markdown).toContain('sidebar-section:acme.one/navigation')
    expect(markdown).toContain('sidebar-section:acme.one/secondary')
    expect(markdown).toMatch(/required cells: 2/i)
    expect(markdown).toContain('complete valid cells: 1')
    expect(markdown).toContain('passing: 1')
    expect(markdown).toContain('below 85: 0')
    expect(markdown).toContain('invalid: 1')
    expect(markdown).toContain('Unchanged raw reason: the row baseline is below the approved spacing \\| tokens.')
    expect(markdown).not.toContain('\n| injected | pass |')
    expect(markdown).toContain(HASH_B)
    expect(markdown).not.toContain('/Users/private')
    expect(markdown).toContain('acme.one')
    expect(markdown).toContain('acme.empty')
    expect(markdown).toContain('not-applicable')
    expect(markdown).toContain('dark')
    expect(markdown).toContain('light')
    expect(markdown).toContain('raw-first')
    expect(markdown).toContain('raw-conflict')
    expect(markdown).toContain('Unchanged raw reason: the row baseline is below the approved spacing \\| tokens.')
    expect(markdown).toContain('Unchanged raw reason: the supporting label wraps at capture width.')
    expect(markdown).toContain('Unchanged raw conflict reason: requests a forbidden host token change.')
    expect(markdown).toContain('Unchanged original capture failure reason.')
    expect(markdown).not.toMatch(/goal.*passed.*true/i)
  })
})
