# Custom GitHub Copilot provider

This package owns the `custom-github-copilot` Pi provider.

- Keep it PAT-only. Support Pi's normal `/login` API-key storage, but do not add
  OAuth, device flow, token exchange, refresh, or credential delegation to Pi's
  built-in `github-copilot` provider.
- Never register or unregister the `github-copilot` provider ID.
- Register before credentials exist so Pi can offer API-key setup. Resolve and
  validate the account-specific endpoint inside the provider-local transport,
  then clone it onto every request model before delegating to Pi's streamer.
- Document that installation and updates require a fresh Pi process; do not
  claim `/reload` reliably replaces provider or catalog state.
- Never return the discovered endpoint as credential-derived auth metadata; the
  transport boundary is the #6768 workaround.
- Keep selector-to-wire model translation local, exact, and provider-scoped.
- Treat the PAT-visible `/models` response as authoritative for entitlement.
  Publish only enabled, picker-visible, tool-capable chat models and suffix every
  selector with its context size.
- Preserve provider-scoped atomic persistence and offline fallback. Never keep
  a retired live model through the hardcoded bootstrap catalog.
- Do not send `X-GitHub-Api-Version` to private Copilot inference endpoints
  without endpoint-specific evidence.
- Never log PATs, authorization headers, discovery response bodies, or complete
  request headers.
- Treat the private Copilot endpoint as experimental and keep that warning in
  `README.md` and `docs/research.md`.
- Keep inventory-only `X-GitHub-Api-Version: 2026-06-01` scoped to `/models`;
  never add it to inference.
- Test provider isolation, endpoint validation, entitlement filtering, cached
  fallback, sanitized failures, transport routing, and every selector-to-wire
  mapping.
- Run `npm run check` before completion.
