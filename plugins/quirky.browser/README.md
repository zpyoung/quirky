# Browser automation

`quirky.browser` exposes owned, headless Chrome pages through the daemon API and the `quirky browser` CLI. Chrome starts only for a command that needs a browser. The plugin never attaches to a desktop browser, opens a visible window, or routes pages to another device.

## Requirements

- Install Google Chrome or Chromium on macOS. The plugin does not bundle a browser.
- The desktop bundle includes the pinned `agent-browser` native helper (0.27.0); source workspaces resolve that dependency from this plugin only.
- Set `QUIRKY_BROWSER_CHROME` to an absolute executable path only when the standard Chrome/Chromium installation locations are not suitable. An invalid explicit path is an error; the plugin does not download a browser or attach to another process.

Each browser profile has its own durable Chrome user-data directory beneath the plugin's private data directory. Each profile runs one Quirky-owned Chrome process and one foreground helper. Helper sockets are private Unix sockets; CDP is bound to an ephemeral loopback port. Disabling the plugin closes only the retained child processes it owns.

## Basic use

```sh
quirky browser tab profile list --json
quirky browser tab create --url http://127.0.0.1:8080 --worktree current --json
quirky browser snapshot --worktree current
quirky browser fill --element '#email' --value 'agent@example.test' --worktree current
quirky browser tab profile create --label Review
```

A page ID can replace a worktree selector for a command. Mutations require a page or worktree target; reads can use the unique global active page. `--worktree all` is a read-only list filter. Snapshot references are short-lived `qbr1:<uuid>:<index>` tokens bound to one page and projection; navigation, tab switching, profile changes, closure, or a new snapshot invalidates them.

The CLI accepts `--json` on every browser command. It uses the same daemon method schemas and destructive confirmation flow as API clients. `--yes` is the explicit confirmation bypass for page close, profile delete, cookie delete, storage clear, and cookie import.

Large text flags accept `@file:<path>` to read exact UTF-8 content through the CLI file service; `@file:-` reads standard input. API calls carry strings directly in their JSON request.

## Profiles and cookies

The `default` profile always exists. `tab profile create` creates an isolated profile; `profile set` changes a page's profile while retaining its public page ID and URL, and `profile clone` copies cookies into an empty isolated profile. Deleting a profile reassigns its pages to Default and removes only that profile's Quirky-owned data.

Cookie-source discovery is explicit (`quirky browser import detect`) and does not launch Chrome or read source files. Cookie import accepts a JSON cookie array or an explicit Chrome/Chromium-family, Firefox, or Safari profile. SQLite sources are snapshotted with WAL contents and read-only; macOS Keychain is consulted only when an explicit import contains supported encrypted Chromium values. Import replaces only public-suffix-aware registrable families that pass the safety policy, skips Google-bound and unsafe cookies, preserves CHIPS partition identities, and rolls back exact destination identities if a write fails. Import jobs are activation-scoped and do not retain source paths or secret cookie values.

## API and command catalog

Methods are declared under `quirky.browser/` and include tab/page lifecycle, navigation, snapshots and references, input, query/wait/eval, screenshots/PDF/download, console/network/HAR/interception, cookies/storage, emulation, clipboard/dialog control, profiles, detection/import jobs, identity intent, local `open-url`, and a closed shell-free `exec` command grammar. API parameter objects reject undeclared fields; unsupported schemes, stale references, unknown profiles and wrong-page dialog responses return structured errors.

`exec open <url>` and `exec navigate <url>` use the selected page's scoped `goto`. Bare `open` is rejected so `exec` cannot launch or attach to another browser.

`clipboard read` and `clipboard write` use Chromium's headless clipboard. They never access the macOS pasteboard; writes are limited to 8 KiB UTF-8. Dialog accept/dismiss is sent out of band only to a current pending dialog on its already-bound page.

## Platform support

The implemented and acceptance-tested distribution target is macOS. Other platform launch, source-browser discovery, native helper binaries, Keychain/DPAPI/keyring, and process-ownership behavior are not claimed by this component.
