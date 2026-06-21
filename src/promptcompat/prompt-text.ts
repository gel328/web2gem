import { createPromptByteLengthSniffer, createTokenCounter, type PromptByteLengthBounded, type TokenCharCounts } from "../shared/tokens";

export type PromptTextTuple<TSecond = unknown> = [string, TSecond] & {
  byteCheck?: PromptByteLengthBounded;
  tokens?: number;
  counts?: TokenCharCounts & { hasText: boolean };
  latestInputText?: string;
  hasToolPrompt?: boolean;
  hasToolInstructions?: boolean;
};

export function createPromptPartAccumulator(maxBytes?: number | null): {
  add: (part: unknown) => void;
  text: () => string;
  result: <TSecond>(second: TSecond) => PromptTextTuple<TSecond>;
} {
  const parts: string[] = [];
  const sniffer = maxBytes == null ? null : createPromptByteLengthSniffer(maxBytes);
  const tokenCounter = createTokenCounter();
  return {
    add(part: unknown) {
      if (!part) return;
      const text = String(part);
      if (!text) return;
      if (parts.length) {
        if (sniffer) sniffer.append("\n\n");
        tokenCounter.append("\n\n");
      }
      if (sniffer) sniffer.append(text);
      tokenCounter.append(text);
      parts.push(text);
    },
    text() {
      return parts.join("\n\n");
    },
    result<TSecond>(second: TSecond) {
      const tuple = [parts.join("\n\n"), second] as PromptTextTuple<TSecond>;
      if (sniffer) tuple.byteCheck = sniffer.result();
      tuple.tokens = tokenCounter.tokens();
      tuple.counts = tokenCounter.counts();
      return tuple;
    },
  };
}
