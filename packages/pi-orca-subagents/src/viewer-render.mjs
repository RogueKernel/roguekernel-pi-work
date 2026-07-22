import {
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
  MAX_TRANSCRIPT_ROWS,
  materializeItem,
  materializePrompts,
  sanitizeText,
} from "./viewer-model.mjs";
import { createTheme } from "./viewer-theme.mjs";

export function positiveDimension(value, fallback = 1) {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : fallback;
}

function singleLine(value, fallback = "") {
  const clean = sanitizeText(value).replace(/\n+/gu, " ").trim();
  return clean || fallback;
}

function boundedLine(value, width) {
  const truncated = truncateToWidth(value, width, "");
  return value.includes("\x1b")
    ? truncated
    : truncated.replace(/\x1b\[0m$/u, "");
}

export function paddedLine(value, width) {
  const safeWidth = positiveDimension(width);
  const truncated = boundedLine(value, safeWidth);
  return `${truncated}${" ".repeat(Math.max(0, safeWidth - visibleWidth(truncated)))}`;
}

function surfaceLine(
  value,
  width,
  theme,
  color = theme.foreground,
  background = theme.surface,
) {
  return theme.bg(paddedLine(theme.fg(value, color), width), background);
}

function canonicalModel(snapshot) {
  const provider = singleLine(
    snapshot?.metrics?.provider ?? snapshot?.manifest?.runtime?.provider,
  );
  const model = singleLine(
    snapshot?.metrics?.model ?? snapshot?.manifest?.runtime?.model,
  );
  return provider && model ? `${provider}/${model}` : model || provider || null;
}

function formatClock(timestamp) {
  if (!Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function formatDuration(startedAt, endedAt) {
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt)) return null;
  const milliseconds = Math.max(0, endedAt - startedAt);
  if (milliseconds < 1_000) return `${Math.round(milliseconds)}ms`;
  const seconds = Math.round(milliseconds / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

function displayLine(value) {
  return sanitizeText(value).replace(/\n/gu, "");
}

function wrapForeground(line, width, theme) {
  const safeLine = displayLine(line);
  const wrapped = wrapTextWithAnsi(
    theme.fg(safeLine, theme.foreground),
    positiveDimension(width),
  );
  return wrapped.length > 0 ? wrapped : [""];
}

function promptDivider(title, provenance, width, theme, task = false) {
  const details = singleLine(provenance);
  const rawTitle = singleLine(title, "PROMPT").toUpperCase();
  const displayTitle =
    task && rawTitle === "TASK" ? "TASK / USER PROMPT" : rawTitle;
  const heading = `${displayTitle}${details ? ` · ${details}` : ""}`;
  const lead = task ? `◆  ${heading} ` : `─  ${heading} `;
  const rule = task ? "━" : "─";
  return surfaceLine(
    `${lead}${rule.repeat(Math.max(0, positiveDimension(width) - visibleWidth(lead)))}`,
    width,
    theme,
    task ? theme.eventColor("task") : theme.prompt,
  );
}

export function renderPromptLines(
  prompts,
  { width = 80, level = 1, theme = createTheme("dark") } = {},
) {
  const safeWidth = positiveDimension(width);
  const records = Array.isArray(prompts) ? prompts : [];
  const transcripts = materializePrompts(records, level);
  const rows = [];
  transcripts.forEach((transcript, index) => {
    const prompt = records[index] || {};
    const task = prompt.kind === "task";
    const accent = theme.eventColor("task");
    rows.push(
      promptDivider(
        transcript.header,
        prompt.provenance,
        safeWidth,
        theme,
        task,
      ),
    );
    for (const line of transcript.body) {
      const inset = task ? 3 : 2;
      for (const wrapped of wrapForeground(
        line,
        Math.max(1, safeWidth - inset),
        theme,
      )) {
        const prefix = task ? `${theme.fg("┃", accent)}  ` : "  ";
        rows.push(surfaceLine(`${prefix}${wrapped}`, safeWidth, theme));
      }
    }
    for (const line of transcript.footer) {
      const safeLine = singleLine(line);
      if (!safeLine.startsWith("provenance:")) {
        const prefix = task ? `${theme.fg("╰─", accent)} ` : "  ";
        rows.push(
          surfaceLine(`${prefix}${safeLine}`, safeWidth, theme, theme.muted),
        );
      }
    }
    if (index < transcripts.length - 1)
      rows.push(surfaceLine("", safeWidth, theme));
  });
  return rows;
}

function renderMasthead(snapshot, width, theme) {
  const child = snapshot?.manifest?.child || {};
  const agent = singleLine(child.agent, "SUBAGENT").toUpperCase();
  const model = canonicalModel(snapshot);
  const identity = [];
  if (child.tagline) identity.push(singleLine(child.tagline));
  if (child.agentFile) identity.push(singleLine(child.agentFile));
  if (Number.isSafeInteger(child.index) && child.index >= 0)
    identity.push(`child ${child.index + 1}`);
  if (child.runId) identity.push(`run ${singleLine(child.runId)}`);
  const runtime = [];
  if (model) runtime.push(model);
  if (snapshot?.manifest?.launch?.promptMode) {
    runtime.push(
      `prompt mode: ${singleLine(snapshot.manifest.launch.promptMode)}`,
    );
  }
  const background = theme.headerSurface ?? theme.surface;
  const rows = [theme.fg("━".repeat(width), theme.structural)];
  rows.push(
    surfaceLine(
      `  ${theme.fg("◆", theme.structural)} ${theme.bold(agent)}`,
      width,
      theme,
      theme.foreground,
      background,
    ),
  );
  if (identity.length > 0) {
    rows.push(
      surfaceLine(
        `  ${identity.join("  ·  ")}`,
        width,
        theme,
        theme.muted,
        background,
      ),
    );
  }
  if (runtime.length > 0) {
    rows.push(
      surfaceLine(
        `  ${runtime.join(" · ")}`,
        width,
        theme,
        theme.prompt,
        background,
      ),
    );
  }
  rows.push(theme.fg("━".repeat(width), theme.structural), "");
  return rows;
}

function compactValue(value) {
  if (typeof value === "string") return singleLine(value);
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  return "";
}

function compactSequence(value, separator = " ") {
  if (!Array.isArray(value)) return "";
  return value.map(compactValue).filter(Boolean).join(separator);
}

function compactList(value) {
  if (!Array.isArray(value)) return "";
  const entries = value.map(compactValue).filter(Boolean);
  if (entries.length === 0) return "";
  return `${entries[0]}${entries.length > 1 ? ` (+${entries.length - 1})` : ""}`;
}

function argumentDetail(args, label) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return "";
  const tool = singleLine(label).toLowerCase();
  if (["find", "grep"].includes(tool)) {
    const pattern = compactValue(args.pattern);
    const path = compactValue(args.path);
    if (pattern && path) return `${pattern} in ${path}`;
    if (pattern) return pattern;
  }
  if (tool === "read") {
    const path = compactValue(args.path);
    if (
      path &&
      Number.isInteger(args.offset) &&
      Number.isInteger(args.limit) &&
      args.limit > 0
    ) {
      return `${path} ${args.offset}–${args.offset + args.limit - 1}`;
    }
  }
  const command = compactSequence(args.args);
  if (command) return command;
  for (const key of ["path", "file", "query", "pattern", "command", "url"]) {
    const value = compactValue(args[key]);
    if (value) return value;
  }
  for (const key of ["paths", "queries", "urls"]) {
    const value = compactList(args[key]);
    if (value) return value;
  }
  for (const key of ["action", "reason", "mode", "cell_id", "code"]) {
    const value = compactValue(args[key]);
    if (value) return value;
  }
  const steps = compactSequence(
    Array.isArray(args.job?.steps)
      ? args.job.steps.map((step) => step?.action)
      : null,
    " → ",
  );
  if (steps) return `job: ${steps}`;
  return "";
}

function timelineDetail(item) {
  if (item?.kind === "tool")
    return argumentDetail(item?.payload?.args, item?.label);
  if (item?.label === "SESSION")
    return singleLine(item?.payload?.canonicalModel);
  const summary = item?.payload?.summary;
  if (!summary || typeof summary !== "object") return "";
  const identity = ["extension", "event"]
    .map((key) => compactValue(summary[key]))
    .filter(Boolean);
  if (identity.length > 0) return identity.join(" · ");
  for (const key of ["errorMessage", "message", "reason"]) {
    const value = compactValue(summary[key]);
    if (value) return value;
  }
  return "";
}

function timelineHeader(item, observedAt, theme) {
  const label = singleLine(item?.label || item?.kind, "UNKNOWN").toUpperCase();
  const eventKind = label.toLowerCase();
  const clock = formatClock(item?.startedAt);
  let endedAt = item?.endedAt ?? null;
  if (endedAt === null && item?.status === "active") endedAt = observedAt;
  const duration = formatDuration(item?.startedAt, endedAt);
  let compact = "";
  if (clock) {
    compact = ` [${clock}${duration ? ` @ ${duration}` : ""}]`;
  }
  const detail = timelineDetail(item);
  const detailText = detail ? `  ${theme.bold(detail)}` : "";
  return `${theme.bold(theme.fg(label, theme.eventColor(eventKind)))}${theme.fg(compact, theme.muted)}${detailText}`;
}

function conciseUnknownBody(item) {
  const summary = item?.payload?.summary;
  if (!summary || typeof summary !== "object") return [];
  const omitted = new Set([
    "type",
    "timestamp",
    "extension",
    "event",
    "payload",
  ]);
  return Object.keys(summary)
    .filter((key) => !omitted.has(key))
    .map((key) => {
      const value = compactValue(summary[key]);
      return value ? `${key}: ${value}` : "";
    })
    .filter(Boolean);
}

function readableBytes(value) {
  if (!Number.isFinite(value) || value < 0) return "";
  if (value < 1_000) return `${value}B`;
  return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}kB`;
}

function toolResultSummary(item, status, hidden) {
  const hiddenSuffix = hidden
    ? ` · ${hidden} hidden · → increase verbosity`
    : "";
  if (status === "failed") return `✗ failed${hiddenSuffix}`;
  if (status === "active") return "◉ active · waiting for result";
  const result = sanitizeText(item?.payload?.result);
  if (!result) return `✓ ${status}${hiddenSuffix}`;
  const lines = result.split("\n").length;
  const bytes = new TextEncoder().encode(result).length;
  return `✓ ${lines} ${lines === 1 ? "line" : "lines"} · ${readableBytes(bytes)}${hiddenSuffix}`;
}

function timelineBody(item, transcript, level) {
  if (item?.kind === "lifecycle") return [];
  if (item?.kind === "unknown" && level < 3) {
    return conciseUnknownBody(item);
  }
  if (item?.kind !== "tool") return [...transcript.body, ...transcript.footer];

  const status = singleLine(item?.status, "unknown");
  const rows = [...transcript.body, ...transcript.footer];
  const statusAt = rows.findIndex((line) => line.startsWith("status:"));
  let body = rows.filter((_, index) => index !== statusAt);
  if (level < 2) body = body.filter((line) => !line.startsWith("args:"));
  let hidden = 0;
  body = body.filter((line) => {
    const match = line.match(
      /^… (\d+) more lines hidden · → increase verbosity$/u,
    );
    if (!match) return true;
    hidden = Number(match[1]);
    return false;
  });
  body.push(toolResultSummary(item, status, hidden));
  return body;
}

function timelineRows(lines, width, theme) {
  const rows = [];
  for (const line of lines) {
    rows.push(...wrapForeground(line, Math.max(1, width - 2), theme));
  }
  return rows.map((line, index) => {
    const branch = index === rows.length - 1 ? "╰─" : "│";
    return `${theme.fg(branch, theme.muted)} ${line}`;
  });
}

const HIDDEN_LIFECYCLE_LABELS = new Set(["TURN START", "TURN END"]);

function appendRenderedTimeline(
  layout,
  item,
  index,
  width,
  level,
  observedAt,
  theme,
) {
  const label = singleLine(item?.label || item?.kind, "UNKNOWN").toUpperCase();
  if (item?.kind === "tool-call") return;
  if (item?.kind === "lifecycle" && HIDDEN_LIFECYCLE_LABELS.has(label)) return;

  const transcript = materializeItem(item, level);
  const body = timelineBody(item, transcript, level);
  if (
    ["assistant", "thinking", "user"].includes(item?.kind) &&
    !body.some((line) => singleLine(line))
  ) {
    return;
  }

  const start = layout.lines.length;
  layout.lines.push(timelineHeader(item, observedAt, theme));
  layout.lines.push(...timelineRows(body, width, theme));
  layout.ranges.push({
    id: singleLine(item?.id, `timeline-${index}`),
    start,
    end: layout.lines.length - 1,
  });
  layout.lines.push("");
}

function omissionText(omittedLogicalLines, wrappedOnly) {
  if (omittedLogicalLines > 0) {
    return `… ${omittedLogicalLines.toLocaleString("en-US")} earlier logical lines omitted`;
  }
  return wrappedOnly ? "… earlier wrapped transcript rows omitted" : null;
}

function renderTimelineTail(items, options) {
  const selected = [];
  let used = 0;
  let wrappedOnly = false;

  for (let index = items.length - 1; index >= 0; index -= 1) {
    const itemLayout = { lines: [], ranges: [] };
    appendRenderedTimeline(
      itemLayout,
      items[index],
      index,
      options.width,
      options.level,
      options.observedAt,
      options.theme,
    );
    if (used + itemLayout.lines.length > options.maxRows) {
      const remaining = Math.max(0, options.maxRows - used);
      if (remaining > 0) {
        itemLayout.lines = itemLayout.lines.slice(-remaining);
        itemLayout.ranges = [];
        selected.unshift(itemLayout);
        used += itemLayout.lines.length;
      }
      wrappedOnly = true;
      break;
    }
    selected.unshift(itemLayout);
    used += itemLayout.lines.length;
    if (used >= options.maxRows) {
      wrappedOnly ||= index > 0;
      break;
    }
  }

  const marker = omissionText(options.omittedLogicalLines, wrappedOnly);
  if (marker && used >= options.maxRows) {
    const first = selected.find((itemLayout) => itemLayout.lines.length > 0);
    if (first) {
      first.lines.shift();
      first.ranges = [];
      used -= 1;
    }
  }

  return { selected, marker, used };
}

export function renderViewerLayout(
  snapshot,
  {
    width = 80,
    height: _height = 24,
    level = 1,
    theme = createTheme("dark"),
    maxTranscriptRows = MAX_TRANSCRIPT_ROWS,
  } = {},
) {
  const safeWidth = positiveDimension(width);
  const safeMaxTranscriptRows = positiveDimension(
    maxTranscriptRows,
    MAX_TRANSCRIPT_ROWS,
  );
  const layout = {
    lines: renderMasthead(snapshot, safeWidth, theme),
    ranges: [],
  };
  if (Array.isArray(snapshot?.prompts) && snapshot.prompts.length > 0) {
    layout.lines.push(
      ...renderPromptLines(snapshot.prompts, {
        width: safeWidth,
        level,
        theme,
      }),
    );
  }
  const boundary = "═".repeat(safeWidth);
  layout.lines.push(
    theme.fg(boundary, theme.prompt),
    theme.fg(boundary, theme.prompt),
  );
  const items = Array.isArray(snapshot?.items) ? snapshot.items : [];
  const timeline = renderTimelineTail(items, {
    width: safeWidth,
    level,
    observedAt: snapshot?.observedAt,
    theme,
    maxRows: safeMaxTranscriptRows,
    omittedLogicalLines: snapshot?.omittedLogicalLines,
  });
  let markerIndex = -1;
  if (timeline.marker) {
    markerIndex = layout.lines.length;
    layout.lines.push(theme.fg(timeline.marker, theme.muted));
  }
  for (const itemLayout of timeline.selected) {
    const offset = layout.lines.length;
    layout.lines.push(...itemLayout.lines);
    layout.ranges.push(
      ...itemLayout.ranges.map((range) => ({
        ...range,
        start: range.start + offset,
        end: range.end + offset,
      })),
    );
  }
  layout.lines = layout.lines.map((line, index) =>
    index === markerIndex ? line : boundedLine(line, safeWidth),
  );
  return layout;
}

export function renderViewerLines(snapshot, options = {}) {
  return renderViewerLayout(snapshot, options).lines;
}

const METRIC_BOXES = Object.freeze({
  agent: 34,
  context: 22,
  elapsed: 10,
  model: 31,
  tokens: 10,
  cost: 9,
});
const MEDIUM_FOOTER_MIN_WIDTH =
  "AGENT ".length +
  METRIC_BOXES.agent +
  " · ".length +
  "CONTEXT ".length +
  METRIC_BOXES.context +
  " · ".length +
  "ELAPSED ".length +
  METRIC_BOXES.elapsed;
const metricBoxWidth = (inner) => inner + 2;

export const wideFooterMinWidth = () =>
  Object.values(METRIC_BOXES).reduce(
    (total, inner) => total + metricBoxWidth(inner),
    0,
  ) +
  4 +
  2;

function footerWidth(width) {
  return Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 80;
}

export function footerMode(width) {
  const safeWidth = footerWidth(width);
  if (safeWidth >= wideFooterMinWidth()) return "wide";
  return safeWidth >= MEDIUM_FOOTER_MIN_WIDTH ? "medium" : "narrow";
}

export function footerRows(width) {
  const mode = footerMode(width);
  if (mode === "wide") return 5;
  if (mode === "medium") return 4;
  return 7;
}

function compactNumber(value) {
  if (!Number.isFinite(value) || value < 0) return "unavailable";
  if (value < 1_000) return String(Math.round(value));
  const scaled = value / 1_000;
  const digits = scaled >= 100 || Number.isInteger(scaled) ? 0 : 1;
  return `${scaled.toFixed(digits).replace(/\.0$/u, "")}k`;
}

function friendlyElapsed(value) {
  if (!Number.isFinite(value) || value < 0) return "unavailable";
  const seconds = Math.floor(value / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const trailingSeconds = seconds % 60;
  if (minutes < 60) {
    return trailingSeconds ? `${minutes}m ${trailingSeconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const trailingMinutes = minutes % 60;
  return trailingMinutes ? `${hours}h ${trailingMinutes}m` : `${hours}h`;
}

function metricCount(value) {
  return Number.isFinite(value) && value >= 0
    ? String(Math.floor(value))
    : "unavailable";
}

function footerFacts(snapshot, level) {
  const metrics = snapshot?.metrics || {};
  const child = snapshot?.manifest?.child || {};
  const agent = singleLine(child.agent);
  const tagline = singleLine(child.tagline);
  const contextUsed = metrics.contextUsed;
  const contextLimit = metrics.contextLimit;
  const context =
    Number.isFinite(contextUsed) &&
    contextUsed >= 0 &&
    Number.isFinite(contextLimit) &&
    contextLimit > 0
      ? `${Math.round((contextUsed / contextLimit) * 100)}% (${compactNumber(contextUsed)}/${compactNumber(contextLimit)})`
      : "unavailable";
  const model = canonicalModel(snapshot) || "unavailable";
  const requestedLevel = Number.isInteger(level) ? level : 1;
  const selectedLevel = Math.min(3, Math.max(0, requestedLevel));
  let agentLabel = "unavailable";
  if (agent) {
    agentLabel = agent.toUpperCase();
    if (tagline) agentLabel += ` · ${tagline}`;
  }

  return {
    agent: agentLabel,
    context,
    elapsed: friendlyElapsed(metrics.elapsedMs),
    model,
    tokens: compactNumber(metrics.tokens),
    cost:
      Number.isFinite(metrics.cost) && metrics.cost >= 0
        ? `$${metrics.cost.toFixed(3)}`
        : "unavailable",
    tools: metricCount(metrics.tools),
    failed: metricCount(metrics.failed),
    retries: metricCount(metrics.retries),
    active: metricCount(metrics.active),
    selectedLevel,
  };
}

function dockLine(value, width, theme) {
  const safeWidth = footerWidth(width);
  return theme.bg(paddedLine(value, safeWidth), theme.dock);
}

function metricDefinitions(facts, theme) {
  return [
    ["AGENT", facts.agent, METRIC_BOXES.agent, theme.foreground, true],
    ["MODEL", facts.model, METRIC_BOXES.model, theme.structural],
    ["CONTEXT", facts.context, METRIC_BOXES.context, theme.prompt],
    ["ELAPSED", facts.elapsed, METRIC_BOXES.elapsed, theme.foreground],
    ["TOKENS", facts.tokens, METRIC_BOXES.tokens, theme.foreground],
    ["COST", facts.cost, METRIC_BOXES.cost, theme.success],
  ];
}

function joinedMetricWidths(definitions, width) {
  const widths = definitions.map((definition) => definition[2]);
  let extra = Math.max(
    0,
    footerWidth(width) -
      2 -
      (definitions.length - 1) -
      widths.reduce((total, value) => total + value, 0),
  );
  const expansionOrder = [1, 0];
  let cursor = 0;
  while (extra > 0) {
    widths[expansionOrder[cursor % expansionOrder.length]] += 1;
    cursor += 1;
    extra -= 1;
  }
  return widths;
}

function metricHeading(label, inner, theme) {
  const prefix = `─ ${label} `;
  return theme.fg(
    `${prefix}${"─".repeat(Math.max(0, inner - visibleWidth(prefix)))}`,
    theme.muted,
  );
}

function metricValue(value, inner, color, theme, bold = false) {
  const plain = paddedLine(singleLine(value, "unavailable"), inner - 2);
  return ` ${theme.fg(bold ? theme.bold(plain) : plain, color)} `;
}

function statusCounts(facts, theme) {
  return [
    theme.fg(`${facts.tools} tools`, theme.prompt),
    theme.fg(
      `${facts.failed} failed`,
      facts.failed === "0" ? theme.success : theme.failure,
    ),
    theme.fg(
      `${facts.retries} retries`,
      facts.retries === "0" ? theme.success : theme.eventColor("task"),
    ),
    theme.fg(
      `${facts.active} active`,
      facts.active === "0" ? theme.success : theme.eventColor("task"),
    ),
  ].join(` ${theme.fg("·", theme.muted)} `);
}

function levelRail(facts, theme) {
  const value = theme.bold(
    theme.fg(`${facts.selectedLevel + 1}/4`, theme.eventColor("task")),
  );
  return `${theme.fg("VERBOSITY:", theme.muted)} ${value}  ${theme.fg("← / →", theme.eventColor("task"))}`;
}

function metricField(label, value, color, theme, bold = false) {
  const clean = singleLine(value, "unavailable");
  return `${theme.fg(label, theme.muted)} ${theme.fg(bold ? theme.bold(clean) : clean, color)}`;
}

function wideFooter(facts, width, theme) {
  const definitions = metricDefinitions(facts, theme);
  const widths = joinedMetricWidths(definitions, width);
  const headings = definitions.map(([label], index) =>
    metricHeading(label, widths[index], theme),
  );
  const values = definitions.map(([, value, , color, bold], index) =>
    metricValue(value, widths[index], color, theme, bold),
  );
  const top = `${theme.fg("╭", theme.muted)}${headings.join(theme.fg("┬", theme.muted))}${theme.fg("╮", theme.muted)}`;
  const middle = `${theme.fg("│", theme.muted)}${values.join(theme.fg("│", theme.muted))}${theme.fg("│", theme.muted)}`;
  const bottom = `${theme.fg("╰", theme.muted)}${widths
    .map((inner) => theme.fg("─".repeat(inner), theme.muted))
    .join(theme.fg("┴", theme.muted))}${theme.fg("╯", theme.muted)}`;
  const counts = statusCounts(facts, theme);
  const levels = levelRail(facts, theme);
  const railGap = " ".repeat(
    Math.max(
      2,
      footerWidth(width) - visibleWidth(counts) - visibleWidth(levels),
    ),
  );
  return [
    dockLine(
      theme.fg("─".repeat(footerWidth(width)), theme.prompt),
      width,
      theme,
    ),
    dockLine(top, width, theme),
    dockLine(middle, width, theme),
    dockLine(bottom, width, theme),
    dockLine(`${counts}${railGap}${levels}`, width, theme),
  ];
}

function mediumFooter(facts, width, theme) {
  const separator = ` ${theme.fg("·", theme.muted)} `;
  return [
    theme.fg("─".repeat(footerWidth(width)), theme.prompt),
    [
      metricField("AGENT", facts.agent, theme.foreground, theme, true),
      metricField("CONTEXT", facts.context, theme.prompt, theme),
      metricField("ELAPSED", facts.elapsed, theme.foreground, theme),
    ].join(separator),
    [
      metricField("MODEL", facts.model, theme.structural, theme),
      metricField("TOKENS", facts.tokens, theme.foreground, theme),
      metricField("COST", facts.cost, theme.success, theme),
    ].join(separator),
    `${statusCounts(facts, theme)}${separator}${levelRail(facts, theme)}`,
  ].map((line) => dockLine(line, width, theme));
}

function narrowFooter(facts, width, theme) {
  const separator = ` ${theme.fg("·", theme.muted)} `;
  return [
    theme.fg("─".repeat(footerWidth(width)), theme.prompt),
    metricField("AGENT", facts.agent, theme.foreground, theme, true),
    [
      metricField("CONTEXT", facts.context, theme.prompt, theme),
      metricField("ELAPSED", facts.elapsed, theme.foreground, theme),
    ].join(separator),
    metricField("MODEL", facts.model, theme.structural, theme),
    [
      metricField("TOKENS", facts.tokens, theme.foreground, theme),
      metricField("COST", facts.cost, theme.success, theme),
    ].join(separator),
    statusCounts(facts, theme),
    `${levelRail(facts, theme)}${separator}${theme.fg("P prompts · Q close", theme.muted)}`,
  ].map((line) => dockLine(line, width, theme));
}

export function renderFooter(
  snapshot,
  { width = 80, theme = createTheme("dark"), level = 1 } = {},
) {
  const safeWidth = footerWidth(width);
  const facts = footerFacts(snapshot, level);
  const mode = footerMode(safeWidth);
  if (mode === "wide") return wideFooter(facts, safeWidth, theme);
  if (mode === "medium") return mediumFooter(facts, safeWidth, theme);
  return narrowFooter(facts, safeWidth, theme);
}
