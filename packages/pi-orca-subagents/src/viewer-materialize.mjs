/** Pure transcript and prompt materialization across verbosity levels. */

import {
  recordOrNull,
  sanitizeManifestValue,
  sanitizeText,
} from "./viewer-safety.mjs";

export const VERBOSITY_LEVELS = Object.freeze([
  Object.freeze({ id: "compact", narrativeLines: 5, toolLines: 0 }),
  Object.freeze({ id: "readable", narrativeLines: 15, toolLines: 1 }),
  Object.freeze({ id: "detailed", narrativeLines: Infinity, toolLines: 5 }),
  Object.freeze({ id: "full", narrativeLines: Infinity, toolLines: Infinity }),
]);

export const MAX_TRANSCRIPT_ROWS = 10_000;

const MALFORMED_PREVIEW_LINES = 100;
const MALFORMED_PREVIEW_CHARACTERS = 1_000;

function logicalLines(value) {
  if (Array.isArray(value)) {
    return value.flatMap((line) => sanitizeText(line).split("\n"));
  }
  if (value === null || value === undefined) return [];
  return sanitizeText(value).split("\n");
}

export function capLogicalLines(lines, limit) {
  const sourceLines = logicalLines(lines);
  const cap =
    limit === Infinity
      ? Infinity
      : Math.max(0, Number.isFinite(limit) ? Math.floor(limit) : 0);
  if (sourceLines.length <= cap) return sourceLines;

  const hidden = sourceLines.length - cap;
  return [
    ...sourceLines.slice(0, cap),
    `… ${hidden} more lines hidden · → increase verbosity`,
  ];
}

function verbosityLevel(level) {
  return (
    VERBOSITY_LEVELS[Number.isInteger(level) ? level : 1] || VERBOSITY_LEVELS[1]
  );
}

function sourceIsTruncated(value, payload) {
  return (
    value?.sourceTruncated === true ||
    value?.truncated === true ||
    value?.isTruncated === true ||
    payload?.sourceTruncated === true ||
    payload?.truncated === true ||
    payload?.isTruncated === true ||
    payload?.source?.truncated === true
  );
}

function safeJson(value, spacing = 0) {
  try {
    const json = JSON.stringify(sanitizeManifestValue(value), null, spacing);
    return typeof json === "string" ? json : sanitizeText(value);
  } catch {
    return sanitizeText(value);
  }
}

function payloadText(payload) {
  if (typeof payload?.text === "string") return payload.text;
  if (typeof payload?.content === "string") return payload.content;
  if (payload && Object.hasOwn(payload, "summary")) {
    return safeJson(payload.summary, 2);
  }
  return "";
}

function appendSourceTruncation(lines, truncated) {
  return truncated
    ? [...lines, "additional source content unavailable"]
    : lines;
}

function compactArgumentSummary(args) {
  const summary = safeJson(args);
  return summary.length <= 240 ? summary : `${summary.slice(0, 239)}…`;
}

function materializeTool(item, payload, level) {
  const body = [];
  if (Object.hasOwn(payload, "args")) {
    body.push(
      `args: ${
        level.id === "full"
          ? safeJson(payload.args)
          : compactArgumentSummary(payload.args)
      }`,
    );
  }

  const status = sanitizeText(item.status || "unknown") || "unknown";
  body.push(`status: ${status}`);

  const resultLines = logicalLines(payload.result);
  if (status === "failed" && level.toolLines === 0) {
    const fact = resultLines.find((line) => line.length > 0);
    body.push(fact ? `failure: ${fact}` : "failure: failed");
  }
  body.push(...capLogicalLines(resultLines, level.toolLines));

  return {
    header: sanitizeText(item.label || "TOOL"),
    body: appendSourceTruncation(body, sourceIsTruncated(item, payload)),
    footer: [],
  };
}

function safetyBoundMalformedPreview(lines) {
  let remaining = MALFORMED_PREVIEW_CHARACTERS;
  let bounded = false;
  const preview = [];
  for (const line of lines) {
    if (/^… \d+ more lines hidden · → increase verbosity$/u.test(line)) {
      preview.push(line);
      continue;
    }
    if (remaining === 0) {
      bounded = true;
      continue;
    }
    if (line.length > remaining) {
      preview.push(line.slice(0, remaining));
      remaining = 0;
      bounded = true;
      continue;
    }
    preview.push(line);
    remaining -= line.length;
  }
  return { preview, bounded };
}

export function materializeItem(value, level = 1) {
  const item = recordOrNull(value) || {};
  const payload = recordOrNull(item.payload) || {};
  const selected = verbosityLevel(level);
  if (item.kind === "tool") return materializeTool(item, payload, selected);

  const sourceLines = logicalLines(payloadText(payload));
  const malformed =
    item.kind === "unknown" &&
    sanitizeText(item.label).toUpperCase() === "UNPARSED";
  const limit = malformed
    ? Math.min(selected.narrativeLines, MALFORMED_PREVIEW_LINES)
    : selected.narrativeLines;
  let body = capLogicalLines(sourceLines, limit);
  if (malformed) {
    const safetyBound = safetyBoundMalformedPreview(body);
    body = safetyBound.preview;
    if (safetyBound.bounded || sourceLines.length > MALFORMED_PREVIEW_LINES) {
      body.push("malformed source preview bounded");
    }
  }

  return {
    header: sanitizeText(item.label || item.kind || "UNKNOWN"),
    body: appendSourceTruncation(body, sourceIsTruncated(item, payload)),
    footer: [],
  };
}

export function materializePrompts(value, level = 1) {
  if (!Array.isArray(value)) return [];
  const selected = verbosityLevel(level);
  return value.map((entry) => {
    const prompt = recordOrNull(entry) || {};
    const body = appendSourceTruncation(
      capLogicalLines(logicalLines(prompt.text), selected.narrativeLines),
      sourceIsTruncated(prompt, prompt),
    );
    const footer = [];
    if (prompt.source !== null && prompt.source !== undefined) {
      footer.push(`source: ${sanitizeText(prompt.source)}`);
    }
    if (prompt.provenance !== null && prompt.provenance !== undefined) {
      footer.push(`provenance: ${sanitizeText(prompt.provenance)}`);
    }
    return {
      header: sanitizeText(prompt.title || prompt.kind || "PROMPT"),
      body,
      footer,
    };
  });
}
