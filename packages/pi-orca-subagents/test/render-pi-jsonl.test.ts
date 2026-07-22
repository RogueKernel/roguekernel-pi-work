import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const renderer = fileURLToPath(new URL("../bin/render-pi-jsonl.mjs", import.meta.url));

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    const expectedPrefix = join(tmpdir(), "pi-orca-render-test-");
    assert.equal(directory.startsWith(expectedPrefix), true);
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "pi-orca-render-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function followArguments(directory: string): string[] {
  return [
    renderer,
    "--stdout-log", join(directory, "stdout.log"),
    "--stderr-log", join(directory, "stderr.log"),
    "--done-file", join(directory, "done"),
    "--manifest", join(directory, "viewer-manifest.json"),
  ];
}

function followerEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NO_COLOR: "1",
    PI_ORCA_RENDER_NONINTERACTIVE: "1",
  };
}

function render(events: unknown[], extraLines: string[] = []): string {
  const input = [
    ...events.map((event) => JSON.stringify(event)),
    ...extraLines,
  ].join("\n");
  const result = spawnSync(process.execPath, [renderer], {
    encoding: "utf8",
    input: `${input}\n`,
    env: {
      ...process.env,
      NO_COLOR: "1",
      PI_ORCA_RENDER_WIDTH: "60",
      PI_SUBAGENT_CHILD_AGENT: "delegate",
      PI_SUBAGENT_CHILD_INDEX: "0",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  return result.stdout;
}

describe("single-process log follower", () => {
  it("updates the live interactive omission count after model eviction", async () => {
    const directory = temporaryDirectory();
    const snapshotPath = join(directory, "live-snapshot.json");
    const viewerModule = join(directory, "viewer-ui.mjs");
    writeFileSync(
      viewerModule,
      `import { writeFileSync } from "node:fs";
export async function createViewerApp({ snapshot }) {
  return {
    state: {
      requestRender() {
        writeFileSync(process.env.PI_ORCA_TEST_SNAPSHOT, JSON.stringify(snapshot));
      },
    },
    async close() {},
  };
}
`,
    );
    writeFileSync(
      join(directory, "viewer-manifest.json"),
      JSON.stringify({ version: 1, runtime: {}, launch: {}, prompts: [] }),
    );
    writeFileSync(
      join(directory, "stdout.log"),
      `${Array.from({ length: 5_001 }, (_, index) =>
        JSON.stringify({
          type: "message_end",
          message: {
            id: `live-${index}`,
            role: "assistant",
            content: [{ type: "text", text: `live line ${index}` }],
          },
        }),
      ).join("\n")}\n`,
    );
    writeFileSync(join(directory, "stderr.log"), "");
    const environment = { ...process.env };
    delete environment.PI_ORCA_RENDER_NONINTERACTIVE;
    environment.NO_COLOR = "1";
    environment.PI_ORCA_RENDER_TUI_MODULE = pathToFileURL(viewerModule).href;
    environment.PI_ORCA_TEST_SNAPSHOT = snapshotPath;

    const child = spawn(process.execPath, followArguments(directory), {
      env: environment,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    try {
      const deadline = Date.now() + 5_000;
      let omittedLogicalLines = 0;
      while (Date.now() < deadline && omittedLogicalLines !== 2) {
        if (existsSync(snapshotPath)) {
          try {
            omittedLogicalLines = JSON.parse(
              readFileSync(snapshotPath, "utf8"),
            ).omittedLogicalLines;
          } catch {}
        }
        if (omittedLogicalLines !== 2) {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
        }
      }
      assert.equal(omittedLogicalLines, 2);
      writeFileSync(join(directory, "done"), "");
      const code = await new Promise<number | null>((resolveExit) => {
        child.once("exit", resolveExit);
      });
      assert.equal(code, 0, stderr);
    } finally {
      if (child.exitCode === null) child.kill("SIGTERM");
    }
  });

  it("bounds plain fallback output to the newest transcript rows", () => {
    const directory = temporaryDirectory();
    writeFileSync(join(directory, "viewer-manifest.json"), JSON.stringify({
      version: 1,
      child: { agent: "bounded-agent" },
      runtime: {},
      launch: {},
      prompts: [],
    }));
    writeFileSync(
      join(directory, "stdout.log"),
      `${Array.from({ length: 5_001 }, (_, index) => JSON.stringify({
        type: "message_end",
        message: {
          id: `bounded-${index}`,
          role: "assistant",
          content: [{ type: "text", text: `bounded line ${index}` }],
        },
      })).join("\n")}\n`,
    );
    writeFileSync(join(directory, "stderr.log"), "");
    writeFileSync(join(directory, "done"), "");

    const result = spawnSync(process.execPath, followArguments(directory), {
      encoding: "utf8",
      env: followerEnvironment(),
      timeout: 10_000,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /… 2 earlier logical lines omitted/);
    assert.match(result.stdout, /bounded line 5000/);
    assert.equal(result.stdout.includes("bounded line 0"), false);
    assert.equal(result.stdout.trimEnd().split("\n").length, 10_001);
  });

  it("drains completed stdout and stderr logs exactly once", () => {
    const directory = temporaryDirectory();
    writeFileSync(join(directory, "viewer-manifest.json"), JSON.stringify({
      version: 1,
      child: { agent: "delegate", index: 0 },
      runtime: {},
      launch: {},
      prompts: [],
    }));
    writeFileSync(join(directory, "stdout.log"), [
      JSON.stringify({
        type: "message_end",
        message: {
          id: "message-1",
          role: "assistant",
          content: [{ type: "text", text: "completed answer" }],
        },
      }),
      JSON.stringify({ type: "future_event", detail: "future detail" }),
      JSON.stringify({ type: "agent_settled" }),
      "",
    ].join("\n"));
    writeFileSync(join(directory, "stderr.log"), "child warning\n");
    writeFileSync(join(directory, "done"), "");

    const result = spawnSync(process.execPath, followArguments(directory), {
      encoding: "utf8",
      env: followerEnvironment(),
      timeout: 5_000,
    });

    assert.equal(result.status, 0, result.stderr);
    for (const fact of [
      "delegate",
      "completed answer",
      "FUTURE_EVENT",
      "future detail",
      "child warning",
      "SETTLED",
    ]) {
      assert.equal(result.stdout.match(new RegExp(fact, "g"))?.length, 1, fact);
    }
  });

  it("falls back when interactive viewer startup is unavailable", () => {
    const directory = temporaryDirectory();
    writeFileSync(join(directory, "viewer-manifest.json"), JSON.stringify({
      version: 1,
      child: { agent: "fallback-agent" },
      runtime: {},
      launch: {},
      prompts: [],
    }));
    writeFileSync(join(directory, "stdout.log"), `${JSON.stringify({
      type: "message_end",
      message: {
        id: "fallback-1",
        role: "assistant",
        content: [{ type: "text", text: "fallback answer" }],
      },
    })}\n`);
    writeFileSync(join(directory, "stderr.log"), "");
    writeFileSync(join(directory, "done"), "");

    const result = spawnSync(process.execPath, followArguments(directory), {
      encoding: "utf8",
      env: {
        ...process.env,
        NO_COLOR: "1",
        PI_ORCA_RENDER_TUI_MODULE: new URL(
          "../fixtures/missing-viewer-ui.mjs",
          import.meta.url,
        ).href,
      },
      timeout: 5_000,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /interactive viewer unavailable/);
    assert.equal(result.stdout.match(/fallback answer/g)?.length, 1);
  });

  it("degrades malformed manifests and missing logs to warnings", () => {
    const directory = temporaryDirectory();
    writeFileSync(join(directory, "viewer-manifest.json"), "{malformed");
    writeFileSync(join(directory, "stderr.log"), "");
    writeFileSync(join(directory, "done"), "");

    const result = spawnSync(process.execPath, followArguments(directory), {
      encoding: "utf8",
      env: followerEnvironment(),
      timeout: 5_000,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /viewer manifest unavailable/);
    assert.match(result.stdout, /stdout log unavailable/);
  });

  it("drains and exits cleanly on SIGINT and SIGTERM", async () => {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      const directory = temporaryDirectory();
      writeFileSync(join(directory, "viewer-manifest.json"), JSON.stringify({
        version: 1,
        child: { agent: "signal-agent" },
        runtime: {},
        launch: {},
        prompts: [],
      }));
      writeFileSync(join(directory, "stdout.log"), `${JSON.stringify({
        type: "future_event",
        detail: signal,
      })}\n`);
      writeFileSync(join(directory, "stderr.log"), "");

      const child = spawn(process.execPath, followArguments(directory), {
        env: followerEnvironment(),
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 80));
      child.kill(signal);
      const code = await new Promise<number | null>((resolveExit) => {
        child.once("exit", resolveExit);
      });
      assert.equal(code, 0, `${signal}: ${stderr}`);
      assert.match(stdout, new RegExp(signal));
    }
  });

  it("waits for complete appended lines and performs a final drain", async () => {
    const directory = temporaryDirectory();
    writeFileSync(join(directory, "viewer-manifest.json"), JSON.stringify({
      version: 1,
      child: { agent: "live-agent", index: 1 },
      runtime: {},
      launch: {},
      prompts: [],
    }));
    writeFileSync(join(directory, "stdout.log"), "");
    writeFileSync(join(directory, "stderr.log"), "");

    const child = spawn(process.execPath, followArguments(directory), {
      env: followerEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });

    const line = JSON.stringify({
      type: "message_end",
      message: {
        id: "live-1",
        role: "assistant",
        content: [{ type: "text", text: "one live answer" }],
      },
    });
    const midpoint = Math.floor(line.length / 2);
    appendFileSync(join(directory, "stdout.log"), line.slice(0, midpoint));
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 80));
    assert.equal(stdout.includes("one live answer"), false);
    appendFileSync(join(directory, "stdout.log"), `${line.slice(midpoint)}\n`);
    appendFileSync(join(directory, "stderr.log"), "late warning\n");
    writeFileSync(join(directory, "done"), "");

    const exitCode = child.exitCode ?? await new Promise<number | null>((resolveExit) => {
      child.once("exit", resolveExit);
    });
    assert.equal(exitCode, 0, stderr);
    assert.equal(stdout.match(/one live answer/g)?.length, 1);
    assert.equal(stdout.match(/late warning/g)?.length, 1);
    assert.equal(existsSync(join(directory, "done")), true);
  });

  it("bounds oversized records and resumes at the next complete line", () => {
	const directory = temporaryDirectory();
	writeFileSync(join(directory, "viewer-manifest.json"), JSON.stringify({
	  version: 1,
	  child: { agent: "bounded-agent" },
	  runtime: {},
	  launch: {},
	  prompts: [],
	}));
	writeFileSync(join(directory, "stdout.log"), [
	  "x".repeat(300_000),
	  JSON.stringify({
		type: "message_end",
		message: {
		  role: "assistant",
		  content: [{ type: "text", text: "record after overflow" }],
		},
	  }),
	  "",
	].join("\n"));
	writeFileSync(join(directory, "stderr.log"), "");
	writeFileSync(join(directory, "done"), "");

	const result = spawnSync(process.execPath, followArguments(directory), {
	  encoding: "utf8",
	  env: followerEnvironment(),
	  timeout: 5_000,
	});

	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /source truncated/);
	assert.match(result.stdout, /record after overflow/);
	assert.ok(result.stdout.length < 2_000);
  });
});

describe("Pi JSONL renderer", () => {
  it("renders streamed assistant text without repeating the completed message", () => {
    const output = render([
      { type: "agent_start" },
      {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "Hello " },
      },
      {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "there" },
      },
      {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "Hello there" }] },
      },
      { type: "agent_settled" },
    ]);

    assert.match(output, /delegate · child 1/);
    assert.match(output, /ASSISTANT\nHello there/);
    assert.equal(output.match(/Hello there/g)?.length, 1);
    assert.match(output, /SETTLED/);
  });

  it("renders concise tool calls, results, and failures", () => {
    const output = render([
      {
        type: "tool_execution_start",
        toolCallId: "bash-1",
        toolName: "bash",
        args: { command: "printf 'hello\\n'" },
      },
      {
        type: "tool_execution_end",
        toolCallId: "bash-1",
        toolName: "bash",
        result: { content: [{ type: "text", text: "hello\n" }] },
        isError: false,
      },
      {
        type: "tool_execution_start",
        toolCallId: "read-1",
        toolName: "read",
        args: { path: "/tmp/file.txt" },
      },
      {
        type: "tool_execution_end",
        toolCallId: "read-1",
        toolName: "read",
        result: { content: [{ type: "text", text: "permission denied" }] },
        isError: true,
      },
      { type: "auto_retry_start", errorMessage: "provider overloaded" },
      { type: "extension_error", error: "extension stopped" },
    ]);

    assert.match(output, /BASH\nargs:.*printf/);
    assert.match(output, /status: succeeded\nhello/);
    assert.match(output, /READ\nargs:.*file\.txt/);
    assert.match(output, /status: failed\npermission denied/);
    assert.match(output, /RETRY[\s\S]*provider overloaded/);
    assert.match(output, /EXTENSION ERROR[\s\S]*extension stopped/);
  });

  it("renders unknown events and safely truncates malformed output", () => {
    const malformed = `not-json ${"x".repeat(400)}\u001b[31m`;
    const output = render([{ type: "future_event", payload: "retained" }], [malformed]);

    assert.match(output, /FUTURE_EVENT/);
    assert.match(output, /retained/);
    assert.match(output, /UNPARSED\nnot-json/);
    assert.equal(output.includes("\u001b[31m"), false);
    assert.ok(output.length < 700);
  });

  it("renders stderr as bounded, sanitized warnings", () => {
    const result = spawnSync(
      process.execPath,
      [renderer, "--stderr"],
      {
        encoding: "utf8",
        input: `warning \u001b[31m${"x".repeat(700)}\n`,
        env: { ...process.env, NO_COLOR: "1" },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^! warning /);
    assert.equal(result.stdout.includes("\u001b[31m"), false);
    assert.ok(result.stdout.length < 550);
  });
});
