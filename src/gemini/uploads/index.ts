import { GEMINI_WEB_USER_AGENT } from "../constants";
import { httpFetch } from "../transport";
import { extractGeminiAppPageTokens, type GeminiAppPageTokens } from "../app-page";
import { TEXT_ENCODER, errorLogSummary, log, makeSapisidHash, timeoutSignal } from "../../shared/runtime";
import { filenameFromUrl, firstNonEmptyString, imageFilenameFromMime, sanitizeUploadFilename } from "../../shared/media";
import { isRecord } from "../../shared/types";
import { configWithFreshGeminiCookie, rotateGeminiCookieForRetry } from "../cookies";
import type { RuntimeConfig } from "../../config";

export { filenameFromUrl, firstNonEmptyString, imageFilenameFromMime, imageFilenameFromObject, parseImageUrl, sanitizeUploadFilename } from "../../shared/media";

type PageTokens = GeminiAppPageTokens;
type PageTokenCache = { key: string; tokens: PageTokens | null; ts: number };
type PageTokenPending = { key: string; promise: Promise<PageTokens> | null };
type UploadFileRef = string | {
  ref?: string;
  fileRef?: string;
  id?: string;
  name?: string;
  filename?: string;
};
type UploadImageResolutionResult = {
  fileRefs: UploadFileRef[] | null;
  droppedNote: string;
};
type ResolvedImageInput = {
  url?: string;
  b64?: unknown;
  mime?: unknown;
  filename?: unknown;
  name?: unknown;
};
type ImageUploadResult = {
  fileRef: UploadFileRef | null;
  error: unknown;
  bytesLength: number;
  mimeForLog: string;
};

const MAX_PARALLEL_IMAGE_UPLOADS = 4;

// ─── 多模态:图片上传(Scotty 续传)───────────────────────────────────────────
// 说明:图片输入需要登录态(GEMINI_COOKIE)。匿名会话上传文件能成功,但带图
// 生成会被后端以 BardErrorInfo[1100] 拒绝(权限门)。无 cookie 时不上传,
// 改为在 prompt 里追加一句提示,降级为纯文本。详见 test/live-image.mjs。

export const _UA = GEMINI_WEB_USER_AGENT;
export let _pageTokens: PageTokenCache = { key: "", tokens: null, ts: 0 };
export let _pageTokensPending: PageTokenPending = { key: "", promise: null };

export function resetGeminiUploadCachesForTest(): void {
  _pageTokens = { key: "", tokens: null, ts: 0 };
  _pageTokensPending = { key: "", promise: null };
}

export function base64ToBytes(b64: unknown): Uint8Array {
  const compact = String(b64 || "").replace(/\s+/g, "");
  const hasBase64UrlAlphabet = /[-_]/.test(compact);
  const fromBase64 = (Uint8Array as Uint8ArrayConstructor & { fromBase64?: (value: string, options?: { alphabet?: "base64" | "base64url" }) => Uint8Array }).fromBase64;
  if (typeof fromBase64 === "function") {
    try {
      return fromBase64(compact, hasBase64UrlAlphabet ? { alphabet: "base64url" } : undefined);
    } catch (_) {
      // Older runtimes may expose fromBase64 without base64url or unpadded input support.
    }
  }
  const normalized = hasBase64UrlAlphabet ? compact.replace(/-/g, "+").replace(/_/g, "/") : compact;
  const padded = normalized + "===".slice((normalized.length + 3) % 4);
  if (typeof fromBase64 === "function") return fromBase64(padded);
  if (typeof atob === "function") {
    const bin = atob(padded);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  throw new Error("base64 decoder is not available in this runtime");
}

// 抓取 gemini.google.com/app 页面里的上传 token(带 10 分钟缓存)。
export async function getPageTokens(cfg: RuntimeConfig): Promise<PageTokens> {
  const activeCfg = await configWithFreshGeminiCookie(cfg);
  return getPageTokensForConfig(activeCfg);
}

async function getPageTokensForConfig(activeCfg: RuntimeConfig): Promise<PageTokens> {
  const now = Date.now();
  const cacheKey = `${activeCfg.gemini_origin || "https://gemini.google.com"}\x00${activeCfg.cookie || ""}`;
  if (_pageTokens.tokens && _pageTokens.key === cacheKey && now - _pageTokens.ts < 600000) return _pageTokens.tokens;
  if (_pageTokensPending.promise && _pageTokensPending.key === cacheKey) return _pageTokensPending.promise;
  const promise = (async () => {
    const headers: Record<string, string> = { "User-Agent": _UA, "Accept-Language": "en-US,en;q=0.9" };
    if (activeCfg.cookie) headers["Cookie"] = activeCfg.cookie;
    const tokens: PageTokens = {};
    try {
      const resp = await httpFetch(`${activeCfg.gemini_origin || "https://gemini.google.com"}/app`, { headers, timeoutMs: 30000, socket: activeCfg.upstream_socket, cfg: activeCfg });
      Object.assign(tokens, await extractGeminiAppPageTokens(resp));
    } catch (e) {
      /* 用默认值兜底 */
    }
    _pageTokens = { key: cacheKey, tokens, ts: now };
    return tokens;
  })();
  _pageTokensPending = { key: cacheKey, promise };
  try {
    return await promise;
  } finally {
    if (_pageTokensPending.promise === promise) _pageTokensPending = { key: "", promise: null };
  }
}

// Scotty 续传上传一张图,返回文件引用(形如 "/contrib_service/ttl_1d/...")。
export async function uploadImage(cfg: RuntimeConfig, bytes: Uint8Array, mime: string): Promise<string> {
  const activeCfg = await configWithFreshGeminiCookie(cfg);
  return uploadImageWithConfig(activeCfg, bytes, mime, false);
}

async function uploadImageWithConfig(cfg: RuntimeConfig, bytes: Uint8Array, mime: string, retriedAfterRotate: boolean): Promise<string> {
  const tokens = await getPageTokensForConfig(cfg);
  const pushId = tokens.push_id || "feeds/mcudyrk2a4khkz";
  const pctx = tokens.pctx || "CgcSBWjK7pYx";

  const startHeaders: Record<string, string> = {
    "Push-ID": pushId,
    "X-Tenant-Id": "bard-storage",
    "X-Client-Pctx": pctx,
    "X-Goog-Upload-Header-Content-Length": String(bytes.length),
    "X-Goog-Upload-Header-Content-Type": mime,
    "X-Goog-Upload-Protocol": "resumable",
    "X-Goog-Upload-Command": "start",
    "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
    "User-Agent": _UA,
  };
  if (cfg.cookie) startHeaders["Cookie"] = cfg.cookie;
  if (cfg.sapisid) startHeaders["Authorization"] = await makeSapisidHash(cfg.sapisid);

  const r1 = await httpFetch("https://content-push.googleapis.com/upload/", { method: "POST", headers: startHeaders, body: "", timeoutMs: 30000, socket: cfg.upstream_socket, cfg });
  if (isAuthFailureStatus(r1.status) && !retriedAfterRotate) {
    const rotatedCfg = await rotateGeminiCookieForRetry(cfg);
    if (rotatedCfg) return uploadImageWithConfig(rotatedCfg, bytes, mime, true);
  }
  const uploadUrl = r1.headers.get("x-goog-upload-url");
  if (!uploadUrl) throw new Error(`no upload URL (status ${r1.status})`);

  const r2 = await httpFetch(uploadUrl, {
    method: "POST",
    headers: { "X-Goog-Upload-Command": "upload, finalize", "X-Goog-Upload-Offset": "0", "Content-Type": "application/octet-stream", "User-Agent": _UA },
    body: bytes,
    timeoutMs: 60000,
    socket: cfg.upstream_socket,
    cfg,
  });
  const fileRef = (await r2.text()).trim();
  if (!fileRef.startsWith("/")) throw new Error(`invalid file ref: ${fileRef.slice(0, 120)}`);
  return fileRef;
}

export async function uploadTextFile(cfg: RuntimeConfig, text: unknown, filename: unknown): Promise<UploadFileRef> {
  const activeCfg = await configWithFreshGeminiCookie(cfg);
  const bytes = TEXT_ENCODER.encode(String(text || ""));
  const name = String(filename || "context.txt");
  const ref = await uploadImageWithConfig(activeCfg, bytes, "text/plain; charset=utf-8", false);
  return { ref, name };
}

// 把收集到的图片解析/上传成文件引用。图片能力不可用时降级为纯文本请求,
// 并通过 droppedNote 明确告知模型图片输入被忽略。
export async function resolveImages(cfg: RuntimeConfig, images: unknown): Promise<UploadImageResolutionResult> {
  const activeCfg = await configWithFreshGeminiCookie(cfg);
  const imageList = normalizeImageInputs(images);
  if (!imageList.length) return { fileRefs: null, droppedNote: "" };
  if (!activeCfg.cookie) {
    log(activeCfg, `image input ignored images=${imageList.length} reason=missing_gemini_cookie`);
    return { fileRefs: null, droppedNote: imageDroppedNote(imageList.length, "image input requires a configured GEMINI_COOKIE") };
  }
  const refs: UploadFileRef[] = [];
  let firstError: unknown = null;
  const uploadResults = await mapWithConcurrency(imageList, MAX_PARALLEL_IMAGE_UPLOADS, (img, index) => uploadResolvedImage(activeCfg, img, index + 1));
  for (let i = 0; i < uploadResults.length; i++) {
    const result = uploadResults[i];
    if (!result) continue;
    if (result.fileRef) {
      refs.push(result.fileRef);
      continue;
    }
    firstError = firstError || result.error;
    log(activeCfg, `image upload failed index=${i + 1} mime=${result.mimeForLog || "unknown"} bytes=${result.bytesLength || "unknown"} ${errorLogSummary(result.error)}`);
  }
  if (refs.length !== imageList.length) {
    log(activeCfg, `image input partially ignored images=${imageList.length} uploaded=${refs.length} ${errorLogSummary(firstError)}`);
    return {
      fileRefs: refs.length ? refs : null,
      droppedNote: imageDroppedNote(imageList.length - refs.length, "some image uploads failed"),
    };
  }
  return { fileRefs: refs.length ? refs : null, droppedNote: "" };
}

async function uploadResolvedImage(activeCfg: RuntimeConfig, img: ResolvedImageInput, index: number): Promise<ImageUploadResult> {
  let bytesLength = 0;
  let mimeForLog = "";
  try {
    let bytes: Uint8Array;
    let mime: string;
    if (img.url) {
      const signal = timeoutSignal(activeCfg.request_timeout_sec * 1000);
      const r = await fetch(img.url, signal ? { signal } : undefined);
      if (!r.ok) throw new Error(`image fetch HTTP ${r.status}`);
      bytes = new Uint8Array(await r.arrayBuffer());
      mime = String(img.mime || r.headers.get("content-type") || "image/png");
    } else {
      bytes = base64ToBytes(img.b64);
      mime = String(img.mime || "image/png");
    }
    bytesLength = bytes.length;
    mimeForLog = String(mime || "");
    const ref = await uploadImageWithConfig(activeCfg, bytes, mime, false);
    const name = firstNonEmptyString(sanitizeUploadFilename(img.filename), sanitizeUploadFilename(img.name), img.url ? filenameFromUrl(img.url) : "") || imageFilenameFromMime(mime, index);
    return { fileRef: { ref, name }, error: null, bytesLength, mimeForLog };
  } catch (e) {
    return { fileRef: null, error: e, bytesLength, mimeForLog };
  }
}

async function mapWithConcurrency<T, R>(items: readonly T[], concurrency: number, mapper: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(Math.floor(concurrency) || 1, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      const item = items[index] as T;
      results[index] = await mapper(item, index);
    }
  });
  await Promise.all(workers);
  return results;
}

function normalizeImageInputs(images: unknown): ResolvedImageInput[] {
  if (!Array.isArray(images)) return [];
  const out: ResolvedImageInput[] = [];
  for (const image of images) {
    if (!isRecord(image)) continue;
    const url = typeof image.url === "string" ? image.url : "";
    const b64 = image.b64;
    if (!url && b64 == null) continue;
    const input: ResolvedImageInput = {
      b64,
      mime: image.mime,
      filename: image.filename,
      name: image.name,
    };
    if (url) input.url = url;
    out.push(input);
  }
  return out;
}

function imageDroppedNote(count: number, reason: string): string {
  return `\n\n[Note: ${count} image(s) were provided but ignored - ${reason}.]`;
}

function isAuthFailureStatus(status: unknown): boolean {
  return Number(status) === 401 || Number(status) === 403;
}
