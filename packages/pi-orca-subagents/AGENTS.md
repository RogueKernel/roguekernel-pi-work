# Orca visibility adapter boundaries

This package is presentation-only; `pi-subagents` owns child execution.

- `pi-subagents` owns profiles, routing, sessions, worktrees, lifecycle, retries,
  interruption, results, and observability. Do not duplicate them here.
- Integrate only through `PI_SUBAGENT_PI_BINARY`; preserve child arguments, cwd,
  environment, stdout, stderr, signals, PID ownership, and exit status.
- Outside Orca or after visibility failure, silently `exec` the real Pi child.
- Orca viewers are read-only copied JSON streams, never interactive Pi TUIs.
- Treat child output as untrusted: sanitize control sequences, bound fields,
  render unknown events as sanitized generic items, and degrade malformed lines
  safely.
- Keep transcript state and rendering bounded independently. Retain
  approximately the newest 10,000 level-1 logical lines, evict only completed
  entries, protect active message streams and tools, and render no more than
  10,000 newest transcript rows. Do not materialize older entries after the
  render budget is full.
- Keep omission counts and lifetime metrics separate: the marker reports only
  model-evicted logical lines, while tokens, cost, tools, failures, retries,
  context, and elapsed time continue to describe the full observed session.
- Propagate the complete model snapshot into the live UI object on every
  follower update; do not hand-copy a subset of snapshot fields.
- Viewer metadata is presentation-only. It may populate titles, factual prompt
  layers and provenance, identity, placement, and observed metrics; it must not
  affect child execution. Missing placement metadata falls back to a background
  `-> subagent` tab, and other missing facts stay absent or unavailable.
- Capture full metadata for every viewer. Treat `ptyId` as stable identity and
  handles as disposable routing tokens: resolve the current handle before later
  operations, falling back only to this adapter's own returned handle. Split
  viewers must never request whole-tab closure. Viewer creation must never steal
  focus—not even briefly; do not implement “focus then restore.” If Orca lacks a
  non-focusing placement primitive, fall back to background tabs.
- Background tabs remain the automatic default. `orca_subagent_view` may alter
  only the next actual launch; management calls and agent turns do not consume it.
- Stop and confirm before crossing this ownership boundary.
- Before release, run `npm run check`, run `npm run test:integration` from an
  Orca-managed terminal, and run `npm pack --dry-run --json`; then scan packed
  files for secrets, PII, local paths, and generated artifacts. The integration
  suite skips outside Orca.
