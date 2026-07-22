export type ViewerValue =
  | null
  | boolean
  | number
  | string
  | ViewerValue[]
  | { [key: string]: ViewerValue };

export type ViewerPromptKind =
  | "system"
  | "project-context"
  | "agent-template"
  | "extension"
  | "task";

export type ViewerPromptProvenance = "exact" | "derived" | "unavailable";

export interface ViewerTaskRecord {
  text: string;
  source: string;
  provenance: ViewerPromptProvenance;
}

export interface ViewerPromptRecord extends ViewerTaskRecord {
  kind: ViewerPromptKind;
  title: string;
}

export interface ViewerManifest {
  version: 1;
  capturedAt: string | null;
  child: {
    agent?: string;
    index?: number;
    runId?: string;
    tagline?: string;
    agentFile?: string;
  };
  launch: {
    promptMode: string | null;
    task: ViewerTaskRecord | null;
  };
  prompts: ViewerPromptRecord[];
  runtime: {
    provider?: string;
    model?: string;
    contextWindow?: number;
  };
}

export interface ViewerItem {
  id: string;
  kind: string;
  label: string;
  startedAt: number;
  endedAt: number | null;
  status: "unknown" | "active" | "succeeded" | "failed" | "settled";
  payload: Record<string, unknown>;
  provenance: "exact";
}

export interface ViewerMetrics {
  tools: number;
  failed: number;
  retries: number;
  active: number;
  tokens: number;
  cost: number;
  elapsedMs: number;
  provider: string | null;
  model: string | null;
  contextUsed: number | null;
  contextLimit: number | null;
}

export interface ViewerSnapshot {
  observedAt: number;
  manifest: ViewerManifest;
  prompts: ViewerPromptRecord[];
  items: ViewerItem[];
  omittedLogicalLines: number;
  metrics: ViewerMetrics;
}

export interface MaterializedTranscript {
  header: string;
  body: string[];
  footer: string[];
}

export const MAX_TRANSCRIPT_ROWS: 10000;

export const VERBOSITY_LEVELS: readonly [
  { readonly id: "compact"; readonly narrativeLines: 5; readonly toolLines: 0 },
  {
    readonly id: "readable";
    readonly narrativeLines: 15;
    readonly toolLines: 1;
  },
  {
    readonly id: "detailed";
    readonly narrativeLines: number;
    readonly toolLines: 5;
  },
  {
    readonly id: "full";
    readonly narrativeLines: number;
    readonly toolLines: number;
  },
];

export function sanitizeText(value: unknown): string;
export function normalizeManifest(value: unknown): ViewerManifest;
export function capLogicalLines(
  lines: readonly unknown[],
  limit: number,
): string[];
export function materializeItem(
  item: unknown,
  level?: number,
): MaterializedTranscript;
export function materializePrompts(
  prompts: readonly unknown[],
  level?: number,
): MaterializedTranscript[];

export class ViewerModel {
  constructor(options?: {
    manifest?: unknown;
    now?: () => unknown;
    maxTranscriptLines?: number;
  });

  ingestLine(
    line: unknown,
    options?: { source?: unknown; receivedAt?: unknown },
  ): void;

  ingestEvent(event: unknown, options?: { receivedAt?: unknown }): void;

  snapshot(now?: unknown): ViewerSnapshot;
}
