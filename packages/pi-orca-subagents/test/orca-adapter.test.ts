import assert from "node:assert/strict";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { afterEach, describe, it } from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ViewerManifest } from "../src/viewer-model.mjs";

import orcaAdapter, {
	installWrapperOverride,
} from "../pi-extension/orca-adapter.ts";

const tempDirs: string[] = [];
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const resolve = (...paths: string[]): string => join(packageRoot, ...paths);

afterEach(() => {
	for (const directory of tempDirs.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function tempDir(): string {
	const directory = mkdtempSync(join(tmpdir(), "pi-orca-adapter-test-"));
	tempDirs.push(directory);
	return directory;
}

function writeExecutable(path: string, contents: string): void {
	writeFileSync(path, contents, "utf8");
	chmodSync(path, 0o755);
}

async function waitForFile(path: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!existsSync(path)) {
		if (Date.now() >= deadline)
			throw new Error(`Timed out waiting for ${path}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<number | null> {
	return new Promise((resolveExit) => child.once("exit", resolveExit));
}

async function waitForNoEntry(path: string, prefix: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (readdirSync(path).some((entry) => entry.startsWith(prefix))) {
		if (Date.now() >= deadline)
			throw new Error(`Timed out waiting for ${prefix} cleanup`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

async function waitForText(path: string, pattern: RegExp): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!existsSync(path) || !pattern.test(readFileSync(path, "utf8"))) {
		if (Date.now() >= deadline) {
			const contents = existsSync(path)
				? readFileSync(path, "utf8")
				: "(missing)";
			throw new Error(
				`Timed out waiting for ${pattern} in ${path}:\n${contents}`,
			);
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

async function captureViewerManifest({
	args = [],
	env = {},
	upstream,
	upstreamPath,
}: {
	args?: string[];
	env?: NodeJS.ProcessEnv;
	upstream?: string | Uint8Array;
	upstreamPath?: string;
}): Promise<{ manifest: ViewerManifest; mode: number }> {
	const root = tempDir();
	const fakeOrca = join(root, "fake-orca");
	const fakePi = join(root, "fake-pi");
	const manifestCopyFile = join(root, "viewer-manifest-copy.json");
	const upstreamManifestFile = join(root, "upstream-manifest.json");

	writeExecutable(
		fakeOrca,
		`#!/usr/bin/env bash
case "$1 $2" in
  "status --json") printf '%s\\n' '{"ok":true,"result":{"runtime":{"state":"ready"}}}' ;;
  "terminal show") printf '%s\\n' '{"ok":true,"result":{"terminal":{"worktreeId":"worktree-1"}}}' ;;
  "terminal create")
    while [[ "$#" -gt 0 ]]; do
      if [[ "$1" == "--command" ]]; then
        manifest_path="$(printf '%s' "$2" | node -e '
          const fs = require("node:fs");
          const command = fs.readFileSync(0, "utf8");
          const match = command.match(/--manifest\\\\ ([^\\\\ ]+)/);
          if (!match) process.exit(1);
          process.stdout.write(match[1]);
        ')" || exit 3
        cp "$manifest_path" "$MANIFEST_COPY_FILE" || exit 4
        break
      fi
      shift
    done
    printf '%s\\n' '{"ok":true,"result":{"terminal":{"handle":"terminal-1"}}}'
    ;;
  "terminal close") printf '%s\\n' '{"ok":true,"result":{}}' ;;
  *) exit 2 ;;
esac
`,
	);
	writeExecutable(
		fakePi,
		`#!/usr/bin/env bash
if [[ -n "\${PI_ARGS_FILE:-}" ]]; then printf '%s\\n' "$@" > "$PI_ARGS_FILE"; fi
printf '%s\\n' '{"type":"agent_settled"}'
`,
	);
	if (upstream !== undefined) writeFileSync(upstreamManifestFile, upstream);

	const result = spawnSync(resolve("bin/orca-pi-wrapper"), args, {
		encoding: "utf8",
		timeout: 15_000,
		env: {
			...process.env,
			TMPDIR: root,
			ORCA_CLI_COMMAND: fakeOrca,
			ORCA_TERMINAL_HANDLE: "parent-terminal",
			PI_ORCA_REAL_PI_BINARY: fakePi,
			PI_SUBAGENT_CHILD_AGENT: "authoritative-agent",
			PI_SUBAGENT_CHILD_INDEX: "2",
			PI_SUBAGENT_VIEWER_MANIFEST:
				upstreamPath ??
				(upstream === undefined ? undefined : upstreamManifestFile),
			MANIFEST_COPY_FILE: manifestCopyFile,
			UNRELATED_VIEWER_SECRET: "must not be copied",
			...env,
		},
	});

	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, '{"type":"agent_settled"}\n');
	const manifest: ViewerManifest = JSON.parse(
		readFileSync(manifestCopyFile, "utf8"),
	);
	const mode = statSync(manifestCopyFile).mode & 0o777;
	await waitForNoEntry(root, "pi-orca-subagent.");
	return { manifest, mode };
}

describe("extension configuration", () => {
	it("does nothing outside an Orca-managed terminal", () => {
		const env: NodeJS.ProcessEnv = {};
		assert.equal(
			installWrapperOverride(env, "/missing/wrapper"),
			"not-in-orca",
		);
		assert.equal(env.PI_SUBAGENT_PI_BINARY, undefined);

		const originalHandle = process.env.ORCA_TERMINAL_HANDLE;
		const originalWrapper = process.env.PI_SUBAGENT_PI_BINARY;
		let registered = false;
		try {
			delete process.env.ORCA_TERMINAL_HANDLE;
			delete process.env.PI_SUBAGENT_PI_BINARY;
			orcaAdapter({
				registerTool() {
					registered = true;
				},
			} as unknown as ExtensionAPI);
			assert.equal(registered, false);
		} finally {
			if (originalHandle === undefined) delete process.env.ORCA_TERMINAL_HANDLE;
			else process.env.ORCA_TERMINAL_HANDLE = originalHandle;
			if (originalWrapper === undefined)
				delete process.env.PI_SUBAGENT_PI_BINARY;
			else process.env.PI_SUBAGENT_PI_BINARY = originalWrapper;
		}
	});

	it("only describes the presentation tool inside Orca", async () => {
		const originalHandle = process.env.ORCA_TERMINAL_HANDLE;
		const originalWrapper = process.env.PI_SUBAGENT_PI_BINARY;
		const originalLayout = process.env.PI_ORCA_SUBAGENT_VIEW_LAYOUT;
		const originalBatch = process.env.PI_ORCA_SUBAGENT_VIEW_BATCH;
		const tools: Array<{
			name: string;
			description: string;
			promptGuidelines?: string[];
			execute(
				toolCallId: string,
				params: { layout: "hidden" },
			): Promise<unknown>;
		}> = [];
		type CapturedHandler = (event: {
			toolName?: string;
			toolCallId?: string;
			input?: unknown;
		}) => void;
		const handlers = new Map<string, CapturedHandler>();

		try {
			process.env.ORCA_TERMINAL_HANDLE = "parent-terminal";
			delete process.env.PI_SUBAGENT_PI_BINARY;
			const pi = {
				registerTool(tool: unknown) {
					tools.push(tool as (typeof tools)[number]);
				},
				on(event: string, handler: unknown) {
					handlers.set(event, handler as CapturedHandler);
				},
				getAllTools() {
					return [{ name: "subagent" }];
				},
			} as unknown as ExtensionAPI;

			orcaAdapter(pi);

			assert.equal(tools.length, 1);
			assert.equal(tools[0]?.name, "orca_subagent_view");
			assert.match(
				tools[0]?.description ?? "",
				/does not create subagents or general-purpose Orca terminals/,
			);
			assert.match(
				tools[0]?.promptGuidelines?.join("\n") ?? "",
				/use Orca terminal tools directly/,
			);

			await tools[0]?.execute("tool-1", { layout: "hidden" });
			assert.equal(process.env.PI_ORCA_SUBAGENT_VIEW_LAYOUT, "hidden");
			assert.match(
				process.env.PI_ORCA_SUBAGENT_VIEW_BATCH ?? "",
				/^[0-9a-f-]{36}$/,
			);

			handlers.get("tool_call")?.({
				toolName: "subagent",
				toolCallId: "subagent-list",
				input: { action: "list" },
			});
			handlers.get("tool_execution_end")?.({ toolCallId: "subagent-list" });
			handlers.get("agent_settled")?.({});
			assert.equal(process.env.PI_ORCA_SUBAGENT_VIEW_LAYOUT, "hidden");
			assert.match(
				process.env.PI_ORCA_SUBAGENT_VIEW_BATCH ?? "",
				/^[0-9a-f-]{36}$/,
			);

			handlers.get("tool_call")?.({
				toolName: "subagent",
				toolCallId: "subagent-1",
				input: { tasks: [{ agent: "delegate", task: "test" }] },
			});
			handlers.get("tool_execution_end")?.({ toolCallId: "subagent-1" });
			assert.equal(process.env.PI_ORCA_SUBAGENT_VIEW_LAYOUT, undefined);
			assert.equal(process.env.PI_ORCA_SUBAGENT_VIEW_BATCH, undefined);
		} finally {
			if (originalHandle === undefined) delete process.env.ORCA_TERMINAL_HANDLE;
			else process.env.ORCA_TERMINAL_HANDLE = originalHandle;
			if (originalWrapper === undefined)
				delete process.env.PI_SUBAGENT_PI_BINARY;
			else process.env.PI_SUBAGENT_PI_BINARY = originalWrapper;
			if (originalLayout === undefined)
				delete process.env.PI_ORCA_SUBAGENT_VIEW_LAYOUT;
			else process.env.PI_ORCA_SUBAGENT_VIEW_LAYOUT = originalLayout;
			if (originalBatch === undefined)
				delete process.env.PI_ORCA_SUBAGENT_VIEW_BATCH;
			else process.env.PI_ORCA_SUBAGENT_VIEW_BATCH = originalBatch;
		}
	});

	it("sets the pi-subagents wrapper without replacing an existing override", () => {
		const env: NodeJS.ProcessEnv = { ORCA_TERMINAL_HANDLE: "parent-terminal" };
		assert.equal(installWrapperOverride(env, process.execPath), "installed");
		assert.equal(env.PI_SUBAGENT_PI_BINARY, process.execPath);

		env.PI_SUBAGENT_PI_BINARY = "/custom/wrapper";
		assert.equal(
			installWrapperOverride(env, process.execPath),
			"already-configured",
		);
		assert.equal(env.PI_SUBAGENT_PI_BINARY, "/custom/wrapper");
	});
});

describe("Orca Pi wrapper", () => {
	it("preserves stdout, stderr, arguments, cwd, and exit code", async () => {
		const root = tempDir();
		const bin = join(root, "bin");
		const work = join(root, "work");
		mkdirSync(bin);
		mkdirSync(work);

		const callsFile = join(root, "orca-calls.txt");
		const argsFile = join(root, "pi-args.txt");
		const cwdFile = join(root, "pi-cwd.txt");
		const envFile = join(root, "pi-env.txt");
		const promptFile = join(root, "task.md");
		const upstreamManifestFile = join(root, "upstream-manifest.json");
		const manifestCopyFile = join(root, "viewer-manifest-copy.json");
		const fakeOrca = join(bin, "fake-orca");
		const fakePi = join(bin, "fake-pi");

		writeExecutable(
			fakeOrca,
			`#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$ORCA_CALLS_FILE"
case "$1 $2" in
  "status --json") printf '%s\\n' '{"ok":true,"result":{"runtime":{"state":"ready"}}}' ;;
  "terminal show") printf '%s\\n' '{"ok":true,"result":{"terminal":{"worktreeId":"worktree-1"}}}' ;;
  "terminal create")
    while [[ "$#" -gt 0 ]]; do
      if [[ "$1" == "--command" ]]; then
        manifest_path="$(printf '%s' "$2" | node -e '
          const fs = require("node:fs");
          const command = fs.readFileSync(0, "utf8");
          const match = command.match(/--manifest\\\\ ([^\\\\ ]+)/);
          if (!match) process.exit(1);
          process.stdout.write(match[1]);
        ')" || exit 3
        cp "$manifest_path" "$MANIFEST_COPY_FILE" || exit 4
        break
      fi
      shift
    done
    printf '%s\\n' '{"ok":true,"result":{"terminal":{"handle":"terminal-1"}}}'
    ;;
  "terminal close") printf '%s\\n' '{"ok":true,"result":{}}' ;;
  *) exit 2 ;;
esac
`,
		);
		writeExecutable(
			fakePi,
			`#!/usr/bin/env bash
printf '%s\\n' "$@" > "$PI_ARGS_FILE"
pwd > "$PI_CWD_FILE"
printf '%s' "$PI_INHERITED_VALUE" > "$PI_ENV_FILE"
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant"}}'
printf '%s\\n' 'child warning' >&2
exit 7
`,
		);

		writeFileSync(promptFile, "Review the exact task", "utf8");
		writeFileSync(
			upstreamManifestFile,
			JSON.stringify({
				version: 1,
				capturedAt: "2026-07-21T20:00:00.000Z",
				child: {
					agent: "untrusted-agent",
					index: 99,
					runId: "run-1",
					tagline: "Code reviewer",
					agentFile: "reviewer.md",
					secret: "do not copy",
				},
				launch: {
					promptMode: "append",
					task: {
						text: "Conflicting upstream launch task",
						source: "upstream manifest",
						provenance: "exact",
					},
					rawArgv: ["--secret"],
				},
				prompts: [
					{
						kind: "system",
						title: "System",
						text: "Validated system prompt",
						source: "upstream manifest",
						provenance: "exact",
					},
					{
						kind: "task",
						title: "Upstream task",
						text: "Conflicting upstream prompt task",
						source: "upstream manifest",
						provenance: "exact",
					},
				],
				runtime: {
					provider: "openai-codex",
					model: "gpt-5.6-luna",
					contextWindow: 272_000,
					apiKey: "do not copy",
				},
				unrelated: "do not copy",
			}),
			"utf8",
		);
		const wrapper = resolve("bin/orca-pi-wrapper");
		const result = spawnSync(wrapper, [
			"-p",
			"--mode",
			"json",
			"--no-session",
			"--prompt-file",
			promptFile,
		], {
			cwd: work,
			encoding: "utf8",
			env: {
				...process.env,
				TMPDIR: root,
				ORCA_CLI_COMMAND: fakeOrca,
				ORCA_TERMINAL_HANDLE: "parent-terminal",
				PI_ORCA_REAL_PI_BINARY: fakePi,
				ORCA_CALLS_FILE: callsFile,
				PI_ARGS_FILE: argsFile,
				PI_CWD_FILE: cwdFile,
				PI_ENV_FILE: envFile,
				PI_INHERITED_VALUE: "preserved",
				PI_SUBAGENT_VIEWER_MANIFEST: upstreamManifestFile,
				MANIFEST_COPY_FILE: manifestCopyFile,
				UNRELATED_VIEWER_SECRET: "must not be copied",
				PI_SUBAGENT_CHILD_AGENT: "reviewer\u009dhidden\u009c",
				PI_SUBAGENT_CHILD_INDEX: "0",
			},
		});

		assert.equal(result.status, 7);
		assert.equal(
			result.stdout,
			'{"type":"message_end","message":{"role":"assistant"}}\n',
		);
		assert.equal(result.stderr, "child warning\n");
		assert.equal(
			readFileSync(argsFile, "utf8"),
			`-p\n--mode\njson\n--no-session\n--prompt-file\n${promptFile}\n`,
		);
		assert.equal(readFileSync(cwdFile, "utf8"), `${realpathSync(work)}\n`);
		assert.equal(readFileSync(envFile, "utf8"), "preserved");
		const manifest: ViewerManifest = JSON.parse(
			readFileSync(manifestCopyFile, "utf8"),
		);
		assert.deepEqual(manifest.launch, {
			promptMode: "append",
			task: {
				text: "Review the exact task",
				source: "prompt file",
				provenance: "exact",
			},
		});
		assert.deepEqual(manifest.child, {
			agent: "reviewer\u009dhidden\u009c",
			index: 0,
			runId: "run-1",
			tagline: "Code reviewer",
			agentFile: "reviewer.md",
		});
		assert.deepEqual(manifest.prompts, [
			{
				kind: "system",
				title: "System",
				text: "Validated system prompt",
				source: "upstream manifest",
				provenance: "exact",
			},
			{
				kind: "task",
				title: "Task",
				text: "Review the exact task",
				source: "prompt file",
				provenance: "exact",
			},
		]);
		assert.deepEqual(manifest.runtime, {
			provider: "openai-codex",
			model: "gpt-5.6-luna",
			contextWindow: 272_000,
		});
		assert.equal(statSync(manifestCopyFile).mode & 0o777, 0o600);
		const serializedManifest = JSON.stringify(manifest);
		assert.doesNotMatch(serializedManifest, /UNRELATED_VIEWER_SECRET/);
		assert.doesNotMatch(serializedManifest, /must not be copied/);
		assert.doesNotMatch(serializedManifest, /"(?:rawA|a)rgv"/i);
		await waitForText(
			callsFile,
			/^terminal close --terminal terminal-1 --tab --json$/m,
		);
		const orcaCalls = readFileSync(callsFile, "utf8");
		assert.doesNotMatch(orcaCalls, /Review the exact task/);
		assert.match(
			orcaCalls,
			/terminal create --worktree id:worktree-1 --title -> reviewer · 1 --command bash --noprofile --norc -c /,
		);
		assert.equal((orcaCalls.match(/render-pi-jsonl\.mjs/g) ?? []).length, 1);
		assert.match(orcaCalls, /--stdout-log[^\n]*stdout\.log/);
		assert.match(orcaCalls, /--stderr-log[^\n]*stderr\.log/);
		assert.match(orcaCalls, /--done-file[^\n]*done/);
		assert.match(orcaCalls, /--manifest[^\n]*viewer-manifest\.json/);
		assert.doesNotMatch(orcaCalls, /tail\\ -n|tail -n|stdout_view_pid|stderr_view_pid/);
		assert.doesNotMatch(orcaCalls, /terminal create[^\n]*terminal\\ close/);
		assert.doesNotMatch(orcaCalls, /terminal create[^\n]* --focus/);
		assert.doesNotMatch(orcaCalls, /terminal send/);
		await waitForNoEntry(root, "pi-orca-subagent.");
	});

	it("captures --prompt-file=<path> as a private authoritative task", async () => {
		const root = tempDir();
		const promptFile = join(root, "equal-task.md");
		writeFileSync(promptFile, "Review the equal-form task", "utf8");

		const { manifest, mode } = await captureViewerManifest({
			args: [`--prompt-file=${promptFile}`],
			upstream: JSON.stringify({
				version: 1,
				launch: {
					task: {
						text: "Conflicting upstream launch task",
						source: "upstream manifest",
						provenance: "exact",
					},
				},
				prompts: [
					{
						kind: "task",
						title: "Upstream task",
						text: "Conflicting upstream prompt task",
						source: "upstream manifest",
						provenance: "exact",
					},
				],
			}),
		});

		assert.deepEqual(manifest.launch.task, {
			text: "Review the equal-form task",
			source: "prompt file",
			provenance: "exact",
		});
		assert.deepEqual(manifest.prompts, [
			{
				kind: "task",
				title: "Task",
				text: "Review the equal-form task",
				source: "prompt file",
				provenance: "exact",
			},
		]);
		assert.equal(mode, 0o600);
		const serializedManifest = JSON.stringify(manifest);
		assert.doesNotMatch(serializedManifest, /UNRELATED_VIEWER_SECRET/);
		assert.doesNotMatch(serializedManifest, /must not be copied/);
		assert.doesNotMatch(serializedManifest, /"(?:rawA|a)rgv"/i);
	});

	it("captures pi-subagents positional task and model metadata", async () => {
		const root = tempDir();
		const agentPrompt = join(root, "researcher.md");
		writeFileSync(agentPrompt, "Research with primary sources", "utf8");
		const { manifest, mode } = await captureViewerManifest({
			args: [
				"--mode",
				"json",
				"-p",
				"--append-system-prompt",
				agentPrompt,
				"--model",
				"openai-codex/gpt-5.6-sol:medium",
				"Task: Research current UK cat food brands",
			],
		});

		assert.deepEqual(manifest.launch, {
			promptMode: "append",
			task: {
				text: "Research current UK cat food brands",
				source: "Pi positional prompt",
				provenance: "exact",
			},
		});
		assert.deepEqual(manifest.prompts, [
			{
				kind: "agent-template",
				title: "Agent prompt",
				text: "Research with primary sources",
				source: "Pi append-system-prompt file",
				provenance: "exact",
			},
			{
				kind: "task",
				title: "Task",
				text: "Research current UK cat food brands",
				source: "Pi positional prompt",
				provenance: "exact",
			},
		]);
		assert.deepEqual(manifest.runtime, {
			provider: "openai-codex",
			model: "gpt-5.6-sol:medium",
		});
		assert.equal(mode, 0o600);
	});

	it("rejects unsafe upstream manifest files without affecting the child", async () => {
		const root = tempDir();
		const validManifest = JSON.stringify({
			version: 1,
			runtime: { model: "must-not-be-copied" },
		});
		const manifestTarget = join(root, "manifest-target.json");
		const manifestSymlink = join(root, "manifest-symlink.json");
		const manifestFifo = join(root, "manifest-fifo");
		const oversizedManifest = join(root, "oversized-manifest.json");
		const invalidUtf8Manifest = join(root, "invalid-utf8-manifest.json");
		writeFileSync(manifestTarget, validManifest);
		symlinkSync(manifestTarget, manifestSymlink);
		assert.equal(spawnSync("mkfifo", [manifestFifo]).status, 0);
		writeFileSync(
			oversizedManifest,
			`${validManifest}${" ".repeat(2 * 1024 * 1024)}`,
		);
		writeFileSync(
			invalidUtf8Manifest,
			Buffer.concat([
				Buffer.from('{"version":1,"runtime":{"model":"'),
				Buffer.from([0xc3, 0x28]),
				Buffer.from('"}}'),
			]),
		);

		for (const upstreamPath of [
			manifestSymlink,
			manifestFifo,
			"/dev/null",
			oversizedManifest,
			invalidUtf8Manifest,
		]) {
			const { manifest } = await captureViewerManifest({ upstreamPath });
			assert.deepEqual(manifest.runtime, {}, upstreamPath);
			assert.deepEqual(manifest.prompts, [], upstreamPath);
		}
	});

	it("rejects an upstream manifest changed while its descriptor is read", async () => {
		const root = tempDir();
		const upstreamPath = join(root, "changing-manifest.json");
		const preload = join(root, "mutate-during-read.cjs");
		writeFileSync(
			upstreamPath,
			JSON.stringify({ version: 1, runtime: { model: "model-a" } }),
		);
		writeFileSync(
			preload,
			`const fs = require("node:fs");
const originalReadSync = fs.readSync;
let changed = false;
fs.readSync = function (fd, ...args) {
  const bytesRead = originalReadSync.call(this, fd, ...args);
  if (!changed && bytesRead > 0 &&
      fs.fstatSync(fd).ino === fs.statSync(process.env.CHANGE_DURING_READ).ino) {
    changed = true;
    fs.writeFileSync(process.env.CHANGE_DURING_READ,
      JSON.stringify({ version: 1, runtime: { model: "model-b" } }));
  }
  return bytesRead;
};
`,
		);

		const { manifest } = await captureViewerManifest({
			env: {
				CHANGE_DURING_READ: upstreamPath,
				NODE_OPTIONS: `--require=${preload}`,
			},
			upstreamPath,
		});

		assert.deepEqual(manifest.runtime, {});
	});

	it("rejects unsafe prompt files in both argument forms without affecting the child", async () => {
		const root = tempDir();
		const promptTarget = join(root, "prompt-target.md");
		const promptSymlink = join(root, "prompt-symlink.md");
		const promptFifo = join(root, "prompt-fifo");
		const oversizedPrompt = join(root, "oversized-prompt.md");
		const invalidUtf8Prompt = join(root, "invalid-utf8-prompt.md");
		writeFileSync(promptTarget, "must not be copied");
		symlinkSync(promptTarget, promptSymlink);
		assert.equal(spawnSync("mkfifo", [promptFifo]).status, 0);
		writeFileSync(oversizedPrompt, Buffer.alloc(8 * 1024 * 1024 + 1, 0x61));
		writeFileSync(invalidUtf8Prompt, Buffer.from([0xc3, 0x28]));

		const cases = [
			["split symlink", ["--prompt-file", promptSymlink]],
			["equals FIFO", [`--prompt-file=${promptFifo}`]],
			["split device", ["--prompt-file", "/dev/null"]],
			["equals oversized", [`--prompt-file=${oversizedPrompt}`]],
			["split invalid UTF-8", ["--prompt-file", invalidUtf8Prompt]],
		] as const;
		for (const [name, args] of cases) {
			const { manifest } = await captureViewerManifest({ args: [...args] });
			assert.equal(manifest.launch.task, undefined, name);
			assert.deepEqual(manifest.prompts, [], name);
		}
	});

	it("rejects a prompt changed while its descriptor is read", async () => {
		const root = tempDir();
		const promptFile = join(root, "changing-prompt.md");
		const preload = join(root, "mutate-prompt-during-read.cjs");
		writeFileSync(promptFile, "prompt-a");
		writeFileSync(
			preload,
			`const fs = require("node:fs");
const originalReadSync = fs.readSync;
let changed = false;
fs.readSync = function (fd, ...args) {
  const bytesRead = originalReadSync.call(this, fd, ...args);
  if (!changed && bytesRead > 0 &&
      fs.fstatSync(fd).ino === fs.statSync(process.env.CHANGE_DURING_READ).ino) {
    changed = true;
    fs.writeFileSync(process.env.CHANGE_DURING_READ, "prompt-b");
  }
  return bytesRead;
};
`,
		);

		const { manifest } = await captureViewerManifest({
			args: [`--prompt-file=${promptFile}`],
			env: {
				CHANGE_DURING_READ: promptFile,
				NODE_OPTIONS: `--require=${preload}`,
			},
		});

		assert.equal(manifest.launch.task, undefined);
		assert.deepEqual(manifest.prompts, []);
	});

	it("keeps raw child argv out of the manifest helper process", async () => {
		const root = tempDir();
		const bin = join(root, "bin");
		const nodeArgv = join(root, "node-argv.bin");
		const piArgs = join(root, "pi-args.txt");
		const fakeNode = join(bin, "node");
		const sentinel = `helper-argv-sentinel-${process.pid}`;
		mkdirSync(bin);
		writeExecutable(
			fakeNode,
			`#!/usr/bin/env bash
printf '%s\\0' "$@" >> "$NODE_ARGV_LOG"
exec "$REAL_NODE" "$@"
`,
		);

		await captureViewerManifest({
			args: [sentinel],
			env: {
				NODE_ARGV_LOG: nodeArgv,
				PATH: `${bin}:${process.env.PATH ?? ""}`,
				PI_ARGS_FILE: piArgs,
				REAL_NODE: process.execPath,
			},
		});

		assert.equal(readFileSync(piArgs, "utf8"), `${sentinel}\n`);
		assert.doesNotMatch(readFileSync(nodeArgv, "utf8"), new RegExp(sentinel));
	});

	it("rejects invalid and unversioned upstream manifests", async () => {
		for (const upstream of [
			"{invalid json",
			JSON.stringify({
				child: { agent: "upstream-agent", index: 99 },
				launch: { promptMode: "replace" },
				prompts: [{ kind: "system", text: "unversioned secret" }],
				runtime: { model: "upstream-model" },
			}),
			JSON.stringify({
				version: 2,
				child: { agent: "upstream-agent", index: 99 },
				prompts: [{ kind: "system", text: "wrong-version secret" }],
			}),
		]) {
			const { manifest, mode } = await captureViewerManifest({ upstream });

			assert.deepEqual(manifest.child, {
				agent: "authoritative-agent",
				index: 2,
			});
			assert.deepEqual(manifest.prompts, []);
			assert.deepEqual(manifest.runtime, {});
			assert.equal(manifest.launch.task, undefined);
			assert.equal(mode, 0o600);
			assert.doesNotMatch(JSON.stringify(manifest), /upstream/);
		}
	});

	it("re-resolves a stale parent handle by its current pane leaf", async () => {
		const root = tempDir();
		const callsFile = join(root, "orca-calls.txt");
		const fakeOrca = join(root, "fake-orca");
		const fakePi = join(root, "fake-pi");

		writeExecutable(
			fakeOrca,
			`#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$ORCA_CALLS_FILE"
case "$1 $2" in
  "status --json") printf '%s\\n' '{"ok":true,"result":{"runtime":{"state":"ready"}}}' ;;
  "terminal show")
    [[ "$4" != "parent-stale" ]] || exit 1
    printf '%s\\n' '{"ok":true,"result":{"terminal":{"handle":"viewer-created","ptyId":"viewer-pty","tabId":"viewer-tab","leafId":"viewer-leaf","worktreeId":"worktree-1"}}}'
    ;;
  "terminal list") printf '%s\\n' '{"ok":true,"result":{"terminals":[{"handle":"parent-current","ptyId":"parent-pty","tabId":"parent-tab","leafId":"parent-leaf","worktreeId":"worktree-1"},{"handle":"viewer-current","ptyId":"viewer-pty","tabId":"viewer-tab","leafId":"viewer-leaf","worktreeId":"worktree-1"}]}}' ;;
  "terminal create") printf '%s\\n' '{"ok":true,"result":{"terminal":{"handle":"viewer-created"}}}' ;;
  "terminal close") printf '%s\\n' '{"ok":true,"result":{"close":{"ptyKilled":true}}}' ;;
  *) exit 2 ;;
esac
`,
		);
		writeExecutable(
			fakePi,
			"#!/usr/bin/env bash\nprintf '%s\\n' '{\"type\":\"agent_settled\"}'\n",
		);

		const result = spawnSync(resolve("bin/orca-pi-wrapper"), [], {
			encoding: "utf8",
			env: {
				...process.env,
				TMPDIR: root,
				ORCA_CLI_COMMAND: fakeOrca,
				ORCA_TERMINAL_HANDLE: "parent-stale",
				ORCA_PANE_KEY: "parent-tab:parent-leaf",
				ORCA_WORKTREE_ID: "worktree-1",
				PI_ORCA_REAL_PI_BINARY: fakePi,
				ORCA_CALLS_FILE: callsFile,
			},
		});

		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stdout, '{"type":"agent_settled"}\n');
		await waitForText(
			callsFile,
			/^terminal close --terminal viewer-current --tab --json$/m,
		);
		const calls = readFileSync(callsFile, "utf8");
		assert.match(calls, /^terminal show --terminal parent-stale --json$/m);
		assert.match(calls, /^terminal list --worktree id:worktree-1 --json$/m);
		assert.match(calls, /^terminal create --worktree id:worktree-1 /m);
	});

	it("re-resolves a viewer handle by stable pty id before closing", async () => {
		const root = tempDir();
		const callsFile = join(root, "orca-calls.txt");
		const fakeOrca = join(root, "fake-orca");
		const fakePi = join(root, "fake-pi");

		writeExecutable(
			fakeOrca,
			`#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$ORCA_CALLS_FILE"
case "$1 $2" in
  "status --json") printf '%s\\n' '{"ok":true,"result":{"runtime":{"state":"ready"}}}' ;;
  "terminal show")
    if [[ "$4" == "parent-terminal" ]]; then
      printf '%s\\n' '{"ok":true,"result":{"terminal":{"handle":"parent-terminal","ptyId":"parent-pty","tabId":"parent-tab","leafId":"parent-leaf","worktreeId":"worktree-1","paneRuntimeId":1}}}'
    else
      printf '%s\\n' '{"ok":true,"result":{"terminal":{"handle":"viewer-created","ptyId":"viewer-pty","tabId":"viewer-tab","leafId":"viewer-leaf","worktreeId":"worktree-1","paneRuntimeId":2}}}'
    fi
    ;;
  "terminal create") printf '%s\\n' '{"ok":true,"result":{"terminal":{"handle":"viewer-created"}}}' ;;
  "terminal list") printf '%s\\n' '{"ok":true,"result":{"terminals":[{"handle":"viewer-current","ptyId":"viewer-pty","tabId":"viewer-tab","leafId":"viewer-leaf","worktreeId":"worktree-1","paneRuntimeId":3}]}}' ;;
  "terminal close")
    [[ "$4" == "viewer-current" ]] || exit 3
    printf '%s\\n' '{"ok":true,"result":{"close":{"handle":"viewer-current","ptyKilled":true}}}'
    ;;
  *) exit 2 ;;
esac
`,
		);
		writeExecutable(
			fakePi,
			"#!/usr/bin/env bash\nprintf '%s\\n' '{\"type\":\"agent_settled\"}'\n",
		);

		const result = spawnSync(resolve("bin/orca-pi-wrapper"), [], {
			encoding: "utf8",
			env: {
				...process.env,
				TMPDIR: root,
				ORCA_CLI_COMMAND: fakeOrca,
				ORCA_TERMINAL_HANDLE: "parent-terminal",
				PI_ORCA_REAL_PI_BINARY: fakePi,
				ORCA_CALLS_FILE: callsFile,
			},
		});

		assert.equal(result.status, 0, result.stderr);
		await waitForText(
			callsFile,
			/^terminal close --terminal viewer-current --tab --json$/m,
		);
		const calls = readFileSync(callsFile, "utf8");
		assert.match(calls, /^terminal show --terminal viewer-created --json$/m);
		assert.match(calls, /^terminal list --worktree id:worktree-1 --json$/m);
		assert.doesNotMatch(
			calls,
			/^terminal close --terminal viewer-created --tab --json$/m,
		);
	});

	it("passes through silently when Pi is not running inside Orca", () => {
		const root = tempDir();
		const argsFile = join(root, "pi-args.txt");
		const orcaCalledFile = join(root, "orca-called.txt");
		const fakeOrca = join(root, "fake-orca");
		const fakePi = join(root, "fake-pi");

		writeExecutable(
			fakeOrca,
			`#!/usr/bin/env bash
touch "$ORCA_CALLED_FILE"
exit 2
`,
		);
		writeExecutable(
			fakePi,
			`#!/usr/bin/env bash
printf '%s\\n' "$@" > "$PI_ARGS_FILE"
printf 'normal stdout\\n'
printf 'normal stderr\\n' >&2
exit 9
`,
		);

		const result = spawnSync(
			resolve("bin/orca-pi-wrapper"),
			["--mode", "json", "task"],
			{
				encoding: "utf8",
				env: {
					...process.env,
					ORCA_CLI_COMMAND: fakeOrca,
					ORCA_CALLED_FILE: orcaCalledFile,
					PI_ORCA_REAL_PI_BINARY: fakePi,
					PI_ARGS_FILE: argsFile,
					ORCA_TERMINAL_HANDLE: undefined,
				},
			},
		);

		assert.equal(result.status, 9);
		assert.equal(result.stdout, "normal stdout\n");
		assert.equal(result.stderr, "normal stderr\n");
		assert.equal(readFileSync(argsFile, "utf8"), "--mode\njson\ntask\n");
		assert.equal(existsSync(orcaCalledFile), false);
	});

	it("passes through silently when Orca visibility setup fails", () => {
		const root = tempDir();
		const fakeOrca = join(root, "fake-orca");
		const fakePi = join(root, "fake-pi");

		writeExecutable(fakeOrca, "#!/usr/bin/env bash\nexit 2\n");
		writeExecutable(
			fakePi,
			"#!/usr/bin/env bash\nprintf 'child output\\n'\nexit 0\n",
		);

		const result = spawnSync(resolve("bin/orca-pi-wrapper"), [], {
			encoding: "utf8",
			env: {
				...process.env,
				ORCA_CLI_COMMAND: fakeOrca,
				ORCA_TERMINAL_HANDLE: "parent-terminal",
				PI_ORCA_REAL_PI_BINARY: fakePi,
			},
		});

		assert.equal(result.status, 0);
		assert.equal(result.stdout, "child output\n");
		assert.equal(result.stderr, "");
	});

	it("passes through within a bounded time when the Orca CLI hangs", () => {
		const root = tempDir();
		const fakeOrca = join(root, "fake-orca");
		const fakePi = join(root, "fake-pi");

		writeExecutable(fakeOrca, "#!/usr/bin/env bash\nsleep 10\n");
		writeExecutable(
			fakePi,
			"#!/usr/bin/env bash\nprintf 'child output\\n'\nexit 0\n",
		);

		const startedAt = Date.now();
		const result = spawnSync(resolve("bin/orca-pi-wrapper"), [], {
			encoding: "utf8",
			env: {
				...process.env,
				ORCA_CLI_COMMAND: fakeOrca,
				ORCA_TERMINAL_HANDLE: "parent-terminal",
				PI_ORCA_COMMAND_TIMEOUT_MS: "100",
				PI_ORCA_REAL_PI_BINARY: fakePi,
			},
		});

		assert.equal(result.status, 0);
		assert.equal(result.stdout, "child output\n");
		assert.equal(result.stderr, "");
		assert.ok(Date.now() - startedAt < 2_000);
	});

	it("passes through silently when temporary log setup fails", () => {
		const root = tempDir();
		const fakeOrca = join(root, "fake-orca");
		const fakePi = join(root, "fake-pi");

		writeExecutable(
			fakeOrca,
			`#!/usr/bin/env bash
case "$1 $2" in
  "status --json") printf '%s\\n' '{"ok":true,"result":{"runtime":{"state":"ready"}}}' ;;
  "terminal show") printf '%s\\n' '{"ok":true,"result":{"terminal":{"worktreeId":"worktree-1"}}}' ;;
  *) exit 2 ;;
esac
`,
		);
		writeExecutable(
			fakePi,
			"#!/usr/bin/env bash\nprintf 'child output\\n'\nexit 0\n",
		);

		const result = spawnSync(resolve("bin/orca-pi-wrapper"), [], {
			encoding: "utf8",
			env: {
				...process.env,
				TMPDIR: join(root, "missing", "directory"),
				ORCA_CLI_COMMAND: fakeOrca,
				ORCA_TERMINAL_HANDLE: "parent-terminal",
				PI_ORCA_REAL_PI_BINARY: fakePi,
			},
		});

		assert.equal(result.status, 0);
		assert.equal(result.stdout, "child output\n");
		assert.equal(result.stderr, "");
	});

	it("refuses unsafe recursive cleanup targets returned by mktemp", () => {
		for (const kind of [
			"empty",
			"root",
			"parent",
			"outside",
			"prefix",
			"basename",
			"symlink",
		]) {
			const root = tempDir();
			const bin = join(root, "bin");
			const temporaryParent = join(root, "temporary-parent");
			const outsideParent = join(root, "outside");
			const prefixParent = `${temporaryParent}-confusion`;
			const rmCalls = join(root, "rm-calls.bin");
			const argsFile = join(root, "pi-args.txt");
			const fakeMktemp = join(bin, "mktemp");
			const fakeRm = join(bin, "rm");
			const fakeOrca = join(bin, "fake-orca");
			const fakePi = join(bin, "fake-pi");
			mkdirSync(bin);
			mkdirSync(temporaryParent);
			mkdirSync(outsideParent);
			mkdirSync(prefixParent);

			const candidate = {
				empty: "",
				root: "/",
				parent: temporaryParent,
				outside: join(outsideParent, "pi-orca-subagent.ABC123"),
				prefix: join(prefixParent, "pi-orca-subagent.ABC123"),
				basename: join(
					temporaryParent,
					"pi-orca-subagent.ABC123-confusion",
				),
				symlink: join(temporaryParent, "pi-orca-subagent.ABC123"),
			}[kind] ?? "";
			if (kind === "symlink") {
				writeFileSync(join(outsideParent, "protected"), kind);
				symlinkSync(outsideParent, candidate, "dir");
			} else if (
				candidate &&
				candidate !== "/" &&
				candidate !== temporaryParent
			) {
				mkdirSync(candidate, { recursive: true });
				writeFileSync(join(candidate, "protected"), kind);
			}

			writeExecutable(fakeMktemp, "#!/usr/bin/env bash\nprintf '%s' \"$MKTEMP_RESULT\"\n");
			writeExecutable(
				fakeRm,
				"#!/usr/bin/env bash\nprintf '%s\\0' \"$@\" >> \"$RM_CALLS\"\n",
			);
			writeExecutable(
				fakeOrca,
				`#!/usr/bin/env bash
case "$1 $2" in
  "status --json") printf '%s\\n' '{"ok":true,"result":{"runtime":{"state":"ready"}}}' ;;
  "terminal show") printf '%s\\n' '{"ok":true,"result":{"terminal":{"worktreeId":"worktree-1"}}}' ;;
  *) exit 2 ;;
esac
`,
			);
			writeExecutable(
				fakePi,
				"#!/usr/bin/env bash\nprintf '%s\\n' \"$@\" > \"$PI_ARGS_FILE\"\nprintf 'child output\\n'\n",
			);

			const result = spawnSync(
				resolve("bin/orca-pi-wrapper"),
				["--mode", "json", `cleanup-${kind}`],
				{
					encoding: "utf8",
					env: {
						...process.env,
						TMPDIR: kind === "root" ? "/" : temporaryParent,
						PATH: `${bin}:${process.env.PATH ?? ""}`,
						MKTEMP_RESULT: candidate,
						RM_CALLS: rmCalls,
						ORCA_CLI_COMMAND: fakeOrca,
						ORCA_TERMINAL_HANDLE: "parent-terminal",
						PI_ORCA_REAL_PI_BINARY: fakePi,
						PI_ARGS_FILE: argsFile,
					},
				},
			);

			assert.equal(result.status, 0, `${kind}: ${result.stderr}`);
			assert.equal(result.stdout, "child output\n", kind);
			assert.equal(
				readFileSync(argsFile, "utf8"),
				`--mode\njson\ncleanup-${kind}\n`,
				kind,
			);
			assert.equal(existsSync(rmCalls), false, kind);
			if (kind === "symlink") {
				assert.equal(readFileSync(join(outsideParent, "protected"), "utf8"), kind);
			} else if (
				candidate &&
				candidate !== "/" &&
				candidate !== temporaryParent
			) {
				assert.equal(readFileSync(join(candidate, "protected"), "utf8"), kind);
			}
		}
	});

	it("keeps copied logs available when an Orca viewer starts after the child exits", async () => {
		const root = tempDir();
		const commandFile = join(root, "viewer-command.txt");
		const fakeOrca = join(root, "fake-orca");
		const fakePi = join(root, "fake-pi");

		writeExecutable(
			fakeOrca,
			`#!/usr/bin/env bash
case "$1 $2" in
  "status --json") printf '%s\\n' '{"ok":true,"result":{"runtime":{"state":"ready"}}}' ;;
  "terminal show") printf '%s\\n' '{"ok":true,"result":{"terminal":{"worktreeId":"worktree-1"}}}' ;;
  "terminal create")
    while [[ "$#" -gt 0 ]]; do
      if [[ "$1" == "--command" ]]; then printf '%s' "$2" > "$VIEWER_COMMAND_FILE"; break; fi
      shift
    done
    printf '%s\\n' '{"ok":true,"result":{"terminal":{"handle":"terminal-1"}}}'
    ;;
  "terminal close") exit 2 ;;
  *) exit 2 ;;
esac
`,
		);
		writeExecutable(
			fakePi,
			`#!/usr/bin/env bash
printf '%s\\n' '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"Delayed viewer output."}}'
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Delayed viewer output."}]}}'
printf '%s\\n' '{"type":"agent_settled"}'
printf '%02000d\\n' 0
`,
		);

		const result = spawnSync(resolve("bin/orca-pi-wrapper"), [], {
			encoding: "utf8",
			env: {
				...process.env,
				TMPDIR: root,
				ORCA_CLI_COMMAND: fakeOrca,
				ORCA_TERMINAL_HANDLE: "parent-terminal",
				PI_ORCA_REAL_PI_BINARY: fakePi,
				PI_ORCA_CAPTURE_LIMIT_BYTES: "512",
				VIEWER_COMMAND_FILE: commandFile,
			},
		});

		assert.equal(result.status, 0, result.stderr);
		await waitForFile(commandFile);
		await new Promise((resolve) => setTimeout(resolve, 200));
		const logEntry = readdirSync(root).find((entry) =>
			entry.startsWith("pi-orca-subagent."),
		);
		assert.ok(logEntry);
		const capturedStdout = readFileSync(
			join(root, logEntry, "stdout.log"),
			"utf8",
		);
		assert.ok(Buffer.byteLength(capturedStdout) <= 512);
		assert.match(capturedStdout, /source truncated/);
		const viewerRecord = JSON.parse(
			readFileSync(join(root, logEntry, "viewer.json"), "utf8"),
		) as {
			viewer: { layout: string; closeMode: string };
			terminal: { createdHandle: string; worktreeId: string };
			parent: { handle: string; worktreeId: string };
		};
		assert.equal(viewerRecord.viewer.layout, "background_tabs");
		assert.equal(viewerRecord.viewer.closeMode, "tab");
		assert.equal(viewerRecord.terminal.createdHandle, "terminal-1");
		assert.equal(viewerRecord.terminal.worktreeId, "worktree-1");
		assert.equal(viewerRecord.parent.handle, "parent-terminal");
		assert.equal(viewerRecord.parent.worktreeId, "worktree-1");

		const viewerCommand = readFileSync(commandFile, "utf8");
		const logDirectory = join(root, logEntry);
		const outsideParent = join(root, "outside-cleanup-target");
		const outsideLogDirectory = join(
			outsideParent,
			"pi-orca-subagent.ABC123",
		);
		mkdirSync(outsideLogDirectory, { recursive: true });
		writeFileSync(join(outsideLogDirectory, "stdout.log"), "");
		writeFileSync(join(outsideLogDirectory, "stderr.log"), "");
		writeFileSync(join(outsideLogDirectory, "done"), "");
		writeFileSync(join(outsideLogDirectory, "protected"), "viewer-side");
		const tamperedViewer = spawnSync(
			"bash",
			["-lc", viewerCommand.replaceAll(logDirectory, outsideLogDirectory)],
			{
				encoding: "utf8",
				env: { ...process.env, NO_COLOR: "1" },
			},
		);
		assert.equal(tamperedViewer.status, 0, tamperedViewer.stderr);
		assert.equal(
			readFileSync(join(outsideLogDirectory, "protected"), "utf8"),
			"viewer-side",
		);

		const viewer = spawnSync("bash", ["-lc", viewerCommand], {
			encoding: "utf8",
			env: { ...process.env, NO_COLOR: "1" },
		});
		assert.equal(viewer.status, 0, viewer.stderr);
		assert.match(viewer.stdout, /Delayed viewer output\./);
		assert.doesNotMatch(viewer.stderr, /No such file or directory/);
		await waitForNoEntry(root, "pi-orca-subagent.");
	});

	it("skips Orca visibility when the next subagent launch is hidden", () => {
		const root = tempDir();
		const orcaCalledFile = join(root, "orca-called.txt");
		const childEnvironmentFile = join(root, "child-environment.txt");
		const fakeOrca = join(root, "fake-orca");
		const fakePi = join(root, "fake-pi");

		writeExecutable(
			fakeOrca,
			`#!/usr/bin/env bash
touch "$ORCA_CALLED_FILE"
exit 2
`,
		);
		writeExecutable(
			fakePi,
			"#!/usr/bin/env bash\nprintf '%s|%s' \"${PI_ORCA_SUBAGENT_VIEW_LAYOUT:-}\" \"${PI_ORCA_SUBAGENT_VIEW_BATCH:-}\" > \"$CHILD_ENVIRONMENT_FILE\"\nprintf 'child output\\n'\n",
		);

		const result = spawnSync(resolve("bin/orca-pi-wrapper"), [], {
			encoding: "utf8",
			env: {
				...process.env,
				ORCA_CLI_COMMAND: fakeOrca,
				ORCA_TERMINAL_HANDLE: "parent-terminal",
				PI_ORCA_REAL_PI_BINARY: fakePi,
				PI_ORCA_SUBAGENT_VIEW_LAYOUT: "hidden",
				PI_ORCA_SUBAGENT_VIEW_BATCH: "one-shot",
				ORCA_CALLED_FILE: orcaCalledFile,
				CHILD_ENVIRONMENT_FILE: childEnvironmentFile,
			},
		});

		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stdout, "child output\n");
		assert.equal(existsSync(orcaCalledFile), false);
		assert.equal(readFileSync(childEnvironmentFile, "utf8"), "|");
	});

	it("falls back to an unfocused background tab when Orca cannot split without focus", () => {
		const root = tempDir();
		const callsFile = join(root, "orca-calls.txt");
		const fakeOrca = join(root, "fake-orca");
		const fakePi = join(root, "fake-pi");

		writeExecutable(
			fakeOrca,
			`#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$ORCA_CALLS_FILE"
case "$1 $2" in
  "status --json") printf '%s\\n' '{"ok":true,"result":{"runtime":{"state":"ready"}}}' ;;
  "terminal show") printf '%s\\n' '{"ok":true,"result":{"terminal":{"handle":"'$4'","worktreeId":"worktree-1"}}}' ;;
  "terminal split") printf '%s\\n' 'Usage: terminal split' ;;
  "terminal create") printf '%s\\n' '{"ok":true,"result":{"terminal":{"handle":"viewer-created"}}}' ;;
  "terminal close") printf '%s\\n' '{"ok":true,"result":{}}' ;;
  *) exit 2 ;;
esac
`,
		);
		writeExecutable(
			fakePi,
			"#!/usr/bin/env bash\nprintf '%s\\n' '{\"type\":\"agent_settled\"}'\n",
		);

		const result = spawnSync(resolve("bin/orca-pi-wrapper"), [], {
			encoding: "utf8",
			env: {
				...process.env,
				TMPDIR: root,
				ORCA_CLI_COMMAND: fakeOrca,
				ORCA_TERMINAL_HANDLE: "parent-terminal",
				PI_ORCA_REAL_PI_BINARY: fakePi,
				PI_ORCA_SUBAGENT_VIEW_LAYOUT: "right_stack",
				PI_ORCA_SUBAGENT_VIEW_BATCH: "batch-no-focus",
				PI_SUBAGENT_CHILD_INDEX: "0",
				ORCA_CALLS_FILE: callsFile,
			},
		});

		assert.equal(result.status, 0, result.stderr);
		const calls = readFileSync(callsFile, "utf8");
		assert.match(calls, /^terminal split --help$/m);
		assert.doesNotMatch(calls, /terminal split --terminal/);
		assert.match(calls, /^terminal create --worktree id:worktree-1 /m);
		assert.doesNotMatch(calls, /terminal create[^\n]* --focus/);
		assert.doesNotMatch(calls, /terminal switch/);
	});

	it("stacks two read-only viewers on the right", async () => {
		const root = tempDir();
		const callsFile = join(root, "orca-calls.txt");
		const fakeOrca = join(root, "fake-orca");
		const fakePi = join(root, "fake-pi");

		writeExecutable(
			fakeOrca,
			`#!/usr/bin/env bash
printf '%s|%s\\n' "\${PI_SUBAGENT_CHILD_INDEX:-}" "$*" >> "$ORCA_CALLS_FILE"
case "$1 $2" in
  "status --json") printf '%s\\n' '{"ok":true,"result":{"runtime":{"state":"ready"}}}' ;;
  "terminal show")
    case "$4" in
      parent-terminal) printf '%s\\n' '{"ok":true,"result":{"terminal":{"handle":"parent-terminal","ptyId":"parent-pty","tabId":"parent-tab","leafId":"parent-leaf","worktreeId":"worktree-1","paneRuntimeId":1}}}' ;;
      right-top-created) printf '%s\\n' '{"ok":true,"result":{"terminal":{"handle":"right-top-created","ptyId":"right-top-pty","tabId":"parent-tab","leafId":"right-top-leaf","worktreeId":"worktree-1","paneRuntimeId":2}}}' ;;
      right-bottom-created) printf '%s\\n' '{"ok":true,"result":{"terminal":{"handle":"right-bottom-created","ptyId":"right-bottom-pty","tabId":"parent-tab","leafId":"right-bottom-leaf","worktreeId":"worktree-1","paneRuntimeId":3}}}' ;;
      *) exit 2 ;;
    esac
    ;;
  "terminal list") printf '%s\\n' '{"ok":true,"result":{"terminals":[{"handle":"right-top-current","ptyId":"right-top-pty"},{"handle":"right-bottom-current","ptyId":"right-bottom-pty"}]}}' ;;
  "terminal split")
    if [[ "$3" == "--help" ]]; then
      printf '%s\\n' 'Usage: terminal split --no-focus'
    elif [[ "\${PI_SUBAGENT_CHILD_INDEX:-}" == "0" ]]; then
      printf '%s\\n' '{"ok":true,"result":{"split":{"handle":"right-top-created"}}}'
    else
      printf '%s\\n' '{"ok":true,"result":{"split":{"handle":"right-bottom-created"}}}'
    fi
    ;;
  "terminal close") printf '%s\\n' '{"ok":true,"result":{}}' ;;
  *) exit 2 ;;
esac
`,
		);
		writeExecutable(
			fakePi,
			"#!/usr/bin/env bash\nprintf '%s\\n' '{\"type\":\"agent_settled\"}'\n",
		);

		const children = [1, 0].map((index) =>
			spawn(resolve("bin/orca-pi-wrapper"), [], {
				stdio: "ignore",
				env: {
					...process.env,
					TMPDIR: root,
					ORCA_CLI_COMMAND: fakeOrca,
					ORCA_TERMINAL_HANDLE: "parent-terminal",
					PI_ORCA_REAL_PI_BINARY: fakePi,
					PI_ORCA_SUBAGENT_VIEW_LAYOUT: "right_stack",
					PI_ORCA_SUBAGENT_VIEW_BATCH: "batch-1",
					PI_SUBAGENT_CHILD_AGENT: "delegate",
					PI_SUBAGENT_CHILD_INDEX: String(index),
					ORCA_CALLS_FILE: callsFile,
				},
			}),
		);

		assert.deepEqual(await Promise.all(children.map(waitForExit)), [0, 0]);
		await waitForText(
			callsFile,
			/^1\|terminal close --terminal right-bottom-current --json$/m,
		);
		const calls = readFileSync(callsFile, "utf8");
		assert.match(
			calls,
			/^0\|terminal split --terminal parent-terminal --direction vertical --command .* --no-focus --json$/m,
		);
		assert.match(
			calls,
			/^1\|terminal split --terminal right-top-current --direction horizontal --command .* --no-focus --json$/m,
		);
		assert.match(
			calls,
			/^0\|terminal close --terminal right-top-current --json$/m,
		);
		assert.doesNotMatch(calls, /terminal create/);
		assert.doesNotMatch(calls, /terminal close[^\n]*--tab/);
	});

	it("allows concurrent Orca terminal creation to take longer than the default CLI timeout", async () => {
		const root = tempDir();
		const successFile = join(root, "created.txt");
		const fakeOrca = join(root, "fake-orca");
		const fakePi = join(root, "fake-pi");

		writeExecutable(
			fakeOrca,
			`#!/usr/bin/env bash
case "$1 $2" in
  "status --json") printf '%s\\n' '{"ok":true,"result":{"runtime":{"state":"ready"}}}' ;;
  "terminal show") printf '%s\\n' '{"ok":true,"result":{"terminal":{"worktreeId":"worktree-1"}}}' ;;
  "terminal create")
    case "\${PI_SUBAGENT_CHILD_INDEX:-0}" in 0) sleep 0.2 ;; 1) sleep 2 ;; 2) sleep 3 ;; esac
    printf '%s\\n' "\${PI_SUBAGENT_CHILD_INDEX:-0}" >> "$CREATED_FILE"
    printf '%s\\n' '{"ok":true,"result":{"terminal":{"handle":"terminal-'"\${PI_SUBAGENT_CHILD_INDEX:-0}"'"}}}'
    ;;
  "terminal close") printf '%s\\n' '{"ok":true,"result":{}}' ;;
  *) exit 2 ;;
esac
`,
		);
		writeExecutable(
			fakePi,
			"#!/usr/bin/env bash\nprintf '%s\\n' '{\"type\":\"agent_settled\"}'\n",
		);

		const children = [0, 1, 2].map((index) =>
			spawn(resolve("bin/orca-pi-wrapper"), [], {
				stdio: "ignore",
				env: {
					...process.env,
					TMPDIR: root,
					ORCA_CLI_COMMAND: fakeOrca,
					ORCA_TERMINAL_HANDLE: "parent-terminal",
					PI_ORCA_REAL_PI_BINARY: fakePi,
					PI_SUBAGENT_CHILD_AGENT: "delegate",
					PI_SUBAGENT_CHILD_INDEX: String(index),
					CREATED_FILE: successFile,
				},
			}),
		);

		assert.deepEqual(await Promise.all(children.map(waitForExit)), [0, 0, 0]);
		assert.deepEqual(
			readFileSync(successFile, "utf8").trim().split("\n").sort(),
			["0", "1", "2"],
		);
	});

	it("replaces itself with Pi so process signals keep their target", async () => {
		const root = tempDir();
		const pidFile = join(root, "pi.pid");
		const signalFile = join(root, "signal.txt");
		const callsFile = join(root, "orca-calls.txt");
		const fakeOrca = join(root, "fake-orca");
		const fakePi = join(root, "fake-pi");

		writeExecutable(
			fakeOrca,
			`#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$ORCA_CALLS_FILE"
case "$1 $2" in
  "status --json") printf '%s\\n' '{"ok":true,"result":{"runtime":{"state":"ready"}}}' ;;
  "terminal show") printf '%s\\n' '{"ok":true,"result":{"terminal":{"worktreeId":"worktree-1"}}}' ;;
  "terminal create") printf '%s\\n' '{"ok":true,"result":{"terminal":{"handle":"terminal-1"}}}' ;;
  "terminal send") printf '%s\\n' '{"ok":true,"result":{}}' ;;
  "terminal close") printf '%s\\n' '{"ok":true,"result":{}}' ;;
  *) exit 2 ;;
esac
`,
		);
		writeExecutable(
			fakePi,
			`#!/usr/bin/env bash
printf '%s\\n' "$$" > "$PI_PID_FILE"
trap 'printf term > "$PI_SIGNAL_FILE"; exit 0' TERM
while true; do sleep 0.1; done
`,
		);

		const child = spawn(resolve("bin/orca-pi-wrapper"), [], {
			stdio: "ignore",
			env: {
				...process.env,
				TMPDIR: root,
				ORCA_CLI_COMMAND: fakeOrca,
				ORCA_TERMINAL_HANDLE: "parent-terminal",
				PI_ORCA_REAL_PI_BINARY: fakePi,
				PI_PID_FILE: pidFile,
				PI_SIGNAL_FILE: signalFile,
				ORCA_CALLS_FILE: callsFile,
			},
		});

		try {
			await waitForFile(pidFile);
			assert.equal(Number(readFileSync(pidFile, "utf8")), child.pid);
			child.kill("SIGTERM");
			const exitCode = await new Promise<number | null>((resolveExit) => {
				child.once("exit", resolveExit);
			});

			assert.equal(exitCode, 0);
			assert.equal(readFileSync(signalFile, "utf8"), "term");
			await waitForText(
				callsFile,
				/^terminal close --terminal terminal-1 --tab --json$/m,
			);
			assert.match(
				readFileSync(callsFile, "utf8"),
				/terminal create --worktree id:worktree-1 --title -> subagent --command bash --noprofile --norc -c .* --json/,
			);
		} finally {
			if (child.exitCode === null && child.signalCode === null) {
				child.kill("SIGKILL");
				await new Promise<void>((resolveExit) =>
					child.once("exit", () => resolveExit()),
				);
			}
		}
	});
});
