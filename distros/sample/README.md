# Sample distro

`distros/sample` is a repository-published example pack. It installs `sample.sidebar`, which overrides the stock worktree sidebar with a flat list, and disables `quirky.git` for the distro layer. Its bundled plugin declares Plugin API `1.0.0` in [`sample.sidebar/quirky-plugin.json`](sample.sidebar/quirky-plugin.json).

From the repository root, inspect the pack before installing it:

```sh
quirky distro inspect ./distros/sample --json
```

Install with explicit confirmation consent:

```sh
quirky distro install ./distros/sample --yes
quirky ui state --json
quirky api --json
```

`--yes` skips the existing confirmation prompt. It does not sandbox the plugin: Quirky plugins are full-trust code and can exercise the host services available to them. Install only code you trust.

After installation, `ui state --json` shows the stable worktree sidebar slot owned by `sample.sidebar`, titled **Worktrees (flat)**, with a flat-list report. The stock `panel:quirky.git/source-control` contribution is absent, and `quirky.git` commands are unavailable while this distro layer is installed. `quirky api --json` reports the daemon's `pluginApiVersion` separately from its application, wire-protocol and catalog schema versions.

Remove the distro to restore the stock sidebar, source-control contribution and Git command group:

```sh
quirky distro remove sample --yes
quirky ui state --json
```

Repository publication means committing these sample files and instructions to this repository. It does not push a release, publish to a registry or require an external service. See the [Plugin API 1.0 author reference](../../docs/plugin-api.md) for manifest, compatibility and lifecycle details.
