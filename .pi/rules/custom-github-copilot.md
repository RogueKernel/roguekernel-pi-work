---
paths:
  - "packages/custom-github-copilot/**/*.js"
  - "packages/custom-github-copilot/**/*.md"
  - "packages/custom-github-copilot/package.json"
summary: "Preserve PAT-only provider isolation, live entitlement refresh, and context-suffixed model semantics."
alwaysApply: false
---
# Custom GitHub Copilot provider boundaries

- Keep the provider ID `custom-github-copilot`; never register, override, or unregister Pi's built-in `github-copilot` provider.
- Authentication is PAT-only. Support Pi's normal `/login` API-key store first and `CUSTOM_GITHUB_COPILOT_TOKEN` for CI; do not add OAuth, device flow, token exchange, refresh, or credential delegation.
- Document that installation and updates require a fresh Pi process; `/reload` does not reliably replace provider or catalog state.
- Register before credentials exist. Resolve and validate the PAT-visible endpoint inside the provider-local transport, fail closed on discovery errors, and clone it onto every request model before delegating to Pi's streamer.
- Never return the discovered endpoint as credential-derived auth metadata; keeping routing inside the transport is the compaction/summary workaround for #6768.
- Keep synthetic selector-to-wire model translation module-local, exact, and scoped by provider ID.
- Build the catalog from PAT-visible `/models` data. Publish only enabled, picker-visible, tool-capable chat models; suffix every selector with its context size and create threshold/full pairs when billing tiers differ.
- Persist successful catalogs atomically in the provider-scoped store, restore them for offline/aborted refreshes, and use the hardcoded GPT table only as a bootstrap fallback.
- Do not send `X-GitHub-Api-Version` to raw Copilot discovery or inference without endpoint-specific evidence.
- Never log PATs, authorization headers, discovery bodies, or full request headers.
- Treat raw `copilot_internal/*` and `*.githubcopilot.com` use as experimental in user documentation.
- Keep `X-GitHub-Api-Version: 2026-06-01` scoped to the `/models` inventory call; never send it on inference.
- Cross-check model thresholds and prices against GitHub's public pricing page, and cover entitlement filtering plus every selector/wire mapping with tests.
- Verify normal requests, manual/automatic compaction, and tree summaries retain the same endpoint and real wire model ID when Pi/provider integration changes.
