# Quirky

Quirky is a macOS desktop app for running coding agents side by side, each in its own git
worktree, with everything tracked in one place. It is a hard fork of the upstream app at
`stablyai/orca`.

## Install

Download a build from [GitHub releases](https://github.com/zpyoung/quirky/releases).

To build from source (macOS only):

```sh
pnpm install
pnpm dev          # run in development
pnpm build:mac    # build a local app bundle
```

## Developer docs

- [AGENTS.md](AGENTS.md): instructions for agents and contributors, including where tests run
- [Worktree storage maintenance](docs/readme/worktree-storage-maintenance.md)

## License

MIT. See [LICENSE](LICENSE).

Based on Orca by Lovecast Inc. (MIT).
