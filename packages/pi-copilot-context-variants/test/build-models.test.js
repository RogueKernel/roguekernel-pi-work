import assert from "node:assert/strict";
import { describe, it } from "node:test";

import copilotContextVariants, {
	buildModels,
	costFromBilling,
	createCopilotProvider,
	createCopilotRefreshModels,
	evaluateCopilotAutoCompaction,
	fetchCopilotModels,
	filterCopilotModelsForCredential,
	registerCopilotAutoCompaction,
	rewriteCopilotRequestPayload,
} from "../src/pi-copilot-context-variants.js";

const builtIns = {
	"claude-opus-4.6": {
		id: "claude-opus-4.6",
		name: "Claude Opus 4.6",
		api: "anthropic-messages",
		reasoning: true,
		thinkingLevelMap: { xhigh: "max" },
		input: ["text", "image"],
		cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		contextWindow: 1_000_000,
		maxTokens: 32_000,
		compat: { forceAdaptiveThinking: true },
	},
	"claude-sonnet-4.6": {
		id: "claude-sonnet-4.6",
		name: "Claude Sonnet 4.6",
		api: "anthropic-messages",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 1_000_000,
		maxTokens: 32_000,
	},
	"not-live-anymore": {
		id: "not-live-anymore",
		name: "Not Live",
		api: "openai-completions",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4_096,
	},
};

function live(id, contextWindow, maxTokens, extra = {}) {
	return {
		id,
		name: extra.name ?? id,
		model_picker_enabled: extra.model_picker_enabled ?? true,
		policy: { state: extra.policyState ?? "enabled" },
		capabilities: {
			type: extra.type ?? "chat",
			family: extra.family ?? id,
			limits: {
				max_context_window_tokens: contextWindow,
				max_output_tokens: maxTokens,
			},
			supports: { vision: extra.vision ?? true },
		},
		...(extra.billing && { billing: extra.billing }),
	};
}

function billing(defaultTier, longContextTier) {
	return {
		token_prices: {
			batch_size: 1_000_000,
			default: defaultTier,
			...(longContextTier && { long_context: longContextTier }),
		},
	};
}

const defaultOpusBilling = billing(
	{
		cache_price: 50,
		cache_write_price: 625,
		context_max: 200_000,
		input_price: 500,
		output_price: 2500,
	},
	{
		cache_price: 50,
		cache_write_price: 625,
		context_max: 936_000,
		input_price: 500,
		output_price: 2500,
	},
);

const gptBilling = billing(
	{
		cache_price: 25,
		cache_write_price: 0,
		context_max: 272_000,
		input_price: 250,
		output_price: 1500,
	},
	{
		cache_price: 50,
		cache_write_price: 0,
		context_max: 922_000,
		input_price: 500,
		output_price: 2250,
	},
);

describe("buildModels", () => {
	it("exposes Copilot's default and expanded context tiers as distinct selector models", () => {
		const models = buildModels(
			{},
			[live("gpt-5.5", 400_000, 128_000, { billing: gptBilling })],
			[
				live("gpt-5.5", 1_050_000, 128_000, {
					name: "GPT 5.5",
					billing: gptBilling,
				}),
			],
			"https://api.individual.githubcopilot.com",
		).models;

		assert.deepEqual(
			models.map((model) => model.id),
			["gpt-5.5", "gpt-5.5-1m"],
		);
		assert.equal(models[0].api, "openai-responses");
		assert.equal(models[0].contextWindow, 400_000);
		assert.equal(models[0].maxTokens, 128_000);
		assert.equal(models[1].contextWindow, 1_050_000);
		assert.equal(models[1].maxTokens, 128_000);
		assert.equal(models[1].copilotModelId, "gpt-5.5");
		assert.deepEqual(models[1].copilotContextBudget, {
			tier: "long_context",
			contextMax: 922_000,
			displayContextWindow: 1_050_000,
			effectiveContextWindow: 875_900,
			autoCompactTokenLimit: 829_800,
			responseBufferTokens: 174_100,
		});
		assert.deepEqual(models[1].thinkingLevelMap, {
			off: null,
			minimal: "low",
			xhigh: "xhigh",
		});
	});

	it("keeps non-GPT Copilot models on their reported context tier", () => {
		const models = buildModels(
			builtIns,
			[live("claude-opus-4.6", 264_000, 64_000)],
			[live("claude-opus-4.6", 264_000, 64_000)],
			"https://api.individual.githubcopilot.com",
		).models;

		assert.equal(models[0].contextWindow, 264_000);
		assert.equal(models[0].maxTokens, 64_000);
	});

	it("converts Copilot AI Credit prices into Pi's USD-per-1M cost shape", () => {
		const model = live("gpt-5.4", 1_050_000, 128_000, { billing: gptBilling });

		assert.deepEqual(costFromBilling(model, "default"), {
			input: 2.5,
			output: 15,
			cacheRead: 0.25,
			cacheWrite: 0,
		});
		assert.deepEqual(costFromBilling(model, "long_context"), {
			input: 5,
			output: 22.5,
			cacheRead: 0.5,
			cacheWrite: 0,
		});
	});

	it("patches live limits onto built-in models while preserving built-in metadata", () => {
		const models = buildModels(
			builtIns,
			[live("claude-opus-4.6", 264_000, 64_000)],
			[live("claude-opus-4.6", 264_000, 64_000)],
			"https://api.individual.githubcopilot.com",
		).models;

		assert.deepEqual(
			models.map((m) => m.id),
			["claude-opus-4.6"],
		);
		assert.deepEqual(models[0], {
			id: "claude-opus-4.6",
			provider: "github-copilot",
			name: "Claude Opus 4.6",
			api: "anthropic-messages",
			baseUrl: "https://api.individual.githubcopilot.com",
			reasoning: true,
			thinkingLevelMap: { xhigh: "max" },
			input: ["text", "image"],
			cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
			contextWindow: 264_000,
			maxTokens: 64_000,
			headers: {
				"User-Agent": "GitHubCopilotChat/0.35.0",
				"Editor-Version": "vscode/1.107.0",
				"Editor-Plugin-Version": "copilot-chat/0.35.0",
				"Copilot-Integration-Id": "vscode-chat",
			},
			compat: { forceAdaptiveThinking: true },
		});
	});

	it("keeps real CAPI context-size variant IDs", () => {
		const models = buildModels(
			builtIns,
			[live("claude-opus-4.6", 264_000, 64_000)],
			[
				live("claude-opus-4.6", 264_000, 64_000),
				live("claude-opus-4.6-1m", 1_000_000, 64_000, {
					name: "Claude Opus 4.6 1M",
				}),
			],
			"https://api.individual.githubcopilot.com",
		).models;

		const ids = models.map((m) => m.id);
		assert.deepEqual(ids, ["claude-opus-4.6", "claude-opus-4.6-1m"]);

		const variant = models.find((m) => m.id === "claude-opus-4.6-1m");
		assert.equal(variant.name, "Claude Opus 4.6 1M");
		assert.equal(variant.api, "anthropic-messages");
		assert.equal(variant.contextWindow, 1_000_000);
		assert.equal(variant.maxTokens, 64_000);
		assert.deepEqual(variant.thinkingLevelMap, { xhigh: "max" });
		assert.deepEqual(variant.compat, { forceAdaptiveThinking: true });
		assert.equal(variant.headers["X-GitHub-Api-Version"], "2026-06-01");
	});

	it("maps a synthetic expanded selector ID back to the real Copilot model ID", () => {
		const result = buildModels(
			builtIns,
			[live("claude-opus-4.6", 264_000, 64_000)],
			[live("claude-opus-4.6", 1_000_000, 64_000, { name: "Claude Opus 4.6" })],
			"https://api.individual.githubcopilot.com",
		);

		assert.deepEqual(
			result.models.map((m) => m.id),
			["claude-opus-4.6", "claude-opus-4.6-1m"],
		);
		assert.equal(result.models[0].contextWindow, 264_000);
		assert.equal(result.models[1].contextWindow, 1_000_000);
		assert.equal(result.models[1].maxTokens, 64_000);
		assert.equal(result.models[1].copilotModelId, "claude-opus-4.6");
		assert.equal(
			result.models[1].headers["X-GitHub-Api-Version"],
			"2026-06-01",
		);
	});

	it("merges versioned Copilot default and long-context billing on top of built-in metadata", () => {
		const result = buildModels(
			builtIns,
			[live("claude-opus-4.6", 264_000, 64_000)],
			[
				live("claude-opus-4.6", 1_000_000, 64_000, {
					name: "Claude Opus 4.6",
					billing: defaultOpusBilling,
				}),
			],
			"https://api.individual.githubcopilot.com",
		);

		assert.deepEqual(
			result.models.map((model) => model.id),
			["claude-opus-4.6", "claude-opus-4.6-1m"],
		);
		assert.equal(result.models[0].contextWindow, 264_000);
		assert.equal(result.models[1].contextWindow, 1_000_000);
		assert.deepEqual(result.models[1].cost, {
			input: 5,
			output: 25,
			cacheRead: 0.5,
			cacheWrite: 6.25,
		});
		assert.deepEqual(result.models[1].thinkingLevelMap, { xhigh: "max" });
	});

	it("uses request-wide pricing tiers when Copilot charges more above the context threshold", () => {
		const models = buildModels(
			{},
			[live("gpt-5.4", 400_000, 128_000)],
			[
				live("gpt-5.4", 1_050_000, 128_000, {
					name: "GPT 5.4",
					billing: gptBilling,
				}),
			],
			"https://api.individual.githubcopilot.com",
		).models;

		assert.deepEqual(
			models.map((model) => model.id),
			["gpt-5.4", "gpt-5.4-1m"],
		);
		assert.deepEqual(models[1].cost, {
			input: 2.5,
			output: 15,
			cacheRead: 0.25,
			cacheWrite: 0,
			tiers: [
				{
					inputTokensAbove: 272_000,
					input: 5,
					output: 22.5,
					cacheRead: 0.5,
					cacheWrite: 0,
				},
			],
		});
	});

	it("classifies live-only picker models when Pi has no built-in definition", () => {
		const models = buildModels(
			builtIns,
			[live("claude-sonnet-5", 264_000, 64_000, { name: "Claude Sonnet 5" })],
			[live("claude-sonnet-5", 264_000, 64_000, { name: "Claude Sonnet 5" })],
			"https://api.individual.githubcopilot.com",
		).models;

		assert.deepEqual(
			models.map((m) => m.id),
			["claude-sonnet-5"],
		);
		assert.equal(models[0].api, "anthropic-messages");
		assert.equal(models[0].reasoning, true);
		assert.equal(models[0].contextWindow, 264_000);
		assert.equal(models[0].maxTokens, 64_000);
	});

	it("triggers proactive compaction for Copilot GPT models at the Codex-style tier threshold", () => {
		const budget = {
			tier: "default",
			contextMax: 272_000,
			displayContextWindow: 400_000,
			effectiveContextWindow: 258_400,
			autoCompactTokenLimit: 244_800,
			responseBufferTokens: 141_600,
		};

		const decision = evaluateCopilotAutoCompaction(
			{
				messages: [
					{
						role: "assistant",
						usage: {
							input: 220_000,
							cacheRead: 25_000,
							output: 1_000,
							totalTokens: 246_000,
						},
					},
				],
			},
			{
				model: {
					id: "gpt-5.5",
					provider: "github-copilot",
					api: "openai-responses",
					copilotContextBudget: budget,
				},
			},
			new Map(),
		);

		assert.deepEqual(decision, {
			shouldCompact: true,
			tokens: 246_000,
			threshold: 244_800,
			reason: "threshold-reached",
			budget,
		});
	});

	it("does not proactively compact non-GPT Copilot models", () => {
		const decision = evaluateCopilotAutoCompaction(
			{ messages: [{ role: "assistant", usage: { totalTokens: 246_000 } }] },
			{ model: { id: "claude-opus-4.6", api: "anthropic-messages" } },
			new Map([["claude-opus-4.6", { autoCompactTokenLimit: 200_000 }]]),
		);

		assert.equal(decision.shouldCompact, false);
		assert.equal(decision.reason, "not-copilot-gpt");
	});

	it("excludes disabled, non-chat, and non-picker live models", () => {
		const models = buildModels(
			builtIns,
			[
				live("claude-opus-4.6", 264_000, 64_000, { policyState: "disabled" }),
				live("claude-sonnet-4.6", 264_000, 64_000, {
					model_picker_enabled: false,
				}),
				live("embedding-model", 8_192, 512, { type: "embedding" }),
			],
			[
				live("claude-opus-4.6", 264_000, 64_000, { policyState: "disabled" }),
				live("claude-sonnet-4.6", 264_000, 64_000, {
					model_picker_enabled: false,
				}),
				live("embedding-model", 8_192, 512, { type: "embedding" }),
			],
			"https://api.individual.githubcopilot.com",
		).models;

		assert.deepEqual(models, []);
	});
});

describe("Copilot selector aliases", () => {
	it("keeps aliases available when their real Copilot model ID is advertised", () => {
		const models = [
			{ id: "claude-opus-4.8" },
			{ id: "claude-opus-4.8-1m", copilotModelId: "claude-opus-4.8" },
			{ id: "not-advertised" },
		];

		const available = filterCopilotModelsForCredential(models, {
			type: "oauth",
			availableModelIds: ["claude-opus-4.8"],
		});

		assert.deepEqual(
			available.map(({ id }) => id),
			["claude-opus-4.8", "claude-opus-4.8-1m"],
		);
	});

	it("rewrites only aliased Copilot request payloads to the real model ID", () => {
		const payload = { model: "claude-opus-4.8-1m", messages: [] };
		const rewritten = rewriteCopilotRequestPayload(payload, {
			id: "claude-opus-4.8-1m",
			provider: "github-copilot",
			copilotModelId: "claude-opus-4.8",
		});

		assert.deepEqual(rewritten, {
			model: "claude-opus-4.8",
			messages: [],
		});
		assert.deepEqual(payload, {
			model: "claude-opus-4.8-1m",
			messages: [],
		});
		assert.equal(
			rewriteCopilotRequestPayload(payload, {
				id: "claude-opus-4.8-1m",
				provider: "other",
				copilotModelId: "claude-opus-4.8",
			}),
			undefined,
		);
	});
});

function fakeBuiltInProvider(models = Object.values(builtIns)) {
	return {
		id: "github-copilot",
		name: "GitHub Copilot",
		baseUrl: "https://api.individual.githubcopilot.com",
		auth: {},
		getModels: () => models,
		stream: () => {},
		streamSimple: () => {},
	};
}

function modelsStore(stored) {
	const writes = [];
	return {
		writes,
		store: {
			read: async () => stored,
			write: async (entry) => writes.push(entry),
			delete: async () => {},
		},
	};
}

describe("provider refresh", () => {
	it("registers a native provider during extension initialization", () => {
		const registrations = [];
		const events = [];

		copilotContextVariants(
			{
				registerProvider: (provider) => registrations.push(provider),
				on: (name, handler) => events.push({ name, handler }),
			},
			{ fetchModels: async () => ({ models: [] }) },
		);

		assert.equal(registrations.length, 1);
		assert.equal(registrations[0].id, "github-copilot");
		assert.equal(typeof registrations[0].getModels, "function");
		assert.equal(typeof registrations[0].refreshModels, "function");
		assert.equal(typeof registrations[0].filterModels, "function");
		assert.equal(
			events.some(({ name }) => name === "session_start"),
			false,
		);
		assert.equal(
			events.some(({ name }) => name === "agent_end"),
			true,
		);
	});

	it("uses Pi's refresh credential, network policy, and abort signal", async () => {
		const calls = [];
		const signal = new AbortController().signal;
		const contextBudgets = new Map();
		const refresh = createCopilotRefreshModels(
			builtIns,
			contextBudgets,
			async (token, enterpriseUrl, apiVersion, requestSignal) => {
				calls.push({ token, enterpriseUrl, apiVersion, requestSignal });
				const model = live(
					"gpt-5.5",
					apiVersion ? 1_050_000 : 400_000,
					128_000,
					{
						billing: gptBilling,
					},
				);
				return {
					baseUrl: "https://api.individual.githubcopilot.com",
					models: [model],
				};
			},
		);

		const models = await refresh({
			credential: {
				type: "oauth",
				access: "token",
				enterpriseUrl: "example.test",
			},
			allowNetwork: true,
			signal,
		});

		assert.deepEqual(
			calls.map(({ apiVersion }) => apiVersion),
			[undefined, "2026-06-01"],
		);
		assert.equal(
			calls.every(({ token }) => token === "token"),
			true,
		);
		assert.equal(
			calls.every(({ enterpriseUrl }) => enterpriseUrl === "example.test"),
			true,
		);
		assert.equal(
			calls.every(({ requestSignal }) => requestSignal === signal),
			true,
		);
		assert.deepEqual(
			models.map(({ id }) => id),
			["gpt-5.5", "gpt-5.5-1m"],
		);
		assert.equal(contextBudgets.has("gpt-5.5"), true);
		assert.equal(contextBudgets.has("gpt-5.5-1m"), true);
	});

	it("persists a successful native-provider discovery", async () => {
		const provider = createCopilotProvider(
			fakeBuiltInProvider(),
			new Map(),
			async (_token, _enterpriseUrl, apiVersion) => ({
				baseUrl: "https://api.individual.githubcopilot.com",
				models: [
					live("gpt-5.5", apiVersion ? 1_050_000 : 400_000, 128_000, {
						billing: gptBilling,
					}),
				],
			}),
		);
		const { store, writes } = modelsStore();

		await provider.refreshModels({
			store,
			allowNetwork: true,
			credential: {
				type: "oauth",
				access: "token",
				enterpriseUrl: "example.test",
			},
		});

		assert.equal(writes.length, 1);
		assert.deepEqual(
			writes[0].models.map(({ id }) => id),
			["gpt-5.5", "gpt-5.5-1m"],
		);
		assert.equal(typeof writes[0].checkedAt, "number");
	});

	it("restores cached aliases before network refresh", async () => {
		let fetchCalls = 0;
		const contextBudget = { autoCompactTokenLimit: 123 };
		const cachedAlias = {
			...builtIns["claude-opus-4.6"],
			id: "claude-opus-4.8-1m",
			provider: "github-copilot",
			copilotModelId: "claude-opus-4.8",
			copilotContextBudget: contextBudget,
		};
		const contextBudgets = new Map();
		const provider = createCopilotProvider(
			fakeBuiltInProvider(),
			contextBudgets,
			async () => {
				fetchCalls += 1;
				throw new Error("unexpected fetch");
			},
		);
		const { store } = modelsStore({ models: [cachedAlias] });

		await provider.refreshModels({ store, allowNetwork: false });

		assert.equal(fetchCalls, 0);
		assert.equal(
			provider.getModels().some(({ id }) => id === cachedAlias.id),
			true,
		);
		assert.equal(contextBudgets.get(cachedAlias.id), contextBudget);
	});

	it("keeps the cached catalog when online discovery fails", async () => {
		const cachedAlias = {
			...builtIns["claude-opus-4.6"],
			id: "claude-opus-4.8-1m",
			provider: "github-copilot",
			copilotModelId: "claude-opus-4.8",
		};
		const provider = createCopilotProvider(
			fakeBuiltInProvider(),
			new Map(),
			async () => {
				throw new Error("offline");
			},
		);
		const { store } = modelsStore({ models: [cachedAlias] });

		await assert.rejects(
			provider.refreshModels({
				store,
				allowNetwork: true,
				credential: { type: "oauth", access: "token" },
			}),
			/offline/,
		);
		assert.equal(
			provider.getModels().some(({ id }) => id === cachedAlias.id),
			true,
		);
	});

	it("preserves existing compaction budgets when either endpoint fails", async () => {
		const existingBudget = { autoCompactTokenLimit: 123 };
		const contextBudgets = new Map([["existing", existingBudget]]);
		const refresh = createCopilotRefreshModels(
			builtIns,
			contextBudgets,
			async (_token, _enterpriseUrl, apiVersion) => {
				if (apiVersion) throw new Error("expanded endpoint unavailable");
				return {
					baseUrl: "https://api.individual.githubcopilot.com",
					models: [live("gpt-5.5", 400_000, 128_000, { billing: gptBilling })],
				};
			},
		);

		await assert.rejects(
			refresh({
				credential: { type: "oauth", access: "token" },
				allowNetwork: true,
			}),
			/expanded endpoint unavailable/,
		);
		assert.deepEqual([...contextBudgets], [["existing", existingBudget]]);
	});

	it("rejects proxy endpoints that are not host-only authorities", async () => {
		const originalFetch = globalThis.fetch;
		let fetchCalls = 0;
		try {
			globalThis.fetch = async () => {
				fetchCalls += 1;
				throw new Error("fetch should not be called");
			};
			for (const endpoint of [
				"proxy.githubcopilot.com@attacker.example",
				"proxy.githubcopilot.com/path",
				"proxy.githubcopilot.com?query",
				"proxy.githubcopilot.com#fragment",
				"proxy.githubcopilot.com:invalid",
			]) {
				await assert.rejects(
					fetchCopilotModels(`token;proxy-ep=${endpoint};`),
					/invalid Copilot proxy endpoint/,
				);
			}
			assert.equal(fetchCalls, 0);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("rejects malformed and empty catalogs instead of publishing zero models", async () => {
		const originalFetch = globalThis.fetch;
		try {
			globalThis.fetch = async () => ({
				ok: true,
				json: async () => ({ unexpected: [] }),
			});
			await assert.rejects(
				fetchCopilotModels("token"),
				/invalid model catalog/,
			);
		} finally {
			globalThis.fetch = originalFetch;
		}

		const refresh = createCopilotRefreshModels({}, new Map(), async () => ({
			baseUrl: "https://api.individual.githubcopilot.com",
			models: [],
		}));
		await assert.rejects(
			refresh({
				credential: { type: "oauth", access: "token" },
				allowNetwork: true,
			}),
			/no usable chat models/,
		);
	});

	it("does not expose Copilot error response bodies", async () => {
		const originalFetch = globalThis.fetch;
		try {
			globalThis.fetch = async () => ({
				ok: false,
				status: 500,
				statusText: "Internal Server Error",
				text: async () => {
					throw new Error("response body should not be read");
				},
			});
			await assert.rejects(fetchCopilotModels("token"), (error) => {
				assert.equal(
					error.message,
					"Copilot /models failed: 500 Internal Server Error",
				);
				return true;
			});
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

describe("proactive compaction lifecycle", () => {
	const budget = {
		tier: "long_context",
		contextMax: 922_000,
		displayContextWindow: 1_050_000,
		effectiveContextWindow: 875_900,
		autoCompactTokenLimit: 829_800,
		responseBufferTokens: 174_100,
	};
	const event = {
		messages: [{ role: "assistant", usage: { totalTokens: 830_000 } }],
	};
	const model = {
		id: "gpt-5.5",
		provider: "github-copilot",
		api: "openai-responses",
	};

	it("uses Pi's normal compaction API and permits another compaction after completion", async () => {
		let handler;
		const compactOptions = [];
		registerCopilotAutoCompaction(
			{
				on: (_name, registered) => {
					handler = registered;
				},
			},
			new Map([[model.id, budget]]),
		);
		const ctx = {
			model,
			hasUI: false,
			isIdle: () => true,
			compact: (options) => compactOptions.push(options),
		};

		handler(event, ctx);
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(compactOptions.length, 1);

		compactOptions[0].onComplete();
		handler(event, ctx);
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(compactOptions.length, 2);
	});

	it("resets its guard after compaction errors", async () => {
		let handler;
		const compactOptions = [];
		registerCopilotAutoCompaction(
			{
				on: (_name, registered) => {
					handler = registered;
				},
			},
			new Map([[model.id, budget]]),
		);
		const ctx = {
			model,
			hasUI: false,
			isIdle: () => true,
			compact: (options) => compactOptions.push(options),
		};

		handler(event, ctx);
		await new Promise((resolve) => setTimeout(resolve, 0));
		compactOptions[0].onError(new Error("failed"));
		handler(event, ctx);
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(compactOptions.length, 2);
	});

	it("defers without compacting when the session becomes busy", async () => {
		let handler;
		let compactCalls = 0;
		registerCopilotAutoCompaction(
			{
				on: (_name, registered) => {
					handler = registered;
				},
			},
			new Map([[model.id, budget]]),
		);

		handler(event, {
			model,
			hasUI: false,
			isIdle: () => false,
			compact: () => {
				compactCalls += 1;
			},
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(compactCalls, 0);
	});
});
