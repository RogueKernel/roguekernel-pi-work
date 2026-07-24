# Changelog

## 0.1.0 - 2026-07-24

- Adds the separate `custom-github-copilot` Pi provider.
- Authenticates only with a user-owned fine-grained GitHub PAT, stored through
  Pi's normal API-key login or supplied by an environment variable for CI.
- Resolves and validates the account-specific Copilot endpoint at request time
  inside the provider-local transport.
- Includes hardcoded GPT pricing-threshold variants as a bootstrap fallback,
  with provider-scoped wire-ID rewriting.
- Adds an explicit `-1m` full-context companion for every threshold variant,
  with request-wide long-context pricing tiers.
- Keeps routing on each model to avoid the known conditions behind Pi issue
  #6768.
- Omits generic `X-GitHub-Api-Version` headers from private Copilot inference.
- Limits v1 to text input until the separate provider's Copilot vision-header
  path is implemented and tested.
- Refreshes all PAT-entitled, picker-visible Copilot chat models and gives every
  selector an explicit context suffix.
- Persists successful live catalogs with bounded refresh and offline fallback.
- Documents that installation and updates require a fresh Pi process.
