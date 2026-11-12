# Agent marks

The files here are copied unchanged from the sources below, except `aider.svg`. `bun scripts/gen-icons.ts` treats them as untrusted, the same way it treats the Catppuccin icons, and writes `generated-agents.ts`. Each licence covers the file. The logo remains its owner's trademark.

- simple-icons 16.36.0, npm `sha512-+VNPPkqSOLidFeSgBKUWX4n50WPpDC09hav+BgS26anIF1oQOlGBb8LvwGR+6fYRjo+B6CiKzNBceMPkSVXANQ==`, CC0-1.0 (`LICENSE.simple-icons`).
- `@lobehub/icons-static-svg` 1.101.0, npm `sha512-Ob6WJOjXauLP/A1qZ9OlPlrncPNbwsIGH+ToFdxWt3APtaaMKtbIBGqJ0/LY2eBeUwTQuG7GpUw9LwPiv7OTdg==`, MIT (`LICENSE.lobe-icons`).
- Aider-AI/aider at commit `5dc9490bb35f9729ef2c95d00a19ccd30c26339c`, `aider/website/assets/icons/safari-pinned-tab.svg`, Apache-2.0 (`LICENSE.aider`). Changed for this repo: removed the XML declaration, doctype, metadata and fixed size, and removed `fill="#000000"` so the mark takes the text color.

| Mark | Source file | Licence | Used by |
| --- | --- | --- | --- |
| aider | Aider repo, above | Apache-2.0 | `aider` |
| amp | lobe-icons `amp.svg` | MIT | `amp` |
| antigravity | lobe-icons `antigravity.svg` | MIT | `antigravity` |
| atlassian | simple-icons `atlassian.svg` | CC0-1.0 | `rovo` (vendor mark) |
| claude | simple-icons `claude.svg` | CC0-1.0 | `claude`, `claude-agent-teams` |
| cline | simple-icons `cline.svg` | CC0-1.0 | `cline` |
| codebuddy | simple-icons `codebuddy.svg` | CC0-1.0 | `codebuddy` |
| codex | lobe-icons `codex.svg` | MIT | `codex` |
| command-code | lobe-icons `commandcode.svg` | MIT | `command-code` |
| copilot | simple-icons `githubcopilot.svg`, from Primer Octicons | MIT (`LICENSE.octicons`) | `copilot` |
| cursor | simple-icons `cursor.svg` | CC0-1.0 | `cursor` |
| devin | lobe-icons `devin.svg` | MIT | `devin` |
| gemini | simple-icons `googlegemini.svg` | CC0-1.0 | `gemini` |
| goose | lobe-icons `goose.svg` | MIT | `goose` |
| grok | lobe-icons `grok.svg` | MIT | `grok` |
| kilo | lobe-icons `kilocode.svg` | MIT | `kilo` |
| kimi | simple-icons `kimi.svg` | CC0-1.0 | `kimi` |
| kiro | lobe-icons `kiro.svg` | MIT | `kiro` |
| mistral | simple-icons `mistralai.svg` | CC0-1.0 | `mistral-vibe` (vendor mark) |
| muse | lobe-icons `muse.svg` | MIT | `muse` |
| opencode | simple-icons `opencode.svg` | CC0-1.0 | `opencode`, `opencode2`, `opencode-go` |
| pi | simple-icons `pi.svg`, from pi.dev | CC0-1.0 | `pi` |
| qoder | lobe-icons `qoder.svg` | MIT | `qoder`, `qoder-cn` |
| qwen | simple-icons `qwen.svg` | CC0-1.0 | `qwen-code` |
| trae | simple-icons `trae.svg` | CC0-1.0 | `trae` |
| zai | simple-icons `zdotai.svg` | CC0-1.0 | `zcode` (vendor mark) |

## Marks left out

These IDs draw a monogram. Check these reasons before adding art for them.

- `minimax`: simple-icons lists custom terms, and MiniMax's statement there keeps its brand policies in force, so no licence can be named.
- `hermes`: simple-icons `hermes.svg` is the parcel company. The lobe-icons Hermes Agent mark is an illustrated face that doesn't read at 16px.
- `mimo-code`: the only mark found is a wordmark that doesn't read at 16px.
- `omp`: upstream art is multi-color (rects in `assets/icon.svg`, a gradient tile on omp.sh), so a single-color version would mean redrawing it.
- `openclaw`: the lobe-icons file uses `clipPath`, which the generator rejects.
- `ante`, `aug`, `autohand`, `codebuff`, `continue`, `crush`, `droid`, `dsh`, `freebuff`, `jcode`, `openclaude`, `prime-agent`: not in either collection under a mark that could be confirmed as theirs.
