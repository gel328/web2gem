export type UnknownRecord = Record<string, unknown>;

export type ErrorWithMetadata = Error & {
  code?: string;
  status?: number;
  promptBytes?: number;
  promptBytesExact?: boolean;
  thresholdBytes?: number;
  upstreamStatus?: number;
  rawLength?: number | null;
  reason?: string;
  cause?: unknown;
};

export function isRecord(value: unknown): value is UnknownRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
