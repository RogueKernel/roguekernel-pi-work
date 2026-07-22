---
paths:
  - "packages/pi-orca-subagents/src/**/*.mjs"
  - "packages/pi-orca-subagents/bin/render-pi-jsonl.mjs"
  - "packages/pi-orca-subagents/test/**/*.ts"
  - "packages/pi-orca-subagents/docs/**/*.md"
  - "packages/pi-orca-subagents/README.md"
summary: "Preserve bounded transcript state, rendering, and lifetime metrics in pi-orca-subagents."
alwaysApply: false
---
# Orca viewer transcript boundaries

- Keep model retention and terminal rendering independently bounded.
- The production model retains approximately the newest **10,000 level-1 logical transcript lines**. Evict only the oldest completed entries.
- Never evict an active message stream or active tool call. A sole newest completed item may exceed the approximate model target.
- Interactive and plain renderers must emit at most **10,000 newest transcript rows** and must stop materializing older entries once the budget is full.
- Counted omission markers report only model-evicted logical lines. Width-only clipping uses an uncounted marker because wrapped-row counts vary with terminal width.
- Keep tokens, cost, context use, tool/failure totals, retries, active-call counts, and elapsed time as lifetime metrics independent of retained timeline items.
- Live follow-mode updates must propagate the complete snapshot contract into the object held by the interactive UI. Do not maintain a hand-copied field subset that can omit new snapshot fields.
- Discarded transcript history is presentation data: do not persist it elsewhere or let retention affect child execution, stdout/stderr forwarding, signals, PID ownership, or exit status.
- Test exact-fill, oversized-item, zero-row-boundary, active-item protection, lifetime-metric, bottom-follow, live interactive snapshot propagation, and plain-fallback cases when changing this area.
