# Pi Copilot Context Variants

Keep Pi's GitHub Copilot picker aligned with Copilot's live context tiers,
output limits, and token pricing—without replacing Pi's OAuth or streaming.

The extension is intentionally narrow: it wraps Pi's built-in `github-copilot`
provider through Pi's native provider API, delegates its authentication and
streaming, and overlays live GitHub Copilot `/models` metadata.

See also: [`docs/research.md`](docs/research.md) for the issue background,
source links, upstream Pi/model metadata context, and the research trail that led
to this implementation.

## The issue this fixes

Pi's built-in GitHub Copilot model list is generated from static metadata. That
metadata can lag behind Copilot's live model picker, especially for model IDs,
context-window tiers, and the token-pricing data introduced with Copilot's
2026-06-01 API version.

Two symptoms motivated this extension:

- Pi may not show the same high-context model choices as the official Copilot
  CLI/model picker. In particular, Copilot can expose a lower/default context
  tier and a higher long-context tier for what is otherwise the same model.
- Pi can only estimate usage cost from the static `model.cost` data available on
  the selected model. If Copilot's live pricing tiers are newer than Pi's
  catalogue, Pi can undercount or misrepresent the cost for long-context
  variants.

The original compaction failure that triggered the investigation was an output
limit stop, not proof of a context-window stop. It did, however, expose the
underlying model-metadata problem: Pi needs accurate context limits before it can
make good compaction/reserve decisions, and Copilot's official picker has more
current context/pricing information than Pi's static catalogue.

## What it changes

- Preserves Pi's built-in model definitions for known Copilot models.
- Patches live context and output-token limits from Copilot `/models`.
- Reads the versioned Copilot API (`X-GitHub-Api-Version: 2026-06-01`) for the
  post-June-2026 token-pricing metadata.
- Exposes default and expanded context tiers as distinct picker IDs. Expanded
  `*-1m` picker aliases map back to the real Copilot API model ID before the
  request is sent.
- Converts Copilot AI Credit pricing into Pi's standard model `cost` shape,
  including request-wide long-context tiers above Copilot's prompt threshold.
- Keeps distinct default and expanded selectors on supported models even when
  their per-token prices are identical.
- Adds Copilot-GPT-only proactive compaction using Copilot's billing-tier
  context budget and Codex-style thresholds, while still displaying Copilot's
  live total context window.

## How it works

At extension load time, the plugin registers a native `github-copilot` provider
that delegates authentication and streaming to Pi's built-in provider. Pi first
restores the extension's last successful model catalogue from its provider model
store, making persisted `*-1m` aliases available during startup scope resolution.
Pi's normal model-refresh lifecycle then performs live discovery when network
access and a Copilot credential are available. During discovery, the plugin:

1. Uses the effective Copilot credential, network policy, and abort signal that
   Pi supplies. The extension never reads, refreshes, writes, or logs credentials.
2. Fetches Copilot `/models` twice:
   - without `X-GitHub-Api-Version`, which currently reflects the ordinary
     picker-visible default model list/limits;
   - with `X-GitHub-Api-Version: 2026-06-01`, which exposes the newer long
     context limits and token billing data.
3. Loads Pi's built-in `github-copilot` provider from the extension-supported
   `@earendil-works/pi-ai/providers/all` catalogue entry point.
4. Builds a merged model list:
   - known Pi models keep Pi's API type, reasoning flags, thinking maps,
     image support, compatibility flags, and provider behavior;
   - volatile live fields are overlaid from Copilot (`contextWindow`,
     `maxTokens`, picker-visible IDs, and `cost`);
   - live-only models are classified conservatively when Pi has no built-in
     definition;
   - when Copilot exposes two tiers under one API model ID, the default keeps
     the real ID and the expanded tier receives a `*-1m` picker alias.
5. Uses the native provider's public `filterModels` hook so Copilot's credential
   filter checks an alias's real request model ID, then rewrites the outgoing
   payload's model field back to that real ID. Pi's OAuth and streaming remain
   unchanged.
6. Atomically returns and persists the merged list through Pi's provider model
   store. Network, schema, empty-catalogue, and abort failures leave the previous
   catalogue unchanged.
7. Registers a narrow `agent_end` compaction trigger for Copilot GPT Responses
   models only. It compacts after Copilot's billing-tier prompt budget reaches
   90%, matching Codex's auto-compaction policy, and leaves Pi's default
   compaction behavior untouched for every other provider/model.

The important compatibility point: this is not a Copilot implementation fork.
It is a native provider wrapper that delegates to Pi's built-in Copilot auth and
streaming while owning the dynamic catalogue and alias filter through public Pi
0.81 APIs. The outgoing payload rewrite only changes an alias back to its real
Copilot model ID. The only compaction change is the Copilot-GPT-specific
post-turn trigger described below; Pi's normal compaction implementation still
does the actual summarization/rewrite.

For current Copilot GPT models, the versioned API exposes both a total expanded
context window and a separate maximum prompt budget. For example, `gpt-5.5`
currently reports a `1.05M` total window, a `922000` maximum prompt, and a
`128000` maximum output.

Pi `0.81.0` natively compacts when usage exceeds
`contextWindow - reserveTokens`; the default reserve is only `16384`. With a
`1.05M` total window, native compaction would therefore happen after roughly
`1.033M` tokens—later than Copilot's `922000` prompt ceiling. `maxTokens` does
not increase Pi's compaction reserve. That mismatch is why the extension keeps
its narrow prompt-budget guard rather than relying on the total window alone.

The extension also stores that Copilot billing-tier budget on each Copilot GPT
model as `copilotContextBudget`. For current `gpt-5.5`, that means:

```text
display context window: 1050000
Copilot long_context max prompt: 922000
effective prompt window: floor(922000 * 0.95) = 875900
auto-compaction threshold: floor(922000 * 0.90) = 829800
reserved response/headroom buffer: 1050000 - 875900 = 174100
```

Set `PI_COPILOT_CONTEXT_AUTO_COMPACT=0` before launching Pi to disable this
extension's proactive compaction trigger.

## Pricing units

Copilot's 2026-06-01 `/models` response reports token prices as **AI Credits**
per `batch_size` tokens. Copilot defines 1 AI Credit as **$0.01 USD**.

Pi's `model.cost` fields are **USD per 1M tokens**. The extension converts with:

```text
usd_per_1m_tokens = (ai_credits / 100) * (1_000_000 / batch_size)
```

For the current Copilot payloads, `batch_size` is usually `1_000_000`, so the
conversion normally reduces to `ai_credits / 100`.

The extension maps `token_prices.default` to Pi's base model cost. When
`token_prices.long_context` has different rates, the expanded selector receives
Pi's request-wide `cost.tiers` entry with `inputTokensAbove` set to the default
tier's `context_max`. Selecting a 1M model therefore does not apply the higher
rate until the request crosses Copilot's published threshold. Models such as
Claude retain distinct default and 1M selectors even when both tiers have the
same prices.

If Copilot omits billing data for a model, the extension falls back to Pi's
built-in cost metadata. For live-only models with no Pi definition and no
Copilot billing, it uses zero cost rather than inventing a price.

Models.dev does not currently expose all of Copilot's context variants/pricing
tiers that this extension needs. That is expected to change eventually; when it
does, Pi's generated catalogue should be able to carry this data directly and
this local extension should become unnecessary.

## Requirements

- Pi `0.81.x` (tested with `0.81.0`)
- Node.js `22.19.0` or newer (the same minimum as current Pi)
- A GitHub Copilot account already connected through Pi

## Installation

The two RogueKernel Pi extensions live in one shared Git repository. Clone it
once and register both package directories. `pi-orca-subagents` also requires
`pi-subagents`, installed here from its Git repository:

```bash
pi install https://github.com/nicobailon/pi-subagents
install_root="${XDG_DATA_HOME:-$HOME/.local/share}/roguekernel-pi-work"
git clone https://github.com/RogueKernel/roguekernel-pi-work.git "$install_root"
pi install "$install_root/packages/pi-copilot-context-variants"
pi install "$install_root/packages/pi-orca-subagents"
```

If the shared repository is already cloned for another package, skip the
`git clone` command.

For project-local installation instead:

```bash
pi install "$install_root/packages/pi-copilot-context-variants" -l --approve
```

If Pi is already running, restart it or run `/reload` after installation or code
changes.

Startup first restores the last successful catalogue from Pi's provider model
store, including alias metadata and compaction budgets. Pi's model refresh
lifecycle performs live discovery using the effective Copilot credential. Failed
refreshes retain the built-in or last successful persisted catalogue.

## Verify

```bash
npm test
npm run check
```

Expected signs that the extension is active:

- The in-session model selector shows both the real/default Copilot model ID and
  a `*-1m` expanded-context alias when Copilot reports distinct tiers.
- Known Pi models retain their normal reasoning/image/API behavior.
- Expanded models use default prices below Copilot's prompt threshold and
  `long_context` prices above it when those rates differ.

To simulate a logged-out Pi agent directory without touching your real auth:

```bash
tmp_agent_dir="$(mktemp -d "${TMPDIR:-/tmp}/pi-copilot-context.XXXXXX")"
PI_CODING_AGENT_DIR="$tmp_agent_dir" pi --list-models github-copilot
case "$tmp_agent_dir" in
  "${TMPDIR:-/tmp}"/pi-copilot-context.*) rm -rf -- "$tmp_agent_dir" ;;
  *) printf 'Refusing unsafe cleanup: %s\n' "$tmp_agent_dir" >&2 ;;
esac
```

With no Copilot auth, the extension should do nothing and Pi should fall back to
its normal built-in provider behavior.

## Security and privacy

Pi packages run with the user's system permissions. This extension makes
authenticated requests only to GitHub Copilot's token-provided API endpoint and
does not log, store, or modify Copilot credentials. Review the source before
installing, as you should for any Pi extension.

## Design notes

The runtime is split along its real change boundaries:

- `src/pi-copilot-context-variants.js` owns discovery, provider wiring, and the
  stable extension facade;
- `src/model-catalog.js` owns live model normalization, pricing, selector
  aliases, and context-budget construction;
- `src/auto-compaction.js` owns the Copilot-GPT prompt-budget policy and its
  narrow lifecycle hook.

The package intentionally supports the pinned Pi/@earendil-works/pi-ai 0.81.x
contract. A broader compatibility claim requires tests against both ends of the
proposed range and a deliberate host-aligned provider strategy.

The extension borrows the two useful ideas from previous community approaches:

- Preserve Pi's built-in model definitions and patch only volatile live metadata.
- Discover current Copilot picker models from `/models`.

It deliberately avoids replacing Pi's OAuth flow, request streaming logic,
reasoning compatibility rules, or model catalogue generator. Once Pi/models.dev
include current Copilot context variants and billing data, this extension should
be deleted rather than expanded.

Relevant local Pi implementation areas:

- `@earendil-works/pi-ai/dist/providers/github-copilot.models.js`: generated
  built-in GitHub Copilot model metadata.
- `@earendil-works/pi-ai/dist/models.js`: `calculateCost`, where Pi multiplies
  usage by `model.cost`.
- `pi-coding-agent/dist/core/compaction/compaction.js`: compaction thresholds
  and reserve-token behavior.
- `pi-coding-agent/dist/core/agent-session.js`: session-level compaction and
  context-overflow checks.
