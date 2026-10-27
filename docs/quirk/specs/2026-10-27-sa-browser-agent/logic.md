# Browser agent core

Status: implementation contract. Operator night-mode scope supersedes the earlier full-parity scope for `sa-browser-agent`.

## Goal

Ship isolated managed browser profiles and pages, with real page commands available through the public plugin API and `quirky browser` CLI. A profile owns one Chrome process and one agent-browser helper. Every helper selection and its complete command execute under the same profile-wide FIFO lock.

## Shipping surface

Keep the existing parameter/result contracts for these methods, narrowed only where a deferred capability would otherwise remain exposed:

- Profiles: `profileList`, `profileCreate` (isolated profiles only).
- Pages: `tabList`, `tabShow`, `tabCurrent`, `tabCreate`, `tabSwitch`, `tabClose`.
- Commands: `goto`, `eval`, `snapshot`, `fill`, `click`, `screenshot` (viewport capture), `exec`.
- `exec` is a shell-free parser for the six shipping page commands above, not arbitrary helper access. Existing documented navigation aliases may normalize to `goto`; no deferred command remains reachable through `exec`.
- CLI input strings are literal data. In particular `@file:<path>` never reads the filesystem. There is no implicit file/stdin expansion.

## Acceptance

### C1 — Profiles and lazy ownership

Discovering/enabling the plugin and listing/creating profile metadata starts no browser. First page use starts exactly one owned Chrome and one owned helper for that profile. Multiple pages share them; another profile gets its own pair. Profiles use managed data directories, never an installed browser's user profile.

### C2 — Page lifecycle and scope

API and CLI create, list, inspect, select and close pages. A page retains its public identity and the exact helper-returned tab identity. Selection/current-page lookup obeys the existing explicit-page/worktree/current-directory scope rules. Conflicting or missing mutation scope fails without mutating another page. Native focus remains unsupported in this headless feature and fails explicitly rather than claiming focus.

### C3 — Real commands and references

API and CLI navigate local HTTP fixture pages, evaluate serializable JavaScript, inspect accessibility snapshots, fill inputs, click selectors and public snapshot refs, and capture a valid viewport image. Observe resulting DOM state on the intended page, not merely forwarded arguments. Snapshot refs map the pinned helper's `eN` keys to its `@eN` selectors. Navigation, actual helper-tab switching, close and epoch loss invalidate affected refs; stale refs fail rather than retarget. Redundant same-tab selection must not destroy a fresh ref.

### C4 — Atomic profile selection and command

Concurrent operations on different pages of one profile leave each page with its own expected state. The lock covers helper tab selection, the entire async command and any metadata/ref updates. Lifecycle operations use the same lock. A profile does not acquire another profile's lock. No command may accidentally execute in the last-selected neighboring page.

### C5 — Literal CLI data and errors

An actual CLI fill with an existing synthetic `@file:` path leaves that exact string in the browser input; it never substitutes file contents. Invalid scope, stale refs, unknown/deferred commands and closed pages return structured errors and a nonzero CLI exit, with no cross-page mutation. Both direct methods and supported `exec` forms observe actual browser state.

### C6 — Owned lifecycle

Plugin teardown closes its owned helper/Chrome processes and transports. Unexpected helper loss fails affected work without replaying a mutation. The next explicit request may reconstruct retained page metadata with fresh helper-returned identities; never guess identity by URL, title or target order. A closed page must not be resurrected by queued work. Tests and smoke programs use fresh ProcessScope homes, mock Chrome Keychain and local fixtures, and clean up owned state.

## Deferred flows

`sa-browser-agent-extras`, dependent on this item, owns cookie source detection/import/rollback and direct cookie/storage APIs; profile default/switch/clone/delete; history commands; advanced interactions/keyboard/find/mouse/upload/download; full screenshots/PDF; network logs/HAR/interception; device/emulation/permissions/clipboard/dialog controls; identity settings; and explicit bulk CLI file/stdin inputs. None is advertised or reachable through this core release. The full pre-cutover source/spec snapshot is retained on `build/sa-browser-agent-full-snapshot`; the decision log records its commit.

Browser-pane and design-mode presentation remain separate queue items. This backend item has no web UI acceptance scenarios. Real native window focus is handed off as pending, not claimed as passed.

## Technical decisions

- Built-in `quirky.browser` plugin, public plugin API only; no kernel-private browser service.
- Pinned agent-browser 0.27.0 foreground NDJSON transport, one private session/socket directory per profile, explicit connection to the owned loopback Chrome endpoint. Never CLI auto-discovery/autostart.
- Only the helper creates managed pages. Retain its returned tab IDs in the epoch map. A per-profile FIFO serializes selection plus command, including page creation/close.
- Preserve existing trusted fresh-page CDP binding where core capture/lifecycle requires it: primitive-script nonce before untrusted navigation; never URL/title/order matching or page-owned globals.
- Native request envelope ID/action wins over user fields. Validate protocol responses at boundaries. Preserve owned-process handles and bounded cancellation/cleanup.
- Generic desktop bundling copies declared dependency-native assets and legal notices; platform-specific executable resolution stays inside the plugin. macOS is the exercised platform; other platforms remain deferred.
- Verification: affected-directory `bun scripts/suite.ts plugins/quirky.browser apps/desktop`, `bun test scripts`, `bun run typecheck`, real API/CLI core smoke. One cross-family review round, blocking fixes only; catch up once immediately before `queue.ts land`. Landing owns the integrated full-suite gate.
