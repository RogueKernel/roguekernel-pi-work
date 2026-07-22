#!/usr/bin/env node

import { sanitizeText } from "../src/viewer-safety.mjs";

const role = sanitizeText(process.argv[2])
  .replace(/\s+/gu, " ")
  .trim()
  .slice(0, 48);
const rawIndex = process.argv[3] ?? "";
const index = /^\d+$/u.test(rawIndex) ? Number(rawIndex) + 1 : null;
const suffix = index === null ? "" : ` · ${index}`;

process.stdout.write(role ? `-> ${role}${suffix}` : "-> subagent");
