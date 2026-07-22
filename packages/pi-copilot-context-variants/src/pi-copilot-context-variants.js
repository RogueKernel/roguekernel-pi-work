/**
 * GitHub Copilot context variants for Pi.
 *
 * Design goals:
 * - Preserve Pi's built-in github-copilot model metadata for known models.
 * - Patch normal/default models with the normal Copilot /models limits.
 * - Patch Copilot token pricing from the 2026-06-01 /models payload while
 *   keeping Pi's cost shape (USD per 1M tokens) intact.
 * - Add live picker-enabled models that Pi does not know about yet.
 * - Expose default and expanded context tiers as distinct picker IDs.
 * - Map picker-only context aliases back to real Copilot API model IDs.
 * - Avoid replacing Pi's OAuth lifecycle or provider streaming.
 */

import { createProvider } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";

import {
	buildModels,
	COPILOT_HEADERS,
	EXPANDED_CONTEXT_API_VERSION,
	filterCopilotModelsForCredential,
	PROVIDER,
	rewriteCopilotRequestPayload,
} from "./model-catalog.js";
import { registerCopilotAutoCompaction } from "./auto-compaction.js";

export {
	billingTier,
	buildModels,
	classifyLiveOnly,
	clonedFromBuiltIn,
	contextBudgetFromBilling,
	contextVariantBaseId,
	costFromBilling,
	costFromBillingWithTiers,
	COPILOT_AUTO_COMPACT_PERCENT,
	COPILOT_EFFECTIVE_CONTEXT_PERCENT,
	dateBaseId,
	displayName,
	filterCopilotModelsForCredential,
	isPickerChatModel,
	liveLimits,
	liveOnlyModel,
	normalizeCopilotLimits,
	rewriteCopilotRequestPayload,
	tierLimits,
} from "./model-catalog.js";
export {
	evaluateCopilotAutoCompaction,
	registerCopilotAutoCompaction,
} from "./auto-compaction.js";

export function normalizeDomain(input) {
	if (!input || typeof input !== "string") return undefined;
	const trimmed = input.trim();
	if (!trimmed) return undefined;
	try {
		return new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`)
			.hostname;
	} catch {
		return undefined;
	}
}

export function copilotTokenBaseUrl(token, enterpriseUrl) {
	const proxy = token.match(/proxy-ep=([^;]+)/)?.[1];
	if (proxy) {
		const authority = proxy.replace(/^proxy\./, "api.");
		if (/[@/?#\s\u0000-\u001f\u007f]/u.test(authority)) {
			throw new Error("invalid Copilot proxy endpoint");
		}
		try {
			const url = new URL(`https://${authority}`);
			if (!url.hostname || url.pathname !== "/" || url.search || url.hash) {
				throw new Error();
			}
			return url.origin;
		} catch {
			throw new Error("invalid Copilot proxy endpoint");
		}
	}
	const domain = normalizeDomain(enterpriseUrl);
	return domain
		? `https://copilot-api.${domain}`
		: "https://api.individual.githubcopilot.com";
}

export async function fetchCopilotModels(
	token,
	enterpriseUrl,
	apiVersion,
	signal,
) {
	const baseUrl = copilotTokenBaseUrl(token, enterpriseUrl);
	const headers = {
		Accept: "application/json",
		Authorization: `Bearer ${token}`,
		...COPILOT_HEADERS,
	};
	if (apiVersion) headers["X-GitHub-Api-Version"] = apiVersion;

	const response = await fetch(`${baseUrl}/models`, {
		headers,
		signal: signal
			? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
			: AbortSignal.timeout(10_000),
	});
	if (!response.ok) {
		throw new Error(
			`Copilot /models failed: ${response.status} ${response.statusText}`.trim(),
		);
	}
	const body = await response.json();
	if (!Array.isArray(body?.data)) {
		throw new Error("Copilot /models returned an invalid model catalog");
	}
	return { baseUrl, models: body.data };
}

export function loadBuiltInCopilotProvider() {
	const provider = builtinProviders().find(({ id }) => id === PROVIDER);
	if (!provider)
		throw new Error(`Pi does not provide the ${PROVIDER} provider`);
	return provider;
}

export function loadBuiltInCopilotModels() {
	return Object.fromEntries(
		loadBuiltInCopilotProvider()
			.getModels()
			.map((model) => [model.id, model]),
	);
}

export function createCopilotRefreshModels(
	builtIns,
	contextBudgets,
	fetchModels = fetchCopilotModels,
) {
	return async ({ credential, signal }) => {
		if (credential?.type !== "oauth" || typeof credential.access !== "string") {
			throw new Error("Copilot model refresh requires an OAuth credential");
		}

		return discoverCopilotModels(
			builtIns,
			contextBudgets,
			credential.access,
			credential.enterpriseUrl,
			signal,
			fetchModels,
		);
	};
}

export function syncContextBudgets(models, contextBudgets) {
	contextBudgets.clear();
	for (const model of models) {
		if (model?.copilotContextBudget) {
			contextBudgets.set(model.id, model.copilotContextBudget);
		}
	}
}

export function createCopilotProvider(
	builtInProvider,
	contextBudgets,
	fetchModels = fetchCopilotModels,
) {
	const builtInModels = builtInProvider.getModels();
	const builtIns = Object.fromEntries(
		builtInModels.map((model) => [model.id, model]),
	);
	const provider = createProvider({
		id: builtInProvider.id,
		name: builtInProvider.name,
		baseUrl: builtInProvider.baseUrl,
		headers: builtInProvider.headers,
		auth: builtInProvider.auth,
		models: builtInModels,
		fetchModels: createCopilotRefreshModels(
			builtIns,
			contextBudgets,
			fetchModels,
		),
		filterModels: filterCopilotModelsForCredential,
		api: {
			stream: (model, context, options) =>
				builtInProvider.stream(model, context, options),
			streamSimple: (model, context, options) =>
				builtInProvider.streamSimple(model, context, options),
		},
	});
	const refreshModels = provider.refreshModels.bind(provider);

	return {
		...provider,
		async refreshModels(context) {
			await refreshModels(context);
			syncContextBudgets(provider.getModels(), contextBudgets);
		},
	};
}

export async function discoverCopilotModels(
	builtIns,
	contextBudgets,
	token,
	enterpriseUrl,
	signal,
	fetchModels = fetchCopilotModels,
) {
	const [normal, expanded] = await Promise.all([
		fetchModels(token, enterpriseUrl, undefined, signal),
		fetchModels(token, enterpriseUrl, EXPANDED_CONTEXT_API_VERSION, signal),
	]);
	const next = buildModels(
		builtIns,
		normal.models,
		expanded.models,
		normal.baseUrl,
	);
	if (next.models.length === 0) {
		throw new Error("Copilot model refresh returned no usable chat models");
	}

	contextBudgets.clear();
	for (const [id, budget] of next.contextBudgets)
		contextBudgets.set(id, budget);
	return next.models;
}

export default function copilotContextVariants(
	pi,
	{ fetchModels = fetchCopilotModels } = {},
) {
	const contextBudgets = new Map();
	pi.registerProvider(
		createCopilotProvider(
			loadBuiltInCopilotProvider(),
			contextBudgets,
			fetchModels,
		),
	);
	pi.on("before_provider_request", (event, ctx) =>
		rewriteCopilotRequestPayload(event.payload, ctx.model),
	);
	registerCopilotAutoCompaction(pi, contextBudgets);
}
