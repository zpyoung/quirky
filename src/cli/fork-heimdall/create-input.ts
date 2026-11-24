import type { z } from 'zod'
import { BudgetPolicySchema, type BudgetPolicy } from '../../shared/fork-heimdall/budget'
import {
  HEIMDALL_ENROLL_OWNER_RUNTIME_CAPABILITY,
  HEIMDALL_HOSTED_REVIEW_CHECK_SCOPE_RUNTIME_CAPABILITY,
  HEIMDALL_HOSTED_REVIEW_CHECK_SCOPE_UPDATE_REQUIRED_MESSAGE,
  HEIMDALL_HOSTED_REVIEW_DERIVED_PAYLOAD_RUNTIME_CAPABILITY,
  HEIMDALL_OBJECTIVE_HOSTED_REVIEW_CHECK_SCOPE_UPDATE_REQUIRED_MESSAGE,
  HEIMDALL_PARALLEL_EXECUTION_RUNTIME_CAPABILITY
} from '../../shared/fork-heimdall/capability'
import {
  HostedReviewEnrollmentCandidateSchema,
  type HostedReviewEnrollmentCandidate
} from '../../shared/fork-hosted-review-sitter'
import { adaptObjectiveEnrollmentToCapabilities } from '../../shared/fork-heimdall-objective/objective-enrollment-compatibility'
import {
  ObjectiveCapabilitiesSchema,
  ObjectiveEnrollmentPayloadSchema,
  type ObjectiveCapabilities,
  type ObjectiveEnrollmentPayload
} from '../../shared/fork-heimdall-objective/contract-types'
import {
  CapabilityModeSchema,
  EnrollInputSchema,
  type EnrollInput,
  type WatcherKindId
} from '../../shared/fork-heimdall/watcher-types'
import { OWNER_INTERVENTION_CAPABILITY } from '../../shared/fork-heimdall/owner/owner-capability'
import {
  WatcherOwnerConfigSchema,
  type WatcherOwnerConfig
} from '../../shared/fork-heimdall/owner/owner-config'
import { isTuiAgent } from '../../shared/tui-agent-config'
import { isPlainObject } from '../../shared/fork-ask-question-tool/ask-question-field-validation'
import { getRequiredStringFlag } from '../flags'
import { RuntimeClientError } from '../runtime-client'
import {
  buildHeimdallCreateFlagOverrides,
  HeimdallHostedReviewCapabilitiesSchema
} from './create-flag-values'
import { mergeHeimdallCreateSpec } from './create-spec'
import { parseHeimdallCreateSchema } from './create-input-validation'

const ObjectiveCapabilitiesForCreateSchema = ObjectiveCapabilitiesSchema.omit({
  [OWNER_INTERVENTION_CAPABILITY]: true
}).strict()

export type HeimdallCreateWorkspace = {
  repoId: string
  worktreeId: string | null
  workspaceKind: 'git' | 'folder'
}

type CandidateBase = {
  worktreeSelector: string
  budget: BudgetPolicy
  owner?: WatcherOwnerConfig
  ownerInterventionCapability?: z.infer<typeof CapabilityModeSchema>
}

export type HeimdallCreateCandidate = CandidateBase &
  (
    | {
        kind: 'objective'
        capabilities: ObjectiveCapabilities
        kindPayload: ObjectiveEnrollmentPayload
      }
    | {
        kind: 'hosted-review'
        capabilities: z.infer<typeof HeimdallHostedReviewCapabilitiesSchema>
        kindPayload: HostedReviewEnrollmentCandidate
      }
  )

export function buildHeimdallCreateCandidate(
  flags: Map<string, string | boolean>,
  cwd: string,
  kind: WatcherKindId
): HeimdallCreateCandidate {
  const explicitOverrides = buildHeimdallCreateFlagOverrides(flags, cwd, kind)
  const merged = mergeHeimdallCreateSpec(kind, flags, cwd, explicitOverrides)
  if (!isPlainObject(merged)) {
    throw new RuntimeClientError('invalid_argument', 'Could not build Heimdall enrollment input.')
  }
  const worktreeSelector = flags.has('worktree')
    ? getRequiredStringFlag(flags, 'worktree')
    : 'active'
  const payload = isPlainObject(merged.kindPayload) ? { ...merged.kindPayload } : merged.kindPayload
  if (kind === 'objective' && isPlainObject(payload)) {
    payload.workspaceKind = 'git'
    if (!payload.objectiveText) {
      throw new RuntimeClientError(
        'invalid_argument',
        'objective: pass --objective, --objective-file, or set kindPayload.objectiveText in --spec.'
      )
    }
  }
  const rawCapabilities = isPlainObject(merged.capabilities)
    ? { ...merged.capabilities }
    : merged.capabilities
  const ownerValue = merged.owner
  if (
    (flags.has('owner-model') || flags.has('owner-effort')) &&
    (!isPlainObject(ownerValue) || ownerValue.agent !== 'claude')
  ) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--owner-model and --owner-effort require --owner claude or spec.owner.agent=claude.'
    )
  }
  const owner =
    ownerValue === undefined
      ? undefined
      : parseHeimdallCreateSchema(WatcherOwnerConfigSchema, ownerValue, 'owner')
  if (owner && owner.agent !== 'claude') {
    throw new RuntimeClientError(
      'invalid_argument',
      'owner.agent: only claude can receive Heimdall interventions.'
    )
  }
  const ownerCapability = merged.ownerInterventionCapability
  if (!owner && ownerCapability !== undefined) {
    throw new RuntimeClientError(
      'invalid_argument',
      `${OWNER_INTERVENTION_CAPABILITY}: requires --owner claude.`
    )
  }
  const ownerInterventionCapability =
    ownerCapability === undefined
      ? owner
        ? 'gated'
        : undefined
      : parseHeimdallCreateSchema(
          CapabilityModeSchema,
          ownerCapability,
          OWNER_INTERVENTION_CAPABILITY
        )
  const budget = parseHeimdallCreateSchema(BudgetPolicySchema, merged.budget, 'budget')
  const ownerFields = {
    ...(owner === undefined ? {} : { owner }),
    ...(ownerInterventionCapability === undefined ? {} : { ownerInterventionCapability })
  }
  if (kind === 'objective') {
    const kindPayload = parseHeimdallCreateSchema(
      ObjectiveEnrollmentPayloadSchema,
      payload,
      'kindPayload'
    )
    for (const [role, agent] of Object.entries(kindPayload.roleAgents)) {
      if (agent && !isTuiAgent(agent)) {
        throw new RuntimeClientError(
          'invalid_argument',
          `kindPayload.roleAgents.${role}: unknown TUI agent "${agent}".`
        )
      }
    }
    return {
      kind,
      worktreeSelector,
      capabilities: parseHeimdallCreateSchema(
        ObjectiveCapabilitiesForCreateSchema,
        rawCapabilities,
        'capabilities'
      ),
      budget,
      kindPayload,
      ...ownerFields
    }
  }
  return {
    kind,
    worktreeSelector,
    capabilities: parseHeimdallCreateSchema(
      HeimdallHostedReviewCapabilitiesSchema,
      rawCapabilities,
      'capabilities'
    ),
    budget,
    kindPayload: parseHeimdallCreateSchema(
      HostedReviewEnrollmentCandidateSchema.strict(),
      payload,
      'kindPayload'
    ),
    ...ownerFields
  }
}

export function assertHeimdallCreateCapabilities(
  candidate: HeimdallCreateCandidate,
  runtimeCapabilities: readonly string[]
): void {
  if (
    (candidate.owner || candidate.ownerInterventionCapability !== undefined) &&
    !runtimeCapabilities.includes(HEIMDALL_ENROLL_OWNER_RUNTIME_CAPABILITY)
  ) {
    throw new RuntimeClientError(
      'incompatible_runtime',
      'The selected runtime does not support Heimdall owner enrollment. Update or restart Quirky, or retry without --owner.'
    )
  }
  if (
    candidate.kind === 'objective' &&
    (candidate.kindPayload.gates?.length ?? 0) > 0 &&
    !runtimeCapabilities.includes(HEIMDALL_PARALLEL_EXECUTION_RUNTIME_CAPABILITY)
  ) {
    throw new RuntimeClientError(
      'incompatible_runtime',
      'The selected runtime does not support objective gates. Update or restart Quirky, or retry without objective gates.'
    )
  }

  if (
    candidate.kind === 'objective' &&
    (candidate.kindPayload.landingBar === 'hosted-review' ||
      candidate.kindPayload.landingBar === 'merged') &&
    !runtimeCapabilities.includes(HEIMDALL_HOSTED_REVIEW_CHECK_SCOPE_RUNTIME_CAPABILITY)
  ) {
    throw new RuntimeClientError(
      'incompatible_runtime',
      HEIMDALL_OBJECTIVE_HOSTED_REVIEW_CHECK_SCOPE_UPDATE_REQUIRED_MESSAGE
    )
  }

  if (
    candidate.kind === 'hosted-review' &&
    !runtimeCapabilities.includes(HEIMDALL_HOSTED_REVIEW_DERIVED_PAYLOAD_RUNTIME_CAPABILITY)
  ) {
    throw new RuntimeClientError(
      'incompatible_runtime',
      'The selected runtime does not support host-derived hosted-review enrollment. Update or restart Quirky before creating a hosted-review watcher.'
    )
  }
  if (
    candidate.kind === 'hosted-review' &&
    !runtimeCapabilities.includes(HEIMDALL_HOSTED_REVIEW_CHECK_SCOPE_RUNTIME_CAPABILITY) &&
    candidate.kindPayload.mergeCheckScope !== 'required'
  ) {
    throw new RuntimeClientError(
      'incompatible_runtime',
      HEIMDALL_HOSTED_REVIEW_CHECK_SCOPE_UPDATE_REQUIRED_MESSAGE
    )
  }
}

export function buildHeimdallEnrollInput(
  candidate: HeimdallCreateCandidate,
  workspace: HeimdallCreateWorkspace,
  runtimeCapabilities: readonly string[]
): EnrollInput {
  if (candidate.kind === 'hosted-review' && workspace.workspaceKind === 'folder') {
    throw new RuntimeClientError(
      'invalid_argument',
      'workspace: hosted-review watchers require a Git worktree.'
    )
  }
  assertHeimdallCreateCapabilities(candidate, runtimeCapabilities)
  let kindPayload: unknown
  if (candidate.kind === 'objective') {
    if (
      workspace.workspaceKind === 'folder' &&
      candidate.kindPayload.landingBar !== 'files-on-disk'
    ) {
      throw new RuntimeClientError(
        'invalid_argument',
        'kindPayload.landingBar: folder workspaces support only files-on-disk.'
      )
    }
    const payload: ObjectiveEnrollmentPayload = {
      ...candidate.kindPayload,
      workspaceKind: workspace.workspaceKind,
      ...(workspace.workspaceKind === 'folder' ? { maxConcurrency: 1 } : {})
    }
    kindPayload = parseHeimdallCreateSchema(
      ObjectiveEnrollmentPayloadSchema,
      adaptObjectiveEnrollmentToCapabilities(payload, runtimeCapabilities),
      'kindPayload'
    )
  } else {
    const {
      branch: _branch,
      provider: _provider,
      reviewNumber: _reviewNumber,
      reviewUrl: _reviewUrl,
      mergeCheckScope,
      ...policy
    } = candidate.kindPayload
    const mergeCheckScopeSupported = runtimeCapabilities.includes(
      HEIMDALL_HOSTED_REVIEW_CHECK_SCOPE_RUNTIME_CAPABILITY
    )
    kindPayload = mergeCheckScopeSupported ? { ...policy, mergeCheckScope } : policy
  }
  return parseHeimdallCreateSchema(
    EnrollInputSchema,
    {
      kind: candidate.kind,
      repoId: workspace.repoId,
      worktreeId: workspace.worktreeId,
      capabilities: candidate.capabilities,
      budget: candidate.budget,
      kindPayload,
      ...(candidate.owner === undefined ? {} : { owner: candidate.owner }),
      ...(candidate.ownerInterventionCapability === undefined
        ? {}
        : { ownerInterventionCapability: candidate.ownerInterventionCapability })
    },
    'input'
  )
}
