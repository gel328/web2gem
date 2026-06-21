import { isRecord, type UnknownRecord } from "./types";

export type ParsedImageUrl = { url: string } | { b64: string; mime: string };

export function parseImageUrl(url: unknown): ParsedImageUrl | null {
  if (!url || typeof url !== "string") return null;
  const m = /^data:([^,]*?);base64,([\s\S]*)$/i.exec(url);
  if (m) return { b64: m[2] || "", mime: ((m[1] || "").split(";")[0] || "image/png").toLowerCase() };
  if (/^https?:\/\//i.test(url)) return { url };
  return null;
}

export function firstNonEmptyString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

export function sanitizeUploadFilename(name: unknown): string {
  if (typeof name !== "string" && typeof name !== "number") return "";
  let safeName = String(name || "").trim();
  if (!safeName) return "";
  safeName = safeName.replace(/\0/g, "").replace(/[\r\n\t]/g, " ").trim();
  safeName = safeName.split(/[\\/]/).filter(Boolean).pop() || "";
  safeName = safeName.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!safeName || safeName === "." || safeName === "..") return "";
  return safeName.slice(0, 180);
}

export function filenameFromUrl(url: unknown): string {
  if (!url || typeof url !== "string") return "";
  try {
    const u = new URL(url);
    const last = decodeURIComponent((u.pathname || "").split("/").filter(Boolean).pop() || "");
    return sanitizeUploadFilename(last);
  } catch (_) {
    const path = String(url || "").split(/[?#]/)[0];
    return sanitizeUploadFilename(path);
  }
}

export function imageFilenameFromObject(obj: unknown): string {
  if (!isRecord(obj)) return "";
  const record = obj;
  const source = isRecord(record.source) ? record.source : null;
  const imageUrl = isRecord(record.image_url) ? record.image_url : null;
  const inlineData = asOptionalRecord(record.inlineData) || asOptionalRecord(record.inline_data);
  const fileData = asOptionalRecord(record.fileData) || asOptionalRecord(record.file_data);
  const file = isRecord(record.file) ? record.file : null;
  return firstNonEmptyString(...[
    record.filename, record.fileName, record.file_name, record.name, record.displayName, record.display_name,
    source && (source.filename || source.fileName || source.file_name || source.name || source.displayName || source.display_name),
    imageUrl && (imageUrl.filename || imageUrl.fileName || imageUrl.file_name || imageUrl.name || imageUrl.displayName || imageUrl.display_name),
    inlineData && (inlineData.filename || inlineData.fileName || inlineData.file_name || inlineData.name || inlineData.displayName || inlineData.display_name),
    fileData && (fileData.filename || fileData.fileName || fileData.file_name || fileData.name || fileData.displayName || fileData.display_name),
    file && (file.filename || file.fileName || file.file_name || file.name || file.displayName || file.display_name)
  ].map(sanitizeUploadFilename));
}

function asOptionalRecord(value: unknown): UnknownRecord | null {
  return isRecord(value) ? value : null;
}

export function imageFilenameFromMime(mime: unknown, index: number): string {
  const base = `image${index > 1 ? `-${index}` : ""}`;
  const typ = (String(mime || "").split(";")[0] || "").trim().toLowerCase();
  switch (typ) {
    case "image/jpeg":
    case "image/jpg":
      return `${base}.jpg`;
    case "image/webp":
      return `${base}.webp`;
    case "image/gif":
      return `${base}.gif`;
    case "image/bmp":
      return `${base}.bmp`;
    case "image/heic":
      return `${base}.heic`;
    case "image/heif":
      return `${base}.heif`;
    case "image/png":
    default:
      return `${base}.png`;
  }
}
