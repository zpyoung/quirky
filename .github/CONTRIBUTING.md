# Contributing to Quirky

Quirky is a personal project, and changes come from its owner. This file records the working rules.

## Setup

Install Node 24, pnpm, and the Bun version in [`config/.bun-version`](../config/.bun-version).

```bash
pnpm install
pnpm dev
```

Set `QUIRKY_DEV_MAIN_SOURCEMAPS=0` before `pnpm dev` to cut main-process rebuild cost when you don't
need its source maps.

## Rules

- Quirky supports macOS only. Don't add Windows or Linux code paths.
- Work must hold up against local repositories, remote servers, and SSH worktrees.
- Keep generic behavior provider-neutral; guard integration-specific logic behind explicit checks.
- For UI work, follow [`docs/STYLEGUIDE.md`](../docs/STYLEGUIDE.md).
- Project-owned type declarations go in `.ts` files. Keep `.d.ts` for ambient shims.
- Use a descriptive branch name such as `fix/ctrl-backspace-delete-word`.
- Follow [`AGENTS.md`](../AGENTS.md) for tests and typechecking.

## Pull requests

Follow [`pull_request_template.md`](./pull_request_template.md). Add tests that would catch a
regression for behavior changes and bug fixes, and attach before and after screenshots for UI
changes.

## Releases

Releases are cut from the **Cut Release** workflow
([`release-cut.yml`](./workflows/release-cut.yml)) and published to `zpyoung/quirky`. The `release`
skill in [`.claude/skills/release/SKILL.md`](../.claude/skills/release/SKILL.md) covers the steps.
Don't include version bumps in a normal change.
