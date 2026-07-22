/** Untrusted text sanitization and viewer-manifest normalization. */

function skipCsi(text, index) {
  while (index < text.length) {
    const code = text.charCodeAt(index++);
    if (code >= 0x40 && code <= 0x7e) return index;
  }
  return index;
}

function skipControlString(text, index, allowBell) {
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (allowBell && code === 0x07) return index + 1;
    if (code === 0x9c) return index + 1;
    if (code === 0x1b && text.charCodeAt(index + 1) === 0x5c) {
      return index + 2;
    }
    index += 1;
  }
  return index;
}

function skipEscape(text, index) {
  if (index >= text.length) return index;

  const code = text.charCodeAt(index);
  if (code === 0x5b) return skipCsi(text, index + 1);
  if (code === 0x5d) return skipControlString(text, index + 1, true);
  if (code === 0x50 || code === 0x58 || code === 0x5e || code === 0x5f) {
    return skipControlString(text, index + 1, false);
  }

  while (index < text.length) {
    const current = text.charCodeAt(index);
    if (current >= 0x20 && current <= 0x2f) {
      index += 1;
      continue;
    }
    if (current >= 0x30 && current <= 0x7e) return index + 1;
    return index;
  }
  return index;
}

export function sanitizeText(value) {
  let text;
  try {
    text = String(value ?? "");
  } catch {
    return "";
  }

  let clean = "";
  for (let index = 0; index < text.length; ) {
    const code = text.charCodeAt(index);

    if (code === 0x1b) {
      index = skipEscape(text, index + 1);
      continue;
    }
    if (code === 0x9b) {
      index = skipCsi(text, index + 1);
      continue;
    }
    if (code === 0x9d) {
      index = skipControlString(text, index + 1, true);
      continue;
    }
    if (code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
      index = skipControlString(text, index + 1, false);
      continue;
    }
    if (code === 0x0d) {
      clean += "\n";
      index += text.charCodeAt(index + 1) === 0x0a ? 2 : 1;
      continue;
    }
    if (code === 0x0a) {
      clean += "\n";
      index += 1;
      continue;
    }
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      index += 1;
      continue;
    }

    clean += text[index++];
  }
  return clean;
}

const MAX_RETAINED_SOURCE_BYTES = 64 * 1024;
const SOURCE_TRUNCATION_MARKER = "\nsource truncated";

export function boundSourceText(value) {
  const text = sanitizeText(value);
  const bytes = Buffer.from(text);
  if (bytes.length <= MAX_RETAINED_SOURCE_BYTES) return text;

  const available = MAX_RETAINED_SOURCE_BYTES -
    Buffer.byteLength(SOURCE_TRUNCATION_MARKER);
  const prefix = bytes.subarray(0, available).toString("utf8")
    .replace(/\ufffd$/u, "");
  return `${prefix}${SOURCE_TRUNCATION_MARKER}`;
}

export function defineSafeProperty(target, key, value) {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

export function sanitizeManifestValue(value, seen = new WeakSet()) {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return value;
  }
  if (typeof value === "string") return sanitizeText(value);
  if (typeof value !== "object") return sanitizeText(value);
  if (seen.has(value)) return null;

  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.map((entry) => sanitizeManifestValue(entry, seen));
    seen.delete(value);
    return result;
  }

  const result = {};
  for (const key of Object.keys(value).sort()) {
    let entry;
    try {
      entry = value[key];
    } catch {
      entry = null;
    }
    defineSafeProperty(
      result,
      sanitizeText(key),
      sanitizeManifestValue(entry, seen),
    );
  }
  seen.delete(value);
  return result;
}

export function nullableText(value) {
  return value === null || value === undefined ? null : sanitizeText(value);
}

const PROMPT_ORDER = new Map([
  ["system", 0],
  ["project-context", 1],
  ["agent-template", 2],
  ["extension", 3],
  ["task", 4],
]);
const PROMPT_PROVENANCE = new Set(["exact", "derived", "unavailable"]);

export function recordOrNull(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function copyTextFields(value, keys) {
  const record = recordOrNull(value);
  const result = {};
  if (!record) return result;
  for (const key of keys) {
    if (typeof record[key] === "string") {
      defineSafeProperty(result, key, sanitizeText(record[key]));
    }
  }
  return result;
}

function normalizeChild(value) {
  const record = recordOrNull(value);
  const child = copyTextFields(record, [
    "agent",
    "runId",
    "tagline",
    "agentFile",
  ]);
  if (Number.isSafeInteger(record?.index) && record.index >= 0) {
    child.index = record.index;
  }
  return child;
}

function normalizeRuntime(value) {
  const record = recordOrNull(value);
  const runtime = copyTextFields(record, ["provider", "model"]);
  if (Number.isFinite(record?.contextWindow) && record.contextWindow >= 0) {
    runtime.contextWindow = record.contextWindow;
  }
  return runtime;
}

function hasSourceControls(value) {
  return /[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function normalizePrompt(value) {
  const record = recordOrNull(value);
  if (!record || !PROMPT_ORDER.has(record.kind)) return null;
  if (!PROMPT_PROVENANCE.has(record.provenance)) return null;
  if (
    typeof record.title !== "string" ||
    typeof record.text !== "string" ||
    typeof record.source !== "string" ||
    hasSourceControls(record.source)
  ) {
    return null;
  }

  const source = sanitizeText(record.source);
  if (!source) return null;
  return {
    kind: record.kind,
    title: sanitizeText(record.title),
    text: sanitizeText(record.text),
    source,
    provenance: record.provenance,
  };
}

function normalizeTask(value) {
  const record = recordOrNull(value);
  if (
    !record ||
    typeof record.text !== "string" ||
    typeof record.source !== "string" ||
    hasSourceControls(record.source) ||
    !PROMPT_PROVENANCE.has(record.provenance)
  ) {
    return null;
  }
  const source = sanitizeText(record.source);
  if (!source) return null;
  return {
    text: sanitizeText(record.text),
    source,
    provenance: record.provenance,
  };
}

export function normalizeManifest(value) {
  const empty = {
    version: 1,
    capturedAt: null,
    child: {},
    launch: { promptMode: null, task: null },
    prompts: [],
    runtime: {},
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) return empty;
  if (value.version !== 1) return empty;

  const launch = recordOrNull(value.launch);
  const task = normalizeTask(launch?.task);
  let prompts = Array.isArray(value.prompts)
    ? value.prompts.map(normalizePrompt).filter(Boolean)
    : [];
  if (task) {
    prompts = prompts.filter(({ kind }) => kind !== "task");
    prompts.push({ kind: "task", title: "Task", ...task });
  }
  prompts.sort(
    (left, right) => PROMPT_ORDER.get(left.kind) - PROMPT_ORDER.get(right.kind),
  );

  return {
    version: 1,
    capturedAt:
      typeof value.capturedAt === "string"
        ? sanitizeText(value.capturedAt)
        : null,
    child: normalizeChild(value.child),
    launch: {
      promptMode:
        typeof launch?.promptMode === "string"
          ? sanitizeText(launch.promptMode)
          : null,
      task,
    },
    prompts,
    runtime: normalizeRuntime(value.runtime),
  };
}
