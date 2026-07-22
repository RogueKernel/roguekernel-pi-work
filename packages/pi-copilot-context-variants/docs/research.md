# Research Notes

These notes capture why this local Pi extension exists, what upstream behavior
it is working around, and which sources informed the implementation.

## Summary

Pi's `github-copilot` provider has a generated static model catalogue. That is a
good default, but Copilot's live model picker can expose newer model metadata
before Pi or models.dev have caught up. The stale/partial metadata matters for:

- context windows used by Pi's context accounting and compaction decisions;
- max output token limits;
- model IDs shown in Pi's default model selector;
- post-2026-06-01 Copilot token pricing tiers;
- long-context model choices that can cost differently from default-context
  choices.

This extension exists as a temporary metadata overlay. It should be removed when
Pi's generated catalogue and/or models.dev include the same data directly.

## Current Pi compatibility

This repository was updated against Pi and `@earendil-works/pi-ai` `0.81.0`.
The extension registers a complete native provider through Pi's public
`registerProvider(provider)` API. That provider delegates authentication and
streaming to Pi's built-in Copilot provider while owning model filtering and
refresh through `createProvider()`.

Pi performs a cache-only provider refresh before resolving startup model scopes.
`createProvider()` restores the last successful dynamic catalogue from Pi's
provider-scoped model store during that refresh, so persisted `*-1m` aliases are
available to `enabledModels`, `--models`, and `--list-models`. Later
network-enabled refreshes receive Pi's effective credential, network policy,
abort signal, and store. Successful catalogues are persisted atomically; failed,
aborted, malformed, or empty refreshes retain the previous catalogue.

Recent Pi releases now cover some of the original workarounds:

- Pi `0.80.4` fixed Copilot extended-context metadata and invalid tiny
  OpenAI Responses output-token caps.
- Pi `0.80.6` added request-wide long-context pricing tiers.
- Pi `0.80.8` added the canonical provider model-refresh lifecycle.

The extension therefore retains only the behavior still supplied by live
Copilot data: picker-visible IDs, live limits and token prices, and the narrow
Copilot GPT billing-budget compaction policy.

Copilot credentials advertise real API model IDs only, while Pi has no separate
picker ID and request-model ID. The extension therefore gives expanded tiers
`*-1m` picker aliases, stores the real Copilot ID on each alias, applies its
alias-aware policy through the native provider's public `filterModels` hook, and
rewrites the outgoing payload model back to the real ID. It continues to use
Pi's built-in OAuth and streaming implementations.

## Original failure mode

The investigation started from a Pi session using GitHub Copilot Claude Opus
4.8 with high thinking. Pi reported an output token limit stop, then compacted a
large session, and a later manual `/compact` returned `Nothing to compact`.

The important distinction:

- `Model stopped because it reached the maximum output token limit` is an output
  limit stop, not a context-window stop.
- `Nothing to compact` after a manual `/compact` can be expected if Pi already
  compacted the session moments earlier.

However, the failure exposed a real metadata issue. If Pi's model context limit
does not match Copilot's actual selected context tier, Pi's compaction threshold
and user-facing model choices can be wrong even when the immediate stop reason
is output length.

A later failure with a Copilot GPT Responses model showed the sharper edge of
that mismatch: older Pi versions could compute an invalid tiny output budget.
Pi `0.80.4` fixed that upstream, so this extension no longer carries its own
request-time output-cap workaround.

Copilot's live API exposes three relevant values for current GPT models. With
the `2026-06-01` API version, `gpt-5.5` currently reports a `1050000` total
context window, a `922000` maximum prompt, and a `128000` maximum output. The
ordinary endpoint reports the same real model ID with a `400000` total and a
`272000` maximum prompt. The extension exposes both tiers as `gpt-5.5` and
`gpt-5.5-1m`; both send `gpt-5.5` to Copilot, while the alias retains its own
limits, pricing, headers, and compaction budget inside Pi.

Pi `0.81.0` compacts at `contextWindow - reserveTokens`, with a default reserve
of `16384`; `maxTokens` does not increase that reserve. A `1050000` total window
would therefore compact around `1033616`, after Copilot's `922000` maximum
prompt. Because Pi does not expose a provider-specific compaction reserve, the
extension adds the narrowest extension-level mitigation available:
after each agent turn, only for Copilot GPT/OpenAI Responses models, it compares
the latest reported session usage with a Codex-style auto-compaction threshold
derived from Copilot's prompt budget. For expanded `gpt-5.5`, that is
`floor(922000 * 0.90) = 829800` tokens. The extension also records the inferred
effective prompt window (`floor(context_max * 0.95)`) and response/headroom
buffer on model metadata as `copilotContextBudget`, while keeping the picker and
Pi model list on Copilot's displayed total context window (`1.05M`).

## Native compaction endpoint probe

The OpenAI Codex CLI uses a native compaction endpoint under
`/responses/compact`, with a Codex variant under `/codex/responses/compact`.
Those routes would have allowed native Responses compaction if the Copilot proxy
exposed them.

On 2026-07-09, this extension's Copilot token resolved to
`https://api.enterprise.githubcopilot.com`. A live probe with a deliberately
minimal body returned `404 page not found` for all of these paths:

```text
/responses/compact
/codex/responses/compact
/openai/responses/compact
```

That indicates the current Copilot proxy endpoint available to this account does
not expose OpenAI/Codex native compaction routes. The extension therefore does
not contain any native compaction client, Codex-adapter configuration, or
`/responses/compact` request path. It keeps the provider-local proactive Pi
compaction trigger instead of depending on a native compaction POST.

## What Copilot exposes

The live Copilot `/models` endpoint can expose fields that are newer or richer
than Pi's static catalogue:

- `model_picker_enabled`
- `policy.state`
- `capabilities.type`
- `capabilities.family`
- `capabilities.supports.vision`
- `capabilities.limits.max_context_window_tokens`
- `capabilities.limits.max_output_tokens`
- `capabilities.limits.max_prompt_tokens`
- `billing.token_prices.default`
- `billing.token_prices.long_context`

The versioned request is important:

```http
X-GitHub-Api-Version: 2026-06-01
```

Copilot changed pricing around 2026-06-01 from a request-like credit model to a
token-usage model. Pre-2026-06-01 pricing data is therefore not authoritative
for current token-cost estimation.

## Context tiers

The official Copilot CLI/model picker can show different context choices. In
practice, Copilot may expose these as separate model IDs in some data sources or
as different pricing/context tiers for the same underlying API model ID.

Pi `0.81.0` filters model IDs that are not listed by the Copilot credential.
The extension keeps both picker choices by checking aliases against their real
request ID and rewriting the payload before transmission:

```text
claude-opus-4.8     -> Copilot model claude-opus-4.8, default headers
claude-opus-4.8-1m  -> Copilot model claude-opus-4.8, 2026-06-01 headers
```

This preserves distinct limits and pricing in Pi without replacing Copilot OAuth
or the built-in streaming implementations. The alias policy now uses Pi 0.81's
public native-provider `filterModels` hook rather than model-registry internals.

## Pricing conversion

Copilot reports pricing in AI Credits per `batch_size` tokens. Copilot defines:

```text
1 AI Credit = $0.01 USD
```

Pi expects model cost values in USD per 1M tokens:

```text
model.cost = {
  input: usd_per_1m_input_tokens,
  output: usd_per_1m_output_tokens,
  cacheRead: usd_per_1m_cache_read_tokens,
  cacheWrite: usd_per_1m_cache_write_tokens
}
```

The conversion used by the extension is:

```text
usd_per_1m_tokens = (ai_credits / 100) * (1_000_000 / batch_size)
```

For current Copilot payloads, `batch_size` is usually `1_000_000`, so this is
normally `ai_credits / 100`.

The extension stores the default rates as Pi's base `cost`. When the long-context
rates differ, it adds them to `cost.tiers` with `inputTokensAbove` set to the
default billing tier's `context_max`. Pi then applies the higher rates to the
entire request only after that threshold is exceeded. Separate smaller and 1M
selectors remain available even when the rates are identical, preserving an
intentional bounded-context choice.

Observed examples that validate the conversion:

| Copilot field | AI Credits | Pi cost |
| --- | ---: | ---: |
| Claude Opus input | 500 | 5.00 |
| Claude Opus output | 2500 | 25.00 |
| Claude Opus cache read | 50 | 0.50 |
| Claude Opus cache write | 625 | 6.25 |
| GPT 5.4 default input | 250 | 2.50 |
| GPT 5.4 long-context input | 500 | 5.00 |
| GPT 5.4 default output | 1500 | 15.00 |
| GPT 5.4 long-context output | 2250 | 22.50 |

## Relationship to models.dev

Pi's built-in model catalogue is generated from static model metadata. Models.dev
is one upstream source for that kind of metadata, but it does not yet include all
of the Copilot long-context variants/pricing tiers needed here.

The relevant models.dev issue says these context variants are exposed as
different model IDs in model metadata work:

- <https://github.com/anomalyco/models.dev/issues/2021>

Until that data is available to Pi's generated catalogue, this extension reads
Copilot's live endpoint and overlays the volatile fields locally. Once upstream
data is current, this extension should be redundant.

## Community approaches reviewed

Two community approaches were especially useful:

1. Runtime Copilot model-limit patching while preserving Pi's built-in provider
   metadata.
2. Copilot model discovery that reads live picker-enabled models from
   Copilot `/models`.

This extension combines those approaches but keeps the scope narrower than a
provider fork:

- Keep Pi's built-in model behavior for known models.
- Overlay only volatile live metadata.
- Apply the expanded tier to real Copilot model IDs.
- Convert Copilot billing into Pi's standard cost fields.

## Source links

### Directly relevant implementation/research sources

- Copilot limits extension/patch by hoesler:
  <https://github.com/hoesler/agent-stuff/blob/main/pi/extensions/copilot-model-limits/index.ts>
- Pi issue: Copilot context-window selection/model picker support:
  <https://github.com/earendil-works/pi/issues/5064>
- Pi issue: stale/wrong Copilot model limits around Claude 4.6 1M metadata:
  <https://github.com/earendil-works/pi/issues/4708>
- Pi PR: runtime Copilot model-limit fetching attempt:
  <https://github.com/earendil-works/pi/pull/2527>
- Oh My Pi issue: `max_prompt_tokens` vs `max_context_window_tokens` confusion:
  <https://github.com/can1357/oh-my-pi/issues/1539>
- Models.dev issue for Copilot context variants/model IDs:
  <https://github.com/anomalyco/models.dev/issues/2021>
- Models.dev homepage/catalogue:
  <https://models.dev>

### Extension/package links reviewed during package survey

- Pi package: `@milespossing/pi-copilot-discovery`:
  <https://pi.dev/packages/@milespossing/pi-copilot-discovery?name=copilot>
- GitHub repo: `milespossing/pi-copilot-discovery`:
  <https://github.com/milespossing/pi-copilot-discovery>
- Pi package: `pi-model-filter`:
  <https://pi.dev/packages/pi-model-filter?name=copilot>
- GitHub repo: `clankercode/pi-model-filter`:
  <https://github.com/clankercode/pi-model-filter>
- Pi package: `@latentminds/pi-quotas`:
  <https://pi.dev/packages/@latentminds/pi-quotas?name=copilot>
- GitHub repo: `latentminds-ai/pi-quotas`:
  <https://github.com/latentminds-ai/pi-quotas>
- Pi package: `pi-copilot-queue`:
  <https://pi.dev/packages/pi-copilot-queue?name=copilot>
- npm package: `pi-copilot-queue`:
  <https://www.npmjs.com/package/pi-copilot-queue>
- Pi package: `copilot-credit-usage`:
  <https://pi.dev/packages/copilot-credit-usage?name=copilot>
- npm package: `copilot-credit-usage`:
  <https://www.npmjs.com/package/copilot-credit-usage>
- Pi package: `pi-copilot-usage`:
  <https://pi.dev/packages/pi-copilot-usage?name=copilot>
- GitHub repo: `DxVapor/pi-copilot-usage`:
  <https://github.com/DxVapor/pi-copilot-usage>
- Pi package: `@atomic-ai/msco-pi-lot`:
  <https://pi.dev/packages/@atomic-ai/msco-pi-lot?name=copilot>
- npm package: `@atomic-ai/msco-pi-lot`:
  <https://www.npmjs.com/package/@atomic-ai/msco-pi-lot>
- Pi package: `msco-pi-lot`:
  <https://pi.dev/packages/msco-pi-lot?name=copilot>
- npm package: `msco-pi-lot`:
  <https://www.npmjs.com/package/msco-pi-lot>
- Pi package: `pi-pilot`:
  <https://pi.dev/packages/pi-pilot?name=copilot>
- GitHub repo: `stakira/pi-pilot`:
  <https://github.com/stakira/pi-pilot>
- Pi package: `pi-ghcp-headers`:
  <https://pi.dev/packages/pi-ghcp-headers?name=copilot>
- npm package: `pi-ghcp-headers`:
  <https://www.npmjs.com/package/pi-ghcp-headers>

### Screenshot reference

The official Copilot model picker screenshot used during the investigation came
from a private `private-user-images.githubusercontent.com` URL with an expiring
JWT query string. Do not commit that full URL into this repository. It was useful
only as a transient visual confirmation that the official picker displays
up-front credit prices by context tier.

## Pi source files inspected

These package-relative implementation areas were inspected while validating
compatibility; they are not runtime paths used by this extension:

- `@earendil-works/pi-ai/dist/providers/github-copilot.models.js`
- `@earendil-works/pi-ai/dist/models.js`
- `pi-coding-agent/dist/core/agent-session.js`
- `pi-coding-agent/dist/core/compaction/compaction.js`
- `pi-coding-agent/dist/modes/interactive/components/model-selector.js`
- `pi-coding-agent/dist/modes/interactive/components/footer.js`
