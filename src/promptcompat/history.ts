import { parseJsonObject } from "../shared/json";
import { isRecord } from "../shared/types";
import { contentTextForHistory, normalizeHistoryRole, reasoningTextForHistory, roleLabelForHistory } from "../toolcall/content";
import { formatPromptToolCallBlock } from "../toolcall/prompt-format";

type HistoryTranscriptEntry = {
  role: string;
  content: string;
};

export function buildOpenAIHistoryTranscript(messages: unknown, filename: unknown = "message.txt"): string {
  const entries: HistoryTranscriptEntry[] = [];
  if (!Array.isArray(messages)) return "";
  for (const msg of messages) {
    if (!isRecord(msg)) continue;
    const role = normalizeHistoryRole(msg.role);
    let content = "";
    if (role === "assistant") {
      const reasoning = reasoningTextForHistory(msg);
      content = [reasoning ? `[reasoning_content]\n${reasoning}\n[/reasoning_content]` : "", contentTextForHistory(msg.content)].filter(Boolean).join("\n\n");
      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
        const blocks = msg.tool_calls.map((tc) => {
          const record = isRecord(tc) ? tc : null;
          const fn = record && isRecord(record.function) ? record.function : {};
          return formatPromptToolCallBlock(fn.name, parseJsonObject(String(fn.arguments || "{}")));
        });
        content = [content, ...blocks].filter(Boolean).join("\n");
      }
    } else if (role === "tool") {
      const meta: string[] = [];
      if (msg.name) meta.push(`name=${msg.name}`);
      if (msg.tool_call_id) meta.push(`tool_call_id=${msg.tool_call_id}`);
      const toolContent = contentTextForHistory(msg.content).trim() || "null";
      content = [meta.length ? `[${meta.join(" ")}]` : "", toolContent].filter(Boolean).join("\n");
    } else {
      content = contentTextForHistory(msg.content);
    }
    content = String(content || "").trim();
    if (content) entries.push({ role, content });
  }
  if (!entries.length) return "";
  const sections = entries.map((entry, idx) => `=== ${idx + 1}. ${roleLabelForHistory(entry.role)} ===\n${entry.content}`);
  return `# ${filename || "message.txt"}\nPrior conversation history and tool progress.\n\n` + sections.join("\n\n") + "\n";
}

export function buildGoogleHistoryTranscript(req: unknown, filename: unknown = "message.txt"): string {
  const request = isRecord(req) ? req : {};
  const messages: HistoryTranscriptEntry[] = [];
  const sys = isRecord(request.systemInstruction) ? request.systemInstruction : null;
  if (sys && Array.isArray(sys.parts)) {
    const text = sys.parts
      .filter((part) => isRecord(part) && part.text)
      .map((part) => isRecord(part) ? part.text : "")
      .join(" ");
    if (text) messages.push({ role: "system", content: text });
  }
  const contents = Array.isArray(request.contents) ? request.contents : [];
  for (const content of contents) {
    if (!isRecord(content)) continue;
    const parts: string[] = [];
    const contentParts = Array.isArray(content.parts) ? content.parts : [];
    for (const p of contentParts) {
      if (!isRecord(p)) continue;
      if (p.text) parts.push(String(p.text));
      else if (isRecord(p.functionCall)) parts.push(formatPromptToolCallBlock(p.functionCall.name, p.functionCall.args || {}));
      else if (isRecord(p.functionResponse)) parts.push(`[Tool result for ${p.functionResponse.name || ""}]: ${JSON.stringify(p.functionResponse.response || {})}`);
      else if (p.inlineData) parts.push("[image input]");
    }
    messages.push({ role: content.role === "model" ? "assistant" : "user", content: parts.join("\n") });
  }
  return buildOpenAIHistoryTranscript(messages, filename);
}

export function latestOpenAIUserInputText(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!isRecord(msg)) continue;
    if (normalizeHistoryRole(msg.role) !== "user") continue;
    const text = contentTextForHistory(msg.content).trim();
    if (text) return text;
  }
  return "";
}

export function latestGoogleUserInputText(req: unknown): string {
  const request = isRecord(req) ? req : {};
  const contents = Array.isArray(request.contents) ? request.contents : [];
  for (let i = contents.length - 1; i >= 0; i--) {
    const content = contents[i];
    if (!isRecord(content) || content.role === "model") continue;
    const parts: string[] = [];
    const contentParts = Array.isArray(content.parts) ? content.parts : [];
    for (const part of contentParts) {
      if (!isRecord(part)) continue;
      const fileData = isRecord(part.fileData) ? part.fileData : null;
      if (part.text) parts.push(String(part.text));
      else if (part.inlineData) parts.push("[image input]");
      else if (fileData) parts.push(`[file input${fileData.fileUri ? ` ${fileData.fileUri}` : ""}]`);
    }
    const text = parts.join("\n").trim();
    if (text) return text;
  }
  return "";
}
