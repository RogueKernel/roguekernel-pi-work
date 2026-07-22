/** Model-catalog normalization, pricing, and selector construction. */

export const PROVIDER = "github-copilot";
export const COPILOT_HEADERS = {
	"User-Agent": "GitHubCopilotChat/0.35.0",
	"Editor-Version": "vscode/1.107.0",
	"Editor-Plugin-Version": "copilot-chat/0.35.0",
	"Copilot-Integration-Id": "vscode-chat",
};
export const EXPANDED_CONTEXT_API_VERSION = "2026-06-01";
export const COPILOT_EFFECTIVE_CONTEXT_PERCENT = 0.95;
export const COPILOT_AUTO_COMPACT_PERCENT = 0.9;
const EXPANDED_CONTEXT_HEADERS = {
	...COPILOT_HEADERS,
	"X-GitHub-Api-Version": EXPANDED_CONTEXT_API_VERSION,
};

export function isPickerChatModel(model) {
	return (
		model &&
		typeof model.id === "string" &&
		model.model_picker_enabled !== false &&
		model.policy?.state !== "disabled" &&
		model.capabilities?.type === "chat"
	);
}

export function dateBaseId(id) {
	return id.replace(/-\d{4}-\d{2}-\d{2}$/, "");
}

export function contextVariantBaseId(id) {
	return id
		.replace(/-1m(?:-internal)?$/, "")
		.replace(/-long$/, "")
		.replace(/-extended$/, "");
}

export function displayName(model) {
	return model.name ?? model.id;
}

export function normalizeCopilotLimits(limits) {
	if (!limits) return undefined;
	return { contextWindow: limits.contextWindow, maxTokens: limits.maxTokens };
}

export function liveLimits(model) {
	const limits = model.capabilities?.limits ?? {};
	const contextWindow = limits.max_context_window_tokens;
	const maxTokens = limits.max_output_tokens;
	if (typeof contextWindow !== "number" || typeof maxTokens !== "number")
		return undefined;
	return { contextWindow, maxTokens };
}

export function billingTier(model, tierName) {
	return model.billing?.token_prices?.[tierName];
}

export function costFromBilling(model, tierName) {
	const prices = billingTier(model, tierName);
	const batchSize = model.billing?.token_prices?.batch_size;
	if (!prices || typeof batchSize !== "number" || batchSize <= 0)
		return undefined;
	if (
		typeof prices.input_price !== "number" ||
		typeof prices.output_price !== "number"
	)
		return undefined;

	// Copilot's 2026-06-01 API reports prices as AI Credits per batch_size
	// tokens. One AI Credit is one US cent. Pi model costs are USD per 1M
	// tokens, so scale by both the cent conversion and the batch size.
	const creditsToUsdPerMillion = (credits) =>
		(credits / 100) * (1_000_000 / batchSize);
	return {
		input: creditsToUsdPerMillion(prices.input_price),
		output: creditsToUsdPerMillion(prices.output_price),
		cacheRead: creditsToUsdPerMillion(prices.cache_price ?? 0),
		cacheWrite: creditsToUsdPerMillion(prices.cache_write_price ?? 0),
	};
}

export function costFromBillingWithTiers(model, tierName) {
	const selectedCost =
		costFromBilling(model, tierName) ?? costFromBilling(model, "default");
	if (tierName !== "long_context") return selectedCost;

	const defaultCost = costFromBilling(model, "default");
	const longContextCost = costFromBilling(model, "long_context");
	const threshold = billingTier(model, "default")?.context_max;
	if (
		!defaultCost ||
		!longContextCost ||
		typeof threshold !== "number" ||
		threshold <= 0
	) {
		return selectedCost;
	}

	const ratesDiffer = Object.keys(defaultCost).some(
		(key) => defaultCost[key] !== longContextCost[key],
	);
	if (!ratesDiffer) return defaultCost;

	return {
		...defaultCost,
		tiers: [{ inputTokensAbove: threshold, ...longContextCost }],
	};
}

export function tierLimits(model, tierName) {
	const limits = model.capabilities?.limits ?? {};
	const maxTokens = limits.max_output_tokens;
	if (typeof maxTokens !== "number") return liveLimits(model);

	const contextMax = billingTier(model, tierName)?.context_max;
	if (typeof contextMax !== "number") return liveLimits(model);

	const tierContextWindow = contextMax + maxTokens;
	const hardContextWindow = limits.max_context_window_tokens;
	return {
		contextWindow:
			typeof hardContextWindow === "number"
				? Math.min(tierContextWindow, hardContextWindow)
				: tierContextWindow,
		maxTokens,
	};
}

export function contextBudgetFromBilling(model, tierName, limits) {
	const contextMax = billingTier(model, tierName)?.context_max;
	if (typeof contextMax !== "number" || contextMax <= 0 || !limits)
		return undefined;
	const displayContextWindow = limits.contextWindow;
	const effectiveContextWindow = Math.floor(
		contextMax * COPILOT_EFFECTIVE_CONTEXT_PERCENT,
	);
	return {
		tier: tierName,
		contextMax,
		displayContextWindow,
		effectiveContextWindow,
		autoCompactTokenLimit: Math.floor(
			contextMax * COPILOT_AUTO_COMPACT_PERCENT,
		),
		responseBufferTokens: Math.max(
			0,
			displayContextWindow - effectiveContextWindow,
		),
	};
}

export function clonedFromBuiltIn(
	model,
	id,
	name,
	baseUrl,
	limits,
	headers = COPILOT_HEADERS,
	cost = model.cost,
	copilotContextBudget,
) {
	const normalizedLimits = normalizeCopilotLimits(
		limits ?? {
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
		},
	);
	return {
		id,
		provider: PROVIDER,
		name,
		api: model.api,
		baseUrl,
		reasoning: model.reasoning,
		...(model.thinkingLevelMap && { thinkingLevelMap: model.thinkingLevelMap }),
		input: model.input,
		cost,
		contextWindow: normalizedLimits?.contextWindow ?? model.contextWindow,
		maxTokens: normalizedLimits?.maxTokens ?? model.maxTokens,
		headers,
		...(model.compat && { compat: model.compat }),
		...(copilotContextBudget && { copilotContextBudget }),
	};
}

export function classifyLiveOnly(model) {
	const id = model.id.toLowerCase();
	const family = (model.capabilities?.family ?? id).toLowerCase();
	const key = `${id} ${family}`;

	if (key.includes("claude")) {
		const needsAdaptive = /claude-(opus|sonnet)-(4\.[6-9]|[5-9])/.test(key);
		const supportsXHigh = /claude-opus-(4\.[7-9]|[5-9])/.test(key);
		return {
			api: "anthropic-messages",
			reasoning: true,
			...(supportsXHigh && {
				thinkingLevelMap: { xhigh: "xhigh", minimal: "low" },
			}),
			...(needsAdaptive && {
				compat: { forceAdaptiveThinking: true, supportsTemperature: false },
			}),
		};
	}
	if (/\b(gpt-5|o1|o3)/.test(key)) {
		return {
			api: "openai-responses",
			reasoning: true,
			thinkingLevelMap: /gpt-5\.(?:[2-9]|\d\d)/.test(key)
				? { off: null, minimal: "low", xhigh: "xhigh" }
				: { off: null, minimal: "low" },
		};
	}
	return { api: "openai-completions", reasoning: false };
}

export function liveOnlyModel(
	model,
	baseUrl,
	limits,
	headers = COPILOT_HEADERS,
	cost = costFromBilling(model, "default"),
	copilotContextBudget,
) {
	const classified = classifyLiveOnly(model);
	const normalizedLimits = normalizeCopilotLimits(
		limits ?? {
			contextWindow: 128000,
			maxTokens: 16384,
		},
	);
	return {
		id: model.id,
		provider: PROVIDER,
		name: displayName(model),
		...classified,
		baseUrl,
		input:
			model.capabilities?.supports?.vision === true
				? ["text", "image"]
				: ["text"],
		cost: cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: normalizedLimits?.contextWindow ?? 128000,
		maxTokens: normalizedLimits?.maxTokens ?? 16384,
		headers,
		...(copilotContextBudget && { copilotContextBudget }),
	};
}

export function filterCopilotModelsForCredential(models, credential) {
	if (credential?.type !== "oauth") return models;
	const availableModelIds = credential.availableModelIds;
	if (
		!Array.isArray(availableModelIds) ||
		!availableModelIds.every((id) => typeof id === "string")
	) {
		return models;
	}
	const available = new Set(availableModelIds);
	return models.filter((model) =>
		available.has(model.copilotModelId ?? model.id),
	);
}

export function rewriteCopilotRequestPayload(payload, model) {
	if (
		model?.provider !== PROVIDER ||
		typeof model.copilotModelId !== "string" ||
		!payload ||
		typeof payload !== "object" ||
		typeof payload.model !== "string"
	) {
		return undefined;
	}
	return { ...payload, model: model.copilotModelId };
}

export function buildModels(
	builtIns,
	normalApiModels,
	expandedApiModels,
	baseUrl,
) {
	const out = [];
	const contextBudgets = new Map();
	const normalById = new Map(
		normalApiModels.filter(isPickerChatModel).map((model) => [model.id, model]),
	);
	const expandedById = new Map(
		expandedApiModels
			.filter(isPickerChatModel)
			.map((model) => [model.id, model]),
	);
	const ids = new Set([...normalById.keys(), ...expandedById.keys()]);
	const realVariantBases = new Set(
		[...ids]
			.filter((id) => contextVariantBaseId(id) !== id)
			.map(contextVariantBaseId),
	);

	const addModel = ({
		selectorId,
		requestModelId,
		live,
		limits,
		tier,
		headers,
		name,
		billingModel = live,
	}) => {
		const cost = costFromBillingWithTiers(billingModel, tier);
		const budget = contextBudgetFromBilling(billingModel, tier, limits);
		const baseId = contextVariantBaseId(dateBaseId(requestModelId));
		const baseModel = builtIns[requestModelId] ?? builtIns[baseId];
		const model = baseModel
			? clonedFromBuiltIn(
					baseModel,
					selectorId,
					name ?? baseModel.name,
					baseUrl,
					limits,
					headers,
					cost ?? baseModel.cost,
					budget,
				)
			: {
					...liveOnlyModel(live, baseUrl, limits, headers, cost, budget),
					id: selectorId,
					...(name && { name }),
				};
		if (selectorId !== requestModelId) model.copilotModelId = requestModelId;
		out.push(model);
		if (budget) contextBudgets.set(selectorId, budget);
	};

	for (const id of ids) {
		const normal = normalById.get(id);
		const expanded = expandedById.get(id);
		const normalLimits = normal ? tierLimits(normal, "default") : undefined;
		const expandedLimits = expanded
			? (tierLimits(expanded, "long_context") ?? liveLimits(expanded))
			: undefined;
		const isRealVariant = contextVariantBaseId(id) !== id;

		if (isRealVariant) {
			const live = expanded ?? normal;
			const limits = expandedLimits ?? normalLimits ?? liveLimits(live);
			const tier = expanded ? "long_context" : "default";
			addModel({
				selectorId: id,
				requestModelId: id,
				live,
				limits,
				tier,
				headers: expanded ? EXPANDED_CONTEXT_HEADERS : COPILOT_HEADERS,
				name: displayName(live),
			});
			continue;
		}

		const defaultLive = normal ?? expanded;
		const defaultLimits =
			normalLimits ??
			tierLimits(expanded, "default") ??
			liveLimits(defaultLive);
		addModel({
			selectorId: id,
			requestModelId: id,
			live: defaultLive,
			limits: defaultLimits,
			tier: "default",
			headers: COPILOT_HEADERS,
			billingModel: expanded ?? defaultLive,
		});

		if (
			normal &&
			expanded &&
			expandedLimits &&
			expandedLimits.contextWindow > (defaultLimits?.contextWindow ?? 0) &&
			!realVariantBases.has(id)
		) {
			addModel({
				selectorId: `${id}-1m`,
				requestModelId: id,
				live: expanded,
				limits: expandedLimits,
				tier: "long_context",
				headers: EXPANDED_CONTEXT_HEADERS,
				name: `${displayName(expanded)} (1M Context)`,
			});
		}
	}

	out.sort((a, b) => a.id.localeCompare(b.id));
	return { models: out, contextBudgets };
}
