#!/usr/bin/env node

import fs from "node:fs";
const destination = process.argv[2];
const argvBytes = fs.readFileSync(0);
if (argvBytes.length > 0 && argvBytes.at(-1) !== 0) process.exit(1);
const args = argvBytes.length === 0
  ? []
  : argvBytes.subarray(0, -1).toString("utf8").split("\0");
const MANIFEST_LIMIT = 2 * 1024 * 1024;
const PROMPT_LIMIT = 8 * 1024 * 1024;
if (!Number.isInteger(fs.constants.O_NOFOLLOW) ||
    !Number.isInteger(fs.constants.O_NONBLOCK)) {
  process.exit(1);
}
const openFlags = fs.constants.O_RDONLY |
  fs.constants.O_NOFOLLOW |
  fs.constants.O_NONBLOCK;

function unchangedFile(before, after) {
  return before.dev === after.dev &&
    before.ino === after.ino &&
    before.mode === after.mode &&
    before.nlink === after.nlink &&
    before.uid === after.uid &&
    before.gid === after.gid &&
    before.rdev === after.rdev &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs;
}

function readBoundedUtf8(path, limit) {
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("invalid path");
  }
  let descriptor;
  try {
    descriptor = fs.openSync(path, openFlags);
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.size > BigInt(limit)) {
      throw new Error("unsafe file");
    }

    const chunks = [];
    let total = 0;
    while (true) {
      const remaining = limit + 1 - total;
      if (remaining <= 0) throw new Error("file exceeds limit");
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
      const bytesRead = fs.readSync(descriptor, chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > limit) throw new Error("file exceeds limit");
      chunks.push(chunk.subarray(0, bytesRead));
    }

    const after = fs.fstatSync(descriptor, { bigint: true });
    if (BigInt(total) !== before.size || !unchangedFile(before, after)) {
      throw new Error("file changed while reading");
    }
    return new TextDecoder("utf-8", { fatal: true })
      .decode(Buffer.concat(chunks, total));
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

const provenance = new Set(["exact", "derived", "unavailable"]);
const promptKinds = new Set([
  "system",
  "project-context",
  "agent-template",
  "extension",
  "task",
]);
const manifest = {
  version: 1,
  capturedAt: new Date().toISOString(),
  child: {},
  launch: {},
  prompts: [],
  runtime: {},
};

function isRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function copyTextFields(source, target, keys) {
  if (!isRecord(source)) return;
  for (const key of keys) {
    if (typeof source[key] === "string") target[key] = source[key];
  }
}

function validSource(source) {
  return typeof source === "string" && source.length > 0 &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(source);
}

function setPrompt(kind, title, text, source) {
  if (typeof text !== "string" || text.length === 0 || !validSource(source)) {
    return;
  }
  const prompt = { kind, title, text, source, provenance: "exact" };
  manifest.prompts = manifest.prompts.filter((value) => value.kind !== kind);
  manifest.prompts.push(prompt);
}

function setTask(text, source) {
  if (typeof text !== "string" || text.length === 0 || !validSource(source)) {
    return;
  }
  const task = { text, source, provenance: "exact" };
  manifest.launch.task = task;
  setPrompt("task", "Task", text, source);
}

function setModel(value) {
  if (typeof value !== "string" || !validSource(value)) return;
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1) return;
  manifest.runtime.provider = value.slice(0, separator);
  manifest.runtime.model = value.slice(separator + 1);
}

function copyTask(value) {
  if (!isRecord(value) || typeof value.text !== "string" ||
      !validSource(value.source) || !provenance.has(value.provenance)) {
    return undefined;
  }
  return {
    text: value.text,
    source: value.source,
    provenance: value.provenance,
  };
}

function copyPrompt(value) {
  if (!isRecord(value) || !promptKinds.has(value.kind) ||
      typeof value.title !== "string") {
    return undefined;
  }
  const task = copyTask(value);
  return task ? { kind: value.kind, title: value.title, ...task } : undefined;
}

function mergeUpstream(value) {
  if (!isRecord(value) || value.version !== 1) return;
  copyTextFields(value.child, manifest.child, [
    "agent",
    "runId",
    "tagline",
    "agentFile",
  ]);
  if (Number.isSafeInteger(value.child?.index) && value.child.index >= 0) {
    manifest.child.index = value.child.index;
  }

  if (typeof value.launch?.promptMode === "string") {
    manifest.launch.promptMode = value.launch.promptMode;
  }
  const task = copyTask(value.launch?.task);
  if (task) manifest.launch.task = task;

  if (Array.isArray(value.prompts)) {
    manifest.prompts = value.prompts.map(copyPrompt).filter(Boolean);
  }

  copyTextFields(value.runtime, manifest.runtime, ["provider", "model"]);
  if (Number.isFinite(value.runtime?.contextWindow) &&
      value.runtime.contextWindow >= 0) {
    manifest.runtime.contextWindow = value.runtime.contextWindow;
  }
}

const upstreamPath = process.env.PI_SUBAGENT_VIEWER_MANIFEST;
if (upstreamPath) {
  try {
    mergeUpstream(JSON.parse(readBoundedUtf8(upstreamPath, MANIFEST_LIMIT)));
  } catch {}
}

delete manifest.child.agent;
delete manifest.child.index;
const childAgent = process.env.PI_SUBAGENT_CHILD_AGENT;
const childIndex = process.env.PI_SUBAGENT_CHILD_INDEX;
if (childAgent) manifest.child.agent = childAgent;
if (/^\d+$/.test(childIndex ?? "")) {
  const index = Number(childIndex);
  if (Number.isSafeInteger(index)) manifest.child.index = index;
}

let promptFile;
let modelArgument;
let systemPromptArgument;
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--prompt-file") {
    promptFile = args[index + 1];
    index += 1;
  } else if (args[index].startsWith("--prompt-file=")) {
    promptFile = args[index].slice("--prompt-file=".length);
  } else if (args[index] === "--model") {
    modelArgument = args[index + 1];
    index += 1;
  } else if (args[index].startsWith("--model=")) {
    modelArgument = args[index].slice("--model=".length);
  } else if (args[index] === "--system-prompt") {
    systemPromptArgument = { mode: "replace", path: args[index + 1] };
    index += 1;
  } else if (args[index].startsWith("--system-prompt=")) {
    systemPromptArgument = {
      mode: "replace",
      path: args[index].slice("--system-prompt=".length),
    };
  } else if (args[index] === "--append-system-prompt") {
    systemPromptArgument = { mode: "append", path: args[index + 1] };
    index += 1;
  } else if (args[index].startsWith("--append-system-prompt=")) {
    systemPromptArgument = {
      mode: "append",
      path: args[index].slice("--append-system-prompt=".length),
    };
  }
}
setModel(modelArgument);

if (systemPromptArgument) {
  try {
    const text = readBoundedUtf8(systemPromptArgument.path, PROMPT_LIMIT);
    manifest.launch.promptMode = systemPromptArgument.mode;
    if (systemPromptArgument.mode === "replace") {
      setPrompt("system", "System prompt", text, "Pi system-prompt file");
    } else {
      setPrompt(
        "agent-template",
        "Agent prompt",
        text,
        "Pi append-system-prompt file",
      );
    }
  } catch {}
}

const positionalPrompt = args.at(-1);
if (typeof positionalPrompt === "string" && positionalPrompt.startsWith("Task: ")) {
  setTask(positionalPrompt.slice("Task: ".length), "Pi positional prompt");
} else if (typeof positionalPrompt === "string" && positionalPrompt.startsWith("@")) {
  try {
    const text = readBoundedUtf8(positionalPrompt.slice(1), PROMPT_LIMIT);
    if (text.startsWith("Task: ")) {
      setTask(text.slice("Task: ".length), "Pi @ prompt file");
    }
  } catch {}
}
if (promptFile) {
  try {
    setTask(readBoundedUtf8(promptFile, PROMPT_LIMIT), "prompt file");
  } catch {}
}

fs.writeFileSync(destination, `${JSON.stringify(manifest, null, 2)}\n`, {
  encoding: "utf8",
  flag: "wx",
  mode: 0o600,
});
fs.chmodSync(destination, 0o600);
