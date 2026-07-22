import assert from "node:assert/strict";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { describe, it } from "node:test";

const hasOrcaParent = Boolean(process.env.ORCA_TERMINAL_HANDLE);
const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const resolve = (...paths: string[]): string => join(packageRoot, ...paths);

interface LiveTerminal {
	handle: string;
	ptyId: string;
	tabId: string;
	leafId: string;
	title: string | null;
}

function runOrca(args: string[]): string {
	const result = spawnSync(process.env.ORCA_CLI_COMMAND ?? "orca", args, {
		encoding: "utf8",
	});
	assert.equal(result.status, 0, result.stderr);
	return result.stdout;
}

function liveTerminals(): LiveTerminal[] {
	const stdout = runOrca([
		"terminal",
		"list",
		"--worktree",
		"active",
		"--json",
	]);
	const payload = JSON.parse(stdout) as {
		result: { terminals: LiveTerminal[] };
	};
	return payload.result.terminals;
}

function currentParentTerminal(): LiveTerminal {
	const configuredHandle = process.env.ORCA_TERMINAL_HANDLE;
	if (configuredHandle) {
		const shown = spawnSync(
			process.env.ORCA_CLI_COMMAND ?? "orca",
			["terminal", "show", "--terminal", configuredHandle, "--json"],
			{ encoding: "utf8" },
		);
		if (shown.status === 0) {
			const payload = JSON.parse(shown.stdout) as {
				result: { terminal: LiveTerminal };
			};
			return payload.result.terminal;
		}
	}

	const terminals = liveTerminals();
	const [paneTabId, paneLeafId] = process.env.ORCA_PANE_KEY?.split(":") ?? [];
	const parent =
		terminals.find((terminal) => terminal.handle === configuredHandle) ??
		terminals.find((terminal) => terminal.leafId === paneLeafId) ??
		terminals.find((terminal) => terminal.tabId === paneTabId) ??
		(terminals.length === 1 ? terminals[0] : undefined);
	assert.ok(parent, "Could not resolve the current Orca parent terminal");
	return parent;
}

function liveActiveLeafId(tabId: string): string | undefined {
	const stdout = runOrca([
		"terminal",
		"list",
		"--worktree",
		"active",
		"--json",
	]);
	const payload = JSON.parse(stdout) as {
		result: {
			visualLayouts?: Array<{
				root: { tabs: Array<{ tabId: string; activeLeafId: string }> };
			}>;
		};
	};
	const visualLayouts = payload.result.visualLayouts;
	if (!Array.isArray(visualLayouts)) {
		return currentParentTerminal().leafId;
	}
	return visualLayouts
		.flatMap((layout) => layout.root.tabs)
		.find((tab) => tab.tabId === tabId)?.activeLeafId;
}

async function waitForTerminalToClose(title: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (liveTerminals().some((terminal) => terminal.title === title)) {
		if (Date.now() >= deadline)
			assert.fail(`Orca terminal did not close: ${title}`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

async function waitForTerminalPtysToClose(ptyIds: string[]): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (liveTerminals().some((terminal) => ptyIds.includes(terminal.ptyId))) {
		if (Date.now() >= deadline)
			assert.fail(`Orca terminals did not close: ${ptyIds.join(", ")}`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

async function waitForFiles(paths: string[]): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (!paths.every((path) => existsSync(path))) {
		if (Date.now() >= deadline)
			assert.fail(`Timed out waiting for ${paths.join(", ")}`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

describe("live Orca wrapper", { skip: !hasOrcaParent }, () => {
	it("places two viewers without moving focus and closes both", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-orca-live-stack-test-"));
		const fakePi = join(directory, "fake-pi");
		const releaseFile = join(directory, "release");
		writeFileSync(
			fakePi,
			`#!/usr/bin/env bash
touch "$STARTED_FILE"
while [[ ! -e "$RELEASE_FILE" ]]; do sleep 0.05; done
printf '%s\\n' '{"type":"agent_settled"}'
`,
			"utf8",
		);
		chmodSync(fakePi, 0o755);
		const agentName = `integration-stack-${process.pid}-${Date.now()}`;
		const batch = `integration-${process.pid}-${Date.now()}`;
		const initialTerminals = liveTerminals();
		const before = new Set(initialTerminals.map((terminal) => terminal.ptyId));
		const parent = currentParentTerminal();
		const supportsNonfocusSplit = /--(?:no-focus|background)\b/.test(
			runOrca(["terminal", "split", "--help"]),
		);
		const initialActiveLeafId = liveActiveLeafId(parent.tabId);
		assert.ok(initialActiveLeafId, "Could not resolve the active Orca pane");

		const children = [0, 1].map((index) =>
			spawn(resolve("bin/orca-pi-wrapper"), [], {
				stdio: "ignore",
				env: {
					...process.env,
					TMPDIR: directory,
					PI_ORCA_REAL_PI_BINARY: fakePi,
					PI_ORCA_SUBAGENT_VIEW_LAYOUT: "right_stack",
					PI_ORCA_SUBAGENT_VIEW_BATCH: batch,
					PI_SUBAGENT_CHILD_AGENT: agentName,
					PI_SUBAGENT_CHILD_INDEX: String(index),
					STARTED_FILE: join(directory, `started-${index}`),
					RELEASE_FILE: releaseFile,
				},
			}),
		);

		try {
			await waitForFiles([
				join(directory, "started-0"),
				join(directory, "started-1"),
			]);
			const added = liveTerminals().filter(
				(terminal) => !before.has(terminal.ptyId),
			);
			assert.equal(
				added.length,
				2,
				`right_stack created duplicate fallback terminals: ${JSON.stringify(added)}`,
			);
			if (supportsNonfocusSplit) {
				assert.ok(added.every((terminal) => terminal.tabId === parent.tabId));
			} else {
				assert.ok(added.every((terminal) => terminal.tabId !== parent.tabId));
				assert.equal(new Set(added.map((terminal) => terminal.tabId)).size, 2);
			}
			assert.notEqual(
				liveTerminals().find((terminal) => terminal.ptyId === parent.ptyId)
					?.title,
				`-> ${agentName} · 2`,
				"right_stack renamed the parent tab",
			);
			assert.equal(
				liveActiveLeafId(parent.tabId),
				initialActiveLeafId,
				"right_stack moved focus away from the previously active pane",
			);

			const exits = children.map(
				(child) =>
					new Promise<void>((resolveExit) => {
						if (child.exitCode !== null || child.signalCode !== null)
							resolveExit();
						else child.once("exit", () => resolveExit());
					}),
			);
			writeFileSync(releaseFile, "", "utf8");
			await Promise.all(exits);
			await waitForTerminalPtysToClose(added.map((terminal) => terminal.ptyId));
			assert.deepEqual(
				liveTerminals().filter((terminal) => !before.has(terminal.ptyId)),
				[],
			);
		} finally {
			writeFileSync(releaseFile, "", "utf8");
			for (const child of children) child.kill("SIGTERM");
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("runs a child through a visible Orca terminal without changing its protocol", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-orca-live-test-"));
		const fakePi = join(directory, "fake-pi");
		const argsFile = join(directory, "pi-args.txt");
		const promptFile = join(directory, "task.md");
		writeFileSync(promptFile, "Review the exact task", "utf8");
		writeFileSync(
			fakePi,
			"#!/usr/bin/env bash\nprintf '%s\\n' \"$@\" > \"$PI_ARGS_FILE\"\nprintf '%s\\n' '{\"type\":\"agent_settled\"}'\n",
			"utf8",
		);
		chmodSync(fakePi, 0o755);
		const agentName = `integration-${process.pid}-${Date.now()}`;
		const terminalTitle = `-> ${agentName} · 1`;

		try {
			const result = spawnSync(resolve("bin/orca-pi-wrapper"), [
				"-p",
				"--mode",
				"json",
				"--no-session",
				`--prompt-file=${promptFile}`,
			], {
				encoding: "utf8",
				env: {
					...process.env,
					PI_ORCA_REAL_PI_BINARY: fakePi,
					PI_SUBAGENT_CHILD_AGENT: agentName,
					PI_SUBAGENT_CHILD_INDEX: "0",
					PI_ARGS_FILE: argsFile,
				},
			});

			assert.equal(result.status, 0, result.stderr);
			assert.equal(result.stdout, '{"type":"agent_settled"}\n');
			assert.equal(result.stderr, "");
			assert.equal(
				readFileSync(argsFile, "utf8"),
				`-p\n--mode\njson\n--no-session\n--prompt-file=${promptFile}\n`,
			);
			await waitForTerminalToClose(terminalTitle);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
