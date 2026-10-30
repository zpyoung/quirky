# Catppuccin file icons

Vendored from https://github.com/catppuccin/vscode-icons at commit
`b6915da9f6889b683a110aa747de96c2820a537d` (release v1.26.0), `icons/mocha` and `icons/latte`, MIT
licensed (see `LICENSE`). Only the icons named in `scripts/gen-icons.ts` are kept. The files are
untrusted input: `bun scripts/gen-icons.ts` rejects any SVG with a script, foreignObject, image,
event attribute or external href before it writes `generated-files.ts`.
