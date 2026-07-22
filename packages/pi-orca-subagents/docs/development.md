# Development

## Architecture

The package keeps process integration, untrusted-data normalization, pure
presentation, and terminal ownership in separate modules:

- `pi-extension/orca-adapter.ts` configures the public
  `PI_SUBAGENT_PI_BINARY` seam only inside an Orca-managed terminal. In that
  environment it also registers one presentation-only tool for configuring the
  next viewer layout; it never registers profiles or a competing subagent tool.
- `bin/orca-pi-wrapper` creates a live Orca viewer terminal, writes the private
  launch manifest, then replaces itself with the real Pi child process.
- `bin/relay-stream.mjs` forwards one child stream byte-for-byte while writing a
  bounded, best-effort viewer copy.
- `bin/subagent-title.mjs` applies the model's complete terminal-control
  sanitizer before constructing cosmetic Orca titles.
- `bin/write-viewer-manifest.mjs` validates bounded upstream metadata and prompt
  files, then writes the private version-1 launch manifest.
- `bin/render-pi-jsonl.mjs` follows both copied logs in one process, starts the
  TUI, and owns fallback and shutdown.
- `src/viewer-model.mjs` normalizes events, stable transcript items, prompt
  records, lifetime observed metrics, and the retained transcript tail.
- `src/viewer-retention.mjs` assigns deterministic level-1 logical-line weights
  to completed items and evicts the oldest completed history at the fixed
  10,000-line boundary without removing active messages or tools.
- `src/viewer-safety.mjs` owns terminal-control stripping, bounded source text,
  and versioned manifest normalization.
- `src/viewer-materialize.mjs` applies verbosity and source-truncation rules to
  transcript and prompt records without terminal side effects.
- `src/viewer-render.mjs` is the pure presentation seam. It renders the masthead,
  continuous prompt surface, structured timeline, and responsive status dock
  from a snapshot without owning terminal state.
- `src/viewer-ui.mjs` owns viewport anchoring, prompt-overlay interaction, input
  routing, Pi TUI integration, and terminal lifecycle.
- `src/viewer-theme.mjs` owns light and dark semantic palettes and surface colors.

Keep factual normalization in the model and terminal side effects in the UI.
Presentation changes belong in the renderer and should be tested through its
small snapshot-to-lines interface. Compare production changes in Orca at all
four verbosity levels and wide, medium, and narrow widths.

The final `exec` is essential. The real Pi process retains the wrapper PID, so
`pi-subagents` continues to own signals, writer leases, timeouts, retries,
result parsing, and exit status. Named pipes feed explicit relay workers that
forward child bytes unchanged and write bounded, best-effort Orca log copies. A
full or failed log sink is disabled without stopping the relay, so stdout and
stderr remain available to `pi-subagents`. Only the copied logs pass through the renderer. The Orca viewer
terminal explicitly starts a clean Bash shell; it must not inherit a worktree
default terminal command such as another Pi TUI.
A separate cleanup monitor waits for both Pi and the relay workers to exit,
writes a completion marker, and gives the viewer a bounded final-drain window
before closing it. The one viewer process watches that marker itself; the wrapper
does not launch `tail -F` pipelines or manage renderer worker PIDs. If Orca cannot
close a viewer, the copied logs remain available for delayed startup and the
viewer removes them after rendering. Each wrapper captures the viewer's Orca metadata and writes
`viewer.json` beside the copied logs. The monitor treats `ptyId` as stable
identity, resolves the current handle before later operations, verifies closure,
and retries once if Orca changes the handle. It requests a whole-tab close for a
background tab or a pane-only close for a split viewer. Every Orca CLI operation
is time-bounded so visibility cannot indefinitely delay the real child. If Orca
has replaced the parent terminal handle, the wrapper resolves the current
terminal from the stable pane leaf identity before creating or splitting viewers.
Terminal creation and splitting have a dedicated five-second bound because Orca
may serialize concurrent operations; other operations retain the shorter general
bound.

The wrapper writes manifest version 1 and passes its private path directly to the
viewer. It includes only validated presentation fields. The optional
`PI_SUBAGENT_VIEWER_MANIFEST` path lets an upstream owner provide additional
version-1 prompt layers, provenance, identity, and model metadata. Wrapper facts
such as the actual child agent/index and a recognized prompt file remain
authoritative. Raw argv and unrelated environment values are never copied.

Each log follower keeps an independent byte offset, UTF-8 decoder, and bounded
incomplete-line buffer. It reads bounded chunks, waits for LF framing, and drains
both logs once more after the done marker appears. Missing logs, malformed
manifests, malformed JSON, and unknown events become sanitized warning or generic
items. TUI import/startup failure falls back to deterministic plain output from
the same model.

Transcript growth has two independent presentation bounds. The model retains
approximately the newest 10,000 level-1 logical lines so snapshot cloning and
state storage do not grow with the full session. The renderer then walks items
from newest to oldest and stops at 10,000 terminal-width-wrapped rows; it must
not materialize older items after the row budget is full. Model eviction uses a
counted `… N earlier logical lines omitted` marker. Width-only clipping uses an
uncounted marker because wrapped-row counts change when the terminal resizes.
The plain fallback follows the same newest-first boundary. The fixed limit is
not configurable, and discarded transcript content is not copied to another
cache or file.

The interactive app retains one snapshot object by reference. Follow-mode
refreshes replace all fields on that object together so newly added snapshot
facts—such as the cumulative omission count—cannot remain frozen at their
startup value.

Active tool calls and message streams are protected until completion. The sole
newest completed item may exceed the model's approximate logical-line target,
but the renderer still applies its hard row limit. Tokens, cost, context use,
tool and failure totals, retries, active calls, and elapsed time are maintained
as lifetime facts rather than recomputed from retained timeline items.

Transcript item IDs do not depend on rendered rows. Tool-call IDs are retained;
message streams add factual stream suffixes when needed; other items use a
viewer-local sequence. The application owns `scrollTop` and stable item ranges.
Top, bottom-follow, and midpoint anchors survive verbosity and width changes.
Left/right arrows pass through a 120 ms quiet-window gate so held repeats do not
skip levels.

The footer reserves the rows it renders: 5 in measured wide mode, 4 in medium
mode, and 7 in narrow mode. Wide mode starts at 134 columns, derived from the six
fixed box widths and gaps. Collapsed modes are left-aligned. Very short terminals
retain at least one transcript row.

The default path always creates one background tab per child without requiring
model involvement. `orca_subagent_view` can arm `right_stack` or `hidden` for the
next actual `subagent` launch. Pending layout state survives management calls and
agent turns; a launch consumes it, and session shutdown clears it. Right-stack
wrappers first probe Orca for an explicit non-focusing split flag. Unsupported
versions fall back to background tabs rather than splitting and restoring focus
afterward. When supported, child zero splits the parent left/right without
activation and publishes its handle plus stable `ptyId`; child one re-resolves
the current handle before splitting that pane top/bottom without activation.
Reverse startup order is supported. Missing metadata, extra children, timeouts,
and split errors fall back to independent background tabs. Layout state changes
presentation only and is cleared after the consuming `subagent` execution.

## Invariants

1. Never write adapter diagnostics to stdout; it is Pi's JSONL protocol stream.
2. Pass every child argument unchanged.
3. Preserve the inherited cwd and environment, except presentation-only
   one-shot layout variables after this wrapper consumes them.
4. Replace the wrapper process with Pi using `exec`.
5. Do not register competing subagent tools, profiles, or child lifecycle
   handlers here. The Orca-only viewer-layout tool may configure presentation.
6. The viewer may be an interactive read-only TUI, but it must never claim to be
   or control the child's interactive Pi session.
7. Outside Orca, or when Orca setup fails, silently `exec` the real Pi child
   without changing its streams or exit behavior.
8. Metadata-derived titles and placement are cosmetic. Missing or malformed
   child metadata must fall back to `-> subagent` in a background tab and never
   affect execution.
9. Always override Orca's worktree default command with the dedicated viewer
   shell when creating a log terminal.
10. Never issue a close against Orca's implicit current terminal. Every close
    must use the exact handle returned by this wrapper's terminal creation or
    split, and split viewers must never request whole-tab closure.
11. Outside Orca, do not register the layout tool or expose Orca-specific prompt
    instructions.
12. Bound retained history by completed-item logical lines; never evict an
    active message stream or tool call.
13. Keep lifetime metrics independent of the retained transcript tail.
14. Bound interactive and plain transcript rendering newest-first, and stop
    materializing older entries as soon as the 10,000-row budget is full.

## Checks

```bash
npm install
npm run check
npm run test:integration # from an Orca-managed terminal
npm pack --dry-run --json
```
