# Provider account preparation

`quirky.accounts/prepare` prepares a real user launch. Its session and worktree identities are persisted so later status and usage work can resolve the actual account home.

`quirky.accounts/prepareProviderEnv` is for a short-lived provider-owned process such as Codex model discovery. It accepts only `agent`, `cwd`, and both provider home overrides; it rejects `sessionId`, `worktreeId`, `resume`, and other extra fields. It uses the same explicit, inherited, injected, absent, selected-account, and System default resolution as `prepare`, including managed-home ownership/authentication checks and Codex config-warning synchronization. Any Codex config synchronization writes only to the verified managed profile; the System default config is read-only. Its result has `shellInit: null` and never creates, updates, or fabricates an `account_sessions` row or resume transcript.

The returned `env` is an environment patch, not credentials. String values are applied; `null` means delete that variable from the child environment. The CLI command reports the resolved account and environment variable names without printing environment values:

```sh
quirky accounts prepare-provider-env --agent codex --cwd "$PWD" --home-overrides '{"claude":{"value":null,"source":"absent"},"codex":{"value":null,"source":"absent"}}'
```

## Usage and sign-in controls

The Usage status bar measures the rendered chip container, gaps and overflow-button widths. It keeps an exact visible prefix and a `+N` button for the omitted providers; the button's tooltip names that suffix. Compact, Detailed, Remaining and badge-only changes remeasure, and hidden measurement elements do not enlarge the status bar.

Codex's **Open** sign-in action invokes the existing public `quirky.terminal/openExternal` method with the validated displayed authorize URL. It does not rely on a webview pop-up or complete/select the account; invocation failures leave Copy and Cancel available. Actual system-browser and OAuth completion are separate from an accepted opener call.

Declared CLI commands dispatch by their existing stable IDs, including `login-status`, `cancel-login`, `session-home`, `inactive-usage`, `ui-state`, `credential-status` and `reset-credit`:

```sh
quirky accounts add --provider codex --json
quirky accounts login-status --id <pending-login-id> --json
quirky accounts cancel-login --id <pending-login-id> --json
```
