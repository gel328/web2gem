import { GEMINI_WEB_USER_AGENT } from "../constants";
import { httpFetch } from "../transport";
import { extractGeminiBuildLabel } from "../app-page";
import { errorLogSummary, log, sleep } from "../../shared/runtime";
import type { RuntimeConfig } from "../../config";

export const GEMINI_BL_CACHE_TTL_SEC = 12 * 60 * 60;

const GEMINI_BL_CACHE_PREFIX = "https://internal-cache/gemini-bl/";
const buildLabelRefreshes = new Map<string, Promise<string>>();
let buildLabelL1: { origin: string; label: string; expiresAt: number } = { origin: "", label: "", expiresAt: 0 };

type BuildLabelCachePayload = {
  gemini_bl?: unknown;
  created_at_ms?: unknown;
};

function geminiOrigin(cfg: RuntimeConfig): string {
  return (cfg.gemini_origin || "https://gemini.google.com").replace(/\/$/, "");
}

function geminiBuildLabelCacheKey(origin: string): Request {
  return new Request(`${GEMINI_BL_CACHE_PREFIX}${encodeURIComponent(origin)}`);
}

function workerCache(): Cache | null {
  if (typeof caches === "undefined") return null;
  const cacheStorage = caches as CacheStorage & { default?: Cache };
  return cacheStorage.default || null;
}

function validGeminiBuildLabel(value: unknown): string {
  const label = typeof value === "string" ? value.trim() : "";
  return label ? label : "";
}

function setBuildLabelL1(origin: string, label: string, now: number = Date.now()): void {
  buildLabelL1 = {
    origin,
    label,
    expiresAt: now + GEMINI_BL_CACHE_TTL_SEC * 1000,
  };
}

function clearBuildLabelL1(origin?: string): void {
  if (!origin || buildLabelL1.origin === origin) {
    buildLabelL1 = { origin: "", label: "", expiresAt: 0 };
  }
}

function cachePutGeminiBuildLabel(cfg: RuntimeConfig, origin: string, buildLabel: string, now: number): Promise<void> {
  const cache = workerCache();
  if (!cache) return Promise.resolve();
  return cache.put(geminiBuildLabelCacheKey(origin), new Response(JSON.stringify({
    gemini_bl: buildLabel,
    created_at_ms: now,
  }), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": `public, max-age=${GEMINI_BL_CACHE_TTL_SEC}`,
    },
  })).catch((e) => {
    log(cfg, `failed to cache Gemini BL ${errorLogSummary(e)}`);
  });
}

export async function getCachedGeminiBuildLabel(cfg: RuntimeConfig): Promise<string> {
  const origin = geminiOrigin(cfg);
  const now = Date.now();
  if (buildLabelL1.origin === origin && buildLabelL1.expiresAt > now) {
    return buildLabelL1.label;
  }
  clearBuildLabelL1(origin);
  const cache = workerCache();
  if (!cache) return "";
  try {
    const resp = await cache.match(geminiBuildLabelCacheKey(origin));
    if (!resp) return "";
    const data = await resp.json().catch(() => null) as BuildLabelCachePayload | null;
    const label = validGeminiBuildLabel(data && data.gemini_bl);
    const createdAt = Number(data && data.created_at_ms);
    if (!label || !Number.isFinite(createdAt)) return "";
    if (now - createdAt > GEMINI_BL_CACHE_TTL_SEC * 1000) {
      await cache.delete(geminiBuildLabelCacheKey(origin)).catch(() => false);
      return "";
    }
    setBuildLabelL1(origin, label, createdAt);
    return label;
  } catch (e) {
    log(cfg, `failed to read cached Gemini BL ${errorLogSummary(e)}`);
    return "";
  }
}

export async function setCachedGeminiBuildLabel(cfg: RuntimeConfig, label: string): Promise<void> {
  const buildLabel = validGeminiBuildLabel(label);
  if (!buildLabel) return;
  const origin = geminiOrigin(cfg);
  const now = Date.now();
  setBuildLabelL1(origin, buildLabel, now);
  const write = cachePutGeminiBuildLabel(cfg, origin, buildLabel, now);
  if (cfg.execution_ctx) {
    cfg.execution_ctx.waitUntil(write);
    return;
  }
  await write;
}

export async function configWithCachedGeminiBuildLabel(cfg: RuntimeConfig): Promise<RuntimeConfig> {
  const cachedBL = await getCachedGeminiBuildLabel(cfg);
  if (!cachedBL || cachedBL === cfg.gemini_bl) return cfg;
  return { ...cfg, gemini_bl: cachedBL };
}

export async function getFreshGeminiBuildLabel(cfg: RuntimeConfig): Promise<string> {
  const refreshKey = geminiOrigin(cfg);
  const pending = buildLabelRefreshes.get(refreshKey);
  if (pending) return pending;

  const refresh = fetchFreshGeminiBuildLabel(cfg);
  buildLabelRefreshes.set(refreshKey, refresh);
  try {
    const freshBL = await refresh;
    if (freshBL) await setCachedGeminiBuildLabel(cfg, freshBL);
    return freshBL;
  } finally {
    buildLabelRefreshes.delete(refreshKey);
  }
}

export function resetGeminiBuildLabelCacheForTest(): void {
  clearBuildLabelL1();
  buildLabelRefreshes.clear();
}

async function fetchFreshGeminiBuildLabel(cfg: RuntimeConfig): Promise<string> {
  try {
    const headers: Record<string, string> = { "User-Agent": GEMINI_WEB_USER_AGENT, "Accept-Language": "en-US,en;q=0.9" };
    if (cfg.cookie) headers["Cookie"] = cfg.cookie;
    const resp = await httpFetch(`${cfg.gemini_origin || "https://gemini.google.com"}/app`, {
      headers,
      timeoutMs: 30000,
      socket: cfg.upstream_socket,
      cfg,
    });
    return await extractGeminiBuildLabel(resp);
  } catch (e) {
    log(cfg, `failed to refresh Gemini BL ${errorLogSummary(e)}`);
    return "";
  }
}

export async function refreshGeminiBuildLabelForRetry(
  cfg: RuntimeConfig,
  activeCfg: RuntimeConfig,
  alreadyRefreshed: boolean,
  context: string,
): Promise<RuntimeConfig | null> {
  if (alreadyRefreshed) return null;
  const freshBL = await getFreshGeminiBuildLabel(cfg);
  if (!freshBL || freshBL === activeCfg.gemini_bl) return null;
  const suffix = context ? ` ${context}` : "";
  log(cfg, `retrying${suffix} with refreshed GEMINI_BL=${freshBL}`);
  return { ...activeCfg, gemini_bl: freshBL };
}

export async function waitBeforeRetry(
  cfg: RuntimeConfig,
  attempt: number,
  error: unknown,
  label: string,
  signal: AbortSignal | null | undefined = undefined,
): Promise<boolean> {
  if (attempt >= Math.max(0, cfg.retry_attempts || 0) - 1) return false;
  log(cfg, `${label} ${attempt + 1}/${cfg.retry_attempts} ${errorLogSummary(error)}`);
  await sleep(cfg.retry_delay_sec * 1000, signal);
  return true;
}
