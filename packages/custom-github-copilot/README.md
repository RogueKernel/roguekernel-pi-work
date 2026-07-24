# Custom GitHub Copilot for Pi

A small Pi extension that adds a separate `custom-github-copilot` provider. It
authenticates with a fine-grained GitHub personal access token (PAT), not OAuth,
and does not replace or read credentials from Pi's built-in `github-copilot`
provider.

> [!WARNING]
> This private package uses undocumented Copilot discovery, catalog, and
> inference endpoints. GitHub may change them without notice. Install it only
> from a source you trust.

## Why use it?

The provider discovers every picker-visible, tool-capable chat model allowed by
the PAT and gives every selector an explicit context suffix. Models with a
higher-priced long-context tier receive two selectors, for example:

| Pi selector | Copilot request model | Declared context |
| --- | --- | ---: |
| `gpt-5.6-sol-272k` | `gpt-5.6-sol` | 272,000 |
| `gpt-5.6-sol-1m` | `gpt-5.6-sol` | 1,000,000 |

The lower selector encourages Pi to compact before crossing GitHub's pricing
threshold. With Pi's default 16,384-token reserve, a 272K model normally
compacts around 255,616 estimated tokens. Pi's estimate is not GitHub's billed
token count, so this is a guardrail—not a billing guarantee.

The PAT-visible Copilot `/models` inventory is authoritative. A small hardcoded
GPT catalog is used only until a live catalog has been persisted or when no
persisted catalog is available offline.

## Requirements

- Node.js 22.19 or newer.
- A paid Copilot plan whose organization policy permits Copilot model use.
- A user-owned **fine-grained PAT** with the **Copilot Requests** account
  permission. Classic `ghp_` PATs are not supported.

## Create the PAT

1. Open <https://github.com/settings/personal-access-tokens/new>.
2. Select your **personal account** as the resource owner. GitHub exposes
   Copilot Requests only on user-owned fine-grained PATs.
3. Choose the minimum repository access needed for your work.
4. Under **Account permissions**, add **Copilot Requests**.
5. Choose a short expiration, generate the token, and copy it immediately.

Start with only **Copilot Requests**, GitHub's documented minimum for Copilot
CLI. The private endpoints used here are not a stable contract, so GitHub may
change their requirements. Organization policy may also require approval or
prohibit access. See GitHub's current
[Copilot CLI authentication instructions](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli#authenticating-with-environment-variables).

## Install and configure

Install from a clone of this repository:

```sh
pi install /absolute/path/to/roguekernel-pi-work/packages/custom-github-copilot
```

**Fully quit and restart Pi after installing or updating.** `/reload` does not
reliably replace already-loaded provider and catalog state.

Store the PAT using Pi's credential flow:

1. Run `/login`.
2. Select **Sign in with an API key**.
3. Select **Custom GitHub Copilot**.
4. Paste the fine-grained PAT.

Then open `/models` and choose a model such as:

```text
custom-github-copilot/gpt-5.6-sol-272k
```

Pi stores the PAT under the separate provider ID. The extension implements no
device flow, OAuth token exchange, or refresh flow.

### CI and non-interactive use

CI can provide the same PAT through `CUSTOM_GITHUB_COPILOT_TOKEN`:

```sh
CUSTOM_GITHUB_COPILOT_TOKEN='github_pat_...' pi -p 'Your prompt'
```

A PAT stored through `/login` takes precedence. Use a CI secret store; never
commit a token to settings, workflows, shell startup files, or logs.

## Catalog refresh

Normal model-picker opens immediately restore the last successful catalog.
`pi update --models` forces a fresh entitlement check. Failed, offline, or
aborted refreshes keep the persisted generation.

Pi refreshes all dynamic providers under one global deadline. Therefore,
`Model refresh timed out; showing cached models` may be caused by another
provider even though this provider's cached catalog remains available.

## Pi issue #6768

[Pi issue #6768](https://github.com/earendil-works/pi/issues/6768) loses an
OAuth-derived Enterprise endpoint on compaction or summary requests. This
provider avoids the known preconditions:

- it has a separate provider ID and no OAuth resolver;
- authentication returns only the PAT, never a credential-derived `baseUrl`;
- its local transport resolves and validates the PAT-specific endpoint; and
- that endpoint and the real Copilot model ID are applied to every request,
  including compaction and tree summaries.

This is an architectural workaround, not a Pi fix. Recheck normal turns,
`/compact`, automatic compaction, and `/tree` after Pi upgrades.

## Current limitations

- Raw Copilot inference with this PAT path remains an undocumented contract.
- The provider advertises text only; image requests need Copilot-specific vision
  headers that are not yet implemented for the separate provider ID.
- User-defined model overrides are intentionally deferred.
- The inventory-only `X-GitHub-Api-Version: 2026-06-01` header is never sent to
  discovery or inference. No generic `2025-05-01` header is used.

See [`docs/research.md`](docs/research.md) for evidence, pricing details, and
design constraints.

## Development

```sh
npm run check --workspace custom-github-copilot
```

Tests use mocked GitHub responses and never require a real PAT.
