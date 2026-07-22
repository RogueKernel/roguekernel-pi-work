#!/usr/bin/env node

import fs from "node:fs";

const logPath = process.argv[2];
const requestedLimit = Number(process.argv[3]);
const limit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0
  ? requestedLimit
  : 8 * 1024 * 1024;
const marker = Buffer.from("\nviewer warning: captured source truncated\n");
const contentLimit = Math.max(0, limit - marker.length);
const buffer = Buffer.allocUnsafe(64 * 1024);

let log;
let captured = 0;
let truncated = false;
try {
  log = fs.openSync(logPath, "a");
} catch {
  log = undefined;
}

function writeAll(descriptor, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    offset += fs.writeSync(
      descriptor,
      bytes,
      offset,
      bytes.length - offset,
    );
  }
}

function writeLog(bytes) {
  if (log === undefined || bytes.length === 0) return;
  try {
    writeAll(log, bytes);
  } catch {
    try {
      fs.closeSync(log);
    } catch {}
    log = undefined;
  }
}

while (true) {
  const bytesRead = fs.readSync(0, buffer, 0, buffer.length);
  if (bytesRead === 0) break;
  const chunk = buffer.subarray(0, bytesRead);
  writeAll(1, chunk);

  if (log === undefined || truncated) continue;
  const remaining = contentLimit - captured;
  if (remaining > 0) {
    const capturedChunk = chunk.subarray(0, remaining);
    writeLog(capturedChunk);
    captured += capturedChunk.length;
  }
  if (chunk.length > remaining) {
    writeLog(marker.subarray(0, limit - captured));
    truncated = true;
  }
}

if (log !== undefined) fs.closeSync(log);
