# Private npm workspace

Contains independently maintained Pi packages under `packages/`.

- Keep package behavior, tests, documentation, and instructions inside the
  owning package.
- Follow the nearest package-level `AGENTS.md` when changing a package.
- Do not introduce shared runtime code unless more than one package actually
  needs it.
- Keep the repository root private and source-only unless the maintainer
  explicitly approves a distribution change.
- Use the root lockfile; do not add package-level lockfiles.
- For temporary-directory cleanup, use a dedicated local variable and verify its
  expected temporary prefix before recursive deletion. Never clean up through a
  configuration variable such as `PI_CODING_AGENT_DIR`.
- Run `npm run setup:git` after a fresh clone and verify the local author before
  making public commits.
- Before a release or distribution change, run `npm run check`, inspect
  `npm pack --dry-run --json` for each affected package, and scan artifacts for
  secrets, personal data, local paths, and generated state.
