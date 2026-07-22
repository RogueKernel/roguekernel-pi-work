import { randomUUID } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const WRAPPER_ENV = "PI_SUBAGENT_PI_BINARY";
const VIEW_LAYOUT_ENV = "PI_ORCA_SUBAGENT_VIEW_LAYOUT";
const VIEW_BATCH_ENV = "PI_ORCA_SUBAGENT_VIEW_BATCH";
const VIEW_TOOL = "orca_subagent_view";
const VIEW_LAYOUTS = ["background_tabs", "right_stack", "hidden"] as const;
type ViewLayout = (typeof VIEW_LAYOUTS)[number];

const wrapperPath = join(
	dirname(fileURLToPath(import.meta.url)),
	"../bin/orca-pi-wrapper",
);

export function installWrapperOverride(
	env: NodeJS.ProcessEnv,
	path = wrapperPath,
): "installed" | "already-configured" | "not-in-orca" {
	if (!env.ORCA_TERMINAL_HANDLE?.trim()) return "not-in-orca";
	if (env[WRAPPER_ENV]?.trim()) return "already-configured";
	accessSync(path, constants.X_OK);
	env[WRAPPER_ENV] = path;
	return "installed";
}

function isViewLayout(value: unknown): value is ViewLayout {
	return (
		typeof value === "string" && VIEW_LAYOUTS.includes(value as ViewLayout)
	);
}

function registerViewTool(pi: ExtensionAPI): void {
	let pendingLayout: ViewLayout | undefined;
	let pendingBatch: string | undefined;
	let consumingToolCall: string | undefined;

	const clearPendingLayout = (): void => {
		if (process.env[VIEW_BATCH_ENV] === pendingBatch) {
			delete process.env[VIEW_LAYOUT_ENV];
			delete process.env[VIEW_BATCH_ENV];
		}
		pendingLayout = undefined;
		pendingBatch = undefined;
		consumingToolCall = undefined;
	};

	const armLayout = (layout: ViewLayout): string => {
		if (pendingLayout === layout && pendingBatch) return pendingBatch;
		clearPendingLayout();
		pendingLayout = layout;
		pendingBatch = randomUUID();
		process.env[VIEW_LAYOUT_ENV] = layout;
		process.env[VIEW_BATCH_ENV] = pendingBatch;
		return pendingBatch;
	};

	pi.registerTool({
		name: VIEW_TOOL,
		label: "Orca Subagent View",
		description:
			"Configure the Orca read-only viewer for the next pi-subagents launch. " +
			"The default is one unfocused background tab per child and requires no call. Use right_stack only when the user asks to stack pi-subagents viewers on the right; Orca versions without non-focusing split support safely fall back to background tabs. Use hidden only when the user explicitly requests no viewer. " +
			"This does not create subagents or general-purpose Orca terminals. Requests to create, split, or stack ordinary working terminals belong directly to Orca terminal tools.",
		promptSnippet:
			"Configure read-only Orca viewer placement for the next pi-subagents launch",
		promptGuidelines: [
			"Do not call orca_subagent_view for ordinary subagent launches; inside Orca, pi-orca-subagents automatically opens one unfocused background read-only tab per child.",
			"Use orca_subagent_view only to request right_stack for the next launch, or hidden when the user explicitly asks for no viewer. Never claim right_stack succeeded when Orca lacks a non-focusing split capability; the adapter falls back to background tabs.",
			"Do not use orca_subagent_view for requests to create, split, or stack ordinary working terminals; use Orca terminal tools directly because those terminals are not pi-subagents viewers.",
		],
		parameters: Type.Object({
			layout: Type.Unsafe<ViewLayout>({
				type: "string",
				enum: [...VIEW_LAYOUTS],
				description: "Viewer layout for the next pi-subagents launch",
			}),
		}),
		async execute(_toolCallId, params) {
			const batch = armLayout(params.layout);
			let text =
				"The next pi-subagents launch will use the default background viewer tabs.";
			if (params.layout === "right_stack") {
				text =
					"The next pi-subagents launch will request up to two read-only viewers stacked on the right. To prevent focus theft, Orca versions without non-focusing split support will use background viewer tabs instead.";
			} else if (params.layout === "hidden") {
				text = "The next pi-subagents launch will not create Orca viewers.";
			}
			return {
				content: [{ type: "text", text }],
				details: { layout: params.layout, batch },
			};
		},
	});

	pi.on("tool_call", (event) => {
		if (event.toolName === VIEW_TOOL) {
			const layout = (event.input as { layout?: unknown }).layout;
			if (isViewLayout(layout)) armLayout(layout);
			return;
		}
		if (event.toolName === "subagent" && pendingBatch && !consumingToolCall) {
			const input = event.input;
			if (!input || typeof input !== "object" || "action" in input) return;
			if (!("agent" in input || "tasks" in input || "chain" in input)) return;
			consumingToolCall = event.toolCallId;
		}
	});

	pi.on("tool_execution_end", (event) => {
		if (event.toolCallId === consumingToolCall) clearPendingLayout();
	});

	pi.on("session_shutdown", clearPendingLayout);
}

export default function orcaAdapter(pi: ExtensionAPI): void {
	const result = installWrapperOverride(process.env);
	if (result === "not-in-orca") return;

	const ownsWrapper = process.env[WRAPPER_ENV] === wrapperPath;
	if (ownsWrapper) registerViewTool(pi);

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;

		if (!ownsWrapper) {
			ctx.ui.notify(
				`${WRAPPER_ENV} is already configured; pi-orca-subagents left it unchanged.`,
				"warning",
			);
			return;
		}

		const hasPiSubagents = pi
			.getAllTools()
			.some((tool) => tool.name === "subagent");
		if (!hasPiSubagents) {
			ctx.ui.notify(
				"pi-orca-subagents requires the separate pi-subagents package.",
				"warning",
			);
		}
	});
}
