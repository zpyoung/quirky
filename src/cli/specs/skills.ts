import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const SKILL_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['skills', 'list'],
    summary: 'List version-matched skill guides bundled with this Quirky CLI',
    usage: 'quirky skills list [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    notes: [
      'Reads bundled guide metadata locally without contacting the Quirky runtime.',
      'With --json, prints a topics array of canonical names and one-line descriptions.',
      'Use `quirky skills get <name>` for the compact guide, `--full` for its full reference package, or `quirky skills install` to install skills.'
    ]
  },
  {
    path: ['skills', 'get'],
    aliases: [['skills', 'show']],
    summary: 'Print a version-matched skill guide as Markdown',
    usage: 'quirky skills get <topic> [--full | --reference <name>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'topic', 'full', 'reference', 'references'],
    positionalArgs: ['topic'],
    notes: [
      'Reads bundled guide content locally without contacting the Quirky runtime.',
      'Prints the compact guide by default. Use --full to print the full guide with bundled references when provided.',
      'Use --reference <name> to print one bundled reference alone, which is what an action gate in the compact guide needs; --references lists the available names.',
      'A reference name may be given bare (recovery-and-cleanup) or as the guide spells it (references/recovery-and-cleanup.md).',
      'Use --json for a deterministic object containing canonical topic metadata and content.'
    ],
    examples: [
      'quirky skills get quirky-cli',
      'quirky skills get quirky-orchestration --full',
      'quirky skills get quirky-orchestration --references',
      'quirky skills get quirky-orchestration --reference recovery-and-cleanup'
    ]
  },
  {
    path: ['skills', 'install'],
    summary: 'Install bundled Quirky skills via the community skills CLI',
    usage:
      'quirky skills install [--skill <name>]... [--all] [--agent <name>[,<name>]] ' +
      '[--local] [--dry-run] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'skill', 'all', 'agent', 'local', 'dry-run'],
    notes: [
      'Reads the bundled skill registry locally without contacting the Quirky runtime.',
      'Resolves to the same `npx skills@<pinned> add <repo>/tree/<commit> --skill <name> ...` ' +
        'command used by Quirky Settings, pinned to the commit this Quirky build was made from, ' +
        'plus the non-interactive flags an unattended host needs (`npx --yes` and `-y`), ' +
        'then runs it and forwards its output and exit code.',
      'Installs globally (all projects, adds --global) by default. Use --local to install ' +
        'into the current project instead.',
      'Targets the coding agents Quirky detects on this host, plus the shared ' +
        '.agents/skills directory. Without an explicit target the skills CLI installs ' +
        'into every agent it knows about, which litters a host with config ' +
        'directories for agents it does not have.',
      'Use --agent <name>[,<name>...] to choose targets yourself, or --agent universal ' +
        'for the shared directory alone. Required when Quirky detects no agent.',
      'Use --dry-run to print the resolved command without running it.',
      'With --json, the skill listing and --dry-run emit JSON; a real install streams ' +
        "npx's own non-JSON output live and rejects --json.",
      'Omit --skill and --all to list installable skill names.',
      'Intended for headless hosts (SSH, containers, CI) with no desktop Settings UI to copy the install command from.'
    ],
    examples: [
      'quirky skills install',
      'quirky skills install --skill quirky-cli --skill quirky-orchestration',
      'quirky skills install --skill quirky-cli --local',
      'quirky skills install --skill quirky-cli --agent claude-code,codex',
      'quirky skills install --all --dry-run'
    ]
  },
  {
    path: ['skills', 'update'],
    summary: 'Update Quirky skills to the version this Quirky build ships',
    usage:
      'quirky skills update [--skill <name>]... [--all] [--agent <name>[,<name>]] ' +
      '[--local] [--dry-run] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'skill', 'all', 'agent', 'local', 'dry-run'],
    notes: [
      'Reads the bundled skill registry locally without contacting the Quirky runtime.',
      'Runs the same pinned `npx skills add` command as `quirky skills install`, which ' +
        'replaces each selected skill with the copy this Quirky build ships.',
      'Updates the global install (all projects, adds --global) by default. Use --local to ' +
        'update the current project instead.',
      'Targets the same agents as `quirky skills install`, or only the shared ' +
        '.agents/skills directory when none is detected; use --agent to choose them yourself.',
      'Use --dry-run to print the resolved command without running it.',
      'With --json, the skill listing and --dry-run emit JSON; a real update streams ' +
        "npx's own non-JSON output live and rejects --json.",
      'Omit --skill and --all to list updatable skill names.',
      'Intended for headless hosts (SSH, containers, CI) with no desktop Settings UI to copy the update command from.'
    ],
    examples: [
      'quirky skills update',
      'quirky skills update --skill quirky-cli --skill quirky-orchestration',
      'quirky skills update --skill quirky-cli --local',
      'quirky skills update --all --dry-run'
    ]
  }
]
