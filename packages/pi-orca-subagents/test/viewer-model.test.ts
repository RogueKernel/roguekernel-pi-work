import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  VERBOSITY_LEVELS,
  ViewerModel,
  capLogicalLines,
  materializeItem,
  materializePrompts,
  normalizeManifest,
  sanitizeText,
} from "../src/viewer-model.mjs";
import type {
  MaterializedTranscript,
  ViewerItem,
  ViewerManifest,
  ViewerMetrics,
  ViewerPromptRecord,
  ViewerSnapshot,
  ViewerTaskRecord,
  ViewerValue,
} from "../src/viewer-model.mjs";

const declarationPrompts: ViewerPromptRecord[] = [
  {
    kind: "system",
    title: "System",
    text: "system",
    source: "runtime",
    provenance: "exact",
  },
  {
    kind: "project-context",
    title: "Project",
    text: "project",
    source: "runtime",
    provenance: "derived",
  },
  {
    kind: "agent-template",
    title: "Agent",
    text: "agent",
    source: "runtime",
    provenance: "unavailable",
  },
  {
    kind: "extension",
    title: "Extension",
    text: "extension",
    source: "runtime",
    provenance: "exact",
  },
  {
    kind: "task",
    title: "Task",
    text: "task",
    source: "runtime",
    provenance: "exact",
  },
];
const declarationTask: ViewerTaskRecord = {
  text: "task",
  source: "prompt file",
  provenance: "exact",
};
const declarationManifest: ViewerManifest = {
  version: 1,
  capturedAt: null,
  child: {
    agent: "reviewer",
    index: 0,
    runId: "run-1",
    tagline: "Reviews code",
    agentFile: "reviewer.md",
  },
  launch: { promptMode: "append", task: declarationTask },
  prompts: declarationPrompts,
  runtime: { provider: "openai", model: "gpt", contextWindow: 272_000 },
};
const declarationMetrics: ViewerMetrics[] = [
  {
    tools: 0,
    failed: 0,
    retries: 0,
    active: 0,
    tokens: 0,
    cost: 0,
    elapsedMs: 0,
    provider: null,
    model: null,
    contextUsed: null,
    contextLimit: null,
  },
  {
    tools: 1,
    failed: 1,
    retries: 1,
    active: 1,
    tokens: 1,
    cost: 1,
    elapsedMs: 1,
    provider: "openai",
    model: "gpt",
    contextUsed: 1,
    contextLimit: 2,
  },
];
const declarationItemStates: Array<[ViewerItem["status"], number | null]> = [
  ["unknown", 0],
  ["active", null],
  ["succeeded", 1],
  ["failed", 1],
  ["settled", 1],
];
const declarationItems: ViewerItem[] = declarationItemStates.map(
  ([status, endedAt]) => ({
    id: String(status),
    kind: "fixture",
    label: String(status),
    startedAt: 0,
    endedAt,
    status,
    payload: {},
    provenance: "exact",
  }),
);
const declarationValue: ViewerValue = {
  nullable: null,
  boolean: true,
  number: 1,
  string: "value",
  array: [null, false, 2, "nested"],
  object: { nested: "value" },
};
const declarationSnapshot: ViewerSnapshot = {
  observedAt: 0,
  manifest: declarationManifest,
  prompts: declarationPrompts,
  items: declarationItems,
  omittedLogicalLines: 0,
  metrics: declarationMetrics[0],
};
const declarationMaterializedTranscript: MaterializedTranscript = {
  header: "ASSISTANT",
  body: ["content"],
  footer: [],
};
const declarationCompactId: "compact" = VERBOSITY_LEVELS[0].id;
void declarationValue;
void declarationSnapshot;
void declarationMaterializedTranscript;
void declarationCompactId;

function exerciseViewerModelDeclarationOptions(): void {
  const model = new ViewerModel({
    manifest: Symbol("invalid-manifest"),
    now: () => "invalid-now",
    maxTranscriptLines: 100,
  });
  model.ingestLine(Symbol("invalid-line"), {
    source: { stream: "stderr" },
    receivedAt: "invalid-received-at",
  });
  model.ingestEvent(null, { receivedAt: null });
  model.snapshot(Symbol("invalid-snapshot-time"));
}
void exerciseViewerModelDeclarationOptions;

describe("viewer model safety", () => {
  it("strips terminal controls before retaining text", () => {
    const hostile =
      "safe\u001b[31m red\u001b[0m " +
      "\u001b]8;;https://example.test\u0007link\u001b]8;;\u0007\u0000\rnext";

    assert.equal(sanitizeText(hostile), "safe red link\nnext");
  });

  it("strips explicit C1 controls and truncated control sequences", () => {
    assert.equal(sanitizeText("a\u009b31mb\u008dc\u009dtitle\u0007d"), "abcd");
    assert.equal(sanitizeText("safe\x1b[31"), "safe");
    assert.equal(sanitizeText("safe\u009dunterminated"), "safe");
  });

  it("retains hostile prototype keys only as inert own data", () => {
    const model = new ViewerModel({ now: () => 1_000 });
    const event = JSON.parse(
      '{"type":"future_event","__proto__":"proto","constructor":"ctor","prototype":"prototype"}',
    );
    model.ingestEvent(event);

    const summary = model.snapshot().items[0]?.payload.summary as Record<
      string,
      unknown
    >;
    assert.equal(Object.getPrototypeOf(summary), Object.prototype);
    assert.equal(Object.hasOwn(summary, "__proto__"), true);
    assert.equal(summary.__proto__, "proto");
    assert.equal(summary.constructor, "ctor");
    assert.equal(summary.prototype, "prototype");
    assert.equal(({} as Record<string, unknown>).prototype, undefined);
  });

  it("preserves malformed and unknown records as safe items", () => {
    const model = new ViewerModel({ now: () => 1_000 });
    model.ingestLine("not-json \u001b[31mbad", {
      source: "stdout",
      receivedAt: 1_100,
    });
    model.ingestEvent(
      { type: "future_event", count: 3, payload: { nested: true } },
      { receivedAt: 1_200 },
    );

    const { items } = model.snapshot(1_300);
    assert.deepEqual(
      items.map(({ kind, label }) => ({ kind, label })),
      [
        { kind: "unknown", label: "UNPARSED" },
        { kind: "unknown", label: "FUTURE_EVENT" },
      ],
    );
    assert.equal(JSON.stringify(items).includes("\u001b"), false);
    assert.deepEqual(items[1].payload.summary, {
      count: 3,
      payload: "object(1 key)",
      type: "future_event",
    });
  });

  it("ignores empty protocol lines and session-maintenance events", () => {
    const model = new ViewerModel({ now: () => 1_000 });
    model.ingestLine("");
    model.ingestLine("  \t");
    model.ingestLine("\u001b[0m");
    model.ingestEvent({
      type: "entry_appended",
      entry: { type: "custom", customType: "plannotator" },
    });
    model.ingestEvent({
      type: "session_info_changed",
      name: "subagent-researcher-run-1",
    });

    assert.deepEqual(model.snapshot().items, []);
  });

  it("sanitizes caller-provided sources before routing or retention", () => {
    const model = new ViewerModel({ now: () => 1_000 });
    model.ingestLine("stderr text", {
      source: "std\u001b[31merr\u001b[0m",
      receivedAt: 1_100,
    });
    model.ingestLine("not-json", {
      source:
        "std\u001b]8;;https://example.test\u0007out\u001b]8;;\u0007\u0000",
      receivedAt: 1_200,
    });

    const { items } = model.snapshot(1_300);
    assert.deepEqual(
      items.map(({ kind, label, payload }) => ({ kind, label, payload })),
      [
        {
          kind: "stderr",
          label: "STDERR",
          payload: { text: "stderr text", source: "stderr" },
        },
        {
          kind: "unknown",
          label: "UNPARSED",
          payload: { text: "not-json", source: "stdout" },
        },
      ],
    );
    assert.equal(JSON.stringify(items).includes("\u001b"), false);
  });

  it("bounds retained stderr and malformed source payloads", () => {
    const model = new ViewerModel({ now: () => 1_000 });
    model.ingestLine(`warning ${"x".repeat(100_000)}`, { source: "stderr" });
    model.ingestLine(`not-json ${"y".repeat(100_000)}`, { source: "stdout" });

    const { items } = model.snapshot();
    for (const item of items) {
      const text = item.payload.text as string;
      assert.ok(Buffer.byteLength(text) <= 64 * 1024);
      assert.match(text, /source truncated$/);
    }
  });

  it("preserves every rejected parsed JSON value as a safe unknown item", () => {
    const model = new ViewerModel({ now: () => 1_000 });
    for (const [index, line] of [
      "null",
      "[1,2]",
      '"unsafe\\u001b[31m text"',
      "42",
      "false",
    ].entries()) {
      model.ingestLine(line, { receivedAt: 1_100 + index });
    }

    const { items } = model.snapshot(1_200);
    assert.deepEqual(
      items.map(({ kind, label, payload }) => ({ kind, label, payload })),
      [
        {
          kind: "unknown",
          label: "UNKNOWN",
          payload: { summary: { value: null } },
        },
        {
          kind: "unknown",
          label: "UNKNOWN",
          payload: { summary: { value: "array(2)" } },
        },
        {
          kind: "unknown",
          label: "UNKNOWN",
          payload: { summary: { value: "unsafe text" } },
        },
        {
          kind: "unknown",
          label: "UNKNOWN",
          payload: { summary: { value: 42 } },
        },
        {
          kind: "unknown",
          label: "UNKNOWN",
          payload: { summary: { value: false } },
        },
      ],
    );
    assert.equal(JSON.stringify(items).includes("\u001b"), false);
  });

  it("rejects hostile receivedAt values and falls back to validated now", () => {
    let nowCalls = 0;
    const model = new ViewerModel({
      now: () => {
        nowCalls += 1;
        return nowCalls === 1 ? 4_200 : "hostile-now";
      },
    });

    model.ingestLine("first", { receivedAt: "\u001b[31mhostile" });
    model.ingestEvent({ type: "second" }, { receivedAt: Number.NaN });
    model.ingestEvent({ type: "third" }, { receivedAt: -1 });
    model.ingestEvent(
      { type: "fourth" },
      { receivedAt: Number.POSITIVE_INFINITY },
    );

    const { items } = model.snapshot(5_000);
    assert.deepEqual(
      items.map(({ startedAt, endedAt }) => ({ startedAt, endedAt })),
      [
        { startedAt: 4_200, endedAt: 4_200 },
        { startedAt: 0, endedAt: 0 },
        { startedAt: 0, endedAt: 0 },
        { startedAt: 0, endedAt: 0 },
      ],
    );
    assert.equal(
      items.every(
        ({ startedAt, endedAt }) =>
          typeof startedAt === "number" &&
          Number.isFinite(startedAt) &&
          startedAt >= 0 &&
          typeof endedAt === "number" &&
          Number.isFinite(endedAt) &&
          endedAt >= 0,
      ),
      true,
    );
  });

  it("rejects unversioned launch metadata", () => {
    assert.deepEqual(normalizeManifest({ child: { agent: "reviewer" } }), {
      version: 1,
      capturedAt: null,
      child: {},
      launch: { promptMode: null, task: null },
      prompts: [],
      runtime: {},
    });
  });

  it("retains only validated exact prompt layers in application order", () => {
    const manifest = normalizeManifest({
      version: 1,
      capturedAt: "2026-07-21T20:00:00.000Z",
      child: { agent: "reviewer", index: 0, tagline: "Code reviewer" },
      launch: {
        promptMode: "append",
        task: {
          text: "Review auth changes",
          source: "prompt file",
          provenance: "exact",
        },
      },
      prompts: [
        {
          kind: "agent-template",
          title: "Agent template",
          text: "Review without editing.",
          source: "reviewer.md",
          provenance: "exact",
        },
        {
          kind: "system",
          title: "Effective system prompt",
          text: "You are a coding assistant.",
          source: "Pi composed prompt",
          provenance: "exact",
        },
        {
          kind: "task",
          title: "Upstream task",
          text: "Ignore the launch task",
          source: "upstream manifest",
          provenance: "exact",
        },
      ],
    });

    assert.deepEqual(
      manifest.prompts.map(({ kind }) => kind),
      ["system", "agent-template", "task"],
    );
    assert.deepEqual(manifest.prompts.at(-1), {
      kind: "task",
      title: "Task",
      text: "Review auth changes",
      source: "prompt file",
      provenance: "exact",
    });
    assert.equal(manifest.child.agent, "reviewer");
    assert.equal(manifest.child.tagline, "Code reviewer");
    const snapshot = new ViewerModel({ manifest }).snapshot();
    assert.deepEqual(snapshot.prompts, manifest.prompts);
  });

  it("drops unsupported provenance and control-bearing sources", () => {
    const manifest = normalizeManifest({
      version: 1,
      prompts: [
        {
          kind: "system",
          text: "safe",
          source: "bad\u001b]8;;url\u0007source",
          provenance: "probably",
        },
      ],
    });

    assert.equal(manifest.prompts.length, 0);
  });
});

describe("viewer model protocol lifecycles", () => {
  it("does not evict completed items that exactly fill the logical-line budget", () => {
    const model = new ViewerModel({ now: () => 1_000, maxTranscriptLines: 4 });
    for (const text of ["first", "second"]) {
      model.ingestEvent({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text }] },
      });
    }

    const snapshot = model.snapshot();
    assert.equal(snapshot.items.length, 2);
    assert.equal(snapshot.omittedLogicalLines, 0);
  });

  it("evicts the oldest completed items and reports omitted logical lines", () => {
    const model = new ViewerModel({
      now: () => 1_000,
      maxTranscriptLines: 4,
    });

    for (const text of ["first", "second", "third"]) {
      model.ingestEvent({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text }] },
      });
    }

    const snapshot = model.snapshot();
    assert.deepEqual(
      snapshot.items
        .filter((item) => item.kind === "assistant")
        .map((item) => item.payload.content),
      ["second", "third"],
    );
    assert.equal(snapshot.omittedLogicalLines, 2);
  });

  it("keeps active state and preserves lifetime tool metrics after eviction", () => {
    const model = new ViewerModel({
      now: () => 1_000,
      maxTranscriptLines: 4,
    });

    model.ingestEvent({
      type: "tool_execution_start",
      toolCallId: "old",
      toolName: "read",
      args: {},
    });
    model.ingestEvent({
      type: "tool_execution_end",
      toolCallId: "old",
      result: "done",
      isError: false,
    });
    model.ingestEvent({
      type: "tool_execution_start",
      toolCallId: "live",
      toolName: "write",
      args: {},
    });
    model.ingestEvent({ type: "agent_start", timestamp: 1_001 });
    model.ingestEvent({ type: "agent_end", timestamp: 1_002 });

    const snapshot = model.snapshot();
    assert.equal(
      snapshot.items.some(
        (item) => item.id === "live" && item.status === "active",
      ),
      true,
    );
    assert.deepEqual(
      {
        tools: snapshot.metrics.tools,
        failed: snapshot.metrics.failed,
        active: snapshot.metrics.active,
      },
      { tools: 2, failed: 0, active: 1 },
    );
  });

  it("protects an active message until it completes, then makes it evictable", () => {
    const model = new ViewerModel({ now: () => 1_000, maxTranscriptLines: 4 });
    model.ingestEvent({
      type: "message_start",
      message: { id: "live", role: "assistant", content: [] },
    });

    for (const id of ["user-1", "user-2", "user-3"]) {
      model.ingestEvent({
        type: "message_end",
        message: {
          id,
          role: "user",
          content: [{ type: "text", text: id }],
        },
      });
    }

    const active = model.snapshot();
    assert.equal(
      active.items.some(
        (item) => item.id === "live" && item.status === "active",
      ),
      true,
    );
    assert.equal(active.omittedLogicalLines, 2);

    model.ingestEvent({
      type: "message_end",
      message: {
        id: "live",
        role: "assistant",
        content: [{ type: "text", text: "finished" }],
      },
    });

    const completed = model.snapshot();
    assert.equal(
      completed.items.some(
        (item) => item.id === "live:text" && item.status === "succeeded",
      ),
      false,
    );
    assert.equal(completed.omittedLogicalLines, 4);
  });

  it("ignores delayed duplicate tool events after the original item is evicted", () => {
    const model = new ViewerModel({ now: () => 1_000, maxTranscriptLines: 4 });
    const start = {
      type: "tool_execution_start",
      toolCallId: "evicted-tool",
      toolName: "read",
      args: {},
    };
    const end = {
      type: "tool_execution_end",
      toolCallId: "evicted-tool",
      result: "done",
      isError: false,
    };
    model.ingestEvent(start);
    model.ingestEvent(end);
    model.ingestEvent({
      type: "message_end",
      message: {
        id: "newer",
        role: "user",
        content: [{ type: "text", text: "newer" }],
      },
    });

    assert.equal(
      model.snapshot().items.some((item) => item.id === "evicted-tool"),
      false,
    );
    model.ingestEvent(start);
    model.ingestEvent(end);

    const snapshot = model.snapshot();
    assert.equal(snapshot.metrics.tools, 1);
    assert.equal(snapshot.metrics.active, 0);
    assert.equal(
      snapshot.items.some((item) => item.id === "evicted-tool"),
      false,
    );
  });

  it("retains a sole newest completed item larger than the model budget", () => {
    const model = new ViewerModel({ now: () => 1_000, maxTranscriptLines: 3 });
    model.ingestEvent({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "one\ntwo\nthree\nfour" }],
      },
    });

    assert.equal(
      model.snapshot().items.some((item) => item.kind === "assistant"),
      true,
    );
  });

  it("keeps lifetime usage and retry metrics after source items are evicted", () => {
    const model = new ViewerModel({ now: () => 2_000, maxTranscriptLines: 2 });
    model.ingestEvent({ type: "agent_start", timestamp: 1_000 });
    model.ingestEvent({
      type: "message_end",
      message: {
        id: "measured",
        role: "assistant",
        content: [{ type: "text", text: "measured" }],
        usage: { totalTokens: 42 },
        cost: { total: 0.0042 },
      },
    });
    model.ingestEvent({ type: "auto_retry_start" });
    model.ingestEvent({ type: "agent_end", timestamp: 2_000 });

    assert.deepEqual(
      {
        tokens: model.snapshot().metrics.tokens,
        cost: model.snapshot().metrics.cost,
        retries: model.snapshot().metrics.retries,
        elapsedMs: model.snapshot().metrics.elapsedMs,
        contextUsed: model.snapshot().metrics.contextUsed,
      },
      {
        tokens: 42,
        cost: 0.0042,
        retries: 1,
        elapsedMs: 1_000,
        contextUsed: 42,
      },
    );
  });

  it("normalizes streaming lifecycles and derives factual metrics", () => {
    const model = new ViewerModel({
      manifest: {
        version: 1,
        capturedAt: "2026-07-21T20:00:00.000Z",
        runtime: { contextWindow: 272_000 },
      },
      now: () => Date.parse("2026-07-21T20:00:10.000Z"),
    });

    const events = [
      { type: "session", provider: "openai-codex", model: "gpt-5.6-luna" },
      { type: "agent_start", timestamp: 1_000 },
      {
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", delta: "checking" },
      },
      {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "answer" },
      },
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "answer" }],
          usage: { totalTokens: 123_000 },
          cost: { total: 0.023 },
        },
      },
      {
        type: "tool_execution_start",
        toolCallId: "call-1",
        toolName: "read",
        args: { path: "src/auth.ts" },
      },
      { type: "auto_retry_start", errorMessage: "provider overloaded" },
    ];
    events.forEach((event, index) =>
      model.ingestEvent(event, { receivedAt: 1_000 + index * 10 }),
    );

    const snapshot = model.snapshot(2_000);
    assert.equal(snapshot.observedAt, 2_000);
    assert.equal(
      snapshot.items.filter((item) => item.kind === "assistant").length,
      1,
    );
    assert.equal(
      snapshot.items.find((item) => item.id === "call-1")?.status,
      "active",
    );
    assert.deepEqual(snapshot.metrics, {
      tools: 1,
      failed: 0,
      retries: 1,
      active: 1,
      tokens: 123_000,
      cost: 0.023,
      elapsedMs: 1_000,
      provider: "openai-codex",
      model: "gpt-5.6-luna",
      contextUsed: 123_000,
      contextLimit: 272_000,
    });
  });

  it("retains null endedAt for an active tool snapshot", () => {
    const model = new ViewerModel({ now: () => 100 });
    model.ingestEvent(
      {
        type: "tool_execution_start",
        toolCallId: "active-call",
        toolName: "read",
        args: { path: "src/active.ts" },
      },
      { receivedAt: 75 },
    );

    const activeTool = model
      .snapshot(125)
      .items.find(({ id }) => id === "active-call");
    assert.ok(activeTool);
    assert.equal(activeTool.status, "active");
    assert.equal(activeTool.endedAt, null);
  });

  it("finalizes one tool item without duplicating updates", () => {
    const model = new ViewerModel({ now: () => 10 });
    model.ingestEvent({
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "bash",
      args: { command: "printf hello" },
    });
    model.ingestEvent({
      type: "tool_execution_update",
      toolCallId: "call-1",
      partialResult: { content: [{ type: "text", text: "partial output" }] },
    });
    model.ingestEvent({
      type: "tool_execution_end",
      toolCallId: "call-1",
      result: { content: [{ type: "text", text: "hello" }] },
      isError: true,
    });

    const snapshot = model.snapshot();
    assert.equal(
      snapshot.items.filter((item) => item.kind === "tool").length,
      1,
    );
    assert.equal(snapshot.items[0].payload.result, "hello");
    assert.equal(snapshot.items[0].status, "failed");
    assert.equal(snapshot.metrics.failed, 1);
  });

  const lifecycleCases = [
    ["agent_start", "AGENT START"],
    ["turn_start", "TURN START"],
    ["turn_end", "TURN END"],
    ["agent_end", "AGENT END"],
    ["agent_settled", "SETTLED"],
    ["auto_retry_start", "RETRY"],
    ["auto_retry_end", "RETRY COMPLETE"],
    ["extension_error", "EXTENSION ERROR"],
    ["session_compaction", "COMPACTION"],
    ["session_switch", "SESSION CHANGE"],
    ["queue_update", "QUEUE"],
  ] as const;

  for (const [type, label] of lifecycleCases) {
    it(`normalizes ${type} as ${label}`, () => {
      const model = new ViewerModel({ now: () => 100 });
      model.ingestEvent({ type, timestamp: 50, detail: "observed" });

      const [item] = model.snapshot().items;
      assert.equal(item.kind, "lifecycle");
      assert.equal(item.label, label);
      assert.notEqual(item.kind, "unknown");
    });
  }

  const messageUpdateCases = [
    ["thinking", "THINKING", "thinking"],
    ["reasoning", "REASONING", "thinking"],
    ["text", "ASSISTANT", "assistant"],
    ["toolcall", "TOOL CALL", "tool-call"],
  ] as const;

  for (const [stream, label, kind] of messageUpdateCases) {
    it(`merges ${stream} start, delta, and end updates`, () => {
      const model = new ViewerModel({ now: () => 100 });
      for (const event of [
        { type: `${stream}_start` },
        { type: `${stream}_delta`, delta: `${stream} content` },
        { type: `${stream}_end` },
      ]) {
        model.ingestEvent({
          type: "message_update",
          assistantMessageEvent: event,
        });
      }

      const snapshot = model.snapshot();
      assert.equal(snapshot.items.length, 1);
      assert.equal(snapshot.items[0].kind, kind);
      assert.equal(snapshot.items[0].label, label);
      assert.equal(snapshot.items[0].payload.content, `${stream} content`);
      assert.equal(snapshot.items[0].payload.streamStatus, "ended");
    });
  }

  it("bounds warnings for malformed known events and continues", () => {
    const model = new ViewerModel({ now: () => 100 });
    model.ingestEvent({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        delta: { unexpected: "x".repeat(2_000) },
      },
    });
    model.ingestEvent({
      type: "tool_execution_start",
      toolCallId: "call-after-warning",
      toolName: "read",
      args: { path: "src/after-warning.ts" },
    });

    const snapshot = model.snapshot();
    assert.equal(snapshot.items[0].kind, "protocol-warning");
    assert.match(snapshot.items[0].label, /^PROTOCOL WARNING/);
    assert.ok(JSON.stringify(snapshot.items[0]).length < 1_000);
    assert.equal(snapshot.items[1].id, "call-after-warning");
    assert.equal(snapshot.items[1].status, "active");
  });

  it("never rewrites a committed message when a later message completes", () => {
    const model = new ViewerModel({ now: () => 100 });
    model.ingestEvent({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "first partial" },
    });
    model.ingestEvent({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "first final" }],
      },
    });
    const committed = structuredClone(model.snapshot().items[0]);

    model.ingestEvent({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "second partial" },
    });
    model.ingestEvent({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "second final" }],
      },
    });

    const assistants = model
      .snapshot()
      .items.filter((item) => item.kind === "assistant");
    assert.equal(assistants.length, 2);
    assert.deepEqual(assistants[0], committed);
    assert.notEqual(assistants[1].id, committed.id);
    assert.equal(assistants[1].payload.content, "second final");
  });

  it("reconciles an id-less stream to a repeated authoritative final ID", () => {
    const model = new ViewerModel({ now: () => 100 });
    model.ingestEvent({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "answer" },
    });
    const finalEvent = {
      type: "message_end",
      message: {
        id: "server-1",
        role: "assistant",
        content: [{ type: "text", text: "answer" }],
        usage: { totalTokens: 42 },
        cost: { total: 0.0042 },
      },
    };

    model.ingestEvent(finalEvent);
    model.ingestEvent(finalEvent);

    const snapshot = model.snapshot();
    const assistants = snapshot.items.filter(
      (item) => item.kind === "assistant",
    );
    assert.equal(assistants.length, 1);
    assert.equal(assistants[0].id, "server-1");
    assert.equal(assistants[0].status, "succeeded");
    assert.equal(assistants[0].payload.content, "answer");
    assert.equal(snapshot.metrics.tokens, 42);
    assert.equal(snapshot.metrics.cost, 0.0042);
  });

  it("gives finalized assistant streams unique IDs and ignores repeated finals", () => {
    const model = new ViewerModel({ now: () => 100 });
    model.ingestEvent({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "checking" },
    });
    model.ingestEvent({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "draft" },
    });
    const finalEvent = {
      type: "message_end",
      message: {
        id: "server-1",
        role: "assistant",
        content: [
          { type: "thinking", thinking: "checked", text: "checked" },
          { type: "reasoning", text: "verified" },
          { type: "text", text: "answer" },
        ],
        usage: { totalTokens: 42 },
        cost: { total: 0.0042 },
      },
    };

    model.ingestEvent(finalEvent);
    const finalized = model.snapshot();
    assert.deepEqual(
      finalized.items.map(({ id, kind }) => ({ id, kind })),
      [
        { id: "server-1:thinking", kind: "thinking" },
        { id: "server-1", kind: "assistant" },
        { id: "server-1:reasoning", kind: "thinking" },
      ],
    );
    assert.equal(new Set(finalized.items.map(({ id }) => id)).size, 3);
    assert.equal(finalized.metrics.tokens, 42);
    assert.equal(finalized.metrics.cost, 0.0042);

    model.ingestEvent(finalEvent);
    assert.deepEqual(model.snapshot(), finalized);
  });

  it("sums finalized usage once while retaining only latest context usage", () => {
    const model = new ViewerModel({ now: () => 100 });
    for (const [id, totalTokens, cost] of [
      ["message-1", 100, 0.01],
      ["message-2", 40, 0.02],
    ] as const) {
      model.ingestEvent({
        type: "message_start",
        message: { id, role: "assistant", content: [] },
      });
      model.ingestEvent({
        type: "message_end",
        message: {
          id,
          role: "assistant",
          content: [{ type: "text", text: id }],
          usage: { totalTokens },
          cost: { total: cost },
        },
      });
    }

    const snapshot = model.snapshot();
    assert.equal(snapshot.metrics.tokens, 140);
    assert.equal(snapshot.metrics.cost, 0.03);
    assert.equal(snapshot.metrics.contextUsed, 40);
  });

  it("retires a stale message when a new message starts after a missing end", () => {
    const model = new ViewerModel({ now: () => 100 });
    model.ingestEvent({
      type: "message_start",
      message: {
        id: "first",
        role: "assistant",
        content: [{ type: "text", text: "first response" }],
      },
    });
    model.ingestEvent({
      type: "message_start",
      message: {
        id: "second",
        role: "assistant",
        content: [{ type: "text", text: "second response" }],
      },
    });

    const { items } = model.snapshot();
    assert.equal(items[0]?.payload.content, "first response");
    assert.equal(items[0]?.status, "failed");
    assert.equal(items[1]?.label, "PROTOCOL WARNING · MESSAGE START");
    assert.equal(items[2]?.payload.content, "second response");
    assert.equal(items[2]?.status, "active");
  });
});

describe("viewer model transcript materialization", () => {
  it("freezes the verbosity matrix and each level entry", () => {
    assert.equal(Object.isFrozen(VERBOSITY_LEVELS), true);
    assert.equal(
      VERBOSITY_LEVELS.every((level) => Object.isFrozen(level)),
      true,
    );
    assert.throws(() => {
      (VERBOSITY_LEVELS as unknown as { push: (value: unknown) => void }).push(
        {},
      );
    }, TypeError);
    assert.throws(() => {
      (
        VERBOSITY_LEVELS[0] as unknown as { narrativeLines: number }
      ).narrativeLines = 99;
    }, TypeError);
  });

  it("exposes the approved four-level line limits exactly", () => {
    assert.deepEqual(VERBOSITY_LEVELS, [
      { id: "compact", narrativeLines: 5, toolLines: 0 },
      { id: "readable", narrativeLines: 15, toolLines: 1 },
      { id: "detailed", narrativeLines: Infinity, toolLines: 5 },
      { id: "full", narrativeLines: Infinity, toolLines: Infinity },
    ]);
  });

  it("applies the approved four-level line matrix", () => {
    const narrative = {
      id: "assistant-1",
      kind: "assistant",
      label: "ASSISTANT",
      payload: {
        text: Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n"),
      },
    };
    const tool = {
      id: "tool-1",
      kind: "tool",
      label: "READ",
      status: "succeeded",
      payload: {
        args: { path: "src/file.ts" },
        result: Array.from({ length: 12 }, (_, i) => `result ${i + 1}`).join(
          "\n",
        ),
      },
    };

    assert.deepEqual(
      [0, 1, 2, 3].map(
        (level) =>
          materializeItem(narrative, level).body.filter((line) =>
            line.startsWith("line "),
          ).length,
      ),
      [5, 15, 20, 20],
    );
    assert.deepEqual(
      [0, 1, 2, 3].map(
        (level) =>
          materializeItem(tool, level).body.filter((line) =>
            line.startsWith("result "),
          ).length,
      ),
      [0, 1, 5, 12],
    );
    assert.match(
      materializeItem(narrative, 0).body.at(-1) || "",
      /… 15 more lines hidden · → increase verbosity/,
    );
    assert.match(
      materializeItem(tool, 2).body.at(-1) || "",
      /… 7 more lines hidden · → increase verbosity/,
    );
  });

  it("shows failure facts even when normal tool output is collapsed", () => {
    const view = materializeItem(
      {
        id: "tool-2",
        kind: "tool",
        label: "BASH",
        status: "failed",
        payload: { args: { command: "false" }, result: "fatal error" },
      },
      0,
    );

    assert.equal(
      view.body.some((line) => line.includes("failed")),
      true,
    );
    assert.equal(
      view.body.some((line) => line.includes("fatal error")),
      true,
    );
  });

  it("caps sanitized logical lines with exact hidden counts", () => {
    assert.deepEqual(
      capLogicalLines(["one\u001b[31m", "two\nthree", "four"], 2),
      ["one", "two", "… 2 more lines hidden · → increase verbosity"],
    );
    assert.deepEqual(capLogicalLines(["one", "two"], Infinity), ["one", "two"]);
  });

  it("uses the same cap semantics for prompts and equivalent narrative items", () => {
    const promptText = Array.from(
      { length: 20 },
      (_, index) => `prompt ${index + 1}`,
    ).join("\n");
    const prompts = [
      { kind: "system", title: "System prompt", text: promptText },
    ];

    for (const level of [0, 1, 2, 3]) {
      const prompt = materializePrompts(prompts, level)[0];
      const narrative = materializeItem(
        {
          kind: "assistant",
          label: "ASSISTANT",
          payload: { text: promptText },
        },
        level,
      );

      assert.deepEqual(prompt.body, narrative.body);
      assert.equal(
        prompt.body.at(-1)?.includes("more lines hidden") ?? false,
        narrative.body.at(-1)?.includes("more lines hidden") ?? false,
      );
    }
  });

  it("applies narrative limits to unknown previews and stderr", () => {
    const text = Array.from(
      { length: 20 },
      (_, index) => `source ${index + 1}`,
    ).join("\n");
    const unknown = {
      id: "unknown-1",
      kind: "unknown",
      label: "UNPARSED",
      payload: { text },
    };
    const stderr = {
      id: "stderr-1",
      kind: "stderr",
      label: "STDERR",
      payload: { text },
    };

    for (const item of [unknown, stderr]) {
      assert.deepEqual(
        [0, 1, 2, 3].map(
          (level) =>
            materializeItem(item, level).body.filter((line) =>
              line.startsWith("source "),
            ).length,
        ),
        [5, 15, 20, 20],
      );
    }
  });

  it("labels source-side truncation without inventing a hidden count", () => {
    const view = materializeItem(
      {
        id: "assistant-truncated",
        kind: "assistant",
        label: "ASSISTANT",
        payload: {
          text: "available source",
          sourceTruncated: true,
        },
      },
      3,
    );

    assert.equal(view.body.at(-1), "additional source content unavailable");
    assert.equal(
      view.body.some((line) => /\d+ more lines hidden/.test(line)),
      false,
    );
  });

  it("preserves all available sanitized source at full verbosity", () => {
    const narrativeSource = "first\u001b[31m\nsecond\n";
    const resultSource = "result one\u001b[32m\nresult two\n";
    const narrative = materializeItem(
      {
        id: "assistant-full",
        kind: "assistant",
        label: "ASSISTANT",
        payload: { content: narrativeSource },
      },
      3,
    );
    const tool = materializeItem(
      {
        id: "tool-full",
        kind: "tool",
        label: "READ",
        status: "succeeded",
        payload: {
          args: { path: "src/\u001b[31mfile.ts", query: "first\nsecond" },
          result: resultSource,
        },
      },
      3,
    );

    assert.equal(narrative.body.join("\n"), sanitizeText(narrativeSource));
    assert.equal(
      tool.body.slice(tool.body.indexOf("result one")).join("\n"),
      sanitizeText(resultSource),
    );
    assert.equal(tool.body.join("\n").includes("src/file.ts"), true);
    assert.equal(tool.body.join("\n").includes("first"), true);
    assert.equal(tool.body.join("\n").includes("second"), true);
  });

  it("keeps malformed-line previews bounded and says they were bounded", () => {
    const malformed = Array.from(
      { length: 140 },
      (_, index) => `malformed ${index + 1}`,
    ).join("\n");
    const view = materializeItem(
      {
        id: "unknown-malformed",
        kind: "unknown",
        label: "UNPARSED",
        payload: { text: malformed },
      },
      3,
    );

    assert.equal(view.body.length < 140, true);
    assert.equal(
      view.body.some((line) => line.includes("bounded")),
      true,
    );
  });

  it("safety-bounds a malformed source even when it has one very long line", () => {
    const view = materializeItem(
      {
        id: "unknown-long-malformed",
        kind: "unknown",
        label: "UNPARSED",
        payload: { text: `malformed ${"x".repeat(4_000)}` },
      },
      3,
    );

    assert.equal(view.body.join("\n").length < 2_000, true);
    assert.equal(
      view.body.some((line) => line.includes("bounded")),
      true,
    );
  });
});
