# Changelog

## 0.1.0 - 2026-07-22

- Restores distinct default and expanded context variants in Pi's model picker.
- Maps expanded `*-1m` picker aliases back to real Copilot request model IDs.
- Keeps distinct smaller and 1M selectors even when both context tiers have the
  same per-token price.
- Applies higher long-context prices through Pi's request-wide `cost.tiers` only
  after Copilot's default prompt threshold is exceeded.
- Migrates to Pi 0.81's native provider registration while delegating Copilot
  OAuth and streaming to Pi's built-in provider.
- Persists successful live catalogues through Pi's provider model store so
  `*-1m` aliases are restored before startup model scopes are resolved.
- Uses the public native-provider `filterModels` hook for alias-aware credential
  filtering instead of patching Pi's model-registry internals.

- Initial live GitHub Copilot model metadata and pricing overlay.
- Uses Pi's provider refresh lifecycle and preserves the built-in catalogue when
  live discovery fails.
- Keeps the documented Copilot GPT prompt-budget compaction guard while relying
  on Pi's normal compaction implementation.
