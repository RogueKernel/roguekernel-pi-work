export type ViewerThemeMode = "light" | "dark";
export type ViewerRgb = `${number};${number};${number}`;

export interface ViewerTheme {
  readonly mode: ViewerThemeMode;
  readonly color: boolean;
  readonly conservative: boolean;
  readonly foreground: string;
  readonly headerSurface: string;
  readonly surface: string;
  readonly dock: string;
  readonly muted: string;
  readonly prompt: string;
  readonly structural: string;
  readonly success: string;
  readonly failure: string;
  eventColor(kind: unknown): string;
  fg(text: string, rgb?: string): string;
  bg(text: string, rgb?: string): string;
  bold(text: string): string;
}

export function createTheme(
  mode?: ViewerThemeMode,
  options?: { color?: boolean; conservative?: boolean },
): ViewerTheme;
export function modeFromBackground(
  color: { r: number; g: number; b: number } | null | undefined,
): ViewerThemeMode | null;
