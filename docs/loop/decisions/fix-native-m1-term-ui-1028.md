# fix-native-m1-term-ui-1028 decisions

## D1: Read the desktop pasteboard through the trusted window bridge
- **Question:** Why does SC-37 Cmd+V fail in WKWebView, and where should clipboard text come from?
- **Options:** retry the permission-gated Web Clipboard API; let native paste events bypass command routing; use the existing trusted preload/host RPC seam
- **Chose:** add a native text-read request backed by Electrobun `Utils.clipboardReadText`, exposed through public `UiPluginContext.readClipboardText`; retain the Web Clipboard API in browser shells
- **Why:** capture-phase command routing intentionally consumes Cmd+V, and the command currently calls `navigator.clipboard.readText`. The native report records permission rejection and the WebKit Paste callout. The installed Electrobun SDK already offers a native clipboard primitive. Clipboard text stays window-local; no daemon API or guest webview gains access.
- **Evidence:** native report `/Users/zpyoung/orca/workspaces/quirky/native-qa/.quirk/using-apps-like-a-user/runs/20261028T045314-56e5/report.md:12-14,42`; `plugins/quirky.terminal/src/window/commands.ts:89-95,241-244`; `apps/desktop/.hutch/devkit/api/sdks/main/core/Utils.ts:314-320`; `apps/desktop/src/bun/native-browser-preload.ts:33`
- **Reversibility:** easy (additive window API; three terminal readers migrate together)
- **Confidence:** high
- **Revisit if:** native bridge cannot read the system pasteboard or introduces duplicate delivery
- **Source:** assumed — autonomous

## D2: Preserve terminal paste framing and migrate all terminal clipboard reads
- **Question:** Should the native acquisition repair change terminal input handling or cover only the shortcut?
- **Options:** shortcut-only special case; migrate command/menu/right-click readers to the public window API and preserve the existing paste pipeline
- **Chose:** migrate all three readers; retain ClipboardEvent data handling, newline normalization, mode-dependent brackets, ordered chunks, size cap, and deadline
- **Why:** each reader hits the same permission gate; all already converge on pane paste. A transport repair must not bypass terminal mode or input gates.
- **Evidence:** `plugins/quirky.terminal/src/window/pane/TerminalPaneView.tsx:583-620,639-645`; `plugins/quirky.terminal/src/window/workspace/controller.ts:1254-1260`; m1-term-ui D22
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** browser or terminal paste behavior regresses
- **Source:** locked by docs/loop/decisions/m1-term-ui.md D22

## D3: Native OS interaction remains a nightly scenario, not a foreground lane action
- **Question:** How should this lane verify a native-only failure while obeying the loop's no-native-foreground rule?
- **Options:** take over the desktop; exercise the production window/terminal path with controlled clipboard sources and requeue SC-37 for native verification
- **Chose:** controlled real-daemon/window/PTY regression and smoke, typecheck/build, then reset only SC-37 to pending with historical failure evidence retained
- **Why:** LOOP.md explicitly forbids native/foreground dogfood by feature lanes and delegates native-only scenarios to the nightly run. m7-test-triage has been claimed, so this fix runs its own checks under the end-phase rules.
- **Evidence:** authoritative build/roadmap `docs/loop/LOOP.md` end phase and step 6; canonical queue status observed m7-test-triage in-progress lane 8
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the nightly native run reports further failure
- **Source:** locked by docs/loop/LOOP.md

## Progress
Root cause investigated from authoritative native evidence and current source. Public clipboard method signatures committed before implementation dispatch. Next: implement native RPC/public UI adapter and migrate readers, exercise real-daemon Cmd+V with Web Clipboard API denied and bracket modes on/off, typecheck and affected checks, catch up once, commit and land.
