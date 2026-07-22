import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  PromptOverlay,
  VerbosityKeyGate,
  ViewportState,
  createViewerApp,
  footerMode,
  footerRows,
  handleViewerInput,
  layoutPrompts,
  layoutTimeline,
  renderFooter,
  renderPromptLines,
  renderViewerLines,
  wideFooterMinWidth,
} from "../src/viewer-ui.mjs";
import { ViewerModel } from "../src/viewer-model.mjs";
import { renderViewerLayout } from "../src/viewer-render.mjs";
import { createTheme } from "../src/viewer-theme.mjs";

interface Layout {
  lines: string[];
  ranges: Array<{ id: string; start: number; end: number }>;
}

const layout = (sizes: number[]): Layout => {
  const lines: string[] = [];
  const ranges: Layout["ranges"] = [];
  sizes.forEach((size, index) => {
    const start = lines.length;
    lines.push(...Array.from({ length: size }, () => `item-${index}`), "");
    ranges.push({ id: `item-${index}`, start, end: lines.length - 2 });
  });
  return { lines, ranges };
};

describe("viewer viewport", () => {
  it("preserves top, bottom, and midpoint anchors", () => {
    const top = new ViewportState({ level: 1, scrollTop: 0 });
    top.changeLevel(2, layout([3, 3, 3]), layout([8, 8, 8]), 6);
    assert.equal(top.scrollTop, 0);
    assert.equal(top.level, 2);

    const bottom = new ViewportState({ level: 1, scrollTop: 6 });
    bottom.changeLevel(2, layout([3, 3, 3]), layout([8, 8, 8]), 6);
    assert.equal(bottom.scrollTop, 21);

    const middle = new ViewportState({ level: 1, scrollTop: 3 });
    const expanded = layout([8, 8, 8]);
    middle.changeLevel(2, layout([3, 3, 3]), expanded, 6);
    const anchor = expanded.ranges.find((range) => range.id === "item-1");
    assert.ok(anchor);
    assert.equal(anchor.start - middle.scrollTop, 1);
  });

  it("does not jump when new items arrive away from the bottom", () => {
    const viewport = new ViewportState({ level: 1, scrollTop: 2 });
    viewport.onAppend(layout([3, 3, 3]), layout([3, 3, 3, 3]), 6);
    assert.equal(viewport.scrollTop, 2);
  });

  it("keeps following the bottom when new items arrive", () => {
    const viewport = new ViewportState({ level: 1, scrollTop: 6 });
    viewport.onAppend(layout([3, 3, 3]), layout([3, 3, 3, 3]), 6);
    assert.equal(viewport.scrollTop, 10);
    assert.equal(viewport.followingBottom, true);
  });

  it("supports bounded scrolling and explicit top and bottom controls", () => {
    const viewport = new ViewportState({ level: 1, scrollTop: 4 });
    const current = layout([3, 3, 3]);

    viewport.scrollBy(3, current, 6);
    assert.equal(viewport.scrollTop, 6);
    assert.equal(viewport.followingBottom, false);

    viewport.scrollBy(-2, current, 6);
    assert.equal(viewport.scrollTop, 4);

    viewport.goTop();
    assert.equal(viewport.scrollTop, 0);

    viewport.goBottom(current, 6);
    assert.equal(viewport.scrollTop, 6);
    assert.equal(viewport.followingBottom, true);

    viewport.clamp(layout([1]), 6);
    assert.equal(viewport.scrollTop, 0);
  });

  it("bounds zero-height and one-row viewports without negative offsets", () => {
    const current = layout([3, 3]);
    const viewport = new ViewportState({
      scrollTop: 99,
      followingBottom: true,
    });

    assert.equal(viewport.clamp(current, 0), current.lines.length);
    assert.equal(viewport.onResize(current, layout([1]), 0, 1), 1);
    viewport.scrollBy(-99, layout([1]), 0);
    assert.equal(viewport.scrollTop, 0);
  });

  it("preserves top, bottom, and midpoint policy across resize", () => {
    const oldLayout = layout([3, 3, 3]);
    const reflowed = layout([5, 5, 5]);

    const top = new ViewportState({ level: 1, scrollTop: 0 });
    top.onResize(oldLayout, reflowed, 6, 8);
    assert.equal(top.scrollTop, 0);

    const bottom = new ViewportState({ level: 1, scrollTop: 6 });
    bottom.onResize(oldLayout, reflowed, 6, 5);
    assert.equal(bottom.scrollTop, 13);
    assert.equal(bottom.followingBottom, true);

    const middle = new ViewportState({ level: 1, scrollTop: 3 });
    middle.onResize(oldLayout, reflowed, 6, 8);
    const anchor = reflowed.ranges.find((range) => range.id === "item-1");
    assert.ok(anchor);
    assert.equal(anchor.start - middle.scrollTop, 1);
    const midpoint = middle.scrollTop + Math.floor(8 / 2);
    assert.equal(anchor.start <= midpoint && midpoint <= anchor.end, true);
  });
});

describe("viewer layout", () => {
  it("adds exactly one separator row after every timeline range", () => {
    const result = layoutTimeline(
      [
        {
          id: "assistant-1",
          kind: "assistant",
          label: "ASSISTANT",
          payload: { text: "first\nsecond" },
        },
        {
          id: "tool-1",
          kind: "tool",
          label: "READ",
          status: "succeeded",
          payload: { args: { path: "src/file.ts" }, result: "found" },
        },
      ],
      1,
    );

    assert.deepEqual(
      result.ranges.map(({ id }) => id),
      ["assistant-1", "tool-1"],
    );
    result.ranges.forEach((range, index) => {
      assert.equal(result.lines[range.end + 1], "");
      const next = result.ranges[index + 1];
      assert.equal(next?.start ?? result.lines.length, range.end + 2);
    });
  });

  it("keeps prompt sections continuous without timeline separators", () => {
    const result = layoutPrompts(
      [
        {
          kind: "system",
          title: "System",
          text: "system text",
          source: "runtime",
          provenance: "exact",
        },
        {
          kind: "task",
          title: "Task",
          text: "task text",
          source: "prompt file",
          provenance: "exact",
        },
      ],
      1,
    );

    assert.equal(result.ranges.length, 2);
    assert.equal(result.ranges[1].start, result.ranges[0].end + 1);
    assert.equal(result.lines[result.ranges[1].start], "Task");
  });

  it("tracks rendered timeline ranges after launch rows and wrapped content", async () => {
    const { app } = await createTestApp({
      snapshot: {
        ...snapshotFixture,
        items: [
          {
            ...snapshotFixture.items[0],
            payload: {
              text: "a wrapped assistant response that cannot fit on one row",
            },
          },
        ],
      },
      columns: 24,
      rows: 30,
    });

    app.root.render(24);
    const range = app.state.layout?.ranges[0];
    assert.ok(range);
    assert.ok(range.start > 6, `expected launch offset, got ${range.start}`);
    assert.equal(
      app.state.layout?.lines[range.start]?.includes("ASSISTANT"),
      true,
    );
    assert.ok(
      range.end - range.start >= 2,
      "wrapped body rows belong to the item range",
    );
    await app.close();
  });

  it("reanchors the application viewport when width or height changes", async () => {
    const { app, terminal } = await createTestApp({ columns: 80, rows: 24 });
    let resizeCalls = 0;
    const original = app.state.viewport.onResize.bind(app.state.viewport);
    app.state.viewport.onResize = (...args: Parameters<typeof original>) => {
      resizeCalls += 1;
      return original(...args);
    };

    app.root.render(80);
    app.root.render(60);
    terminal.rows = 18;
    app.root.render(60);

    assert.equal(resizeCalls, 2);
    await app.close();
  });

  it("keeps following the bottom when bounded history is replaced", async () => {
    const liveSnapshot = structuredClone(snapshotFixture) as Record<
      string,
      unknown
    >;
    const { app } = await createTestApp({
      snapshot: liveSnapshot,
      columns: 40,
      rows: 12,
    });
    app.root.render(40);
    const initialLayout = app.state.layout;
    const initialHeight = app.state.height;
    assert.ok(initialLayout);
    assert.ok(initialHeight);
    app.state.viewport.goBottom(initialLayout, initialHeight);

    liveSnapshot.omittedLogicalLines = 40;
    liveSnapshot.items = Array.from({ length: 20 }, (_, index) => ({
      id: `new-${index}`,
      kind: "assistant",
      label: "ASSISTANT",
      status: "succeeded",
      payload: { content: `new ${index}`, stream: "text" },
    }));
    app.root.render(40);

    const updatedLayout = app.state.layout;
    const updatedHeight = app.state.height;
    assert.ok(updatedLayout);
    assert.ok(updatedHeight);
    assert.equal(app.state.viewport.followingBottom, true);
    assert.equal(
      app.state.viewport.scrollTop,
      Math.max(0, updatedLayout.lines.length - updatedHeight),
    );
    await app.close();
  });

  it("keeps a manual scroll position valid when bounded history is replaced", async () => {
    const liveSnapshot = structuredClone(snapshotFixture) as Record<
      string,
      unknown
    >;
    liveSnapshot.items = Array.from({ length: 20 }, (_, index) => ({
      id: `old-${index}`,
      kind: "assistant",
      label: "ASSISTANT",
      status: "succeeded",
      payload: { content: `old ${index}`, stream: "text" },
    }));
    const { app } = await createTestApp({
      snapshot: liveSnapshot,
      columns: 40,
      rows: 12,
    });
    app.root.render(40);
    assert.ok(app.state.layout);
    assert.ok(app.state.height);
    app.state.viewport.goTop();
    app.state.viewport.scrollBy(3, app.state.layout, app.state.height);

    liveSnapshot.omittedLogicalLines = 40;
    liveSnapshot.items = Array.from({ length: 20 }, (_, index) => ({
      id: `new-${index}`,
      kind: "assistant",
      label: "ASSISTANT",
      status: "succeeded",
      payload: { content: `new ${index}`, stream: "text" },
    }));
    app.root.render(40);

    assert.equal(app.state.viewport.followingBottom, false);
    assert.equal(app.state.viewport.scrollTop, 3);
    await app.close();
  });
});

const startedAt = new Date(2026, 0, 1, 20, 46).getTime();
const snapshotFixture = {
  manifest: {
    version: 1 as const,
    capturedAt: null,
    child: { agent: "reviewer", index: 0 },
    launch: { promptMode: null, task: null },
    prompts: [],
    runtime: { provider: "openai-codex", model: "gpt-5.6-luna" },
  },
  prompts: [
    {
      kind: "system" as const,
      title: "System",
      text: "You are a careful reviewer.",
      source: "runtime",
      provenance: "exact" as const,
    },
    {
      kind: "task" as const,
      title: "Task",
      text: "Review the change.",
      source: "prompt argument",
      provenance: "exact" as const,
    },
  ],
  items: [
    {
      id: "assistant-1",
      kind: "assistant",
      label: "ASSISTANT",
      startedAt,
      endedAt: startedAt + 14_000,
      status: "succeeded" as const,
      payload: { text: "First response." },
      provenance: "exact" as const,
    },
    {
      id: "read-1",
      kind: "tool",
      label: "READ",
      startedAt: startedAt + 15_000,
      endedAt: startedAt + 16_000,
      status: "succeeded" as const,
      payload: { args: { path: "src/file.ts" }, result: "contents" },
      provenance: "exact" as const,
    },
  ],
  metrics: {
    tools: 1,
    failed: 0,
    retries: 0,
    active: 0,
    tokens: 0,
    cost: 0,
    elapsedMs: 16_000,
    provider: "openai-codex",
    model: "gpt-5.6-luna",
    contextUsed: null,
    contextLimit: null,
  },
};

describe("adaptive viewer rendering", () => {
  it("renders only the newest transcript rows with a counted omission marker", () => {
    const result = renderViewerLayout(
      {
        ...snapshotFixture,
        omittedLogicalLines: 12_430,
        items: Array.from({ length: 8 }, (_, index) => ({
          id: `item-${index}`,
          kind: "assistant",
          label: "ASSISTANT",
          status: "succeeded",
          payload: { content: `message ${index}`, stream: "text" },
        })),
      },
      { width: 80, maxTranscriptRows: 8 },
    );

    const marker = result.lines.findIndex((line) =>
      line.includes("12,430 earlier logical lines omitted"),
    );
    assert.ok(marker >= 0);
    assert.equal(result.lines.some((line) => line.includes("message 0")), false);
    assert.equal(result.lines.some((line) => line.includes("message 7")), true);
    assert.ok(result.ranges.every((range) => range.start >= marker));
  });

  it("uses an uncounted marker when wrapping alone clips retained rows", () => {
    const result = renderViewerLayout(
      {
        ...snapshotFixture,
        omittedLogicalLines: 0,
        items: [
          {
            id: "wide",
            kind: "assistant",
            label: "ASSISTANT",
            status: "succeeded",
            payload: { content: "word ".repeat(100), stream: "text" },
          },
        ],
      },
      { width: 12, level: 3, maxTranscriptRows: 6 },
    );

    const transcriptStart = result.lines.findIndex((line) =>
      line.includes("earlier wrapped transcript rows omitted"),
    );
    assert.ok(transcriptStart >= 0);
    assert.ok(result.lines.length - transcriptStart <= 6);
  });

  it("stops before materializing older items when the row budget fills exactly", () => {
    const olderItem = {
      get kind(): string {
        throw new Error("older item was materialized");
      },
    };
    const result = renderViewerLayout(
      {
        ...snapshotFixture,
        omittedLogicalLines: 0,
        items: [
          olderItem,
          {
            id: "newest",
            kind: "assistant",
            label: "ASSISTANT",
            status: "succeeded",
            payload: { content: "newest message", stream: "text" },
          },
        ],
      },
      { width: 80, maxTranscriptRows: 3 },
    );

    const marker = result.lines.findIndex((line) =>
      line.includes("earlier wrapped transcript rows omitted"),
    );
    assert.ok(marker >= 0);
    assert.equal(result.lines.length - marker, 3);
    assert.equal(
      result.lines.some((line) => line.includes("newest message")),
      true,
    );
  });

  it("reserves the marker row with a zero-row item at the boundary", () => {
    const result = renderViewerLayout(
      {
        ...snapshotFixture,
        omittedLogicalLines: 12,
        items: [
          {
            id: "hidden",
            kind: "lifecycle",
            label: "TURN START",
            status: "succeeded",
            payload: {},
          },
          {
            id: "newest",
            kind: "assistant",
            label: "ASSISTANT",
            status: "succeeded",
            payload: { content: "newest message", stream: "text" },
          },
        ],
      },
      { width: 80, maxTranscriptRows: 3 },
    );

    const marker = result.lines.findIndex((line) =>
      line.includes("12 earlier logical lines omitted"),
    );
    assert.ok(marker >= 0);
    assert.equal(result.lines.length - marker, 3);
  });

  it("assigns distinct semantic accents in light and dark modes", () => {
    for (const mode of ["light", "dark"] as const) {
      const theme = createTheme(mode);
      const accents = [
        "assistant",
        "thinking",
        "reasoning",
        "user",
        "read",
        "grep",
        "find",
        "ls",
        "bash",
        "edit",
        "write",
        "extension",
        "unknown",
      ].map((kind) => theme.eventColor(kind));
      assert.equal(new Set(accents).size, 12);
      assert.notEqual(theme.foreground, theme.surface);
    }
  });

  it("renders Variant A without invented metadata and one blank timeline row", () => {
    const lines = renderViewerLines(snapshotFixture, {
      width: 100,
      height: 28,
      level: 1,
      theme: createTheme("dark", { color: false }),
    });
    const output = lines.join("\n");

    assert.match(output, /REVIEWER/);
    assert.match(output, /openai-codex\/gpt-5\.6-luna/);
    assert.doesNotMatch(output, /PROMPT MANIFEST|All available prompt layers/);
    assert.match(output, /◆ REVIEWER/);
    assert.match(output, /ASSISTANT \[20:46 @ 14s\]/);
    assert.match(output, /╰─ First response\./);
    assert.match(output, /READ \[20:46 @ 1s\] {2}src\/file\.ts/);
    assert.match(output, /╰─ ✓ 1 line · 8B/);
    assert.doesNotMatch(output, /args:|arguments:|status:/);
    assert.doesNotMatch(output, /tagline|run id/i);
    const firstEnd = lines.findIndex((line) =>
      line.includes("First response."),
    );
    const read = lines.findIndex((line) => line.includes("READ"));
    assert.equal(read > firstEnd, true);
    assert.equal(
      lines.slice(firstEnd + 1, read).filter((line) => line === "").length,
      1,
    );
    assert.equal(
      lines.some((line, index) => line === "" && lines[index + 1] === ""),
      false,
    );
  });

  it("shows grep pattern and search path in the compact header", () => {
    const output = renderViewerLines(
      {
        ...snapshotFixture,
        prompts: [],
        items: [
          {
            ...snapshotFixture.items[1],
            id: "grep-1",
            label: "GREP",
            payload: {
              args: { path: ".", pattern: "TEGRA_ESP_IMAGE", limit: 100 },
              result: "No matches found",
            },
          },
        ],
      },
      {
        width: 100,
        level: 1,
        theme: createTheme("dark", { color: false }),
      },
    ).join("\n");

    assert.match(output, /GREP .*TEGRA_ESP_IMAGE in \./);
    assert.doesNotMatch(output, /args:/);
  });

  it("shows find patterns and read line windows in compact headers", () => {
    const output = renderViewerLines(
      {
        ...snapshotFixture,
        prompts: [],
        items: [
          {
            ...snapshotFixture.items[1],
            id: "find-1",
            label: "FIND",
            payload: {
              args: { path: "src", pattern: "**/*.test.ts" },
              result: "src/example.test.ts",
            },
          },
          {
            ...snapshotFixture.items[1],
            id: "read-window-1",
            label: "READ",
            payload: {
              args: { path: "src/auth/session.ts", offset: 84, limit: 78 },
              result: "contents",
            },
          },
        ],
      },
      {
        width: 120,
        level: 1,
        theme: createTheme("dark", { color: false }),
      },
    ).join("\n");

    assert.match(output, /FIND .*\*\*\/\*\.test\.ts in src/);
    assert.match(output, /READ .*src\/auth\/session\.ts 84–161/);
    assert.doesNotMatch(output, /args:/);
  });

  it("shows concise headers for nested and fallback tool arguments", () => {
    const tool = (id: string, label: string, args: object) => ({
      ...snapshotFixture.items[1],
      id,
      label,
      payload: { args, result: "done" },
    });
    const output = renderViewerLines(
      {
        ...snapshotFixture,
        prompts: [],
        items: [
          tool("browser-1", "AGENT_BROWSER", {
            args: ["snapshot", "-i"],
          }),
          tool("browser-job-1", "AGENT_BROWSER", {
            job: {
              steps: [
                { action: "open" },
                { action: "wait" },
                { action: "snapshot" },
              ],
            },
          }),
          tool("diagnostics-1", "LSP_DIAGNOSTICS", {
            paths: ["src/one.ts", "src/two.ts"],
            severity: "all",
          }),
          tool("search-1", "WEB_SEARCH", {
            queries: ["first query", "second query"],
          }),
          tool("supervisor-1", "CONTACT_SUPERVISOR", {
            reason: "need_decision",
            message: "The detailed request remains available at higher verbosity.",
          }),
          tool("exec-1", "EXEC", {
            code: "const result = await tools.exec_command({ cmd: 'npm test' });",
          }),
        ],
      },
      {
        width: 120,
        level: 1,
        theme: createTheme("dark", { color: false }),
      },
    ).join("\n");

    assert.match(output, /AGENT_BROWSER .*snapshot -i/);
    assert.match(output, /AGENT_BROWSER .*job: open → wait → snapshot/);
    assert.match(output, /LSP_DIAGNOSTICS .*src\/one\.ts \(\+1\)/);
    assert.match(output, /WEB_SEARCH .*first query \(\+1\)/);
    assert.match(output, /CONTACT_SUPERVISOR .*need_decision/);
    assert.match(output, /EXEC .*const result = await tools\.exec_command/);
    assert.doesNotMatch(output, /args:/);
  });

  it("omits routine turn markers and empty or duplicate stream placeholders", () => {
    const item = (id: string, kind: string, label: string, content = "") => ({
      id,
      kind,
      label,
      startedAt,
      endedAt: startedAt,
      status: "succeeded",
      payload: { content, summary: { type: id } },
    });
    const output = renderViewerLines(
      {
        ...snapshotFixture,
        prompts: [],
        items: [
          item("turn_start", "lifecycle", "TURN START"),
          item("assistant-empty", "assistant", "ASSISTANT"),
          item("thinking-empty", "thinking", "THINKING"),
          item("toolcall", "tool-call", "TOOL CALL", '{"path":"file.ts"}'),
          item("assistant-real", "assistant", "ASSISTANT", "Useful result"),
          item("auto_retry_start", "lifecycle", "RETRY"),
          item("turn_end", "lifecycle", "TURN END"),
        ],
      },
      { width: 100, level: 3, theme: createTheme("dark", { color: false }) },
    ).join("\n");

    assert.doesNotMatch(output, /TURN START|TURN END|TOOL CALL|THINKING/);
    assert.equal(output.match(/^ASSISTANT /gmu)?.length, 1);
    assert.match(output, /Useful result/);
    assert.match(output, /^RETRY /mu);
  });

  it("summarizes lifecycle and unknown events without compact raw JSON", () => {
    const items = [
      {
        id: "start-1",
        kind: "lifecycle",
        label: "AGENT START",
        startedAt,
        status: "active",
        payload: { summary: { type: "agent_start", timestamp: startedAt } },
      },
      {
        id: "extension-1",
        kind: "unknown",
        label: "FUTURE EXTENSION EVENT",
        startedAt,
        status: "unknown",
        payload: {
          summary: {
            type: "future_extension_event",
            extension: "policy-guard",
            event: "before_tool_call",
            decision: "allow",
            payload: "object(1 key)",
          },
        },
      },
    ];
    const compact = renderViewerLines(
      { ...snapshotFixture, prompts: [], items },
      { width: 100, level: 1, theme: createTheme("dark", { color: false }) },
    ).join("\n");
    const full = renderViewerLines(
      { ...snapshotFixture, prompts: [], items },
      { width: 100, level: 3, theme: createTheme("dark", { color: false }) },
    ).join("\n");

    assert.match(
      compact,
      /FUTURE EXTENSION EVENT .*policy-guard · before_tool_call/,
    );
    assert.match(compact, /╰─ decision: allow/);
    assert.doesNotMatch(compact, /"type"|"agent_start"|object\(1 key\)/);
    assert.match(full, /"type": "future_extension_event"/);
  });

  it("folds tool hidden counts into one result summary", () => {
    const output = renderViewerLines(
      {
        ...snapshotFixture,
        prompts: [],
        items: [
          {
            ...snapshotFixture.items[1],
            payload: {
              args: { path: "src/file.ts" },
              result: "one\ntwo\nthree",
            },
          },
        ],
      },
      {
        width: 100,
        level: 0,
        theme: createTheme("dark", { color: false }),
      },
    ).join("\n");

    assert.match(
      output,
      /╰─ ✓ 3 lines · 13B · 3 hidden · → increase verbosity/,
    );
    assert.doesNotMatch(output, /… 3 more lines hidden/);
  });

  it("colors reasoning headings by their factual label", () => {
    const theme = createTheme("dark");
    const lines = renderViewerLines(
      {
        ...snapshotFixture,
        prompts: [],
        items: [
          {
            ...snapshotFixture.items[0],
            id: "reasoning-1",
            kind: "thinking",
            label: "REASONING",
          },
        ],
      },
      { width: 80, level: 1, theme },
    );

    assert.equal(
      lines.some((line) =>
        line.includes(`\x1b[38;2;${theme.eventColor("reasoning")}mREASONING`),
      ),
      true,
    );
  });

  it("uses identical launch and overlay prompt rows", () => {
    const theme = createTheme("dark", { color: false });
    const launchRows = renderPromptLines(snapshotFixture.prompts, {
      width: 72,
      level: 1,
      theme,
    });
    const overlay = new PromptOverlay({
      prompts: snapshotFixture.prompts,
      level: 1,
      theme,
      height: 8,
    });

    assert.deepEqual(overlay.allPromptRows(72), launchRows);
    const promptSurface = launchRows.join("\n");
    assert.equal((promptSurface.match(/exact/g) ?? []).length, 2);
    assert.equal((promptSurface.match(/source:/g) ?? []).length, 2);
    assert.match(promptSurface, /◆ {2}TASK \/ USER PROMPT · exact/);
    assert.match(promptSurface, /┃ {2}Review the change\./);
    assert.match(promptSurface, /╰─ source: prompt argument/);
    assert.doesNotMatch(promptSurface, /provenance:/);
    assert.equal(
      overlay.render(0).every((line) => visibleWidth(line) <= 1),
      true,
    );
  });

  it("paints the full padded prompt surface through nested SGR resets", () => {
    const theme = createTheme("dark");
    const [, line] = renderPromptLines(snapshotFixture.prompts.slice(0, 1), {
      width: 50,
      level: 1,
      theme,
    });
    assert.equal(visibleWidth(line), 50);

    const surface = theme.surface.split(";").map(Number);
    let background: number[] | null = null;
    let paintedColumns = 0;
    for (let index = 0; index < line.length; ) {
      if (line[index] === "\x1b" && line[index + 1] === "[") {
        const end = line.indexOf("m", index + 2);
        assert.notEqual(end, -1);
        const codes = line
          .slice(index + 2, end)
          .split(";")
          .map(Number);
        if (codes.length === 1 && codes[0] === 0) background = null;
        if (codes.length === 1 && codes[0] === 49) background = null;
        if (codes[0] === 48 && codes[1] === 2) background = codes.slice(2, 5);
        index = end + 1;
        continue;
      }
      assert.deepEqual(
        background,
        surface,
        `column ${paintedColumns} lost the surface background`,
      );
      paintedColumns += 1;
      index += 1;
    }
    assert.equal(paintedColumns, 50);
  });

  it("sanitizes every display scalar at the final render boundary", () => {
    const hostile =
      "safe\nforged\x1b]8;;https://invalid.example\x07link\x1b[2J";
    const lines = renderViewerLines(
      {
        ...snapshotFixture,
        manifest: {
          ...snapshotFixture.manifest,
          child: {
            agent: hostile,
            tagline: hostile,
            runId: hostile,
            agentFile: hostile,
          },
          launch: { promptMode: hostile, task: null },
        },
        prompts: [
          {
            kind: "task",
            title: hostile,
            text: "body\x1b[31m text",
            source: hostile,
            provenance: hostile,
          },
        ],
        items: [
          {
            ...snapshotFixture.items[0],
            label: hostile,
            payload: { text: "body\x1b[31m text" },
          },
        ],
      },
      {
        width: 100,
        level: 3,
        theme: createTheme("dark", { color: false }),
      },
    );
    const output = lines.join("\n");

    assert.equal(output.includes("\x1b"), false);
    assert.doesNotMatch(output, /safe\nforged/);
    assert.match(output, /safe forgedlink/);
    assert.doesNotMatch(output, /invalid\.example|\[2J|\[31m/);
  });

  it("clamps prompt overlay scrolling at both ends", () => {
    const overlay = new PromptOverlay({
      prompts: snapshotFixture.prompts.map((prompt) => ({
        ...prompt,
        text: Array.from({ length: 20 }, (_, index) => `line ${index}`).join(
          "\n",
        ),
      })),
      level: 3,
      theme: createTheme("light", { color: false }),
      height: 7,
    });

    overlay.handleInput("\x1b[A");
    assert.equal(overlay.scrollTop, 0);
    for (let index = 0; index < 100; index += 1) overlay.handleInput("\x1b[6~");
    const bottom = overlay.scrollTop;
    assert.equal(bottom > 0, true);
    overlay.handleInput("\x1b[B");
    assert.equal(overlay.scrollTop, bottom);
    for (let index = 0; index < 100; index += 1) overlay.handleInput("k");
    assert.equal(overlay.scrollTop, 0);
  });
});

describe("responsive factual footer", () => {
  it("selects footer modes from measured box widths", () => {
    const minimum = wideFooterMinWidth();
    assert.equal(minimum, 134);
    assert.equal(footerMode(minimum), "wide");
    assert.equal(footerMode(minimum - 1), "medium");
    assert.equal(footerRows(minimum), 5);
    assert.equal(footerRows(100), 4);
    assert.equal(footerRows(80), 7);
    assert.equal(footerRows(50), 7);
  });

  it("left-aligns every collapsed footer row", () => {
    for (const width of [100, 50]) {
      const lines = renderFooter(snapshotFixture, {
        width,
        theme: createTheme("dark", { color: false }),
        level: 1,
      });
      assert.equal(lines.length, footerRows(width));
      for (const line of lines.slice(1)) {
        assert.equal(line.startsWith(" "), false);
      }
    }
  });

  it("keeps the approved rounded, padded, uppercase wide footer contract", () => {
    const lines = renderFooter(snapshotFixture, {
      width: 180,
      theme: createTheme("dark", { color: false }),
      level: 1,
    });
    const output = lines.join("\n");

    assert.match(
      output,
      /╭─ AGENT .*┬─ MODEL .*┬─ CONTEXT .*┬─ ELAPSED .*┬─ TOKENS .*┬─ COST/,
    );
    assert.match(output, /│ REVIEWER {2,}│/);
    assert.match(output, /┴/);
    const metricWidths = lines[1]
      .slice(1, -1)
      .split("┬")
      .map((segment) => visibleWidth(segment));
    assert.deepEqual(metricWidths.slice(2), [22, 10, 10, 9]);
    assert.equal(Math.abs(metricWidths[0] - metricWidths[1]) <= 3, true);
    assert.doesNotMatch(output, /╮ ╭/);
    assert.equal(
      lines.every((line) => visibleWidth(line) === 180),
      true,
    );
    assert.match(output, /VERBOSITY: 2\/4 {2}← \/ →/);
    assert.doesNotMatch(output, /COMPACT|READABLE|DETAILED|FULL/);
    assert.match(output, /1 tools · 0 failed · 0 retries · 0 active/);
    assert.doesNotMatch(output, /1 Compact|2 Readable/);
  });

  it("keeps semantic colours in medium and narrow footer modes", () => {
    const theme = createTheme("dark");
    for (const width of [100, 50]) {
      const output = renderFooter(snapshotFixture, {
        width,
        theme,
        level: 3,
      }).join("\n");
      for (const color of [
        theme.prompt,
        theme.structural,
        theme.success,
        theme.eventColor("task"),
      ]) {
        assert.equal(output.includes(`\x1b[38;2;${color}m`), true);
      }
      const plain = renderFooter(snapshotFixture, {
        width,
        theme: createTheme("dark", { color: false }),
        level: 3,
      }).join("\n");
      assert.match(plain, /VERBOSITY: 4\/4/);
      assert.doesNotMatch(plain, /Compact|Readable|Detailed|Full/);
    }
  });

  it("computes context percentage and never copies a supplied percentage", () => {
    const lines = renderFooter(
      {
        ...snapshotFixture,
        metrics: {
          ...snapshotFixture.metrics,
          contextUsed: 123_000,
          contextLimit: 272_000,
          contextPercent: 99,
        },
      },
      {
        width: 180,
        theme: createTheme("dark", { color: false }),
        level: 1,
      },
    );
    assert.match(lines.join("\n"), /45% \(123k\/272k\)/);
    assert.doesNotMatch(lines.join("\n"), /99%/);
  });

  it("shows only factual available values and paints every row to width", () => {
    const unavailable = {
      ...snapshotFixture,
      manifest: {
        ...snapshotFixture.manifest,
        child: {},
        runtime: {},
      },
      metrics: {
        tools: 0,
        failed: 0,
        retries: 0,
        active: 0,
        tokens: null,
        cost: null,
        elapsedMs: null,
        provider: null,
        model: null,
        contextUsed: null,
        contextLimit: null,
      },
    };

    for (const width of [wideFooterMinWidth(), 80, 50]) {
      const lines = renderFooter(unavailable, {
        width,
        theme: createTheme("light"),
        level: 1,
      });
      assert.equal(lines.length, footerRows(width));
      assert.equal(
        lines.every((line) => visibleWidth(line) === width),
        true,
      );
      const output = lines.join("\n");
      assert.doesNotMatch(output, /undefined|NaN|helpful|reviewer/i);
      assert.match(output, /unavailable/);
    }
  });

  it("reserves the responsive footer height and keeps a positive transcript", async () => {
    for (const width of [wideFooterMinWidth(), 80, 50]) {
      const { app, terminal } = await createTestApp({
        columns: width,
        rows: 20,
      });
      const lines = app.root.render(width);
      assert.equal(app.state.height, 20 - footerRows(width));
      assert.equal(lines.length, 20);
      terminal.rows = 1;
      app.root.render(width);
      assert.equal(app.state.height, 1);
      await app.close();
    }
  });
});

describe("hostile end-to-end viewer content", () => {
  it("keeps caps, overlay parity, sanitization, and resize behavior stable", async () => {
    const controlPrompt =
      "task start\x1b]8;;https://invalid.example\x07link\x1b]8;;\x07\n" +
      Array.from({ length: 19 }, (_, index) => `prompt ${index + 2}`).join(
        "\n",
      );
    const model = new ViewerModel({
      manifest: {
        version: 1,
        child: {},
        launch: {
          task: {
            text: controlPrompt,
            source: "prompt argument",
            provenance: "exact",
          },
        },
        prompts: [],
        runtime: {},
      },
      now: () => startedAt,
    });
    model.ingestLine("{malformed \x1b[31mjson");
    model.ingestEvent({
      type: "extension_future",
      detail: "future\x1b[2J extension",
    });
    model.ingestEvent({
      type: "message_end",
      message: {
        id: "hostile-message",
        role: "assistant",
        content: [
          {
            type: "text",
            text: Array.from(
              { length: 100 },
              (_, index) =>
                `assistant ${index + 1}${index === 0 ? "\x1b[31m" : ""}`,
            ).join("\n"),
          },
        ],
      },
    });
    model.ingestEvent({
      type: "tool_execution_start",
      toolCallId: "hostile-tool",
      toolName: "extension_tool",
      args: { value: "\x1b]0;title\x07safe" },
    });
    model.ingestEvent({
      type: "tool_execution_end",
      toolCallId: "hostile-tool",
      toolName: "extension_tool",
      result: {
        content: [
          {
            type: "text",
            text: Array.from(
              { length: 100 },
              (_, index) => `tool ${index + 1}${index === 0 ? "\x1b[2J" : ""}`,
            ).join("\n"),
          },
        ],
      },
      isError: false,
    });
    const snapshot = model.snapshot();
    const expectedNotices = [
      ["… 95 more lines hidden · → increase verbosity", "100 hidden"],
      ["… 85 more lines hidden · → increase verbosity", "99 hidden"],
      [null, "95 hidden"],
      [null, null],
    ] as const;

    for (const width of [wideFooterMinWidth(), 80, 50]) {
      for (let level = 0; level < 4; level += 1) {
        const lines = renderViewerLines(snapshot, {
          width,
          level,
          theme: createTheme("dark", { color: false }),
        });
        const output = lines.join("\n");
        assert.equal(output.includes("\x1b"), false);
        assert.doesNotMatch(output, /undefined|NaN|invalid\.example/);
        assert.match(output, /UNPARSED|EXTENSION_FUTURE/);
        for (const notice of expectedNotices[level]) {
          if (notice)
            assert.match(
              output,
              new RegExp(notice.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
            );
        }
      }
    }

    const theme = createTheme("light", { color: false });
    const promptRows = renderPromptLines(snapshot.prompts, {
      width: 72,
      level: 1,
      theme,
    });
    const overlay = new PromptOverlay({
      prompts: snapshot.prompts,
      level: 1,
      theme,
      height: 10,
    });
    assert.deepEqual(overlay.allPromptRows(72), promptRows);

    const { app } = await createTestApp({ snapshot, columns: 140, rows: 24 });
    for (const width of [140, 80, 50]) {
      const lines = app.root.render(width);
      assert.equal(lines.join("\n").includes("undefined"), false);
      assert.ok((app.state.height ?? 0) >= 1);
    }
    await app.close();
  });
});

describe("viewer input routing", () => {
  const makeState = () => {
    const current = layout([3, 3, 3, 3]);
    const calls = { overlay: 0, close: 0, child: 0, render: 0 };
    return {
      calls,
      state: {
        viewport: new ViewportState({ level: 1, scrollTop: 3 }),
        gate: new VerbosityKeyGate(),
        layout: current,
        height: 6,
        layoutForLevel: () => current,
        onOpenPrompts: () => {
          calls.overlay += 1;
        },
        onCloseViewer: () => {
          calls.close += 1;
        },
        onChildControl: () => {
          calls.child += 1;
        },
        requestRender: () => {
          calls.render += 1;
        },
      },
    };
  };

  it("routes every approved scrolling control and End resumes follow", () => {
    const { state } = makeState();
    handleViewerInput(state, "\x1b[A", 1_000);
    assert.equal(state.viewport.scrollTop, 2);
    handleViewerInput(state, "j", 1_010);
    assert.equal(state.viewport.scrollTop, 3);
    handleViewerInput(state, "K", 1_020);
    assert.equal(state.viewport.scrollTop, 2);
    handleViewerInput(state, "\x1b[6~", 1_030);
    assert.equal(state.viewport.scrollTop, 8);
    handleViewerInput(state, "\x1b[5~", 1_040);
    assert.equal(state.viewport.scrollTop, 2);
    handleViewerInput(state, "\x1b[<65;1;1M", 1_050);
    assert.equal(state.viewport.scrollTop, 5);
    handleViewerInput(state, "\x1b[<64;1;1M", 1_060);
    assert.equal(state.viewport.scrollTop, 2);
    handleViewerInput(state, "\x1b[H", 1_070);
    assert.equal(state.viewport.scrollTop, 0);
    handleViewerInput(state, "\x1b[F", 1_080);
    assert.equal(state.viewport.followingBottom, true);
    assert.equal(state.viewport.scrollTop, 10);
  });

  it("gates arrows for 120 ms and does not add bracket aliases", () => {
    const { state } = makeState();
    handleViewerInput(state, "\x1b[C", 1_000);
    assert.equal(state.viewport.level, 2);
    handleViewerInput(state, "\x1b[C", 1_040);
    assert.equal(state.viewport.level, 2);
    handleViewerInput(state, "\x1b[D", 1_050);
    assert.equal(state.viewport.level, 1);
    handleViewerInput(state, "]", 1_200);
    handleViewerInput(state, "[", 1_300);
    assert.equal(state.viewport.level, 1);
  });

  it("opens only prompts and closes only the viewer", () => {
    const { state, calls } = makeState();
    handleViewerInput(state, "p", 1_000);
    handleViewerInput(state, "q", 1_010);
    handleViewerInput(state, "\x03", 1_020);
    assert.deepEqual(calls, { overlay: 1, close: 2, child: 0, render: 0 });
  });
});

const createTestApp = async ({
  snapshot = snapshotFixture,
  columns = 80,
  rows = 24,
  calls = [],
  writes = [],
  lifecycleTarget = new EventEmitter(),
}: {
  snapshot?: unknown;
  columns?: number;
  rows?: number;
  calls?: string[];
  writes?: string[];
  lifecycleTarget?: EventEmitter;
} = {}) => {
  class FakeTerminal {
    columns = columns;
    rows = rows;
    kittyProtocolActive = false;
    write(data: string) {
      writes.push(data);
    }
    start() {}
    stop() {
      calls.push("terminal.stop");
    }
    drainInput() {
      return Promise.resolve();
    }
    moveBy() {}
    hideCursor() {}
    showCursor() {}
    clearLine() {}
    clearFromCursor() {}
    clearScreen() {
      calls.push("clear");
    }
    setTitle() {}
    setProgress() {}
  }
  class FakeTui {
    terminal: FakeTerminal;
    root: unknown;
    constructor(terminal: FakeTerminal) {
      this.terminal = terminal;
    }
    setClearOnShrink(value: boolean) {
      calls.push(`shrink:${value}`);
    }
    addChild(root: unknown) {
      this.root = root;
    }
    setFocus() {}
    showOverlay() {
      return { hide() {} };
    }
    start() {
      calls.push("tui.start");
    }
    stop() {
      calls.push("tui.stop");
    }
    requestRender(force?: boolean) {
      calls.push(`render:${String(force)}`);
    }
    async queryTerminalColorScheme(): Promise<"dark" | "light" | undefined> {
      calls.push("scheme");
      return undefined;
    }
    async queryTerminalBackgroundColor(): Promise<
      { r: number; g: number; b: number } | undefined
    > {
      calls.push("background");
      return { r: 245, g: 245, b: 245 };
    }
  }

  const terminal = new FakeTerminal();
  const app = await createViewerApp({
    snapshot,
    ProcessTerminalClass: class {
      constructor() {
        return terminal;
      }
    } as unknown as typeof FakeTerminal,
    TUIClass: FakeTui,
    installSignalHandlers: true,
    lifecycleTarget,
  });
  return {
    app,
    terminal,
    calls,
    writes,
    lifecycleTarget,
    FakeTerminal,
    FakeTui,
  };
};

describe("viewer app terminal ownership", () => {
  it("detects scheme before background and restores modes exactly once", async () => {
    const writes: string[] = [];
    const calls: string[] = [];
    const { app, FakeTerminal, FakeTui } = await createTestApp({
      writes,
      calls,
    });
    assert.equal(calls.indexOf("scheme") < calls.indexOf("background"), true);
    assert.equal(calls.includes("shrink:false"), true);
    await app.close();
    await app.close();

    assert.equal(writes.filter((value) => value.includes("?1049h")).length, 1);
    assert.equal(writes.filter((value) => value.includes("?1049l")).length, 1);
    assert.equal(writes.filter((value) => value.includes("?1000h")).length, 1);
    assert.equal(writes.filter((value) => value.includes("?1000l")).length, 1);
    assert.equal(calls.filter((value) => value === "tui.stop").length, 1);
    assert.equal(calls.includes("clear"), false);

    class RejectingQueriesTui extends FakeTui {
      async queryTerminalColorScheme(): Promise<undefined> {
        calls.push("reject-scheme");
        throw new Error("unsupported");
      }
      async queryTerminalBackgroundColor(): Promise<undefined> {
        calls.push("reject-background");
        throw new Error("unsupported");
      }
    }
    const conservative = await createViewerApp({
      snapshot: snapshotFixture,
      ProcessTerminalClass: FakeTerminal,
      TUIClass: RejectingQueriesTui,
      installSignalHandlers: false,
    });
    assert.equal(conservative.theme.conservative, true);
    assert.equal(calls.includes("reject-background"), true);
    await conservative.close();

    class ThrowingStartTui extends FakeTui {
      start() {
        throw new Error("no TUI");
      }
    }
    const restoresBefore = writes.filter((value) =>
      value.includes("?1049l"),
    ).length;
    await assert.rejects(
      createViewerApp({
        snapshot: snapshotFixture,
        ProcessTerminalClass: FakeTerminal,
        TUIClass: ThrowingStartTui,
        installSignalHandlers: false,
      }),
      /no TUI/,
    );
    assert.equal(
      writes.filter((value) => value.includes("?1049l")).length,
      restoresBefore + 1,
    );
    assert.equal(calls.includes("render:true"), false);
  });

  it("restores post-enter modes on render errors and retries a failed restore", async () => {
    const writes: string[] = [];
    const calls: string[] = [];
    const lifecycleTarget = new EventEmitter();
    const base = await createTestApp({ writes, calls, lifecycleTarget });
    await base.app.close();

    class ThrowingRenderTui extends base.FakeTui {
      requestRender() {
        throw new Error("render failed");
      }
    }
    await assert.rejects(
      createViewerApp({
        snapshot: snapshotFixture,
        ProcessTerminalClass: base.FakeTerminal,
        TUIClass: ThrowingRenderTui,
        lifecycleTarget,
      }),
      /render failed/,
    );
    assert.ok(writes.filter((value) => value.includes("?1049l")).length >= 2);

    let restoreAttempts = 0;
    class RetryTerminal extends base.FakeTerminal {
      write(data: string) {
        if (data.includes("?1049l") && restoreAttempts++ === 0) {
          throw new Error("restore interrupted");
        }
        writes.push(data);
      }
    }
    const retry = await createViewerApp({
      snapshot: snapshotFixture,
      ProcessTerminalClass: RetryTerminal,
      TUIClass: base.FakeTui,
      lifecycleTarget,
    });
    await assert.rejects(retry.close(), /restore interrupted/);
    await retry.close();
    assert.equal(restoreAttempts, 2);
  });

  it("restores on signals and process-exit lifecycle events without double restoration", async () => {
    const writes: string[] = [];
    const lifecycleTarget = new EventEmitter();
    const { app } = await createTestApp({ writes, lifecycleTarget });

    lifecycleTarget.emit("SIGTERM");
    await new Promise((resolve) => setImmediate(resolve));
    lifecycleTarget.emit("exit", 0);
    await app.close();

    assert.equal(writes.filter((value) => value.includes("?1049l")).length, 1);
    assert.equal(lifecycleTarget.listenerCount("SIGINT"), 0);
    assert.equal(lifecycleTarget.listenerCount("SIGTERM"), 0);
    assert.equal(lifecycleTarget.listenerCount("exit"), 0);
  });
});

describe("verbosity key gate", () => {
  it("coalesces held arrows but accepts a direction change immediately", () => {
    const gate = new VerbosityKeyGate({ quietMs: 120 });
    assert.equal(gate.accept(1, 1_000), true);
    assert.equal(gate.accept(1, 1_040), false);
    assert.equal(gate.accept(-1, 1_050), true);
    assert.equal(gate.accept(1, 1_060), true);
    assert.equal(gate.accept(1, 1_180), true);
    assert.equal(gate.accept(1, 1_299), false);
    assert.equal(gate.accept(1, 1_419), true);
  });
});
