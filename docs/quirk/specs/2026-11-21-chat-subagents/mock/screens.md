# Screens: subagents in native chat (mock v2)

Open `mock.html` in a browser. The dashed bar at the top switches scenarios and is not product UI.

| Screen | Purpose | States | Elements (pin) | Repo component |
|---|---|---|---|---|
| Chat turn | Show where agents started and ended, and their asks | three running, background, quiet, all finished, reopened, twelve agents | spawn marker (`marker-spawn-*`), folded spawn line (`marker-fold`), return marker (`marker-return-*`), subagent ask (`ask-*`) | Turn rows in `plugins/quirky.session/src/window/chat/Turn.tsx`; ask card from `quirky.ask`; **marker row and folded line: gap** |
| Dock | One-line live summary above the composer | running, needs you, quiet, hidden when none run | dock (`dock`) | `StatusDot`, `Badge`; **dock row: gap** |
| Chat header | Status and tokens including subagents | Working, Ready · N agents running, Done | header tokens (`header-tokens`) | `ChatHeader.tsx` figures |
| Agents card: list | Running and Done agents, nested by parent | working, needs you, quiet, failed, stopped, child needs you, Done collapsed | list (`agents-list`), row (`row-*`), row Stop (`row-stop-*`), Done group (`done-group`) | `ListRow`, `StatusDot`; **Agents card kind in `VisualPanel.tsx`: gap** |
| Agents card: selected transcript | One agent's work, read-only | running, done, failed, stopped | header (`agent-header`), Stop (`agent-stop`), prompt (`agent-prompt`), activity (`agent-activity`), test card (`agent-tests-card`) | Turn renderer, `Activity.tsx`, `cards/Card.tsx`, `cards/TestResults.tsx` |

No pins were left during review. The user asked how it looks with 12 agents, which produced v2 (scenario 6).
