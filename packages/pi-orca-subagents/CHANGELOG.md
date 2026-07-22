# Changelog

All notable changes to this project will be documented here.

## Unreleased

- Captures pi-subagents' exact agent prompt, positional task, and model
  arguments so launch context is visible from the start of each viewer.
- Gives search, browser, and otherwise-unclassified tools semantic heading
  colours instead of rendering them like unknown events.
- Omits blank protocol records and routine session persistence events from the
  visible timeline.

## 0.1.0 - 2026-07-22

- Shows concise tool intent in compact and readable headers, including
  GREP/FIND pattern and path, READ ranges, browser commands and jobs, and
  structured fallback arguments.
- Keeps long-running viewers responsive with a rolling 10,000-logical-line
  transcript tail, a hard 10,000-row render bound, and an explicit count of
  omitted earlier history while preserving lifetime metrics and active items.
- Updates the development compatibility baseline to Pi 0.81.0.
- Re-resolves stale Orca parent terminal handles from the current pane identity
  before creating or splitting viewers.
- Keeps background read-only tabs as the automatic default for every
  `pi-subagents` child, without requiring model tool use.
- Adds an Orca-only presentation tool for stacking two viewers on the right or
  suppressing viewers for the next subagent launch, with concise routing guidance
  that distinguishes subagent viewers from ordinary Orca working terminals.
- Coordinates reverse-order split startup safely and closes split panes without
  closing the parent tab.
- Never focuses a new viewer: right-stack placement requires an explicit Orca
  non-focusing split capability and otherwise falls back to background tabs.
- Replaces raw child JSONL in Orca tabs with a sanitized, bounded, read-only
  renderer for assistant text, thinking, tools, retries, errors, and completion.
- Keeps copied logs available for delayed Orca terminal startup, uses stream
  completion rather than wrapper PID polling, and clears the echoed startup
  command before rendering.
- Gives concurrent Orca terminal creation a dedicated five-second bound instead
  of the shorter general command timeout.
- Preserves explicit viewer layout across management calls and agent turns until
  the next actual subagent launch consumes it.
- Captures viewer and parent terminal metadata, uses stable `ptyId` identity to
  re-resolve changed handles, verifies cleanup, and retries closure after layout
  changes.

- Prefixes Orca child log tabs with `->` and includes agent/index metadata when
  available, with a safe generic fallback.
- Closes whole Orca log tabs after child exit, including signal-terminated
  children, without changing `pi-subagents` process ownership or protocol
  streams.
- Starts each log viewer in an explicit Bash shell so worktree default terminal
  commands (such as another Pi TUI) cannot replace the viewer.

- Initial thin adapter using the public `PI_SUBAGENT_PI_BINARY` seam.
- Adds visible Orca log terminals without replacing `pi-subagents` profiles,
  lifecycle, orchestration, or result handling.
- Remains inactive outside Orca and silently passes through to Pi when
  visibility setup is unavailable.
