# Temporary Copilot metadata overlay

Prefer deletion when Pi/models.dev catches up over expanding this into a
permanent Copilot implementation.

- Preserve Pi's built-in Copilot auth, streaming, compatibility metadata, model
  selection, provider store, and `ctx.compact()` implementation.
- Register through Pi's native provider API. Delegate auth/streaming to the
  built-in provider; own only live metadata, alias filtering, and refresh.
- Keep `*-1m` picker aliases mapped to real Copilot request IDs and cover both
  credential filtering and payload rewriting with tests.
- Overlay only live limits, output caps, picker IDs, and pricing. Preserve
  built-in costs when billing data is absent.
- Apply `long_context` rates through request-wide `cost.tiers` only above the
  default tier's `context_max`.
- Keep proactive compaction limited to Copilot GPT prompt-budget protection.
- Never log credentials, auth payloads, or full request headers.
- Keep `README.md` and `docs/research.md` synchronized with behavior and sources.
- Run `npm run check` before completion. For no-auth tests, use a dedicated,
  prefix-guarded temporary directory; never clean up through
  `PI_CODING_AGENT_DIR` itself.
