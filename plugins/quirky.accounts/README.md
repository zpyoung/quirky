# Provider account preparation

`quirky.accounts/prepare` prepares a real user launch. Its session and worktree identities are persisted so later status and usage work can resolve the actual account home.

`quirky.accounts/prepareProviderEnv` is for a short-lived provider-owned process or API probe such as Codex or Claude model discovery. It accepts only `agent`, `cwd`, and both provider home overrides; it rejects `sessionId`, `worktreeId`, `resume`, and other extra fields. It uses the same explicit, inherited, injected, absent, selected-account, and System default resolution as `prepare`, including managed-home ownership/authentication checks and Codex config-warning synchronization. Any Codex config synchronization writes only to the verified managed profile; the System default config is read-only. Its result has `shellInit: null` and never creates, updates, or fabricates an `account_sessions` row or resume transcript.

`account.authKind` is non-secret selected-account metadata (`oauth`, `api-key`, `none`, or `unknown`). Provider API probes use it to distinguish API-key access from OAuth sign-in; OAuth tokens are never used as model-list API keys.

The returned `env` is an environment patch, not credentials. String values are applied; `null` means delete that variable from the child environment. The CLI command reports the resolved account and environment variable names without printing environment values:

```sh
orca accounts prepare-provider-env --agent codex --cwd "$PWD" --home-overrides '{"claude":{"value":null,"source":"absent"},"codex":{"value":null,"source":"absent"}}'
```

## Native sign-in links

Codex sign-in's **Open** button sends the displayed, approved authorize URL through the public `quirky.terminal/openExternal` system-handler API rather than a webview popup. While the handoff is pending, **Copy link** and **Cancel** remain available. A failed handoff shows a recoverable error; retrying does not restart sign-in or change the URL.
