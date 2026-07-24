# Investigation and design record

Last reviewed: 2026-07-24.

## Decision

`custom-github-copilot` is a separate PAT-only Pi provider. Its authoritative
catalog comes from the PAT-visible Copilot `/models` inventory; a small,
hardcoded set of pricing-threshold GPT variants is used only during bootstrap or
when no persisted live catalog is available.

It deliberately does not decorate or replace Pi's built-in `github-copilot`
provider. Pi scopes provider composition, credentials, and model storage by
provider ID; sharing the built-in ID caused the previous
`pi-copilot-context-variants` implementation to compete with Pi for ownership.

## Authentication evidence

GitHub documents environment-variable authentication for Copilot CLI as the
recommended non-interactive/CI approach. Supported credentials include a
user-owned fine-grained PAT (`github_pat_`) with the **Copilot Requests** account
permission. GitHub documents classic PATs (`ghp_`) as unsupported:

- <https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli>
- <https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens>

The primary setup path is Pi's `/login` API-key provider selector, which stores
the PAT under `custom-github-copilot`. The extension also accepts the distinct
`CUSTOM_GITHUB_COPILOT_TOKEN` variable for CI. It does not use
`COPILOT_GITHUB_TOKEN`, so Pi's built-in provider cannot consume the fallback.
Pi's stored provider credential takes precedence over the environment variable.

## Endpoint discovery and support status

On the first request for a PAT, the provider-local transport sends it to
`https://api.github.com/copilot_internal/user`. The returned `endpoints.api`
origin is cloned onto that request model and cached in memory for later requests
using the same PAT. The origin must use HTTPS and be `githubcopilot.com` or a
subdomain. Userinfo, paths, query strings, and fragments are rejected.

`copilot_internal/user` and raw `*.githubcopilot.com` inference are not a stable,
documented developer API. The provider is therefore experimental. The GA
[Copilot SDK](https://github.com/github/copilot-sdk) or documented
[GitHub Models inference API](https://docs.github.com/en/rest/models/inference?apiVersion=2026-03-10)
should be preferred when they meet the use case.

GitHub's Copilot CLI documentation proves that the CLI accepts a fine-grained
PAT; it does not establish whether the CLI sends that PAT unchanged to raw CAPI
inference. Direct PAT inference therefore remains an experimental integration
risk that must be smoke-tested in each target account.

Pi's generic transports add dynamic Copilot headers only when the provider ID
is exactly `github-copilot`. This provider intentionally has a different ID.
V1 consequently advertises text only and retains a minimal static compatibility
header set pending smoke testing. In particular, it does not claim image support
without the dynamically required `Copilot-Vision-Request` header.

## API-version headers

The extension sends no `X-GitHub-Api-Version` header to endpoint discovery or
raw Copilot inference. `2025-05-01` is not a current public GitHub REST API
version, and there is no endpoint-specific evidence that it belongs on these
private inference calls. Public GitHub REST versioning is documented separately:

- <https://docs.github.com/en/rest/about-the-rest-api/api-versions>
- <https://api.github.com/versions>

Do not add a public REST version such as `2026-03-10`, or Pi's private Copilot
model-inventory value `2026-06-01`, to inference by analogy.

## Pricing source and catalog choice

GitHub's public pricing table is the human-readable reference for thresholds and
prices:

- <https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing>

The 2026-07-24 table lists these higher-price input thresholds:

- GPT-5.4: `>272K`
- GPT-5.5: `>272K`
- GPT-5.6 Luna: `>200K`
- GPT-5.6 Sol: `>272K`
- GPT-5.6 Terra: `>272K`
- Gemini 3.1 Pro: `>200K`

The implementation uses the PAT-visible private `/models` response as its live
source of entitlement, context limits, and billing tiers. `2026-06-01` is sent
only to this inventory endpoint; it is never copied onto inference. The live
catalog is filtered to enabled, picker-visible, tool-capable chat models.

Every selector ID has an explicit context suffix. Models with different default
and long-context prices receive a threshold selector plus a full-context
selector. Full-context selectors use Pi's request-wide `cost.tiers` metadata so
estimates retain default pricing below the threshold and switch above it.

Pi's generated Copilot definitions supply API and compatibility metadata for
known IDs. This avoids rediscovering protocol quirks while allowing the PAT to
remain authoritative about availability. Live-only models use a conservative
family classifier. Successful catalogs are written atomically to the
provider-scoped model store; failed/offline refresh restores the last successful
generation, with the hardcoded GPT table as the final bootstrap fallback. Normal
picker refreshes prefer the cache immediately; an explicit forced model update
performs the network refresh.

A live Enterprise check on 2026-07-24 completed endpoint plus model discovery in
approximately 1.4 seconds, returned 39 raw entries, and projected 32 suffixed
selectors after excluding non-picker, embedding, completion-only, and utility
entries.

## Synthetic IDs and compaction

Pi identifies a model by provider plus `model.id`, and its extension model
configuration has no separate `requestModelId`. Synthetic picker IDs therefore
require one translation seam. A module-local map rewrites only the outbound
payload's `model` field when `ctx.model.provider === "custom-github-copilot"`.

Pi's standard compaction trigger is approximately:

```text
estimated context tokens > model.contextWindow - compaction.reserveTokens
```

With the default 16,384-token reserve, a 272,000 context window triggers near
255,616 estimated tokens. The extension does not add custom compaction logic.
This remains an estimate and cannot guarantee GitHub's billed input count.

## Pi issue #6768

Issue: <https://github.com/earendil-works/pi/issues/6768>

The observed failure occurs when OAuth produces a credential-specific base URL,
normal inference copies it onto a request model, and compaction's second auth
pass loses it. The separate provider avoids those known conditions by using no
OAuth and returning no `baseUrl` from authentication. Its provider-local
transport resolves the endpoint from the request's PAT and clones it onto the
request model immediately before delegating to Pi's OpenAI Responses streamer.

Regression checks must cover normal inference, manual and automatic compaction,
and tree summaries. If any path sends a synthetic ID or routes to an Individual
endpoint, this workaround has failed.

The recommended post-install smoke suite is one normal text request, one tool
follow-up, manual `/compact`, automatic compaction where practical, and a
`/tree` summary. Log only sanitized destination origins/paths, model IDs, header
names, and HTTP statuses during that test—never token or header values.

## Deferred features

### User model overrides

Deferred. A useful override format would need to validate selector ID, wire ID,
API protocol, context threshold, output limit, cost, and compatibility metadata.
That is not a trivial v1 setting.

### Image support

Deferred. Pi's generic transports add Copilot's vision header only for the
built-in provider ID. The custom provider remains text-only until that behavior
has a tested provider-local adapter.
