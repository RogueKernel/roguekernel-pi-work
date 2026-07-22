/** Pi JSONL event reduction into stable viewer snapshots. */

import {
  boundSourceText,
  defineSafeProperty,
  normalizeManifest,
  nullableText,
  sanitizeManifestValue,
  sanitizeText,
} from "./viewer-safety.mjs";
import { TranscriptRetention } from "./viewer-retention.mjs";

export { normalizeManifest, sanitizeText } from "./viewer-safety.mjs";
export {
  capLogicalLines,
  MAX_TRANSCRIPT_ROWS,
  materializeItem,
  materializePrompts,
  VERBOSITY_LEVELS,
} from "./viewer-materialize.mjs";

function normalizeSource(value) {
  const source = sanitizeText(value);
  return source || "stdout";
}

function summarizeValue(value) {
  if (Array.isArray(value)) return `array(${value.length})`;
  if (value && typeof value === "object") {
    const count = Object.keys(value).length;
    return `object(${count} ${count === 1 ? "key" : "keys"})`;
  }
  if (typeof value === "string") return sanitizeText(value);
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return value;
  }
  return sanitizeText(value);
}

function summarizeUnknown(event) {
  const summary = {};
  for (const key of Object.keys(event).sort()) {
    let value;
    try {
      value = event[key];
    } catch {
      value = "unavailable";
    }
    defineSafeProperty(summary, sanitizeText(key), summarizeValue(value));
  }
  return summary;
}

function isValidTimestamp(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function normalizeTimestamp(receivedAt, now) {
  if (isValidTimestamp(receivedAt)) return receivedAt;

  let fallback;
  try {
    fallback = now();
  } catch {
    fallback = 0;
  }
  return isValidTimestamp(fallback) ? fallback : 0;
}

function contextUsedFromMessage(message) {
  const value = message?.usage?.totalTokens;
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function canonicalModel(provider, model) {
  return provider && model ? `${provider}/${model}` : model || provider || null;
}

function statusFromToolEnd(event) {
  return event.isError === true ? "failed" : "succeeded";
}

function finalizedStreamId(protocolId, stream) {
  if (!protocolId) return null;
  return stream === "text" ? protocolId : `${protocolId}:${stream}`;
}

function nonnegativeNumber(value) {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function recordText(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  if (typeof value.text === "string") return sanitizeText(value.text);
  if (!Array.isArray(value.content)) return "";
  return value.content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      if (typeof part.text === "string") return sanitizeText(part.text);
      if (typeof part.content === "string") return sanitizeText(part.content);
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function messageContent(message) {
  const streams = new Map();
  if (
    !message ||
    typeof message !== "object" ||
    !Array.isArray(message.content)
  ) {
    return streams;
  }

  for (const part of message.content) {
    if (!part || typeof part !== "object") continue;
    const type = sanitizeText(part.type).toLowerCase();
    const stream =
      type === "reasoning"
        ? "reasoning"
        : type === "thinking"
          ? "thinking"
          : type === "toolcall" || type === "tool_call"
            ? "toolcall"
            : type === "text"
              ? "text"
              : null;
    if (!stream) continue;
    const text =
      typeof part.text === "string"
        ? part.text
        : typeof part.content === "string"
          ? part.content
          : "";
    streams.set(stream, `${streams.get(stream) || ""}${sanitizeText(text)}`);
  }
  return streams;
}

const lifecycleLabels = new Map([
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
]);

const messageStreams = new Map([
  ["thinking_start", ["thinking", "THINKING"]],
  ["thinking_delta", ["thinking", "THINKING"]],
  ["thinking_end", ["thinking", "THINKING"]],
  ["reasoning_start", ["reasoning", "REASONING"]],
  ["reasoning_delta", ["reasoning", "REASONING"]],
  ["reasoning_end", ["reasoning", "REASONING"]],
  ["text_start", ["text", "ASSISTANT"]],
  ["text_delta", ["text", "ASSISTANT"]],
  ["text_end", ["text", "ASSISTANT"]],
  ["toolcall_start", ["toolcall", "TOOL CALL"]],
  ["toolcall_delta", ["toolcall", "TOOL CALL"]],
  ["toolcall_end", ["toolcall", "TOOL CALL"]],
]);

export class ViewerModel {
  constructor({ manifest = {}, now = Date.now, maxTranscriptLines } = {}) {
    this.manifest = normalizeManifest(manifest);
    this.now = now;
    this.items = [];
    this.retention = new TranscriptRetention(maxTranscriptLines);
    this.sequence = 0;
    this.activeMessages = new Map();
    this.toolItems = new Map();
    this.finalizedMessageIds = new Set();
    this.finalizedToolIds = new Set();
    this.totalTools = 0;
    this.failedTools = 0;
    this.activeTools = 0;
    this.totalTokens = 0;
    this.totalCost = 0;
    this.provider = nullableText(this.manifest.runtime.provider);
    this.model = nullableText(this.manifest.runtime.model);
    this.agentStartedAt = null;
    this.agentEndedAt = null;
    this.retries = 0;
    this.contextUsed = null;
  }

  ingestLine(line, { source = "stdout", receivedAt = this.now() } = {}) {
    const normalizedSource = normalizeSource(source);
    if (normalizedSource === "stderr") {
      this.#append(
        "stderr",
        "STDERR",
        {
          text: boundSourceText(line),
          source: normalizedSource,
        },
        receivedAt,
      );
      return;
    }

    let event;
    try {
      event = JSON.parse(line);
    } catch {
      this.#append(
        "unknown",
        "UNPARSED",
        {
          text: boundSourceText(line),
          source: normalizedSource,
        },
        receivedAt,
      );
      return;
    }
    this.ingestEvent(event, { receivedAt });
  }

  ingestEvent(event, { receivedAt = this.now() } = {}) {
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      this.#append(
        "unknown",
        "UNKNOWN",
        { summary: { value: summarizeValue(event) } },
        receivedAt,
      );
      return;
    }

    const type = sanitizeText(event.type || "unknown").toLowerCase();
    if (type === "session") {
      this.#reduceSession(event, receivedAt);
    } else if (lifecycleLabels.has(type)) {
      this.#reduceLifecycle(type, event, receivedAt);
    } else if (type === "message_start") {
      this.#reduceMessageStart(event, receivedAt);
    } else if (type === "message_update") {
      this.#reduceMessageUpdate(event, receivedAt);
    } else if (type === "message_end") {
      this.#reduceMessageEnd(event, receivedAt);
    } else if (type === "tool_execution_start") {
      this.#reduceToolStart(event, receivedAt);
    } else if (type === "tool_execution_update") {
      this.#reduceToolUpdate(event, receivedAt);
    } else if (type === "tool_execution_end") {
      this.#reduceToolEnd(event, receivedAt);
    } else {
      this.#append(
        "unknown",
        sanitizeText(event.type || "unknown").toUpperCase(),
        { summary: summarizeUnknown(event) },
        receivedAt,
      );
    }
  }

  snapshot(now = this.now()) {
    const observedAt = normalizeTimestamp(now, this.now);
    const end = this.agentEndedAt ?? observedAt;
    const elapsedMs =
      this.agentStartedAt === null ? 0 : Math.max(0, end - this.agentStartedAt);

    return {
      observedAt,
      manifest: structuredClone(this.manifest),
      prompts: structuredClone(this.manifest.prompts),
      items: structuredClone(this.items),
      omittedLogicalLines: this.retention.omittedLogicalLines,
      metrics: {
        tools: this.totalTools,
        failed: this.failedTools,
        retries: this.retries,
        active: this.activeTools,
        tokens: this.totalTokens,
        cost: this.totalCost,
        elapsedMs,
        provider: this.provider,
        model: this.model,
        contextUsed: this.contextUsed,
        contextLimit:
          Number.isFinite(this.manifest.runtime.contextWindow) &&
          this.manifest.runtime.contextWindow >= 0
            ? this.manifest.runtime.contextWindow
            : null,
      },
    };
  }

  #reduceSession(event, receivedAt) {
    this.provider = nullableText(event.provider) ?? this.provider;
    this.model = nullableText(event.model) ?? this.model;
    this.#append(
      "lifecycle",
      "SESSION",
      {
        provider: this.provider,
        model: this.model,
        canonicalModel: canonicalModel(this.provider, this.model),
      },
      receivedAt,
    );
  }

  #reduceLifecycle(type, event, receivedAt) {
    const timestamp = normalizeTimestamp(event.timestamp, () =>
      normalizeTimestamp(receivedAt, this.now),
    );
    if (type === "agent_start") {
      this.agentStartedAt = timestamp;
      this.agentEndedAt = null;
    } else if (type === "agent_end" || type === "agent_settled") {
      this.agentEndedAt = timestamp;
    } else if (type === "auto_retry_start") {
      this.retries += 1;
    }

    const failed = type === "extension_error";
    const settled = type === "agent_settled";
    const active = type.endsWith("_start");
    this.#append(
      "lifecycle",
      lifecycleLabels.get(type),
      { summary: summarizeUnknown(event) },
      timestamp,
      {
        status: failed
          ? "failed"
          : settled
            ? "settled"
            : active
              ? "active"
              : "succeeded",
      },
    );
  }

  #reduceMessageStart(event, receivedAt) {
    const message = event.message;
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      this.#protocolWarning("MESSAGE START", event, receivedAt);
      return;
    }
    const role = sanitizeText(message.role || "assistant").toLowerCase();
    const rolePrefix = `${role}:`;
    if ([...this.activeMessages.keys()].some((key) => key.startsWith(rolePrefix))) {
      const timestamp = normalizeTimestamp(receivedAt, this.now);
      for (const [key, item] of this.activeMessages) {
        if (!key.startsWith(rolePrefix)) continue;
        item.status = "failed";
        item.endedAt = timestamp;
        item.payload.streamStatus = "ended";
        this.activeMessages.delete(key);
        this.#completeItem(item);
      }
      this.#protocolWarning("MESSAGE START", event, receivedAt);
    }
    const streams = messageContent(message);
    if (streams.size === 0) {
      this.#messageItem(role, "text", receivedAt, nullableText(message.id));
      return;
    }
    for (const [stream, text] of streams) {
      const item = this.#messageItem(
        role,
        stream,
        receivedAt,
        nullableText(message.id),
      );
      item.payload.content = text;
    }
  }

  #reduceMessageUpdate(event, receivedAt) {
    const update = event.assistantMessageEvent;
    if (!update || typeof update !== "object" || Array.isArray(update)) {
      this.#protocolWarning("MESSAGE UPDATE", event, receivedAt);
      return;
    }
    const updateType = sanitizeText(update.type).toLowerCase();
    const streamDetails = messageStreams.get(updateType);
    if (!streamDetails) {
      this.#protocolWarning("MESSAGE UPDATE", event, receivedAt);
      return;
    }

    const [stream] = streamDetails;
    if (updateType.endsWith("_delta") && typeof update.delta !== "string") {
      this.#protocolWarning("MESSAGE UPDATE", event, receivedAt);
      return;
    }
    const protocolId = nullableText(update.partial?.id);
    const item = this.#messageItem("assistant", stream, receivedAt, protocolId);
    if (updateType.endsWith("_delta")) {
      item.payload.content += sanitizeText(update.delta);
    }
    item.payload.streamStatus = updateType.endsWith("_end")
      ? "ended"
      : "active";
    item.endedAt = normalizeTimestamp(receivedAt, this.now);
  }

  #reduceMessageEnd(event, receivedAt) {
    const message = event.message;
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      this.#protocolWarning("MESSAGE END", event, receivedAt);
      return;
    }
    const role = sanitizeText(message.role || "assistant").toLowerCase();
    const protocolId = nullableText(message.id);
    if (protocolId && this.finalizedMessageIds.has(protocolId)) return;

    if (role === "assistant") {
      this.totalTokens += nonnegativeNumber(message.usage?.totalTokens);
      this.totalCost += nonnegativeNumber(message.cost?.total);
      this.contextUsed = contextUsedFromMessage(message);
    }

    const timestamp = normalizeTimestamp(receivedAt, this.now);
    const finalStreams = messageContent(message);
    let usageItem = null;

    for (const [stream, text] of finalStreams) {
      const item = this.#messageItem(role, stream, receivedAt, protocolId);
      if (protocolId) item.id = finalizedStreamId(protocolId, stream);
      item.payload.content = text;
      usageItem ??= item;
    }
    const rolePrefix = `${role}:`;
    for (const [key, item] of this.activeMessages) {
      if (!key.startsWith(rolePrefix)) continue;
      if (protocolId) {
        item.id = finalizedStreamId(protocolId, item.payload.stream);
      }
      item.status = message.errorMessage ? "failed" : "succeeded";
      item.endedAt = timestamp;
      item.payload.streamStatus = "ended";
      usageItem ??= item;
      this.activeMessages.delete(key);
      this.#completeItem(item);
    }
    if (!usageItem) {
      usageItem = this.#append(
        role === "assistant" ? "assistant" : role,
        role.toUpperCase(),
        { role, stream: "text", content: "", streamStatus: "ended" },
        receivedAt,
        {
          id: protocolId,
          status: message.errorMessage ? "failed" : "succeeded",
        },
      );
    }
    if (protocolId) {
      this.finalizedMessageIds.add(protocolId);
    }
  }

  #reduceToolStart(event, receivedAt) {
    const id = sanitizeText(event.toolCallId);
    if (!id) {
      this.#protocolWarning("TOOL START", event, receivedAt);
      return;
    }
    if (this.toolItems.has(id) || this.finalizedToolIds.has(id)) {
      this.#protocolWarning("TOOL START", event, receivedAt);
      return;
    }
    const name = sanitizeText(event.toolName || "tool");
    const item = this.#append(
      "tool",
      name ? name.toUpperCase() : "TOOL",
      { name, args: sanitizeManifestValue(event.args), result: "" },
      receivedAt,
      { id, status: "active", endedAt: null },
    );
    this.toolItems.set(id, item);
    this.totalTools += 1;
    this.activeTools += 1;
  }

  #reduceToolUpdate(event, receivedAt) {
    const id = sanitizeText(event.toolCallId);
    const item = this.toolItems.get(id);
    if (!id || !item || item.status !== "active") {
      this.#protocolWarning("TOOL UPDATE", event, receivedAt);
      return;
    }
    item.payload.result = recordText(event.partialResult);
    item.endedAt = normalizeTimestamp(receivedAt, this.now);
  }

  #reduceToolEnd(event, receivedAt) {
    const id = sanitizeText(event.toolCallId);
    if (!id) {
      this.#protocolWarning("TOOL END", event, receivedAt);
      return;
    }
    if (this.finalizedToolIds.has(id)) {
      this.#protocolWarning("TOOL END", event, receivedAt);
      return;
    }
    let item = this.toolItems.get(id);
    if (item && item.status !== "active") {
      this.#protocolWarning("TOOL END", event, receivedAt);
      return;
    }
    if (!item) {
      const name = sanitizeText(event.toolName || "tool");
      item = this.#append(
        "tool",
        name ? name.toUpperCase() : "TOOL",
        { name, args: null, result: "" },
        receivedAt,
        { id, status: "active", endedAt: null },
      );
      this.toolItems.set(id, item);
      this.totalTools += 1;
      this.activeTools += 1;
    }
    item.payload.result = recordText(event.result);
    item.status = statusFromToolEnd(event);
    item.endedAt = normalizeTimestamp(receivedAt, this.now);
    this.finalizedToolIds.add(id);
    this.activeTools -= 1;
    if (item.status === "failed") this.failedTools += 1;
    this.#completeItem(item);
  }

  #messageItem(role, stream, receivedAt, protocolId = null) {
    const key = `${role}:${stream}`;
    const active = this.activeMessages.get(key);
    if (active) return active;
    const [, streamLabel] =
      [...messageStreams.values()].find(([name]) => name === stream) || [];
    const kind =
      stream === "thinking" || stream === "reasoning"
        ? "thinking"
        : stream === "toolcall"
          ? "tool-call"
          : role === "assistant"
            ? "assistant"
            : role;
    const item = this.#append(
      kind,
      streamLabel || role.toUpperCase(),
      { role, stream, content: "", streamStatus: "active" },
      receivedAt,
      {
        id: finalizedStreamId(protocolId, stream),
        status: "active",
        endedAt: null,
      },
    );
    this.activeMessages.set(key, item);
    return item;
  }

  #protocolWarning(label, event, receivedAt) {
    const summary = {};
    for (const key of Object.keys(event).sort().slice(0, 12)) {
      const value = summarizeValue(event[key]);
      defineSafeProperty(
        summary,
        sanitizeText(key).slice(0, 80),
        typeof value === "string" ? value.slice(0, 240) : value,
      );
    }
    this.#append(
      "protocol-warning",
      `PROTOCOL WARNING · ${label}`,
      { summary },
      receivedAt,
      { status: "unknown" },
    );
  }

  #completeItem(item) {
    this.retention.complete(item);
    const removed = new Set(this.retention.prune(this.items));
    for (const [id, tool] of this.toolItems) {
      if (removed.has(tool)) this.toolItems.delete(id);
    }
  }

  #append(kind, label, payload, receivedAt, options = {}) {
    const timestamp = normalizeTimestamp(receivedAt, this.now);
    const id = options.id || `${kind}-${this.sequence++}`;
    const item = {
      id,
      kind,
      label,
      startedAt: timestamp,
      endedAt: options.endedAt === undefined ? timestamp : options.endedAt,
      status: options.status || "unknown",
      payload,
      provenance: "exact",
    };
    this.items.push(item);
    this.#completeItem(item);
    return item;
  }
}
