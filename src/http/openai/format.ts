import { streamErrorText } from "../core/stream-errors";
import type { SSEWrite } from "../core/sse";
import { nowSec } from "../../shared/runtime";
import { tokenEst } from "../../shared/tokens";
import { isRecord } from "../../shared/types";

export { finalizeOpenAICompletionResult } from "../../completion/turn";

type OpenAIChunkDelta = Record<string, unknown>;
type OpenAIToolCall = {
  id: string;
  function: { name: string; arguments: string };
};

export function openAIChatChunk(id: string, model: unknown, delta: OpenAIChunkDelta | null | undefined, finishReason: string | null) {
  return {
    id,
    object: "chat.completion.chunk",
    created: nowSec(),
    model: String(model || ""),
    choices: [{ index: 0, delta: delta || {}, finish_reason: finishReason == null ? null : finishReason }],
  };
}

export function openAIChatUsageFromCompletionTokens(promptTokens: unknown, completionTokens: unknown) {
  const promptTokenCount = Math.max(0, Number(promptTokens) || 0);
  const completionTokenCount = Math.max(0, Number(completionTokens) || 0);
  return {
    prompt_tokens: promptTokenCount,
    completion_tokens: completionTokenCount,
    total_tokens: promptTokenCount + completionTokenCount,
  };
}

export async function writeOpenAIChatUsageTokenChunk(write: SSEWrite, id: string, model: unknown, promptTokens: unknown, completionTokens: unknown): Promise<void> {
  const result = write(`data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: nowSec(),
    model: String(model || ""),
    choices: [],
    usage: openAIChatUsageFromCompletionTokens(promptTokens, completionTokens),
  })}\n\n`);
  if (isPromiseLike(result)) await result;
}

export async function writeOpenAIChatStreamError(write: SSEWrite, id: string, model: unknown, e: unknown): Promise<void> {
  let result = write(`data: ${JSON.stringify(openAIChatChunk(id, model, { content: streamErrorText(e) }, null))}\n\n`);
  if (isPromiseLike(result)) await result;
  result = write(`data: ${JSON.stringify(openAIChatChunk(id, model, {}, "stop"))}\n\n`);
  if (isPromiseLike(result)) await result;
  result = write("data: [DONE]\n\n");
  if (isPromiseLike(result)) await result;
}

export function openAIResponsesUsage(promptTokens: unknown, outputText: unknown) {
  const inputTokens = Math.max(0, Number(promptTokens) || 0);
  const outputTokens = tokenEst(outputText);
  return { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens };
}

export function buildResponsesOutput(text: unknown, toolCalls: unknown, mid: string) {
  const output: Array<Record<string, unknown>> = [];
  if (Array.isArray(toolCalls)) {
    for (const tc of toolCalls) {
      if (!isOpenAIToolCall(tc)) continue;
      const call = tc;
      output.push({ type: "function_call", id: call.id, call_id: call.id, name: call.function.name, arguments: call.function.arguments, status: "completed" });
    }
  }
  if (text || !Array.isArray(toolCalls) || !toolCalls.length) {
    output.push({ type: "message", id: mid, role: "assistant", status: "completed", content: [{ type: "output_text", text: text || "", annotations: [] }] });
  }
  return output;
}

function isOpenAIToolCall(value: unknown): value is OpenAIToolCall {
  if (!isRecord(value) || !isRecord(value.function)) return false;
  return typeof value.id === "string"
    && typeof value.function.name === "string"
    && typeof value.function.arguments === "string";
}

function isPromiseLike(value: unknown): value is Promise<void> {
  return !!value && typeof (value as Promise<void>).then === "function";
}
