import { trimContinuationOverlap } from "../../shared/tokens";

const STREAM_APPEND_PROBE_CHARS = 64;

export function stripArtifacts(text: unknown): string {
  let source = String(text || "");
  if (!source) return "";
  if (source.indexOf("```") >= 0 && source.indexOf("code_event_index=") >= 0) {
    source = source.replace(/```(?:python|javascript|text)\?code_(?:reference|stdout)&code_event_index=\d+\n[\s\S]*?```\n?/g, "");
  }
  if (source.indexOf("googleusercontent.com/card_content") >= 0 && source.indexOf("http://googleusercontent.com/card_content/") >= 0) {
    source = source.replace(/http:\/\/googleusercontent\.com\/card_content\/\d+\n?/g, "");
  }
  return source;
}

function hasArtifactMarkers(source: string): boolean {
  return (
    source.indexOf("```") >= 0
    && source.indexOf("code_event_index=") >= 0
  ) || (
    source.indexOf("googleusercontent.com/card_content") >= 0
    && source.indexOf("http://googleusercontent.com/card_content/") >= 0
  );
}

export function cleanText(text: unknown): string {
  return stripArtifacts(text).trim();
}

export function extractTextsFromLine(line: unknown): string[] {
  const source = String(line || "");
  if (!isWrbResponseLineCandidate(source)) return [];
  try {
    const arr = JSON.parse(source);
    if (!Array.isArray(arr) || !Array.isArray(arr[0])) return [];
    const innerStr = arr[0][2];
    if (typeof innerStr !== "string" || innerStr.length < 50) return [];
    const inner = JSON.parse(innerStr);
    if (!(Array.isArray(inner) && inner.length > 4 && inner[4])) return [];
    const texts: string[] = [];
    for (const part of inner[4]) {
      if (Array.isArray(part) && part.length > 1 && part[1] && Array.isArray(part[1])) {
        for (const t of part[1]) {
          if (typeof t === "string" && t) texts.push(t);
        }
      }
    }
    return texts;
  } catch (_) {
    return [];
  }
}

function isWrbResponseLineCandidate(source: string): boolean {
  if (source.length < 200) return false;
  let i = skipJsonWhitespace(source, 0);
  if (source.charCodeAt(i) !== 91) return false; // [
  i = skipJsonWhitespace(source, i + 1);
  if (source.charCodeAt(i) !== 91) return false; // [
  i = skipJsonWhitespace(source, i + 1);
  return source.startsWith('"wrb.fr"', i);
}

function skipJsonWhitespace(source: string, index: number): number {
  while (index < source.length) {
    const c = source.charCodeAt(index);
    if (c !== 32 && c !== 9 && c !== 10 && c !== 13) break;
    index += 1;
  }
  return index;
}

export function extractResponseText(raw: unknown): string {
  let lastText = "";
  const source = String(raw || "");
  for (const line of iterateLines(source)) {
    for (const t of extractTextsFromLine(line)) {
      if (t.length > lastText.length) lastText = t;
    }
  }
  return cleanText(lastText);
}

function* iterateLines(source: string): Generator<string> {
  let start = 0;
  while (start <= source.length) {
    const idx = source.indexOf("\n", start);
    if (idx < 0) {
      yield source.slice(start);
      return;
    }
    yield source.slice(start, idx);
    start = idx + 1;
  }
}

export function createStreamTextExtractor() {
  let prevVisible = "";
  let prevRaw = "";
  let prevRawHead = "";
  let prevRawTail = "";
  let prevRawHasArtifacts = false;
  let started = false;
  const rememberRaw = (raw: string) => {
    prevRaw = raw;
    prevRawHead = raw.slice(0, STREAM_APPEND_PROBE_CHARS);
    prevRawTail = raw.slice(-STREAM_APPEND_PROBE_CHARS);
    prevRawHasArtifacts = hasArtifactMarkers(raw);
  };
  const rawAppendDelta = (raw: string): string | null => {
    if (!prevRaw || raw.length <= prevRaw.length || prevRawHasArtifacts) return null;
    if (prevRaw.length <= STREAM_APPEND_PROBE_CHARS * 2) {
      if (!raw.startsWith(prevRaw)) return null;
    } else if (
      raw.slice(0, prevRawHead.length) !== prevRawHead
      || raw.slice(prevRaw.length - prevRawTail.length, prevRaw.length) !== prevRawTail
    ) {
      return null;
    }
    const delta = raw.slice(prevRaw.length);
    if (hasArtifactMarkers(prevRawTail + delta)) return null;
    return delta;
  };
  const consumeLine = function* (line: unknown): Generator<string> {
    for (const t of extractTextsFromLine(line)) {
      const raw = String(t || "");
      let delta = "";
      const appendedRawDelta = rawAppendDelta(raw);
      if (appendedRawDelta !== null) {
        delta = appendedRawDelta;
        prevVisible += delta;
        rememberRaw(raw);
      } else {
        const visible = stripArtifacts(raw);
        if (!prevVisible) {
          delta = visible;
          prevVisible = visible;
          rememberRaw(raw);
        } else if (visible.length > prevVisible.length && visible.startsWith(prevVisible)) {
          delta = visible.slice(prevVisible.length);
          prevVisible = visible;
          rememberRaw(raw);
        } else if (prevVisible.startsWith(visible)) {
          continue;
        } else {
          delta = trimContinuationOverlap(prevVisible, visible);
          if (!delta) {
            if (visible.length > prevVisible.length) {
              prevVisible = visible;
              rememberRaw(raw);
            }
            continue;
          }
          prevVisible += delta;
          rememberRaw(raw);
        }
      }
      if (!started) delta = delta.replace(/^\s+/, "");
      if (delta) {
        started = true;
        yield delta;
      }
    }
  };
  return { consumeLine };
}
