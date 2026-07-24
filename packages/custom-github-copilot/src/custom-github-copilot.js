import { lazyStream } from "@earendil-works/pi-ai";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";

const PROVIDER_NAME = "Custom GitHub Copilot";
export const PROVIDER_ID = "custom-github-copilot";
export const TOKEN_ENV = "CUSTOM_GITHUB_COPILOT_TOKEN";
// pi-lens-ignore: hardcoded-url-js
export const COPILOT_USER_ENDPOINT = "https://api.github.com/copilot_internal/user";

const DISCOVERY_TIMEOUT_MS = 10_000;
const MODEL_REFRESH_TIMEOUT_MS = 12_000;
const MODELS_API_VERSION = "2026-06-01";
// pi-lens-ignore: hardcoded-url-js
const UNRESOLVED_BASE_URL = "https://unresolved.invalid";
const CUSTOM_API = "custom-github-copilot-api";

// Private CAPI compatibility headers retained for the text-only integration.
// Deliberately no X-GitHub-Api-Version is sent to inference.
export const INFERENCE_HEADERS = Object.freeze({
	"Copilot-Integration-Id": "copilot-developer-cli",
	"Openai-Intent": "conversation-agent",
	"X-Initiator": "user",
});

function bootstrapCost(input, output, cacheRead) {
	return { input, output, cacheRead, cacheWrite: 0 };
}

// Startup/offline fallback used until the PAT-visible catalog refreshes. Each
// fallback family exposes lower-price and full-context choices explicitly.
const MODEL_FAMILIES = Object.freeze([
	{
		wireModelId: "gpt-5.4",
		name: "GPT-5.4",
		thresholdLabel: "272k",
		threshold: 272_000,
		defaultCost: bootstrapCost(2.5, 15, 0.25),
		longContextCost: bootstrapCost(5, 22.5, 0.5),
	},
	{
		wireModelId: "gpt-5.5",
		name: "GPT-5.5",
		thresholdLabel: "272k",
		threshold: 272_000,
		defaultCost: bootstrapCost(5, 30, 0.5),
		longContextCost: bootstrapCost(10, 45, 1),
	},
	{
		wireModelId: "gpt-5.6-luna",
		name: "GPT-5.6 Luna",
		thresholdLabel: "200k",
		threshold: 200_000,
		defaultCost: bootstrapCost(1, 6, 0.1),
		longContextCost: bootstrapCost(2, 9, 0.2),
	},
	{
		wireModelId: "gpt-5.6-sol",
		name: "GPT-5.6 Sol",
		thresholdLabel: "272k",
		threshold: 272_000,
		defaultCost: bootstrapCost(5, 30, 0.5),
		longContextCost: bootstrapCost(10, 45, 1),
	},
	{
		wireModelId: "gpt-5.6-terra",
		name: "GPT-5.6 Terra",
		thresholdLabel: "272k",
		threshold: 272_000,
		defaultCost: bootstrapCost(2.5, 15, 0.25),
		longContextCost: bootstrapCost(5, 22.5, 0.5),
	},
]);

const MODEL_DEFINITIONS = Object.freeze(
	MODEL_FAMILIES.flatMap((model) => [
		{
			id: `${model.wireModelId}-${model.thresholdLabel}`,
			wireModelId: model.wireModelId,
			name: `${model.name} (≤${model.thresholdLabel.toUpperCase()} pricing tier)`,
			contextWindow: model.threshold,
			cost: model.defaultCost,
		},
		{
			id: `${model.wireModelId}-1m`,
			wireModelId: model.wireModelId,
			name: `${model.name} (1M context)`,
			contextWindow: 1_000_000,
			cost: {
				...model.defaultCost,
				tiers: [
					{ inputTokensAbove: model.threshold, ...model.longContextCost },
				],
			},
		},
	]),
);

const MODEL_ROUTES = new Map();

function replaceModelRoutes(models) {
	const nextRoutes = new Map();
	for (const model of models) {
		if (model.copilotWireModelId && model.copilotApi) {
			nextRoutes.set(model.id, {
				wireModelId: model.copilotWireModelId,
				api: model.copilotApi,
			});
		}
	}
	MODEL_ROUTES.clear();
	for (const [id, route] of nextRoutes) MODEL_ROUTES.set(id, route);
}

export function parseCopilotApiUrl(payload) {
	const apiUrl =
		payload &&
		typeof payload === "object" &&
		"endpoints" in payload &&
		payload.endpoints &&
		typeof payload.endpoints === "object" &&
		"api" in payload.endpoints &&
		typeof payload.endpoints.api === "string"
			? payload.endpoints.api
			: undefined;

	if (!apiUrl) {
		throw new Error("GitHub Copilot endpoint lookup returned no API endpoint");
	}

	let endpoint;
	try {
		endpoint = new URL(apiUrl);
	} catch {
		throw new Error("GitHub Copilot endpoint lookup returned an invalid API endpoint");
	}

	const trustedHostname =
		endpoint.hostname === "githubcopilot.com" ||
		endpoint.hostname.endsWith(".githubcopilot.com");
	if (
		endpoint.protocol !== "https:" ||
		!trustedHostname ||
		endpoint.username ||
		endpoint.password ||
		endpoint.pathname !== "/" ||
		endpoint.search ||
		endpoint.hash
	) {
		throw new Error("GitHub Copilot endpoint lookup returned an untrusted API endpoint");
	}

	return endpoint.origin;
}

export async function resolveCopilotApiUrl(
	pat,
	fetchImpl = fetch,
	timeoutSignal = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
) {
	const response = await fetchImpl(COPILOT_USER_ENDPOINT, {
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${pat}`,
		},
		signal: timeoutSignal,
	});

	if (!response.ok) {
		throw new Error(`GitHub Copilot endpoint lookup failed (${response.status})`);
	}

	return parseCopilotApiUrl(await response.json());
}

export function buildModels(baseUrl) {
	const models = MODEL_DEFINITIONS.map(({ wireModelId, ...definition }) => ({
		...definition,
		api: CUSTOM_API,
		copilotApi: "openai-responses",
		copilotWireModelId: wireModelId,
		baseUrl,
		reasoning: true,
		thinkingLevelMap: { off: null, minimal: "low", xhigh: "xhigh" },
		// Pi's generic transport only emits Copilot-Vision-Request for the built-in
		// provider ID. Keep v1 text-only until this provider has a tested adapter.
		input: ["text"],
		maxTokens: 128_000,
		headers: { ...INFERENCE_HEADERS },
	}));
	replaceModelRoutes(models);
	return models;
}

function asRecord(value) {
	return value && typeof value === "object" ? value : undefined;
}

function isSelectableChatModel(model) {
	const policy = asRecord(model.policy);
	const capabilities = asRecord(model.capabilities);
	const supports = asRecord(capabilities?.supports);
	return (
		typeof model.id === "string" &&
		model.model_picker_enabled === true &&
		policy?.state !== "disabled" &&
		capabilities?.type === "chat" &&
		supports?.tool_calls !== false
	);
}

function costFromBilling(model, tierName) {
	const tokenPrices = asRecord(model.billing)?.token_prices;
	const tier = asRecord(tokenPrices)?.[tierName];
	const batchSize = asRecord(tokenPrices)?.batch_size;
	if (
		!tier ||
		typeof batchSize !== "number" ||
		batchSize <= 0 ||
		typeof tier.input_price !== "number" ||
		typeof tier.output_price !== "number"
	) {
		return undefined;
	}
	const toUsdPerMillion = (credits) =>
		(credits / 100) * (1_000_000 / batchSize);
	return {
		input: toUsdPerMillion(tier.input_price),
		output: toUsdPerMillion(tier.output_price),
		cacheRead: toUsdPerMillion(tier.cache_price ?? 0),
		cacheWrite: toUsdPerMillion(tier.cache_write_price ?? 0),
	};
}

function classifyCopilotApi(model) {
	const value = `${model.id} ${model.capabilities?.family ?? ""}`.toLowerCase();
	if (value.includes("claude")) return "anthropic-messages";
	if (/\bgpt-5/.test(value)) return "openai-responses";
	return "openai-completions";
}

function contextSuffix(tokens) {
	return tokens >= 1_000_000 ? "1m" : `${Math.round(tokens / 1_000)}k`;
}

function selectorBaseId(id) {
	return id.replace(/-(?:\d+k|1m)$/i, "");
}

export function buildEntitledModels(liveModels, builtIns, baseUrl) {
	const builtInById = new Map(builtIns.map((model) => [model.id, model]));
	const models = [];

	for (const live of liveModels.filter(isSelectableChatModel)) {
		const selectorBase = selectorBaseId(live.id);
		const base = builtInById.get(live.id) ?? builtInById.get(selectorBase);
		const limits = asRecord(live.capabilities)?.limits;
		const fullContextWindow =
			typeof limits?.max_context_window_tokens === "number"
				? limits.max_context_window_tokens
				: (base?.contextWindow ?? 128_000);
		const maxTokens =
			typeof limits?.max_output_tokens === "number"
				? limits.max_output_tokens
				: (base?.maxTokens ?? 16_384);
		const defaultCost = costFromBilling(live, "default") ?? base?.cost ?? {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		};
		const longContextCost = costFromBilling(live, "long_context");
		const threshold = live.billing?.token_prices?.default?.context_max;
		const copilotApi = base?.api ?? classifyCopilotApi(live);
		const common = {
			api: CUSTOM_API,
			copilotApi,
			copilotWireModelId: live.id,
			baseUrl,
			reasoning: base?.reasoning ?? true,
			...(base?.thinkingLevelMap && { thinkingLevelMap: base.thinkingLevelMap }),
			input: ["text"],
			maxTokens,
			headers: { ...INFERENCE_HEADERS },
			...(base?.compat && { compat: base.compat }),
		};

		if (
			typeof threshold === "number" &&
			threshold > 0 &&
			threshold < fullContextWindow &&
			longContextCost
		) {
			models.push({
				...common,
				id: `${selectorBase}-${contextSuffix(threshold)}`,
				name: `${live.name ?? base?.name ?? live.id} (≤${contextSuffix(threshold).toUpperCase()} pricing tier)`,
				cost: defaultCost,
				contextWindow: threshold,
			});
		}

		models.push({
			...common,
			id: `${selectorBase}-${contextSuffix(fullContextWindow)}`,
			name: `${live.name ?? base?.name ?? live.id} (${contextSuffix(fullContextWindow).toUpperCase()} context)`,
			cost:
				longContextCost && typeof threshold === "number"
					? {
							...defaultCost,
							tiers: [{ inputTokensAbove: threshold, ...longContextCost }],
						}
					: defaultCost,
			contextWindow: fullContextWindow,
		});
	}

	models.sort((a, b) => a.id.localeCompare(b.id));
	replaceModelRoutes(models);
	return models;
}

export function createCopilotRequestModelResolver(fetchImpl = fetch) {
	let cachedPat;
	let cachedBaseUrl;
	let inflight;

	return async (model, pat, signal) => {
		if (!pat?.trim()) {
			throw new Error(`[${PROVIDER_ID}] no GitHub Copilot PAT was resolved`);
		}

		if (cachedPat !== pat || !cachedBaseUrl) {
			if (cachedPat !== pat) {
				cachedPat = pat;
				cachedBaseUrl = undefined;
				inflight = undefined;
			}
			inflight ??= resolveCopilotApiUrl(pat, fetchImpl, signal);
			try {
				cachedBaseUrl = await inflight;
			} catch (error) {
				inflight = undefined;
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(`[${PROVIDER_ID}] endpoint discovery failed: ${message}`, {
					cause: error,
				});
			}
		}

		return { ...model, baseUrl: cachedBaseUrl };
	};
}

export async function fetchEntitledCopilotModels(
	pat,
	baseUrl,
	fetchImpl = fetch,
	signal = AbortSignal.timeout(MODEL_REFRESH_TIMEOUT_MS),
) {
	const response = await fetchImpl(`${baseUrl}/models`, {
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${pat}`,
			...INFERENCE_HEADERS,
			"X-GitHub-Api-Version": MODELS_API_VERSION,
		},
		signal,
	});
	if (!response.ok) {
		throw new Error(`GitHub Copilot model lookup failed (${response.status})`);
	}
	const payload = await response.json();
	if (!Array.isArray(payload?.data)) {
		throw new Error("GitHub Copilot model lookup returned an invalid catalog");
	}
	return payload.data;
}

export function createCopilotRefreshModels(
	fetchImpl,
	builtIns,
	resolveRequestModel,
) {
	return async ({ credential, store, allowNetwork, force, signal }) => {
		const cached = await store.read();
		const fallbackModels = () => {
			if (cached?.models?.length) {
				replaceModelRoutes(cached.models);
				return cached.models;
			}
			return buildModels(UNRESOLVED_BASE_URL);
		};
		if (!allowNetwork || signal?.aborted || (cached?.models?.length && !force)) {
			return fallbackModels();
		}
		if (credential?.type !== "api_key" || !credential.key) {
			throw new Error("GitHub Copilot model refresh requires a PAT");
		}

		try {
			const timeout = AbortSignal.timeout(MODEL_REFRESH_TIMEOUT_MS);
			const refreshSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
			const routedModel = await resolveRequestModel(
				{ baseUrl: UNRESOLVED_BASE_URL },
				credential.key,
				refreshSignal,
			);
			const liveModels = await fetchEntitledCopilotModels(
				credential.key,
				routedModel.baseUrl,
				fetchImpl,
				refreshSignal,
			);
			const models = buildEntitledModels(liveModels, builtIns, routedModel.baseUrl);
			if (models.length === 0) {
				throw new Error("GitHub Copilot returned no selectable chat models");
			}
			await store.write({ models, checkedAt: Date.now() });
			return models;
		} catch {
			return fallbackModels();
		}
	};
}

export function createCopilotStreamSimple(
	fetchImpl = fetch,
	apiProvider,
	resolveRequestModel = createCopilotRequestModelResolver(fetchImpl),
) {
	return (model, context, options) =>
		lazyStream(model, async () => {
			const route = MODEL_ROUTES.get(model.id);
			if (!route) throw new Error(`No Copilot route for model ${model.id}`);
			const streams = apiProvider ?? getApiProvider(route.api);
			if (!streams) throw new Error(`Pi API provider is unavailable: ${route.api}`);
			const routedModel = await resolveRequestModel(
				model,
				options?.apiKey,
				options?.signal,
			);
			const requestModel = {
				...routedModel,
				id: route.wireModelId,
				api: route.api,
			};
			return streams.streamSimple(requestModel, context, options);
		});
}

export function rewriteCopilotRequestPayload(payload, model) {
	if (
		model?.provider !== PROVIDER_ID ||
		!payload ||
		typeof payload !== "object" ||
		Array.isArray(payload)
	) {
		return payload;
	}

	const route = MODEL_ROUTES.get(model.id);
	return route ? { ...payload, model: route.wireModelId } : payload;
}

export default function customGithubCopilot(
	pi,
	{
		fetchImpl = fetch,
		apiProvider,
		builtIns = getBuiltinModels("github-copilot"),
	} = {},
) {
	const resolveRequestModel = createCopilotRequestModelResolver(fetchImpl);
	pi.registerProvider(PROVIDER_ID, {
		name: PROVIDER_NAME,
		// Requests never use this fail-closed placeholder: streamSimple resolves
		// the PAT-specific endpoint and clones it onto every request model.
		baseUrl: UNRESOLVED_BASE_URL,
		apiKey: `$${TOKEN_ENV}`,
		authHeader: true,
		api: CUSTOM_API,
		headers: { ...INFERENCE_HEADERS },
		models: buildModels(UNRESOLVED_BASE_URL),
		refreshModels: createCopilotRefreshModels(
			fetchImpl,
			builtIns,
			resolveRequestModel,
		),
		streamSimple: createCopilotStreamSimple(
			fetchImpl,
			apiProvider,
			resolveRequestModel,
		),
	});

	pi.on("before_provider_request", (event, ctx) =>
		rewriteCopilotRequestPayload(event.payload, ctx.model),
	);
	pi.on("before_provider_headers", (event, ctx) => {
		if (ctx.model?.provider === PROVIDER_ID) event.headers["x-api-key"] = null;
	});
}
