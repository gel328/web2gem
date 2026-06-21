import { addTokenCharCounts, asTokenText, buildTextWithTokens, tokenCharCounts, tokenCountFromCounts } from "../shared/tokens";
import type { PreparedTokenText, TokenCharCounts } from "../shared/tokens";
import { isRecord } from "../shared/types";
import { GEMINI_NATIVE_HIDDEN_TOOLS_PROMPT } from "../toolcall/prompt-format";

type TokenCountsWithTextFlag = TokenCharCounts & { hasText: boolean };

function preparedText(prepared: unknown): unknown {
  return isRecord(prepared) ? prepared.text : undefined;
}

function preparedCounts(prepared: unknown): TokenCountsWithTextFlag | null {
  if (!isRecord(prepared) || !isRecord(prepared.counts)) return null;
  return {
    asciiChars: typeof prepared.counts.asciiChars === "number" ? prepared.counts.asciiChars : 0,
    nonASCIIChars: typeof prepared.counts.nonASCIIChars === "number" ? prepared.counts.nonASCIIChars : 0,
    hasText: prepared.counts.hasText === true,
  };
}

function objectFromPrepared(prepared: unknown): Record<string, unknown> {
  return prepared == null ? {} : Object(prepared) as Record<string, unknown>;
}

export function structuredInstruction(requirement: unknown): string {
  if (!isRecord(requirement)) return "";
  return typeof requirement.instruction === "string" ? requirement.instruction : "";
}

export function withGeminiNativeHiddenToolsPromptWithTokens(prompt: unknown, keepText: boolean = true): PreparedTokenText {
  const base = String(prompt || "").trimEnd();
  if (!base) {
    const text = prompt || "";
    return buildTextWithTokens([text], keepText);
  }
  return buildTextWithTokens([base, "\n\n", GEMINI_NATIVE_HIDDEN_TOOLS_PROMPT], keepText);
}

export function appendTextToPreparedWithTokens(prepared: unknown, parts: readonly unknown[] | null | undefined, keepText: boolean = true): PreparedTokenText {
  const sourceCounts = preparedCounts(prepared);
  if (!sourceCounts) {
    return buildTextWithTokens([preparedText(prepared), ...(parts || [])], keepText);
  }
  const counts: TokenCountsWithTextFlag = { asciiChars: 0, nonASCIIChars: 0, hasText: false };
  addTokenCharCounts(counts, sourceCounts);
  const text = preparedText(prepared);
  const out = keepText ? [text ? String(text) : ""] : null;
  for (const part of parts || []) {
    const text = asTokenText(part);
    if (!text) continue;
    const partCounts = tokenCharCounts(text);
    addTokenCharCounts(counts, { ...partCounts, hasText: true });
    if (out) out.push(text);
  }
  return { text: out ? out.join("") : "", tokens: tokenCountFromCounts(counts), counts };
}

export function withGeminiNativeHiddenToolsPromptForPrepared(prepared: unknown, keepText: boolean = true): unknown {
  const counts = preparedCounts(prepared);
  if (!counts) return withGeminiNativeHiddenToolsPromptWithTokens(preparedText(prepared), keepText);
  if (!counts.hasText) return keepText ? prepared : { ...objectFromPrepared(prepared), text: "" };
  if (keepText) {
    const text = String(preparedText(prepared) || "");
    if (text.trimEnd() !== text) return withGeminiNativeHiddenToolsPromptWithTokens(text, keepText);
  }
  return appendTextToPreparedWithTokens(prepared, ["\n\n", GEMINI_NATIVE_HIDDEN_TOOLS_PROMPT], keepText);
}

export function appendStructuredOutputInstructionWithTokens(prompt: unknown, requirement: unknown, keepText: boolean = true): PreparedTokenText {
  const instruction = structuredInstruction(requirement);
  if (!instruction) {
    const text = prompt || "";
    return buildTextWithTokens([text], keepText);
  }
  const base = String(prompt || "").trimEnd();
  const prepared = base
    ? buildTextWithTokens([base, "\n\n", instruction], keepText)
    : buildTextWithTokens([instruction], keepText);
  return prepared;
}

export function appendStructuredOutputInstructionToPrepared(prepared: unknown, requirement: unknown, keepText: boolean = true): unknown {
  const instruction = structuredInstruction(requirement);
  if (!instruction) {
    return keepText ? prepared : { ...objectFromPrepared(prepared), text: "" };
  }
  const countsSource = preparedCounts(prepared);
  const text = String(preparedText(prepared) || "");
  if (!countsSource || (keepText && text.trimEnd() !== text)) {
    return appendStructuredOutputInstructionWithTokens(preparedText(prepared), requirement, keepText);
  }
  const parts: string[] = [];
  const counts: TokenCountsWithTextFlag = { asciiChars: 0, nonASCIIChars: 0, hasText: false };
  addTokenCharCounts(counts, countsSource);
  if (countsSource.hasText) {
    parts.push(text || "");
    const sepCounts = tokenCharCounts("\n\n");
    addTokenCharCounts(counts, { ...sepCounts, hasText: true });
    if (keepText) parts.push("\n\n");
  }
  const instructionCounts = tokenCharCounts(instruction);
  addTokenCharCounts(counts, { ...instructionCounts, hasText: !!instruction });
  if (keepText) parts.push(instruction);
  return { text: keepText ? parts.join("") : "", tokens: tokenCountFromCounts(counts), counts };
}
