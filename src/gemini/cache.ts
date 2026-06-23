import type { RuntimeConfig } from "../config";
import { errorLogSummary, log } from "../shared/runtime";

type OriginScopedStringCacheOptions = {
  cachePrefix: string;
  ttlSec: number;
  payloadKey: string;
  logLabel: string;
};

type OriginScopedStringCachePayload = Record<string, unknown> & {
  created_at_ms?: unknown;
};

function geminiOrigin(cfg: RuntimeConfig): string {
  return (cfg.gemini_origin || "https://gemini.google.com").replace(/\/$/, "");
}

function workerCache(): Cache | null {
  if (typeof caches === "undefined") return null;
  const cacheStorage = caches as CacheStorage & { default?: Cache };
  return cacheStorage.default || null;
}

export function createOriginScopedStringCache(options: OriginScopedStringCacheOptions) {
  const refreshes = new Map<string, Promise<string>>();
  let l1: { origin: string; value: string; expiresAt: number } = { origin: "", value: "", expiresAt: 0 };

  const cacheKey = (origin: string): Request => new Request(`${options.cachePrefix}${encodeURIComponent(origin)}`);

  const setL1 = (origin: string, value: string, now: number = Date.now()): void => {
    l1 = {
      origin,
      value,
      expiresAt: now + options.ttlSec * 1000,
    };
  };

  const clearL1 = (origin?: string): void => {
    if (!origin || l1.origin === origin) {
      l1 = { origin: "", value: "", expiresAt: 0 };
    }
  };

  const put = (cfg: RuntimeConfig, origin: string, value: string, now: number): Promise<void> => {
    const cache = workerCache();
    if (!cache) return Promise.resolve();
    return cache.put(cacheKey(origin), new Response(JSON.stringify({
      [options.payloadKey]: value,
      created_at_ms: now,
    }), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": `public, max-age=${options.ttlSec}`,
      },
    })).catch((e) => {
      logCacheError(cfg, `failed to cache ${options.logLabel}`, e);
    });
  };

  const getCached = async (cfg: RuntimeConfig): Promise<string> => {
    const origin = geminiOrigin(cfg);
    const now = Date.now();
    if (l1.origin === origin && l1.expiresAt > now) {
      return l1.value;
    }
    clearL1(origin);
    const cache = workerCache();
    if (!cache) return "";
    try {
      const resp = await cache.match(cacheKey(origin));
      if (!resp) return "";
      const data = await resp.json().catch(() => null) as OriginScopedStringCachePayload | null;
      const value = validString(data && data[options.payloadKey]);
      const createdAt = Number(data && data.created_at_ms);
      if (!value || !Number.isFinite(createdAt)) return "";
      if (now - createdAt > options.ttlSec * 1000) {
        await cache.delete(cacheKey(origin)).catch(() => false);
        return "";
      }
      setL1(origin, value, createdAt);
      return value;
    } catch (e) {
      logCacheError(cfg, `failed to read cached ${options.logLabel}`, e);
      return "";
    }
  };

  const deleteCached = async (cfg: RuntimeConfig): Promise<void> => {
    const origin = geminiOrigin(cfg);
    clearL1(origin);
    const cache = workerCache();
    if (!cache) return;
    await cache.delete(cacheKey(origin)).catch(() => false);
  };

  const setCached = async (cfg: RuntimeConfig, rawValue: string): Promise<void> => {
    const value = validString(rawValue);
    if (!value) return;
    const origin = geminiOrigin(cfg);
    const now = Date.now();
    setL1(origin, value, now);
    const write = put(cfg, origin, value, now);
    if (cfg.execution_ctx) {
      cfg.execution_ctx.waitUntil(write);
      return;
    }
    await write;
  };

  const getFresh = async (cfg: RuntimeConfig, fetchFresh: (cfg: RuntimeConfig) => Promise<string>): Promise<string> => {
    const refreshKey = geminiOrigin(cfg);
    const pending = refreshes.get(refreshKey);
    if (pending) return pending;

    const refresh = (async () => {
      const value = validString(await fetchFresh(cfg));
      if (value) await setCached(cfg, value);
      return value;
    })();
    refreshes.set(refreshKey, refresh);
    try {
      return await refresh;
    } finally {
      refreshes.delete(refreshKey);
    }
  };

  return {
    getCached,
    setCached,
    deleteCached,
    getFresh,
    reset(): void {
      clearL1();
      refreshes.clear();
    },
  };
}

function validString(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text : "";
}

function logCacheError(cfg: RuntimeConfig, prefix: string, error: unknown): void {
  log(cfg, `${prefix} ${errorLogSummary(error)}`);
}
