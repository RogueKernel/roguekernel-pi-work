import assert from "node:assert/strict";
import { describe, it } from "node:test";

import customGithubCopilot, {
	buildModels,
	buildEntitledModels,
	COPILOT_USER_ENDPOINT,
	createCopilotRequestModelResolver,
	createCopilotRefreshModels,
	createCopilotStreamSimple,
	INFERENCE_HEADERS,
	fetchEntitledCopilotModels,
	parseCopilotApiUrl,
	PROVIDER_ID,
	resolveCopilotApiUrl,
	rewriteCopilotRequestPayload,
	TOKEN_ENV,
} from "../src/custom-github-copilot.js";

const API_URL = "https://api.business.githubcopilot.com";
const TOKEN = "github_pat_test_secret";

function successfulFetch(payload = { endpoints: { api: API_URL } }) {
	return async () => ({
		ok: true,
		status: 200,
		json: async () => payload,
	});
}

describe("parseCopilotApiUrl", () => {
	it("accepts and normalizes a trusted Copilot API origin", () => {
		assert.equal(
			parseCopilotApiUrl({ endpoints: { api: `${API_URL}/` } }),
			API_URL,
		);
	});

	it("rejects missing and malformed endpoint payloads", () => {
		assert.throws(() => parseCopilotApiUrl({}), /returned no API endpoint/);
		assert.throws(
			() => parseCopilotApiUrl({ endpoints: { api: "not a URL" } }),
			/invalid API endpoint/,
		);
	});

	it("rejects untrusted or ambiguous endpoints", () => {
		for (const api of [
			"http://api.business.githubcopilot.com",
			"https://githubcopilot.com.example.com",
			"https://user@api.business.githubcopilot.com",
			"https://api.business.githubcopilot.com/v1",
			"https://api.business.githubcopilot.com/?target=elsewhere",
		]) {
			assert.throws(
				() => parseCopilotApiUrl({ endpoints: { api } }),
				/untrusted API endpoint/,
			);
		}
	});
});

describe("resolveCopilotApiUrl", () => {
	it("uses the PAT without sending an API-version header", async () => {
		let request;
		const result = await resolveCopilotApiUrl(
			TOKEN,
			async (url, init) => {
				request = { url, init };
				return { ok: true, status: 200, json: async () => ({ endpoints: { api: API_URL } }) };
			},
			new AbortController().signal,
		);

		assert.equal(result, API_URL);
		assert.equal(request.url, COPILOT_USER_ENDPOINT);
		assert.equal(request.init.headers.Authorization, `Bearer ${TOKEN}`);
		assert.equal(request.init.headers["X-GitHub-Api-Version"], undefined);
	});

	it("does not include response bodies or the PAT in errors", async () => {
		await assert.rejects(
			() =>
				resolveCopilotApiUrl(TOKEN, async () => ({
					ok: false,
					status: 403,
					text: async () => `denied ${TOKEN}`,
				})),
			(error) => {
				assert.match(error.message, /\(403\)/);
				assert.doesNotMatch(error.message, new RegExp(TOKEN));
				assert.doesNotMatch(error.message, /denied/);
				return true;
			},
		);
	});
});

describe("fetchEntitledCopilotModels", () => {
	it("uses the models-endpoint API version without adding it to inference", async () => {
		let request;
		const models = await fetchEntitledCopilotModels(
			TOKEN,
			API_URL,
			async (url, init) => {
				request = { url, init };
				return { ok: true, status: 200, json: async () => ({ data: [{ id: "gpt-5.5" }] }) };
			},
			new AbortController().signal,
		);

		assert.deepEqual(models, [{ id: "gpt-5.5" }]);
		assert.equal(request.url, `${API_URL}/models`);
		assert.equal(request.init.headers["X-GitHub-Api-Version"], "2026-06-01");
		assert.equal(INFERENCE_HEADERS["X-GitHub-Api-Version"], undefined);
	});

	it("rejects failed and malformed catalog responses without reading bodies", async () => {
		await assert.rejects(
			() =>
				fetchEntitledCopilotModels(TOKEN, API_URL, async () => ({
					ok: false,
					status: 403,
				})),
			/GitHub Copilot model lookup failed \(403\)/,
		);
		await assert.rejects(
			() =>
				fetchEntitledCopilotModels(TOKEN, API_URL, async () => ({
					ok: true,
					status: 200,
					json: async () => ({ data: {} }),
				})),
			/invalid catalog/,
		);
	});
});

describe("model catalog", () => {
	it("shows every entitled chat model with explicit context suffixes", () => {
		const builtIns = [
			{
				id: "gpt-5.5",
				name: "GPT-5.5",
				api: "openai-responses",
				reasoning: true,
				input: ["text"],
				cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
				contextWindow: 1_000_000,
				maxTokens: 128_000,
			},
			{
				id: "claude-sonnet-4.6",
				name: "Claude Sonnet 4.6",
				api: "anthropic-messages",
				reasoning: true,
				input: ["text"],
				cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
				contextWindow: 1_000_000,
				maxTokens: 32_000,
			},
		];
		const entitled = [
			{
				id: "gpt-5.5",
				name: "GPT-5.5",
				model_picker_enabled: true,
				policy: { state: "enabled" },
				capabilities: {
					type: "chat",
					limits: { max_context_window_tokens: 1_000_000, max_output_tokens: 128_000 },
					supports: { tool_calls: true },
				},
				billing: {
					token_prices: {
						batch_size: 1_000_000,
						default: { context_max: 272_000, input_price: 500, output_price: 3000, cache_price: 50 },
						long_context: { context_max: 1_000_000, input_price: 1000, output_price: 4500, cache_price: 100 },
					},
				},
			},
			{
				id: "claude-sonnet-4.6",
				name: "Claude Sonnet 4.6",
				model_picker_enabled: true,
				policy: { state: "enabled" },
				capabilities: {
					type: "chat",
					limits: { max_context_window_tokens: 1_000_000, max_output_tokens: 32_000 },
					supports: { tool_calls: true },
				},
			},
			{
				id: "gemini-3.1-pro-preview",
				name: "Gemini 3.1 Pro",
				model_picker_enabled: true,
				policy: { state: "enabled" },
				capabilities: {
					type: "chat",
					family: "gemini",
					limits: { max_context_window_tokens: 1_000_000, max_output_tokens: 64_000 },
					supports: { tool_calls: true },
				},
			},
		];

		assert.deepEqual(
			buildEntitledModels(entitled, builtIns, API_URL).map((model) => model.id),
			[
				"claude-sonnet-4.6-1m",
				"gemini-3.1-pro-preview-1m",
				"gpt-5.5-1m",
				"gpt-5.5-272k",
			],
		);
	});

	it("filters non-selectable models and does not double-suffix live IDs", () => {
		const live = (id, overrides = {}) => ({
			id,
			model_picker_enabled: true,
			policy: { state: "enabled" },
			capabilities: {
				type: "chat",
				limits: { max_context_window_tokens: 200_000, max_output_tokens: 8_000 },
				supports: { tool_calls: true },
			},
			...overrides,
		});
		const models = buildEntitledModels(
			[
				live("claude-test-200k"),
				live("hidden", { model_picker_enabled: false }),
				live("disabled", { policy: { state: "disabled" } }),
				live("embedding", { capabilities: { type: "embedding" } }),
				live("no-tools", {
					capabilities: {
						type: "chat",
						limits: { max_context_window_tokens: 200_000 },
						supports: { tool_calls: false },
					},
				}),
			],
			[],
			API_URL,
		);

		assert.deepEqual(models.map((model) => model.id), ["claude-test-200k"]);
		assert.equal(models[0].copilotWireModelId, "claude-test-200k");
		assert.equal(models[0].copilotApi, "anthropic-messages");
	});

	it("exposes explicit threshold and 1m variants for every model family", () => {
		const models = buildModels(API_URL);

		assert.deepEqual(
			models.map((model) => model.id),
			[
				"gpt-5.4-272k",
				"gpt-5.4-1m",
				"gpt-5.5-272k",
				"gpt-5.5-1m",
				"gpt-5.6-luna-200k",
				"gpt-5.6-luna-1m",
				"gpt-5.6-sol-272k",
				"gpt-5.6-sol-1m",
				"gpt-5.6-terra-272k",
				"gpt-5.6-terra-1m",
			],
		);
		assert.ok(models.every((model) => model.baseUrl === API_URL));
		assert.ok(models.every((model) => model.api === "custom-github-copilot-api"));
		assert.ok(models.every((model) => model.copilotApi === "openai-responses"));
		assert.ok(models.every((model) => model.maxTokens === 128_000));
		assert.ok(models.every((model) => model.input.length === 1 && model.input[0] === "text"));
		assert.ok(models.every((model) => /-(?:\d+k|1m)$/.test(model.id)));
		assert.ok(models.every((model) => !("X-GitHub-Api-Version" in model.headers)));
		assert.deepEqual(models[0].headers, INFERENCE_HEADERS);
		assert.deepEqual(models[1].cost.tiers, [
			{
				inputTokensAbove: 272_000,
				input: 5,
				output: 22.5,
				cacheRead: 0.5,
				cacheWrite: 0,
			},
		]);
		assert.equal(models[1].contextWindow, 1_000_000);
	});

	it("rewrites synthetic IDs only for this provider", () => {
		const payload = { model: "gpt-5.5-272k", input: [] };
		assert.deepEqual(
			rewriteCopilotRequestPayload(payload, {
				provider: PROVIDER_ID,
				id: "gpt-5.5-272k",
			}),
			{ model: "gpt-5.5", input: [] },
		);
		assert.equal(
			rewriteCopilotRequestPayload(payload, {
				provider: "github-copilot",
				id: "gpt-5.5-272k",
			}),
			payload,
		);
		assert.deepEqual(
			rewriteCopilotRequestPayload(
				{ model: "gpt-5.6-sol-1m", input: [] },
				{ provider: PROVIDER_ID, id: "gpt-5.6-sol-1m" },
			),
			{ model: "gpt-5.6-sol", input: [] },
		);
	});

	it("removes routes for models retired by a successful catalog generation", () => {
		const live = (id) => ({
			id,
			model_picker_enabled: true,
			policy: { state: "enabled" },
			capabilities: {
				type: "chat",
				limits: { max_context_window_tokens: 128_000, max_output_tokens: 16_000 },
				supports: { tool_calls: true },
			},
		});
		buildEntitledModels([live("old-model")], [], API_URL);
		const oldPayload = { model: "old-model-128k" };
		assert.deepEqual(
			rewriteCopilotRequestPayload(oldPayload, {
				provider: PROVIDER_ID,
				id: "old-model-128k",
			}),
			{ model: "old-model" },
		);

		buildEntitledModels([live("new-model")], [], API_URL);
		assert.equal(
			rewriteCopilotRequestPayload(oldPayload, {
				provider: PROVIDER_ID,
				id: "old-model-128k",
			}),
			oldPayload,
		);
	});
});

describe("catalog fallback", () => {
	it("persists a successful forced refresh", async () => {
		let written;
		const liveModel = {
			id: "gpt-5.5",
			name: "GPT-5.5",
			model_picker_enabled: true,
			policy: { state: "enabled" },
			capabilities: {
				type: "chat",
				limits: { max_context_window_tokens: 1_000_000, max_output_tokens: 128_000 },
				supports: { tool_calls: true },
			},
		};
		const refresh = createCopilotRefreshModels(
			async () => ({
				ok: true,
				status: 200,
				json: async () => ({ data: [liveModel] }),
			}),
			[],
			async (model) => ({ ...model, baseUrl: API_URL }),
		);
		const result = await refresh({
			credential: { type: "api_key", key: TOKEN },
			store: {
				read: async () => undefined,
				write: async (generation) => (written = generation),
			},
			allowNetwork: true,
			force: true,
			signal: new AbortController().signal,
		});

		assert.deepEqual(result.map((model) => model.id), ["gpt-5.5-1m"]);
		assert.deepEqual(written.models, result);
		assert.equal(typeof written.checkedAt, "number");
	});

	it("uses the persisted generation without networking unless refresh is forced", async () => {
		const cachedModels = buildModels(API_URL);
		const refresh = createCopilotRefreshModels(
			async () => assert.fail("cached refresh must not fetch"),
			[],
			async () => assert.fail("cached refresh must not discover"),
		);
		const result = await refresh({
			credential: { type: "api_key", key: TOKEN },
			store: { read: async () => ({ models: cachedModels }) },
			allowNetwork: true,
			force: false,
			signal: new AbortController().signal,
		});

		assert.deepEqual(result, cachedModels);
	});

	it("uses the bootstrap catalog when no persisted generation is available", async () => {
		const refresh = createCopilotRefreshModels(
			async () => assert.fail("offline refresh must not fetch"),
			[],
			async () => assert.fail("offline refresh must not discover"),
		);
		const result = await refresh({
			store: { read: async () => undefined },
			allowNetwork: false,
			signal: new AbortController().signal,
		});

		assert.deepEqual(result.map((model) => model.id), buildModels("ignored").map((model) => model.id));
		assert.ok(result.every((model) => model.baseUrl === "https://unresolved.invalid"));
	});

	it("returns the persisted generation after a network-enabled refresh failure", async () => {
		const cachedModels = buildModels(API_URL);
		const refresh = createCopilotRefreshModels(
			async () => {
				throw new Error("offline");
			},
			[],
			async () => {
				throw new Error("discovery failed");
			},
		);
		const result = await refresh({
			credential: { type: "api_key", key: TOKEN },
			store: {
				read: async () => ({ models: cachedModels }),
				write: async () => assert.fail("failed refresh must not overwrite cache"),
			},
			allowNetwork: true,
			force: true,
			signal: new AbortController().signal,
		});

		assert.deepEqual(result, cachedModels);
	});

	it("restores the persisted generation when Pi requests offline refresh", async () => {
		const cachedModels = buildModels(API_URL);
		const refresh = createCopilotRefreshModels(
			async () => assert.fail("offline refresh must not fetch"),
			[],
			async () => assert.fail("offline refresh must not discover"),
		);
		const result = await refresh({
			credential: { type: "api_key", key: TOKEN },
			store: { read: async () => ({ models: cachedModels }) },
			allowNetwork: false,
			signal: new AbortController().signal,
		});

		assert.deepEqual(result, cachedModels);
	});

	it("restores the persisted generation when Pi has already aborted refresh", async () => {
		const cachedModels = buildModels(API_URL);
		const controller = new AbortController();
		controller.abort();
		const refresh = createCopilotRefreshModels(
			async () => assert.fail("aborted refresh must not fetch"),
			[],
			async () => assert.fail("aborted refresh must not discover"),
		);
		const result = await refresh({
			credential: { type: "api_key", key: TOKEN },
			store: { read: async () => ({ models: cachedModels }) },
			allowNetwork: true,
			force: true,
			signal: controller.signal,
		});

		assert.deepEqual(result, cachedModels);
	});
});

describe("extension registration", () => {
	it("registers before a PAT is configured so Pi can offer API-key login", () => {
		let registration;
		let fetched = false;
		customGithubCopilot(
			{
				registerProvider: (id, config) => (registration = { id, config }),
				on: () => {},
			},
			{ fetchImpl: async () => (fetched = true) },
		);

		assert.equal(registration.id, PROVIDER_ID);
		assert.equal(registration.config.apiKey, `$${TOKEN_ENV}`);
		assert.equal(registration.config.oauth, undefined);
		assert.equal(typeof registration.config.streamSimple, "function");
		assert.equal(fetched, false);
	});

	it("registers a separate PAT-only provider with fail-closed model routing", () => {
		let registration;
		let requestHandler;
		let headerHandler;
		customGithubCopilot(
			{
				registerProvider: (id, config) => (registration = { id, config }),
				on: (event, handler) => {
					if (event === "before_provider_request") requestHandler = handler;
					if (event === "before_provider_headers") headerHandler = handler;
				},
			},
			{ fetchImpl: successfulFetch() },
		);

		assert.equal(registration.id, PROVIDER_ID);
		assert.notEqual(registration.id, "github-copilot");
		assert.equal(registration.config.apiKey, `$${TOKEN_ENV}`);
		assert.equal(registration.config.oauth, undefined);
		assert.equal(typeof registration.config.refreshModels, "function");
		assert.ok(
			registration.config.models.every(
				(model) => model.baseUrl === "https://unresolved.invalid",
			),
		);
		assert.deepEqual(
			requestHandler(
				{ payload: { model: "gpt-5.4-272k" } },
				{ model: { provider: PROVIDER_ID, id: "gpt-5.4-272k" } },
			),
			{ model: "gpt-5.4" },
		);
		const headers = { "x-api-key": TOKEN };
		headerHandler({ headers }, { model: { provider: PROVIDER_ID } });
		assert.equal(headers["x-api-key"], null);
	});

	it("resolves and caches the PAT-specific endpoint on request models", async () => {
		let calls = 0;
		const resolveRequestModel = createCopilotRequestModelResolver(async () => {
			calls += 1;
			return {
				ok: true,
				status: 200,
				json: async () => ({ endpoints: { api: API_URL } }),
			};
		});
		const model = { provider: PROVIDER_ID, id: "gpt-5.5-272k", baseUrl: "https://unresolved.invalid" };

		assert.equal((await resolveRequestModel(model, TOKEN)).baseUrl, API_URL);
		assert.equal((await resolveRequestModel(model, TOKEN)).baseUrl, API_URL);
		assert.equal(calls, 1);
	});

	it("rediscovers the endpoint when the PAT changes", async () => {
		let calls = 0;
		const resolveRequestModel = createCopilotRequestModelResolver(async () => {
			calls += 1;
			return {
				ok: true,
				status: 200,
				json: async () => ({ endpoints: { api: API_URL } }),
			};
		});
		const model = { id: "gpt-5.5-272k", baseUrl: "https://unresolved.invalid" };

		await resolveRequestModel(model, TOKEN);
		await resolveRequestModel(model, `${TOKEN}_rotated`);
		assert.equal(calls, 2);
	});

	it("rejects a request when no PAT is resolved", async () => {
		const resolveRequestModel = createCopilotRequestModelResolver(
			async () => assert.fail("missing credentials must not fetch"),
		);

		await assert.rejects(
			() => resolveRequestModel({ id: "gpt-5.5-272k" }, ""),
			/no GitHub Copilot PAT was resolved/,
		);
	});

	it("routes stream requests with the real model ID and resolved endpoint", async () => {
		const model = buildModels("https://unresolved.invalid").find(
			(candidate) => candidate.id === "gpt-5.5-272k",
		);
		let delegated;
		const streamSimple = createCopilotStreamSimple(
			undefined,
			{
				streamSimple: (requestModel, context, options) => {
					delegated = { requestModel, context, options };
					return (async function* () {
						yield { type: "done", reason: "stop", message: { role: "assistant" } };
					})();
				},
			},
			async (requestModel) => ({ ...requestModel, baseUrl: API_URL }),
		);
		const context = { messages: [], tools: [] };
		const options = { apiKey: TOKEN };

		await streamSimple(model, context, options).result();
		assert.equal(delegated.requestModel.id, "gpt-5.5");
		assert.equal(delegated.requestModel.api, "openai-responses");
		assert.equal(delegated.requestModel.baseUrl, API_URL);
		assert.equal(delegated.context, context);
		assert.equal(delegated.options, options);
	});

	it("fails closed when a selector has no provider-local route", async () => {
		const streamSimple = createCopilotStreamSimple(
			undefined,
			{ streamSimple: () => assert.fail("unknown routes must not delegate") },
			async () => assert.fail("unknown routes must not discover"),
		);
		const result = await streamSimple(
			{ provider: PROVIDER_ID, id: "unknown-128k", api: "custom-github-copilot-api" },
			{ messages: [], tools: [] },
			{ apiKey: TOKEN },
		).result();

		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage, /No Copilot route for model unknown-128k/);
	});

	it("fails closed with a sanitized request-time discovery error", async () => {
		const resolveRequestModel = createCopilotRequestModelResolver(async () => ({
			ok: false,
			status: 401,
		}));
		await assert.rejects(
			() => resolveRequestModel({ id: "gpt-5.5-272k" }, TOKEN),
			(error) => {
				assert.match(error.message, /endpoint discovery failed/);
				assert.doesNotMatch(error.message, new RegExp(TOKEN));
				return true;
			},
		);
	});
});
