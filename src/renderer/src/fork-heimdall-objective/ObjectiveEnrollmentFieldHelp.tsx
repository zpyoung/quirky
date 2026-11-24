import { Info } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import type { ObjectiveCapability } from './objective-enrollment-model'
import {
  objectiveCapabilityLabel,
  objectiveCapabilityModeLabel,
  objectiveLandingBarLabel,
  objectiveTierLabel
} from './objective-copy'

type ObjectiveEnrollmentHelpValue = {
  label: string
  description: string
}

export type ObjectiveEnrollmentHelpCopy = {
  label: string
  summary: string
  values: readonly ObjectiveEnrollmentHelpValue[]
}

export function ObjectiveEnrollmentFieldHelp({
  label,
  summary,
  values
}: ObjectiveEnrollmentHelpCopy): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className="inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <Info aria-hidden className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        sideOffset={6}
        className="w-max max-w-[min(34rem,calc(100vw-2rem))] text-left"
      >
        <p className="leading-4">{summary}</p>
        <ul className="mt-1.5 list-disc space-y-1 pl-4">
          {values.map((value) => (
            <li key={value.label} className="leading-4">
              <span className="font-medium">{value.label}</span> — {value.description}
            </li>
          ))}
        </ul>
      </TooltipContent>
    </Tooltip>
  )
}

export function objectiveTierHelp(): ObjectiveEnrollmentHelpCopy {
  return {
    label: translate('fork.heimdallObjective.enrollment.tierHelpLabel', 'Tier help'),
    summary: translate(
      'fork.heimdallObjective.enrollment.tierHelpSummary',
      'Sets the review required before landing.'
    ),
    values: [
      {
        label: objectiveTierLabel('express'),
        description: translate(
          'fork.heimdallObjective.enrollment.tierHelp.express',
          'No reviewer or integrator.'
        )
      },
      {
        label: objectiveTierLabel('standard'),
        description: translate(
          'fork.heimdallObjective.enrollment.tierHelp.standard',
          'Reviewer approval required.'
        )
      },
      {
        label: objectiveTierLabel('full'),
        description: translate(
          'fork.heimdallObjective.enrollment.tierHelp.full',
          'Reviewer and integrator approval required.'
        )
      }
    ]
  }
}

export function objectiveLandingBarHelp(): ObjectiveEnrollmentHelpCopy {
  return {
    label: translate('fork.heimdallObjective.enrollment.landingBarHelpLabel', 'Landing bar help'),
    summary: translate(
      'fork.heimdallObjective.enrollment.landingBarHelpSummary',
      'Sets the stopping rung; folders allow only Files on disk.'
    ),
    values: [
      {
        label: objectiveLandingBarLabel('files-on-disk'),
        description: translate(
          'fork.heimdallObjective.enrollment.landingBarHelp.filesOnDisk',
          'Keep completed edits uncommitted.'
        )
      },
      {
        label: objectiveLandingBarLabel('committed-local-branch'),
        description: translate(
          'fork.heimdallObjective.enrollment.landingBarHelp.committedLocalBranch',
          'Commit territory changes locally.'
        )
      },
      {
        label: objectiveLandingBarLabel('pushed-ref'),
        description: translate(
          'fork.heimdallObjective.enrollment.landingBarHelp.pushedRef',
          'Push the commit to its remote branch.'
        )
      },
      {
        label: objectiveLandingBarLabel('hosted-review'),
        description: translate(
          'fork.heimdallObjective.enrollment.landingBarHelp.hostedReview',
          'Open a review; GitHub/GitLab worktree required.'
        )
      },
      {
        label: objectiveLandingBarLabel('merged'),
        description: translate(
          'fork.heimdallObjective.enrollment.landingBarHelp.merged',
          'Watcher handoff for gated merge; GitHub/GitLab worktree required.'
        )
      }
    ]
  }
}

export function objectiveConcurrencyHelp(): ObjectiveEnrollmentHelpCopy {
  return {
    label: translate(
      'fork.heimdallObjective.enrollment.maxConcurrencyHelpLabel',
      'Max concurrency help'
    ),
    summary: translate(
      'fork.heimdallObjective.enrollment.maxConcurrencyHelpSummary',
      'Limits isolated implementer dispatches for this watcher.'
    ),
    values: [
      {
        label: '1',
        description: translate(
          'fork.heimdallObjective.enrollment.maxConcurrencyHelp.one',
          'Runs in place without dispatch worktrees.'
        )
      },
      {
        label: '3',
        description: translate(
          'fork.heimdallObjective.enrollment.maxConcurrencyHelp.three',
          'Default. Runs up to three independent nodes or lanes.'
        )
      }
    ]
  }
}

export function objectiveTerritoryHelp(): ObjectiveEnrollmentHelpCopy {
  return {
    label: translate(
      'fork.heimdallObjective.enrollment.territoryHelpLabel',
      'Write territory help'
    ),
    summary: translate(
      'fork.heimdallObjective.enrollment.territoryTooltipSummary',
      'Limits writes; protected .git and .quirky paths are always excluded.'
    ),
    values: [
      {
        label: translate(
          'fork.heimdallObjective.enrollment.territoryTooltip.allWorkspaceLabel',
          'Whole workspace (blank / **)'
        ),
        description: translate(
          'fork.heimdallObjective.enrollment.territoryTooltip.allWorkspace',
          'Blank becomes ** and allows every other relative path.'
        )
      },
      {
        label: translate(
          'fork.heimdallObjective.enrollment.territoryTooltip.customGlobsLabel',
          'Custom globs'
        ),
        description: translate(
          'fork.heimdallObjective.enrollment.territoryTooltip.customGlobs',
          'Up to 64 unique relative globs; one per line, no absolute paths or ..'
        )
      }
    ]
  }
}

function objectiveCapabilityModeValues(): ObjectiveEnrollmentHelpValue[] {
  return [
    {
      label: objectiveCapabilityModeLabel('off'),
      description: translate(
        'fork.heimdallObjective.enrollment.capabilityModeHelp.off',
        'Blocks this capability.'
      )
    },
    {
      label: objectiveCapabilityModeLabel('gated'),
      description: translate(
        'fork.heimdallObjective.enrollment.capabilityModeHelp.gated',
        'Pauses each action for approval.'
      )
    },
    {
      label: objectiveCapabilityModeLabel('on'),
      description: translate(
        'fork.heimdallObjective.enrollment.capabilityModeHelp.on',
        'Runs without approval after safety checks.'
      )
    }
  ]
}

export function objectiveCapabilityModesHelp(): ObjectiveEnrollmentHelpCopy {
  return {
    label: translate(
      'fork.heimdallObjective.enrollment.capabilityModesHelpLabel',
      'Capability values help'
    ),
    summary: translate(
      'fork.heimdallObjective.enrollment.capabilityModesHelpSummary',
      'Sets how each objective action is authorized.'
    ),
    values: objectiveCapabilityModeValues()
  }
}

export function objectiveGatesHelp(): ObjectiveEnrollmentHelpCopy {
  return {
    label: translate('fork.heimdallObjective.enrollment.gatesHelpLabel', 'Gates help'),
    summary: translate(
      'fork.heimdallObjective.enrollment.gatesHelpSummary',
      'Named whole-tree commands the kernel runs on the integrated branch after every plan node has merged, before review and landing.'
    ),
    values: [
      {
        label: translate('fork.heimdallObjective.enrollment.gatesHelp.whenLabel', 'When'),
        description: translate(
          'fork.heimdallObjective.enrollment.gatesHelp.when',
          'After the last plan node merges, before review and landing.'
        )
      },
      {
        label: translate(
          'fork.heimdallObjective.enrollment.gatesHelp.whatLabel',
          'What belongs here'
        ),
        description: translate(
          'fork.heimdallObjective.enrollment.gatesHelp.what',
          'The full test suite and other whole-tree checks, not per-node checks.'
        )
      }
    ]
  }
}

export function objectiveCapabilityHelp(
  capability: ObjectiveCapability
): ObjectiveEnrollmentHelpCopy {
  const capabilityLabel = objectiveCapabilityLabel(capability)
  const label = translate(
    'fork.heimdallObjective.enrollment.capabilityHelpLabel',
    '{{capability}} capability help',
    { capability: capabilityLabel }
  )
  let summary: string
  switch (capability) {
    case 'plan':
      summary = translate(
        'fork.heimdallObjective.enrollment.capabilityHelp.plan',
        'Controls planning, replanning, and activation.'
      )
      break
    case 'implement':
      summary = translate(
        'fork.heimdallObjective.enrollment.capabilityHelp.implement',
        'Controls task dispatch and report ingestion.'
      )
      break
    case 'review':
      summary = translate(
        'fork.heimdallObjective.enrollment.capabilityHelp.review',
        'Controls reviewer and Full-tier integrator verdicts.'
      )
      break
    case 'check':
      summary = translate(
        'fork.heimdallObjective.enrollment.capabilityHelp.check',
        'Controls active-plan shell checks.'
      )
      break
    case 'land':
      summary = translate(
        'fork.heimdallObjective.enrollment.capabilityHelp.land',
        'Controls record, commit, push, and open-review steps.'
      )
      break
  }
  return { label, summary, values: objectiveCapabilityModeValues() }
}
