# RogueKernel Pi Work

Focused Pi extensions for **seeing delegated work clearly** and **keeping
GitHub Copilot model metadata honest**. Each package is independently owned,
tested, documented, and installable; the private workspace simply keeps their
development and release checks consistent.

![Read-only Orca subagent viewer](packages/pi-orca-subagents/docs/viewer-preview.png)

## Packages

| Package | Purpose |
| --- | --- |
| [`pi-orca-subagents`](packages/pi-orca-subagents) | Follow every `pi-subagents` child in a live, read-only Orca viewer with bounded long-session history and no changes to execution, focus, or protocol streams. |
| [`pi-copilot-context-variants`](packages/pi-copilot-context-variants) | Sync Copilot context tiers, output limits, and pricing while preserving Pi's built-in auth and streaming. |

This repository is currently source-only. The packages are not published to
npm, and the repository root is not an aggregate Pi package.

## Install from GitHub

Pi does not currently support Git package specs that target a repository
subdirectory. Clone the source once, then register either or both package
directories individually. The repository root is never added as a Pi package.

```bash
install_root="${XDG_DATA_HOME:-$HOME/.local/share}/roguekernel-pi-work"
git clone https://github.com/RogueKernel/roguekernel-pi-work.git "$install_root"

pi install "$install_root/packages/pi-orca-subagents"
pi install "$install_root/packages/pi-copilot-context-variants"
```

Because Pi records these as individual local package paths, update the shared
clone explicitly and then reload Pi:

```bash
git -C "${XDG_DATA_HOME:-$HOME/.local/share}/roguekernel-pi-work" pull --ff-only
```

See each package README for its requirements and behavior.

## Development

```bash
npm install
npm run setup:git
npm run check
npm run pack:dry
```

The live Orca integration suite is intentionally separate because it requires
an Orca-managed terminal. Before releasing `pi-orca-subagents`, also run:

```bash
npm run test:integration --workspace pi-orca-subagents
```

Outside Orca that suite skips; a green workspace check alone does not prove live
terminal creation, focus preservation, or cleanup.

`npm run setup:git` stores the public `Rogue Kernel` author identity in this
checkout's local Git configuration. Run it once after each fresh clone; it does
not change the machine-wide identity used by other repositories.

The root is private and exists only to orchestrate the workspaces. Each package
keeps its own manifest, version, tests, documentation, and license.
