import { GEMINI_WEB_USER_AGENT } from "../constants";
import { makeSapisidHash, nowSec, uuid } from "../../shared/runtime";
import type { RuntimeConfig } from "../../config";

type PayloadFileRef = string | {
  ref?: unknown;
  fileRef?: unknown;
  id?: unknown;
  name?: unknown;
  filename?: unknown;
};

export function buildPayload(
  prompt: string,
  modelId: number,
  thinkMode: number,
  fileRefs: readonly PayloadFileRef[] | null,
  extra: Record<number, unknown> | null,
): string {
  const inner = new Array(102);
  if (fileRefs && fileRefs.length) {
    const files = fileRefs.map((item) => {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        return [[item.ref || item.fileRef || item.id || "", 1], item.name || item.filename || "file.txt"];
      }
      return [[item, 1], "file.txt"];
    });
    inner[0] = [prompt, 0, null, files, null, null, 0];
  } else {
    inner[0] = [prompt, 0, null, null, null, null, 0];
  }
  inner[1] = ["en"];
  inner[2] = ["", "", "", null, null, null, null, null, null, ""];
  inner[6] = [0];
  inner[7] = 1;
  inner[10] = 1;
  inner[11] = 0;
  inner[17] = [[thinkMode]];
  inner[18] = 0;
  inner[27] = 1;
  inner[30] = [4];
  inner[41] = [2];
  inner[53] = 0;
  inner[59] = uuid();
  inner[61] = [];
  inner[68] = 1;
  inner[79] = modelId;
  if (extra) {
    for (const k of Object.keys(extra)) {
      const index = Number(k);
      inner[index] = extra[index];
    }
  }
  const outer = [null, JSON.stringify(inner)];
  return new URLSearchParams({ "f.req": JSON.stringify(outer) }).toString();
}

export function getUrl(cfg: RuntimeConfig): string {
  const reqid = nowSec() % 1000000;
  const origin = (cfg.gemini_origin || "https://gemini.google.com").replace(/\/$/, "");
  return (
    origin +
    "/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate" +
    `?bl=${encodeURIComponent(cfg.gemini_bl)}&hl=en&_reqid=${reqid}&rt=c`
  );
}

export async function buildHeaders(cfg: RuntimeConfig): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    "Origin": "https://gemini.google.com",
    "Referer": "https://gemini.google.com/app",
    "X-Same-Domain": "1",
    "User-Agent": GEMINI_WEB_USER_AGENT,
    "Accept-Language": "en-US,en;q=0.9",
  };
  if (cfg.cookie) headers["Cookie"] = cfg.cookie;
  if (cfg.sapisid) headers["Authorization"] = await makeSapisidHash(cfg.sapisid);
  return headers;
}
