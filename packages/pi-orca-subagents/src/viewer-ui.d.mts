import type { Component, OverlayHandle, RgbColor, TerminalColorScheme } from "@earendil-works/pi-tui";
import type { ViewerTheme } from "./viewer-theme.mjs";

export interface ViewerLayoutRange {
  id: string;
  start: number;
  end: number;
}

export interface ViewerLayout {
  lines: string[];
  ranges: ViewerLayoutRange[];
}

export interface ViewportStateOptions {
  level?: number;
  scrollTop?: number;
  followingBottom?: boolean;
}

export class ViewportState {
  constructor(options?: ViewportStateOptions);
  level: number;
  scrollTop: number;
  followingBottom: boolean;
  scrollBy(delta: number, layout: ViewerLayout, height: number): number;
  goTop(): number;
  goBottom(layout: ViewerLayout, height: number): number;
  changeLevel(level: number, oldLayout: ViewerLayout, newLayout: ViewerLayout, height: number): number;
  onAppend(oldLayout: ViewerLayout, newLayout: ViewerLayout, height: number): number;
  onResize(oldLayout: ViewerLayout, newLayout: ViewerLayout, oldHeight: number, newHeight?: number): number;
  clamp(layout: ViewerLayout, height: number): number;
}

export class VerbosityKeyGate {
  constructor(options?: { quietMs?: number });
  quietMs: number;
  direction: number;
  lastAt: number;
  accept(direction: number, at: number): boolean;
}

export function layoutTimeline(items: readonly unknown[], level?: number): ViewerLayout;
export function layoutPrompts(prompts: readonly unknown[], level?: number): ViewerLayout;

export type { ViewerFooterMode, ViewerRenderOptions } from "./viewer-render.mjs";
export {
  footerMode,
  footerRows,
  renderFooter,
  renderPromptLines,
  renderViewerLines,
  wideFooterMinWidth,
} from "./viewer-render.mjs";

export interface PromptOverlayOptions {
  prompts?: readonly unknown[];
  level?: number;
  theme?: ViewerTheme;
  height?: number;
  onClose?: () => void;
  onChange?: () => void;
}

export class PromptOverlay implements Component {
  constructor(options?: PromptOverlayOptions);
  prompts: readonly unknown[];
  level: number;
  theme: ViewerTheme;
  height: number;
  scrollTop: number;
  lastWidth: number;
  onClose?: () => void;
  onChange?: () => void;
  allPromptRows(width?: number): string[];
  handleInput(data: string): void;
  render(width: number): string[];
  invalidate(): void;
}

export interface ViewerInputState {
  viewport: ViewportState;
  gate?: VerbosityKeyGate;
  layout?: ViewerLayout;
  height?: number;
  layoutForLevel?: (level: number) => ViewerLayout;
  onOpenPrompts?: () => void;
  onCloseViewer?: () => void;
  onChildControl?: () => void;
  requestRender?: () => void;
  handle?: (data: string) => boolean;
}

export function handleViewerInput(state: ViewerInputState, data: string, now?: number): boolean;

export interface ViewerTerminalLike {
  readonly columns: number;
  readonly rows: number;
  readonly kittyProtocolActive: boolean;
  write(data: string): void;
}

export interface ViewerTuiLike {
  setClearOnShrink(enabled: boolean): void;
  addChild(component: Component): void;
  setFocus(component: Component | null): void;
  showOverlay(component: Component, options?: object): OverlayHandle | { hide(): void };
  start(): void;
  stop(): void;
  requestRender(force?: boolean): void;
  queryTerminalColorScheme(options: { timeoutMs: number }): Promise<TerminalColorScheme | undefined>;
  queryTerminalBackgroundColor(options: { timeoutMs: number }): Promise<RgbColor | undefined>;
}

export interface ViewerLifecycleTarget {
  once(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown;
}

export interface CreateViewerAppOptions<
  TerminalType extends ViewerTerminalLike = ViewerTerminalLike,
  TuiType extends ViewerTuiLike = ViewerTuiLike,
> {
  snapshot?: unknown;
  ProcessTerminalClass?: new () => TerminalType;
  TUIClass?: new (terminal: TerminalType) => TuiType;
  installSignalHandlers?: boolean;
  colorQueryTimeoutMs?: number;
  lifecycleTarget?: ViewerLifecycleTarget;
}

export interface ViewerApp<
  TerminalType extends ViewerTerminalLike = ViewerTerminalLike,
  TuiType extends ViewerTuiLike = ViewerTuiLike,
> {
  terminal: TerminalType;
  tui: TuiType;
  root: Component;
  state: ViewerInputState;
  readonly theme: ViewerTheme;
  close(): Promise<void>;
}

export function createViewerApp<
  TerminalType extends ViewerTerminalLike = ViewerTerminalLike,
  TuiType extends ViewerTuiLike = ViewerTuiLike,
>(options?: CreateViewerAppOptions<TerminalType, TuiType>): Promise<ViewerApp<TerminalType, TuiType>>;
