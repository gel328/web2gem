import { imageFilenameFromObject, sanitizeUploadFilename } from "../shared/media";
import { isRecord } from "../shared/types";

type OpenAIRefFile = string | { id: string; name: string };

export function collectOpenAIRefFileIDs(req: unknown): OpenAIRefFile[] | null {
  if (!isRecord(req)) return null;
  const out: OpenAIRefFile[] = [];
  const seen = new Set<string>();
  for (const key of ["ref_file_ids", "file_ids", "attachments", "messages", "input"]) {
    const raw = req[key];
    if (raw == null) continue;
    if ((key === "messages" || key === "input") && typeof raw === "string") continue;
    appendOpenAIRefFileIDs(out, seen, raw);
  }
  return out.length ? out : null;
}

export function appendOpenAIRefFileIDs(out: OpenAIRefFile[], seen: Set<string>, raw: unknown): void {
  if (raw == null) return;
  if (typeof raw === "string") { addOpenAIRefFileID(out, seen, raw); return; }
  if (Array.isArray(raw)) { for (const item of raw) appendOpenAIRefFileIDs(out, seen, item); return; }
  if (!isRecord(raw)) return;

  const rawFilename = imageFilenameFromObject(raw);
  if (raw.file_id != null) addOpenAIRefFileID(out, seen, raw.file_id, rawFilename);
  const typ = String(raw.type || "").trim().toLowerCase();
  if (typ.includes("file") && raw.id != null) addOpenAIRefFileID(out, seen, raw.id, rawFilename);
  const file = isRecord(raw.file) ? raw.file : null;
  if (file) {
    const fileFilename = imageFilenameFromObject(file) || rawFilename;
    if (file.file_id != null) addOpenAIRefFileID(out, seen, file.file_id, fileFilename);
    if (file.id != null) addOpenAIRefFileID(out, seen, file.id, fileFilename);
  }
  for (const key of ["ref_file_ids", "file_ids", "attachments", "messages", "input", "content", "files", "items", "data", "source"]) {
    if (!(key in raw)) continue;
    const nested = raw[key];
    if ((key === "content" || key === "input") && typeof nested === "string") continue;
    appendOpenAIRefFileIDs(out, seen, nested);
  }
}

export function addOpenAIRefFileID(out: OpenAIRefFile[], seen: Set<string>, fileID: unknown, filename: unknown = undefined): void {
  const id = String(fileID || "").trim();
  if (!id || seen.has(id)) return;
  seen.add(id);
  const name = sanitizeUploadFilename(filename);
  out.push(name ? { id, name } : id);
}
