import { materializeItem } from "./viewer-materialize.mjs";

const DEFAULT_TRANSCRIPT_LINE_LIMIT = 10_000;

function normalizedLimit(value) {
  return Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : DEFAULT_TRANSCRIPT_LINE_LIMIT;
}

function logicalLineWeight(item) {
  const transcript = materializeItem(item, 1);
  return Math.max(
    1,
    1 +
      (Array.isArray(transcript.body) ? transcript.body.length : 0) +
      (Array.isArray(transcript.footer) ? transcript.footer.length : 0),
  );
}

function isProtectedActiveItem(item) {
  return (
    (item?.kind === "tool" && item?.status === "active") ||
    item?.payload?.streamStatus === "active"
  );
}

export class TranscriptRetention {
  constructor(limit = DEFAULT_TRANSCRIPT_LINE_LIMIT) {
    this.limit = normalizedLimit(limit);
    this.completedLines = 0;
    this.omittedLogicalLines = 0;
    this.weights = new WeakMap();
  }

  complete(item) {
    if (!item || isProtectedActiveItem(item) || this.weights.has(item)) return;
    const weight = logicalLineWeight(item);
    this.weights.set(item, weight);
    this.completedLines += weight;
  }

  prune(items) {
    const completed = items.filter(
      (item) => !isProtectedActiveItem(item) && this.weights.has(item),
    );
    if (completed.length <= 1 || this.completedLines <= this.limit) return [];

    const removed = [];
    for (const item of completed.slice(0, -1)) {
      if (this.completedLines <= this.limit) break;
      const weight = this.weights.get(item) ?? 1;
      this.completedLines -= weight;
      this.omittedLogicalLines += weight;
      removed.push(item);
    }

    if (removed.length === 0) return removed;
    const removedItems = new Set(removed);
    let writeIndex = 0;
    for (const item of items) {
      if (removedItems.has(item)) continue;
      items[writeIndex] = item;
      writeIndex += 1;
    }
    items.length = writeIndex;
    return removed;
  }
}
