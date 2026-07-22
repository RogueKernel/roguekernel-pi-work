import type { ViewerTheme } from "./viewer-theme.mjs";

export interface ViewerRenderRange {
  id: string;
  start: number;
  end: number;
}

export interface ViewerRenderedLayout {
  lines: string[];
  ranges: ViewerRenderRange[];
}

export interface ViewerRenderOptions {
  width?: number;
  height?: number;
  level?: number;
  theme?: ViewerTheme;
  maxTranscriptRows?: number;
}

export type ViewerFooterMode = "wide" | "medium" | "narrow";

export function positiveDimension(value: unknown, fallback?: number): number;
export function paddedLine(value: string, width: number): string;
export function renderPromptLines(
  prompts: readonly unknown[],
  options?: Omit<ViewerRenderOptions, "height">,
): string[];
export function renderViewerLayout(
  snapshot: unknown,
  options?: ViewerRenderOptions,
): ViewerRenderedLayout;
export function renderViewerLines(
  snapshot: unknown,
  options?: ViewerRenderOptions,
): string[];
export function wideFooterMinWidth(): number;
export function footerMode(width: number): ViewerFooterMode;
export function footerRows(width: number): number;
export function renderFooter(
  snapshot: unknown,
  options?: Omit<ViewerRenderOptions, "height">,
): string[];
