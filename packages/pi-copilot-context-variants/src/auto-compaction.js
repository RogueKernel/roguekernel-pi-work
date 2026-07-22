/** Copilot GPT prompt-budget compaction policy and lifecycle hook. */

import { PROVIDER } from "./model-catalog.js";

const RETRYABLE_ERROR_RE =
	/overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|websocket.?closed|websocket.?error|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|http2 request did not get a response|timed? out|timeout|terminated|retry delay/i;

function latestAssistantUsageTokens(messages) {
	if (!Array.isArray(messages)) return undefined;
	for (const entry of messages.toReversed()) {
		const message = entry?.message ?? entry;
		if (message?.role !== "assistant") continue;
		const usage = message.usage ?? entry?.usage;
		if (!usage || typeof usage !== "object") continue;
		if (typeof usage.totalTokens === "number") return usage.totalTokens;
		const input = typeof usage.input === "number" ? usage.input : 0;
		const cacheRead = typeof usage.cacheRead === "number" ? usage.cacheRead : 0;
		const output = typeof usage.output === "number" ? usage.output : 0;
		const computed = input + cacheRead + output;
		if (computed > 0) return computed;
	}
	return undefined;
}

function lastAssistantWasRetryableError(messages) {
	if (!Array.isArray(messages)) return false;
	const lastAssistant = messages
		.toReversed()
		.find((entry) => (entry?.message ?? entry)?.role === "assistant");
	const message = lastAssistant?.message ?? lastAssistant;
	return (
		message?.stopReason === "error" &&
		typeof message.errorMessage === "string" &&
		RETRYABLE_ERROR_RE.test(message.errorMessage)
	);
}

function isCopilotGptResponsesModel(model) {
	const id = typeof model?.id === "string" ? model.id.toLowerCase() : "";
	return (
		model?.provider === PROVIDER &&
		model?.api === "openai-responses" &&
		/\b(gpt-5|o1|o3)/.test(id)
	);
}

export function evaluateCopilotAutoCompaction(event, ctx, contextBudgets) {
	const model = ctx?.model;
	if (!isCopilotGptResponsesModel(model)) {
		return { shouldCompact: false, reason: "not-copilot-gpt" };
	}
	const budget = model.copilotContextBudget ?? contextBudgets?.get?.(model.id);
	if (!budget || typeof budget.autoCompactTokenLimit !== "number") {
		return { shouldCompact: false, reason: "missing-budget" };
	}
	if (lastAssistantWasRetryableError(event?.messages)) {
		return { shouldCompact: false, reason: "retryable-error", budget };
	}
	const tokens = latestAssistantUsageTokens(event?.messages);
	if (typeof tokens !== "number") {
		return {
			shouldCompact: false,
			reason: "missing-usage",
			threshold: budget.autoCompactTokenLimit,
			budget,
		};
	}
	if (tokens < budget.autoCompactTokenLimit) {
		return {
			shouldCompact: false,
			reason: "below-threshold",
			tokens,
			threshold: budget.autoCompactTokenLimit,
			budget,
		};
	}
	return {
		shouldCompact: true,
		tokens,
		threshold: budget.autoCompactTokenLimit,
		reason: "threshold-reached",
		budget,
	};
}

export function registerCopilotAutoCompaction(pi, contextBudgets) {
	if (process.env.PI_COPILOT_CONTEXT_AUTO_COMPACT === "0") return;
	let compactInFlight = false;
	pi.on("agent_end", (event, ctx) => {
		if (compactInFlight) return;
		const decision = evaluateCopilotAutoCompaction(event, ctx, contextBudgets);
		if (!decision.shouldCompact) return;

		const hasUI = ctx.hasUI;
		const ui = ctx.ui;
		if (hasUI) {
			ui?.notify(
				`Copilot context variants: compaction threshold reached (${decision.tokens.toLocaleString()} / ${decision.threshold.toLocaleString()} tokens); triggering compaction`,
				"info",
			);
		}

		compactInFlight = true;
		setTimeout(() => {
			try {
				if (!ctx.isIdle()) {
					compactInFlight = false;
					if (hasUI)
						ui?.notify(
							"Copilot context variants: compaction deferred because the session became busy",
							"info",
						);
					return;
				}
				ctx.compact({
					onComplete: () => {
						compactInFlight = false;
						if (hasUI)
							ui?.notify(
								"Copilot context variants: compaction complete",
								"info",
							);
					},
					onError: () => {
						compactInFlight = false;
						if (hasUI)
							ui?.notify(
								"Copilot context variants: compaction failed",
								"error",
							);
					},
				});
			} catch {
				compactInFlight = false;
				if (hasUI)
					ui?.notify(
						"Copilot context variants: could not start compaction",
						"error",
					);
			}
		}, 0);
	});
}
