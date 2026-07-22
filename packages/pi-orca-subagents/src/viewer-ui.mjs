import {
  Key,
  ProcessTerminal,
  TUI,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { materializeItem, materializePrompts } from "./viewer-model.mjs";
import { createTheme, modeFromBackground } from "./viewer-theme.mjs";
import {
  footerMode,
  footerRows,
  paddedLine,
  positiveDimension,
  renderFooter,
  renderPromptLines,
  renderViewerLayout,
  wideFooterMinWidth,
} from "./viewer-render.mjs";

export {
  footerMode,
  footerRows,
  renderFooter,
  renderPromptLines,
  renderViewerLines,
  wideFooterMinWidth,
} from "./viewer-render.mjs";

function layoutLength(layout) {
  return Array.isArray(layout?.lines) ? layout.lines.length : 0;
}

function viewportHeight(height) {
  return Number.isFinite(height) ? Math.max(0, Math.floor(height)) : 0;
}

function maximumScroll(layout, height) {
  return Math.max(0, layoutLength(layout) - viewportHeight(height));
}

function boundedScroll(scrollTop, layout, height) {
  const offset = Number.isFinite(scrollTop) ? Math.floor(scrollTop) : 0;
  return Math.min(maximumScroll(layout, height), Math.max(0, offset));
}

function midpointRange(layout, scrollTop, height) {
  const ranges = Array.isArray(layout?.ranges) ? layout.ranges : [];
  if (ranges.length === 0) return null;

  const midpoint = scrollTop + Math.floor(viewportHeight(height) / 2);
  return (
    ranges.find((range) => range.start <= midpoint && midpoint <= range.end) ||
    ranges.find((range) => range.start > midpoint) ||
    ranges.at(-1)
  );
}

export class ViewportState {
  constructor({ level = 1, scrollTop = 0, followingBottom = false } = {}) {
    this.level = level;
    this.scrollTop = Number.isFinite(scrollTop) ? Math.floor(scrollTop) : 0;
    this.followingBottom = followingBottom === true;
  }

  scrollBy(delta, layout, height) {
    const amount = Number.isFinite(delta) ? Math.floor(delta) : 0;
    this.followingBottom = false;
    this.scrollTop += amount;
    return this.clamp(layout, height);
  }

  goTop() {
    this.followingBottom = false;
    this.scrollTop = 0;
    return this.scrollTop;
  }

  goBottom(layout, height) {
    this.followingBottom = true;
    this.scrollTop = maximumScroll(layout, height);
    return this.scrollTop;
  }

  changeLevel(level, oldLayout, newLayout, height) {
    this.#reanchor(oldLayout, newLayout, height, height);
    this.level = level;
    return this.scrollTop;
  }

  onAppend(oldLayout, newLayout, height) {
    const oldScrollTop = boundedScroll(this.scrollTop, oldLayout, height);
    const atBottom =
      oldScrollTop > 0 && oldScrollTop === maximumScroll(oldLayout, height);
    if (this.followingBottom || atBottom) {
      return this.goBottom(newLayout, height);
    }

    this.scrollTop = oldScrollTop;
    return this.clamp(newLayout, height);
  }

  onResize(oldLayout, newLayout, oldHeight, newHeight = oldHeight) {
    return this.#reanchor(oldLayout, newLayout, oldHeight, newHeight);
  }

  clamp(layout, height) {
    this.scrollTop = boundedScroll(this.scrollTop, layout, height);
    return this.scrollTop;
  }

  #reanchor(oldLayout, newLayout, oldHeight, newHeight) {
    const oldScrollTop = boundedScroll(this.scrollTop, oldLayout, oldHeight);
    const oldMaximum = maximumScroll(oldLayout, oldHeight);

    if (this.followingBottom) {
      return this.goBottom(newLayout, newHeight);
    }
    if (oldScrollTop === 0) {
      return this.goTop();
    }
    if (oldScrollTop === oldMaximum) {
      return this.goBottom(newLayout, newHeight);
    }

    const oldAnchor = midpointRange(oldLayout, oldScrollTop, oldHeight);
    const newRanges = Array.isArray(newLayout?.ranges) ? newLayout.ranges : [];
    const newAnchor =
      oldAnchor && newRanges.find((range) => range.id === oldAnchor.id);
    this.followingBottom = false;
    this.scrollTop = newAnchor
      ? newAnchor.start - (oldAnchor.start - oldScrollTop)
      : oldScrollTop;
    return this.clamp(newLayout, newHeight);
  }
}

function transcriptLines(transcript) {
  return [transcript.header, ...transcript.body, ...transcript.footer];
}

function appendRange(layout, id, sectionLines, separator) {
  const start = layout.lines.length;
  layout.lines.push(...sectionLines);
  layout.ranges.push({ id, start, end: layout.lines.length - 1 });
  if (separator) layout.lines.push("");
}

export function layoutTimeline(items, level = 1) {
  const layout = { lines: [], ranges: [] };
  if (!Array.isArray(items)) return layout;

  items.forEach((item, index) => {
    const id = String(item?.id ?? `timeline-${index}`);
    appendRange(
      layout,
      id,
      transcriptLines(materializeItem(item, level)),
      true,
    );
  });
  return layout;
}

export function layoutPrompts(prompts, level = 1) {
  const layout = { lines: [], ranges: [] };
  if (!Array.isArray(prompts)) return layout;

  const transcripts = materializePrompts(prompts, level);
  transcripts.forEach((transcript, index) => {
    const kind = prompts[index]?.kind;
    const id = `${typeof kind === "string" && kind ? kind : "prompt"}-${index}`;
    appendRange(layout, id, transcriptLines(transcript), false);
  });
  return layout;
}

export class VerbosityKeyGate {
  constructor({ quietMs = 120 } = {}) {
    this.quietMs = quietMs;
    this.direction = 0;
    this.lastAt = -Infinity;
  }

  accept(direction, at) {
    const released = at - this.lastAt >= this.quietMs;
    const accepted = released || direction !== this.direction;
    this.direction = direction;
    this.lastAt = at;
    return accepted;
  }
}

export class PromptOverlay {
  constructor({
    prompts = [],
    level = 1,
    theme = createTheme("dark"),
    height = 20,
    onClose,
    onChange,
  } = {}) {
    this.prompts = Array.isArray(prompts) ? prompts : [];
    this.level = level;
    this.theme = theme;
    this.height = positiveDimension(height);
    this.scrollTop = 0;
    this.onClose = onClose;
    this.onChange = onChange;
    this.lastWidth = 80;
  }

  allPromptRows(width = this.lastWidth) {
    this.lastWidth = positiveDimension(width);
    return renderPromptLines(this.prompts, {
      width: this.lastWidth,
      level: this.level,
      theme: this.theme,
    });
  }

  #contentHeight() {
    return Math.max(1, this.height - 2);
  }

  #maximum() {
    return Math.max(0, this.allPromptRows().length - this.#contentHeight());
  }

  #scroll(delta) {
    this.scrollTop = Math.min(
      this.#maximum(),
      Math.max(0, this.scrollTop + delta),
    );
    this.onChange?.();
  }

  handleInput(data) {
    const printable = typeof data === "string" ? data.toLowerCase() : "";
    if (matchesKey(data, Key.escape) || printable === "p") {
      this.onClose?.();
    } else if (matchesKey(data, Key.up) || printable === "k") {
      this.#scroll(-1);
    } else if (matchesKey(data, Key.down) || printable === "j") {
      this.#scroll(1);
    } else if (matchesKey(data, Key.pageUp)) {
      this.#scroll(-this.#contentHeight());
    } else if (matchesKey(data, Key.pageDown)) {
      this.#scroll(this.#contentHeight());
    }
  }

  render(width) {
    const safeWidth = positiveDimension(width);
    const innerWidth = Math.max(1, safeWidth - 2);
    const rows = this.allPromptRows(innerWidth);
    this.scrollTop = Math.min(this.#maximum(), Math.max(0, this.scrollTop));
    const content = rows.slice(
      this.scrollTop,
      this.scrollTop + this.#contentHeight(),
    );
    while (content.length < this.#contentHeight())
      content.push(" ".repeat(innerWidth));
    const title = " PROMPT MANIFEST ";
    const top = `┌${title}${"─".repeat(Math.max(0, innerWidth - visibleWidth(title)))}┐`;
    const bottom = `└${"─".repeat(innerWidth)}┘`;
    return [
      themeLine(top, safeWidth, this.theme, this.theme.prompt),
      ...content.map((line) =>
        truncateToWidth(`│${paddedLine(line, innerWidth)}│`, safeWidth, ""),
      ),
      themeLine(bottom, safeWidth, this.theme, this.theme.prompt),
    ].slice(0, this.height);
  }

  invalidate() {}
}

function themeLine(line, width, theme, color) {
  return truncateToWidth(theme.fg(line, color), positiveDimension(width), "");
}

function isMouseWheel(data, button) {
  if (typeof data !== "string") return false;
  if (button === 64) return data.startsWith("\u001b[<64;");
  if (button === 65) return data.startsWith("\u001b[<65;");
  return false;
}

export function handleViewerInput(state, data, now = Date.now()) {
  const viewport = state?.viewport;
  if (!viewport) return false;
  const layout = state.layout || { lines: [], ranges: [] };
  const height = viewportHeight(state.height);
  const printable = typeof data === "string" ? data.toLowerCase() : "";

  if (matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
    const direction = matchesKey(data, Key.right) ? 1 : -1;
    if (!state.gate?.accept(direction, now)) return true;
    const nextLevel = Math.min(3, Math.max(0, viewport.level + direction));
    if (nextLevel === viewport.level) return true;
    const nextLayout = state.layoutForLevel?.(nextLevel) || layout;
    viewport.changeLevel(nextLevel, layout, nextLayout, height);
    state.layout = nextLayout;
    state.requestRender?.();
    return true;
  }

  let delta = null;
  if (matchesKey(data, Key.up) || printable === "k") delta = -1;
  else if (matchesKey(data, Key.down) || printable === "j") delta = 1;
  else if (matchesKey(data, Key.pageUp)) delta = -Math.max(1, height);
  else if (matchesKey(data, Key.pageDown)) delta = Math.max(1, height);
  else if (isMouseWheel(data, 64)) delta = -3;
  else if (isMouseWheel(data, 65)) delta = 3;

  if (delta !== null) viewport.scrollBy(delta, layout, height);
  else if (matchesKey(data, Key.home)) viewport.goTop();
  else if (matchesKey(data, Key.end)) viewport.goBottom(layout, height);
  else if (printable === "p") {
    state.onOpenPrompts?.();
    return true;
  } else if (printable === "q" || matchesKey(data, Key.ctrl("c"))) {
    state.onCloseViewer?.();
    return true;
  } else {
    return false;
  }

  state.requestRender?.();
  return true;
}

function layoutForSnapshot(snapshot, width, level, theme) {
  return renderViewerLayout(snapshot, { width, level, theme });
}

class ViewerRoot {
  constructor({ snapshot, terminal, theme, onInput, onFatal }) {
    this.snapshot = snapshot;
    this.terminal = terminal;
    this.theme = theme;
    this.onInput = onInput;
    this.onFatal = onFatal;
    this.hasRendered = false;
    this.lastWidth = null;
    this.lastHeight = null;
  }

  render(width) {
    try {
      return this.renderViewer(width);
    } catch (error) {
      this.onFatal?.(error);
      throw error;
    }
  }

  renderViewer(width) {
    const height = positiveDimension(this.terminal.rows, 24);
    const footerHeight = footerRows(width);
    const transcriptHeight = Math.max(1, height - footerHeight);
    const oldLayout = this.onInput.layout;
    const oldHeight = this.onInput.height;
    const layout = layoutForSnapshot(
      this.snapshot,
      width,
      this.onInput.viewport.level,
      this.theme,
    );
    this.onInput.layout = layout;
    this.onInput.height = transcriptHeight;
    this.onInput.layoutForLevel = (level) =>
      layoutForSnapshot(this.snapshot, width, level, this.theme);
    const resized =
      this.hasRendered &&
      (width !== this.lastWidth || transcriptHeight !== this.lastHeight);
    if (resized) {
      this.onInput.viewport.onResize(
        oldLayout,
        layout,
        oldHeight,
        transcriptHeight,
      );
    } else if (this.hasRendered) {
      this.onInput.viewport.onAppend(oldLayout, layout, transcriptHeight);
    } else {
      this.onInput.viewport.clamp(layout, transcriptHeight);
    }
    this.hasRendered = true;
    this.lastWidth = width;
    this.lastHeight = transcriptHeight;
    const visible = layout.lines.slice(
      this.onInput.viewport.scrollTop,
      this.onInput.viewport.scrollTop + transcriptHeight,
    );
    while (visible.length < transcriptHeight) visible.push("");
    visible.push(
      ...renderFooter(this.snapshot, {
        width,
        theme: this.theme,
        level: this.onInput.viewport.level,
      }),
    );
    return visible;
  }

  handleInput(data) {
    try {
      this.onInput.handle(data);
    } catch (error) {
      this.onFatal?.(error);
      throw error;
    }
  }

  invalidate() {}
}

const ENTER_MODES = "\x1b[?1049h\x1b[?1000h\x1b[?1006h";
const RESTORE_MODES = "\x1b[?1006l\x1b[?1000l\x1b[?1049l";

export async function createViewerApp({
  snapshot,
  ProcessTerminalClass = ProcessTerminal,
  TUIClass = TUI,
  installSignalHandlers = true,
  colorQueryTimeoutMs = 80,
  lifecycleTarget = process,
} = {}) {
  const terminal = new ProcessTerminalClass();
  const tui = new TUIClass(terminal);
  tui.setClearOnShrink(false);

  let theme = createTheme("dark", { conservative: true });
  let overlayHandle = null;
  let entered = false;
  let restored = false;
  let stopCompleted = false;
  let closing = null;
  let listenersInstalled = false;

  const removeLifecycleListeners = () => {
    if (!listenersInstalled) return;
    listenersInstalled = false;
    lifecycleTarget.removeListener("SIGINT", signalClose);
    lifecycleTarget.removeListener("SIGTERM", signalClose);
    lifecycleTarget.removeListener("exit", exitClose);
  };
  const stopTui = () => {
    if (stopCompleted) return;
    tui.stop();
    stopCompleted = true;
  };
  const restoreModes = () => {
    if (!entered || restored) return;
    terminal.write(RESTORE_MODES);
    restored = true;
  };
  const closeSynchronously = () => {
    removeLifecycleListeners();
    try {
      stopTui();
    } catch {}
    try {
      restoreModes();
    } catch {}
  };
  const close = () => {
    if (stopCompleted && (!entered || restored)) return Promise.resolve();
    if (closing) return closing;
    closing = Promise.resolve()
      .then(() => {
        removeLifecycleListeners();
        let firstError;
        try {
          stopTui();
        } catch (error) {
          firstError = error;
        }
        try {
          restoreModes();
        } catch (error) {
          firstError ??= error;
        }
        if (firstError) throw firstError;
      })
      .finally(() => {
        closing = null;
      });
    return closing;
  };
  function signalClose() {
    void close().catch(() => {});
  }
  function exitClose() {
    closeSynchronously();
  }
  const installLifecycleListeners = () => {
    if (!installSignalHandlers || listenersInstalled) return;
    listenersInstalled = true;
    lifecycleTarget.once("SIGINT", signalClose);
    lifecycleTarget.once("SIGTERM", signalClose);
    lifecycleTarget.once("exit", exitClose);
  };
  const fatal = () => {
    void close().catch(() => {});
  };
  const requestRender = () => {
    try {
      tui.requestRender();
    } catch (error) {
      fatal();
      throw error;
    }
  };

  const viewport = new ViewportState({ level: 1, followingBottom: true });
  const state = {
    viewport,
    gate: new VerbosityKeyGate({ quietMs: 120 }),
    layout: { lines: [], ranges: [] },
    height: Math.max(1, terminal.rows - footerRows(terminal.columns)),
    requestRender,
    onChildControl: undefined,
  };
  state.onCloseViewer = signalClose;
  state.onOpenPrompts = () => {
    if (overlayHandle) return;
    const overlay = new PromptOverlay({
      prompts: snapshot?.prompts,
      level: viewport.level,
      theme,
      height: Math.max(3, Math.floor(terminal.rows * 0.8)),
      onChange: requestRender,
      onClose: () => {
        overlayHandle?.hide();
        overlayHandle = null;
        requestRender();
      },
    });
    overlayHandle = tui.showOverlay(overlay, {
      width: "92%",
      maxHeight: "85%",
      anchor: "center",
      margin: 1,
    });
  };
  state.handle = (data) => handleViewerInput(state, data, Date.now());

  const root = new ViewerRoot({
    snapshot,
    terminal,
    theme,
    onInput: state,
    onFatal: fatal,
  });
  tui.addChild(root);
  tui.setFocus(root);

  try {
    terminal.write(ENTER_MODES);
    entered = true;
    installLifecycleListeners();
    tui.start();

    let mode;
    try {
      mode = await tui.queryTerminalColorScheme({
        timeoutMs: colorQueryTimeoutMs,
      });
    } catch {
      mode = undefined;
    }
    if (!mode) {
      let background;
      try {
        background = await tui.queryTerminalBackgroundColor({
          timeoutMs: colorQueryTimeoutMs,
        });
      } catch {
        background = undefined;
      }
      mode = modeFromBackground(background);
    }
    theme = mode
      ? createTheme(mode)
      : createTheme("dark", { conservative: true });
    root.theme = theme;
    root.invalidate();
    requestRender();
  } catch (error) {
    try {
      await close();
    } catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        "Viewer startup failed and terminal restoration was incomplete",
      );
    }
    throw error;
  }

  return {
    terminal,
    tui,
    root,
    state,
    get theme() {
      return theme;
    },
    close,
  };
}
