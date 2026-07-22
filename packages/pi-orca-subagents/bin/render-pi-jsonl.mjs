#!/usr/bin/env node

import { access, open, readFile } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import {
  MAX_TRANSCRIPT_ROWS,
  ViewerModel,
  materializeItem,
  sanitizeText,
} from "../src/viewer-model.mjs";

const DEFAULT_POLL_INTERVAL_MS = 40;
const MAX_LOGICAL_RECORD_BYTES = 256 * 1024;

function parseArgs(args) {
  /** @type {{ stderr: boolean, stdoutLog?: string, stderrLog?: string, doneFile?: string, manifest?: string }} */
  const options = { stderr: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--stderr") {
      options.stderr = true;
      continue;
    }
    const field = {
      "--stdout-log": "stdoutLog",
      "--stderr-log": "stderrLog",
      "--done-file": "doneFile",
      "--manifest": "manifest",
    }[argument];
    if (!field || index + 1 >= args.length) continue;
    options[field] = args[index + 1];
    index += 1;
  }
  return options;
}

function singleLine(value, fallback = "") {
  const clean = sanitizeText(value).replace(/\n+/gu, " ").trim();
  return clean || fallback;
}

function manifestFromEnvironment() {
  const child = {};
  const agent = singleLine(process.env.PI_SUBAGENT_CHILD_AGENT);
  const rawIndex = process.env.PI_SUBAGENT_CHILD_INDEX ?? "";
  if (agent) child.agent = agent;
  if (/^\d+$/u.test(rawIndex)) {
    const index = Number(rawIndex);
    if (Number.isSafeInteger(index)) child.index = index;
  }
  return {
    version: 1,
    capturedAt: null,
    child,
    launch: { promptMode: null, task: null },
    prompts: [],
    runtime: {},
  };
}

async function loadManifest(path) {
  if (!path) return { manifest: manifestFromEnvironment(), warning: null };
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (!value || typeof value !== "object" || value.version !== 1) {
      throw new Error("manifest version 1 required");
    }
    return { manifest: value, warning: null };
  } catch (error) {
    return {
      manifest: manifestFromEnvironment(),
      warning: `viewer manifest unavailable: ${singleLine(error?.message, "invalid manifest")}`,
    };
  }
}

function createLogState(path, source) {
  return {
    path,
    source,
    offset: 0,
    buffer: "",
    discardingRecord: false,
    decoder: new StringDecoder("utf8"),
    warnedMissing: false,
  };
}

function ingestCompleteLines(state, text, model) {
  let changed = false;
  let remaining = text;
  while (remaining.length > 0) {
    if (state.discardingRecord) {
      const newline = remaining.indexOf("\n");
      if (newline === -1) return changed;
      state.discardingRecord = false;
      remaining = remaining.slice(newline + 1);
      continue;
    }

    const newline = remaining.indexOf("\n");
    const fragment = newline === -1 ? remaining : remaining.slice(0, newline);
    if (Buffer.byteLength(state.buffer) + Buffer.byteLength(fragment) >
        MAX_LOGICAL_RECORD_BYTES) {
      state.buffer = "";
      state.discardingRecord = newline === -1;
      model.ingestLine(
        `viewer warning: ${state.source} record exceeded ${MAX_LOGICAL_RECORD_BYTES} bytes; source truncated`,
        { source: "stderr" },
      );
      changed = true;
      if (newline === -1) return changed;
      remaining = remaining.slice(newline + 1);
      continue;
    }

    state.buffer += fragment;
    if (newline === -1) return changed;
    const line = state.buffer.replace(/\r$/u, "");
    state.buffer = "";
    remaining = remaining.slice(newline + 1);
    if (line.length > 0) {
      model.ingestLine(line, { source: state.source });
      changed = true;
    }
  }
  return changed;
}

async function readLogDelta(state, model) {
  let descriptor;
  try {
    descriptor = await open(state.path, "r");
    const stats = await descriptor.stat();
    if (!stats.isFile()) throw new Error("not a regular file");
    if (stats.size < state.offset) {
      state.offset = 0;
      state.buffer = "";
      state.decoder = new StringDecoder("utf8");
    }
    const available = stats.size - state.offset;
    if (available <= 0) return false;
    const length = Math.min(64 * 1024, available);
    const bytes = Buffer.allocUnsafe(length);
    const { bytesRead } = await descriptor.read(bytes, 0, length, state.offset);
    state.offset += bytesRead;
    return ingestCompleteLines(
      state,
      state.decoder.write(bytes.subarray(0, bytesRead)),
      model,
    );
  } catch (error) {
    if (state.warnedMissing) return false;
    state.warnedMissing = true;
    model.ingestLine(
      `viewer warning: ${state.source} log unavailable (${singleLine(error?.message, "read failed")})`,
      { source: "stderr" },
    );
    return true;
  } finally {
    await descriptor?.close().catch(() => {});
  }
}

async function drainLogFully(state, model) {
  let changed = false;
  while (true) {
    const previousOffset = state.offset;
    changed = (await readLogDelta(state, model)) || changed;
    if (state.offset === previousOffset) return changed;
  }
}

function flushTrailingLine(state, model) {
  const trailing = state.buffer + state.decoder.end();
  state.buffer = "";
  if (!trailing) return false;
  model.ingestLine(trailing.replace(/\r$/u, ""), { source: state.source });
  return true;
}

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function copySnapshot(target, source) {
  Object.assign(target, source);
}

function plainSnapshot(snapshot) {
  const rows = [];
  const child = snapshot?.manifest?.child || {};
  const agent = singleLine(child.agent, "subagent");
  const index =
    Number.isSafeInteger(child.index) && child.index >= 0
      ? ` · child ${child.index + 1}`
      : "";
  rows.push(`${agent}${index}`);

  const transcriptRows = [];
  const items = Array.isArray(snapshot?.items) ? snapshot.items : [];
  let clipped = false;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (transcriptRows.length >= MAX_TRANSCRIPT_ROWS) {
      clipped = true;
      break;
    }
    const item = items[index];
    const transcript = materializeItem(item, 1);
    const itemRows = [
      singleLine(item?.label || transcript.header, "UNKNOWN"),
      ...transcript.body.map((line) => sanitizeText(line)),
      ...transcript.footer.map((line) => sanitizeText(line)),
    ];
    if (transcriptRows.length + itemRows.length > MAX_TRANSCRIPT_ROWS) {
      const remaining = Math.max(
        0,
        MAX_TRANSCRIPT_ROWS - transcriptRows.length,
      );
      if (remaining > 0) transcriptRows.unshift(...itemRows.slice(-remaining));
      clipped = true;
      break;
    }
    transcriptRows.unshift(...itemRows);
  }

  const omitted = Number(snapshot?.omittedLogicalLines) || 0;
  if (omitted > 0 || clipped) {
    if (transcriptRows.length >= MAX_TRANSCRIPT_ROWS) transcriptRows.shift();
    transcriptRows.unshift(
      omitted > 0
        ? `… ${omitted.toLocaleString("en-US")} earlier logical lines omitted`
        : "… earlier transcript lines omitted",
    );
  }
  rows.push(...transcriptRows);
  return `${rows.join("\n")}\n`;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function startInteractiveViewer(snapshot, onClose) {
  const moduleSpecifier =
    process.env.PI_ORCA_RENDER_TUI_MODULE ||
    new URL("../src/viewer-ui.mjs", import.meta.url).href;
  const { createViewerApp } = await import(moduleSpecifier);
  const app = await createViewerApp({ snapshot });
  app.state.onCloseViewer = () => {
    onClose();
    void app.close().catch(() => {});
  };
  return app;
}

async function runFollowMode(options) {
  const loaded = await loadManifest(options.manifest);
  const model = new ViewerModel({ manifest: loaded.manifest });
  if (loaded.warning) model.ingestLine(loaded.warning, { source: "stderr" });

  const stdoutState = createLogState(options.stdoutLog, "stdout");
  const stderrState = createLogState(options.stderrLog, "stderr");
  const liveSnapshot = model.snapshot();
  const noninteractive =
    process.env.PI_ORCA_RENDER_NONINTERACTIVE === "1" ||
    (!process.stdout.isTTY && !process.env.PI_ORCA_RENDER_TUI_MODULE);
  let stopping = false;
  let app = null;
  let plainFallback = noninteractive;
  const stopFollowing = () => {
    stopping = true;
  };
  process.once("SIGINT", stopFollowing);
  process.once("SIGTERM", stopFollowing);

  if (!noninteractive) {
    try {
      app = await startInteractiveViewer(liveSnapshot, stopFollowing);
    } catch (error) {
      plainFallback = true;
      model.ingestLine(
        `interactive viewer unavailable: ${singleLine(error?.message, "startup failed")}`,
        { source: "stderr" },
      );
    }
  }

  let liveTick = -1;
  try {
    while (!stopping) {
      let changed = false;
      changed = (await readLogDelta(stdoutState, model)) || changed;
      changed = (await readLogDelta(stderrState, model)) || changed;
      const now = Date.now();
      const nextLiveTick = Math.floor(now / 1_000);
      if (changed || nextLiveTick !== liveTick) {
        liveTick = nextLiveTick;
        copySnapshot(liveSnapshot, model.snapshot(now));
        app?.state.requestRender?.();
      }

      if (await fileExists(options.doneFile)) {
        changed = (await drainLogFully(stdoutState, model)) || changed;
        changed = (await drainLogFully(stderrState, model)) || changed;
        changed = flushTrailingLine(stdoutState, model) || changed;
        changed = flushTrailingLine(stderrState, model) || changed;
        if (changed) copySnapshot(liveSnapshot, model.snapshot());
        break;
      }
      await sleep(DEFAULT_POLL_INTERVAL_MS);
    }
  } finally {
    process.removeListener("SIGINT", stopFollowing);
    process.removeListener("SIGTERM", stopFollowing);
    await app?.close().catch(() => {});
  }

  if (plainFallback) process.stdout.write(plainSnapshot(model.snapshot()));
}

async function runStdinFallback({ stderr }) {
  if (stderr) {
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    const emit = (line) => {
      const clean = sanitizeText(line).slice(0, 500);
      if (clean) process.stdout.write(`! ${clean}\n`);
    };
    for await (const chunk of process.stdin) {
      buffer += decoder.write(chunk);
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) break;
        emit(buffer.slice(0, newline).replace(/\r$/u, ""));
        buffer = buffer.slice(newline + 1);
      }
    }
    buffer += decoder.end();
    if (buffer) emit(buffer.replace(/\r$/u, ""));
    return;
  }

  const model = new ViewerModel({ manifest: manifestFromEnvironment() });
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  for await (const chunk of process.stdin) {
    buffer += decoder.write(chunk);
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline === -1) break;
      const line = buffer.slice(0, newline).replace(/\r$/u, "");
      buffer = buffer.slice(newline + 1);
      if (line) model.ingestLine(line);
    }
  }
  buffer += decoder.end();
  if (buffer) model.ingestLine(buffer.replace(/\r$/u, ""));
  process.stdout.write(plainSnapshot(model.snapshot()));
}

const options = parseArgs(process.argv.slice(2));
try {
  if (options.stdoutLog && options.stderrLog && options.doneFile) {
    await runFollowMode(options);
  } else {
    await runStdinFallback({ stderr: options.stderr });
  }
} catch (error) {
  process.stderr.write(
    `pi-orca-subagents viewer: ${singleLine(error?.message, "unexpected failure")}\n`,
  );
  process.exitCode = 1;
}
